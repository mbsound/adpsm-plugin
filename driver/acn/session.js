// One ACN SDT session with a Shure device, held open for as long as the
// caller wants it — the way Wireless Workbench holds one for the life of the
// app. Ported from the validated Python engine (ADTQ Mute/engine/wwb_mirror.py
// and adtq_mute.py's AdtqSession) with the same wire behaviour:
//
//   SLP advert x3 -> 3 s gap -> JOIN -> JOIN_ACCEPT / reciprocal JOIN ->
//   key derivation -> early ack + proto-0x102 declaration ->
//   device DECL09 (we reciprocate ASSOC0a) + device ASSOC0a (DMP enabled) ->
//   0.8 s write gate -> ready.
//
// After that each GET or SET is one encrypted DMP PDU on the live association
// and completes in tens of milliseconds. The session keeps itself alive:
// a cumulative ack of the device's reliable frontier every 1.4 s and an SLP
// re-registration every 4 s, both of which the device needs to keep serving
// us. Node's event loop is the pump thread the Python version needed.
//
// The reliable-sequence lockstep matters and is easy to break: JOIN advertises
// the reliable base as our channel number, so the device expects our first
// reliable wrapper at chan+1 — which is where the counters below put it. A
// base one lower makes the device NAK a phantom gap and no DMP ever flows.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { authTag, sessionKey } from './crypto.js';
import {
  DMP,
  DmpDecoder,
  JOIN_REFUSE_REASON,
  MGMT,
  PROTO_DMP,
  PROTO_SDT,
  SDT_VEC,
  TRAILER_FIRST_RELIABLE,
  TRAILER_PLAIN,
  buildJoin,
  buildJoinAccept,
  buildWrapper,
  clientBlock,
  dmpPdu,
  dmpProps,
  encryptDmp,
  mgmtAck,
  mgmtAssociate,
  mgmtDeclare,
  mgmtDisassociate,
  parseJoin,
  parseJoinAccept,
  parseMgmt,
  parseWrapper,
  rootLeave,
  rootParse,
  sdtLeaving,
  sdtPdus,
} from './pdu.js';
import { SLP_GROUP, SLP_PORT, SHURE_CID_TAIL, buildAdvert } from './slp.js';
import { delay, localIpToward } from '../netutil.js';

export const TERMINAL_DMP_VECTORS = new Set([DMP.GET_REPLY, DMP.GET_FAIL, DMP.SET_FAIL]);
const GET_ANSWERS = new Set([DMP.GET_REPLY, DMP.GET_FAIL]);

/** A fresh controller CID in Shure's MAC-derived shape. */
export const generateCid = () => Buffer.concat([randomBytes(4), Buffer.from(SHURE_CID_TAIL, 'hex')]);

const noop = () => {};

export class AcnSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host the device's IP address
   * @param {number} options.port the device's control port (from SLP)
   * @param {Buffer} options.deviceCid the device's CID (from SLP); mandatory
   * @param {string} [options.localIp] our address facing the device
   * @param {number} [options.slpPort=8427]
   * @param {boolean} [options.multicast=true] advertise on the SLP group
   * @param {boolean} [options.unicastSlp=false] also advertise straight to the device (test fakes)
   * @param {number} [options.advertPulses=3]
   * @param {number} [options.advertGapMs=120]
   * @param {number} [options.joinDelayMs=3000] the advert -> JOIN gap Workbench leaves
   * @param {number} [options.connectTimeoutMs=20000]
   * @param {number} [options.writeGateMs=800] settle time before the first DMP
   * @param {number} [options.requestTimeoutMs=3000]
   * @param {(level: string, msg: string) => void} [options.log]
   */
  constructor(options) {
    super();
    const {
      host, port, deviceCid, localIp, slpPort = SLP_PORT, multicast = true, unicastSlp = false,
      advertPulses = 3, advertGapMs = 120, joinDelayMs = 3000, connectTimeoutMs = 20000,
      writeGateMs = 800, requestTimeoutMs = 3000, log = noop,
    } = options;
    if (!host || !port) throw new Error('AcnSession needs host and port');
    if (!deviceCid || deviceCid.length !== 16) throw new Error('AcnSession needs the 16-byte device CID');
    this.host = host;
    this.port = port;
    this.deviceCid = Buffer.from(deviceCid);
    this.localIp = localIp ?? localIpToward(host);
    this.slpPort = slpPort;
    this.multicast = multicast;
    this.unicastSlp = unicastSlp;
    this.advertPulses = advertPulses;
    this.advertGapMs = advertGapMs;
    this.joinDelayMs = joinDelayMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.writeGateMs = writeGateMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;

    this.cid = generateCid();
    // a high random channel each session, as Workbench does
    this.ourChan = 0x8000 | (randomBytes(1)[0] << 4);
    this.devChan = null;

    // SDT reliable transport counters (reliable base == chan)
    this.totalSeq = (this.ourChan + 1) & 0xffff;
    this.relSeq = this.ourChan & 0xffff;
    this.firstRelSeq = null;
    this.firstRel = true;
    this.unacked = new Map(); // our rel seq -> blocks, for NAK retransmit
    this.devRel = 0; // the device's reliable frontier we cumulatively ack

    // crypto
    this.key = null;
    this.txNonce = randomBytes(8);
    this.txPos = 0;
    this.decoder = null;

    // state machine
    this.acceptedUs = false;
    this.sentAccept = false;
    this.joined = false;
    this.protoOk = false;
    this.recipAssocSent = false;
    this.ready = false;
    this.closed = false;
    this.refused = null;

    this.sock = null;
    this.slpSock = null;
    this.advert = null;
    this.lastSlp = 0;
    this.lastKeepalive = 0;
    this.keepaliveTimer = null;

    this.waiters = new Map(); // addr -> Set<{ accepts: Set<vector>, resolve }>
    this.stats = { sent: 0, received: 0, decoded: 0, undecodable: 0, naks: 0 };
  }

  // -- lifecycle ----------------------------------------------------------------

  /** Runs the prologue and resolves once DMP may be sent. */
  async open() {
    if (this.sock) throw new Error('session already opened');
    this.sock = await this.bind(0);
    this.sock.on('message', (msg) => this.onDatagram(msg));
    this.sock.on('error', (err) => this.fail(err));
    const { port: srcPort } = this.sock.address();
    this.advert = buildAdvert({ cid: this.cid, ip: this.localIp, port: srcPort });
    this.log('debug', `session ${this.cid.toString('hex')} chan 0x${this.ourChan.toString(16)} from ${this.localIp}:${srcPort} to ${this.host}:${this.port}`);

    await this.advertise();
    if (this.closed) throw new Error('session closed during advertisement');
    this.sock.send(buildJoin(this.cid, this.deviceCid, this.ourChan), this.port, this.host);
    this.log('debug', `JOIN sent (chan 0x${this.ourChan.toString(16)})`);

    const deadline = Date.now() + this.connectTimeoutMs;
    while (!this.protoOk && !this.closed && !this.refused && Date.now() < deadline) {
      await delay(20);
    }
    if (this.refused) {
      const why = JOIN_REFUSE_REASON[this.refused] ?? this.refused;
      await this.teardown();
      throw new Error(`${this.host} refused the session (JOIN_REFUSE ${why})`);
    }
    if (!this.protoOk) {
      await this.teardown();
      throw new Error(
        `Could not associate with ${this.host}:${this.port}. The device never answered the ` +
          'session request: check that its CID is right and that nothing else (Wireless ' +
          'Workbench, another copy of this plugin) holds the session.'
      );
    }
    // the device drops writes issued into a half-open association; settle once here
    await delay(this.writeGateMs);
    if (this.closed) throw new Error('session closed during association');
    this.ready = true;
    this.keepaliveTimer = setInterval(() => this.keepalive(), 200);
    this.keepaliveTimer.unref?.();
    this.emit('ready');
    return this;
  }

  bind(port) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.once('error', reject);
      sock.bind(port, () => {
        sock.removeListener('error', reject);
        resolve(sock);
      });
    });
  }

  async advertise() {
    try {
      this.slpSock = await this.bind(this.slpPort);
    } catch (err) {
      this.log('debug', `could not bind SLP :${this.slpPort} (${err.message}); advertising from an ephemeral port`);
      this.slpSock = await this.bind(0);
    }
    this.slpSock.on('error', noop);
    this.slpSock.on('message', noop);
    try {
      this.slpSock.setMulticastTTL(4);
      if (this.multicast) {
        this.slpSock.setMulticastInterface(this.localIp);
        this.slpSock.addMembership(SLP_GROUP, this.localIp);
      }
    } catch (err) {
      this.log('debug', `SLP multicast setup: ${err.message}`);
    }
    for (let i = 0; i < this.advertPulses; i += 1) {
      this.sendAdvert();
      await delay(this.advertGapMs);
    }
    this.log('debug', `SLP advert sent; waiting ${this.joinDelayMs} ms before JOIN`);
    await delay(this.joinDelayMs);
  }

  sendAdvert() {
    if (!this.slpSock || !this.advert) return;
    if (this.multicast) this.slpSock.send(this.advert, this.slpPort, SLP_GROUP, noop);
    if (this.unicastSlp) this.slpSock.send(this.advert, this.slpPort, this.host, noop);
    this.lastSlp = Date.now();
  }

  keepalive() {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastSlp > 4000) this.sendAdvert();
    if (this.joined && now - this.lastKeepalive > 1400) {
      this.ackDevice();
      this.lastKeepalive = now;
    }
  }

  /** Clean disconnect: disassociate, LEAVING, root-layer leave. Idempotent. */
  async close() {
    await this.teardown();
  }

  async teardown() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    for (const waiters of this.waiters.values()) for (const w of waiters) w.resolve(null);
    this.waiters.clear();
    if (this.sock && this.joined && this.devChan) {
      try {
        for (let i = 0; i < 2; i += 1) {
          this.sendReliable([clientBlock(1, PROTO_SDT, 0, mgmtDisassociate())]);
          this.sendReliable([clientBlock(1, PROTO_SDT, 0, sdtLeaving())]);
          await delay(50);
        }
        const leave = rootLeave(this.cid, this.deviceCid);
        this.sock.send(leave, this.port, this.host, noop);
        this.sock.send(leave, this.port, this.host, noop);
        await delay(20);
      } catch (err) {
        this.log('debug', `disconnect: ${err.message}`);
      }
    }
    for (const s of [this.sock, this.slpSock]) {
      try {
        s?.close();
      } catch {
        // already closed
      }
    }
    this.sock = null;
    this.slpSock = null;
    this.emit('close');
  }

  fail(err) {
    if (this.closed) return;
    this.log('error', `session error: ${err?.message || err}`);
    this.emit('error', err);
    this.teardown().catch(noop);
  }

  // -- SDT senders -----------------------------------------------------------------

  sendReliable(blocks) {
    const tot = this.totalSeq;
    this.totalSeq = (this.totalSeq + 1) & 0xffff;
    this.relSeq = (this.relSeq + 1) & 0xffff;
    if (this.firstRelSeq === null) this.firstRelSeq = this.relSeq;
    const trailer = this.firstRel ? TRAILER_FIRST_RELIABLE : TRAILER_PLAIN;
    this.firstRel = false;
    this.unacked.set(this.relSeq, blocks);
    // Workbench pins oldest-available at its first reliable seq
    const pkt = buildWrapper(this.cid, this.ourChan, tot, this.relSeq, this.firstRelSeq, blocks, true, trailer);
    this.sock?.send(pkt, this.port, this.host, noop);
    this.stats.sent += 1;
  }

  sendUnreliable(blocks) {
    const tot = this.totalSeq;
    this.totalSeq = (this.totalSeq + 1) & 0xffff;
    const pkt = buildWrapper(this.cid, this.ourChan, tot, this.relSeq, this.relSeq, blocks, false, TRAILER_PLAIN);
    this.sock?.send(pkt, this.port, this.host, noop);
  }

  /** Cumulative unreliable ack of the device's reliable frontier. */
  ackDevice() {
    this.sendUnreliable([clientBlock(1, PROTO_SDT, this.devChan ?? 0, mgmtAck(this.devRel))]);
  }

  /** Encrypt-then-tag one DMP PDU at the continuous stream position. */
  sendDmp(pdu) {
    if (!this.key) throw new Error('session has no key yet');
    const cb = encryptDmp(this.key, this.txNonce, this.txPos, pdu);
    this.txPos += pdu.length;
    const block = Buffer.concat([cb, authTag(this.key, cb)]);
    this.sendReliable([clientBlock(1, PROTO_DMP, 0, block)]);
  }

  // -- receive -------------------------------------------------------------------------

  onDatagram(data) {
    if (this.closed) return;
    this.stats.received += 1;
    const root = rootParse(data);
    if (!root) return;
    // the device coalesces its cumulative ack and its reliable DECL09 into
    // one datagram; every SDT PDU in it has to be seen
    for (const { vector, data: vdata } of sdtPdus(root.sdt)) this.dispatch(vector, vdata);
    if (this.acceptedUs && this.sentAccept && this.devChan && !this.joined) this.completeJoin();
  }

  dispatch(vec, vdata) {
    switch (vec) {
      case SDT_VEC.JOIN_ACCEPT: {
        const accept = parseJoinAccept(vdata);
        if (!accept) return;
        this.acceptedUs = true;
        this.devChan = accept.recipChan;
        this.log('debug', `JOIN_ACCEPT: device chan 0x${this.devChan.toString(16)}`);
        return;
      }
      case SDT_VEC.JOIN: {
        const join = parseJoin(vdata);
        if (!join) return;
        this.devChan = join.chan;
        this.devRel = join.relSeq;
        if (!this.sentAccept) {
          this.sock?.send(
            buildJoinAccept(this.cid, this.deviceCid, this.devChan, join.relSeq, this.ourChan),
            this.port, this.host, noop
          );
          this.sentAccept = true;
          this.log('debug', `reciprocal JOIN: device chan 0x${this.devChan.toString(16)}, accepted`);
        }
        return;
      }
      case SDT_VEC.REL_WRAP:
      case SDT_VEC.UNREL_WRAP: {
        const w = parseWrapper(vdata);
        if (!w) return;
        if (vec === SDT_VEC.REL_WRAP) {
          this.devRel = w.rel & 0xffff;
          this.scanAssoc(w.blocks);
          // reactive cumulative ack on every device reliable wrapper keeps
          // the device's send window drained
          this.ackDevice();
          this.lastKeepalive = Date.now();
        } else {
          this.scanAssoc(w.blocks);
        }
        for (const { proto, payload } of w.blocks) {
          if (proto === PROTO_DMP && this.decoder && payload[0] === 0x01) {
            const dec = this.decoder.decode(payload);
            if (dec) {
              this.stats.decoded += 1;
              this.handleDmp(dec);
            } else {
              this.stats.undecodable += 1;
            }
          }
        }
        return;
      }
      case SDT_VEC.NAK: {
        this.stats.naks += 1;
        const missed = vdata.length >= 24 ? vdata.readUInt16BE(22) : null;
        this.log('debug', `NAK missed=0x${(missed ?? 0).toString(16)}`);
        if (missed === null) return;
        const seqs = [...this.unacked.keys()]
          .filter((q) => ((q - missed) & 0xffff) < 0x8000)
          .sort((a, b) => ((a - missed) & 0xffff) - ((b - missed) & 0xffff));
        for (const sq of seqs) {
          const tot = this.totalSeq;
          this.totalSeq = (this.totalSeq + 1) & 0xffff;
          const oldest = this.firstRelSeq ?? sq;
          this.sock?.send(
            buildWrapper(this.cid, this.ourChan, tot, sq, oldest, this.unacked.get(sq), true),
            this.port, this.host, noop
          );
        }
        return;
      }
      case SDT_VEC.JOIN_REFUSE: {
        const reason = vdata.length > 16 ? vdata[vdata.length - 1] : null;
        this.refused = reason ?? 1;
        this.log('warn', `JOIN_REFUSE reason=${reason} (${JOIN_REFUSE_REASON[reason] ?? '?'})`);
        return;
      }
      case SDT_VEC.LEAVING:
        this.log('warn', 'device is leaving the session');
        this.emit('leaving');
        return;
      default:
    }
  }

  scanAssoc(blocks) {
    for (const { proto, payload } of blocks) {
      if (proto !== PROTO_SDT && proto !== null) continue;
      const mgmt = parseMgmt(payload);
      if (!mgmt) continue;
      if (mgmt.vec === MGMT.ACK) {
        this.onOurAck(mgmt.seq);
      } else if (mgmt.vec === MGMT.DECLARE && mgmt.proto === PROTO_DMP && !this.recipAssocSent) {
        // reciprocal ASSOC0a MUST carry the device channel; with 0 the push
        // channel stays half-open and SETs are silently dropped
        this.recipAssocSent = true;
        this.sendReliable([clientBlock(1, PROTO_SDT, this.devChan ?? 0, mgmtAssociate())]);
        this.log('debug', 'device declared 0x102; reciprocal ASSOC0a sent');
      } else if (mgmt.vec === MGMT.ASSOCIATE && mgmt.proto === PROTO_DMP && !this.protoOk) {
        this.protoOk = true;
        this.log('debug', 'device accepted our 0x102 declaration; DMP enabled');
      }
    }
  }

  onOurAck(ackSeq) {
    for (const q of [...this.unacked.keys()]) {
      if (((q - ackSeq) & 0xffff) === 0 || ((ackSeq - q) & 0xffff) < 0x8000) this.unacked.delete(q);
    }
  }

  completeJoin() {
    this.joined = true;
    this.key = sessionKey(this.cid, this.deviceCid, this.ourChan, this.devChan);
    this.decoder = new DmpDecoder(this.key);
    this.log('debug', `joined: us 0x${this.ourChan.toString(16)} device 0x${this.devChan.toString(16)}`);
    // early ack of the device's frontier, then declare 0x102 (Workbench order)
    this.ackDevice();
    this.lastKeepalive = Date.now();
    this.sendReliable([clientBlock(1, PROTO_SDT, 0, mgmtDeclare())]);
  }

  handleDmp(dec) {
    for (const prop of dmpProps(dec)) {
      this.emit('dmp', prop);
      if (!TERMINAL_DMP_VECTORS.has(prop.vector)) continue;
      const waiters = this.waiters.get(prop.addr);
      if (!waiters) continue;
      for (const w of [...waiters]) {
        if (!w.accepts.has(prop.vector)) continue;
        waiters.delete(w);
        w.resolve(prop);
      }
      if (!waiters.size) this.waiters.delete(prop.addr);
    }
  }

  // -- request / response -----------------------------------------------------------------

  /**
   * Sends `pdu` and resolves with the terminal reply for `addr` —
   * `{ vector, addr, value }` — or null on timeout. Only GET_REPLY, GET_FAIL
   * and SET_FAIL settle a request (`accepts` narrows that further): the
   * device also emits SET echoes and unsolicited EVENTs on the same address,
   * and treating those as the answer would hand back a stale or racing value.
   */
  request(pdu, addr, timeoutMs = this.requestTimeoutMs, accepts = TERMINAL_DMP_VECTORS) {
    if (!this.ready) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const waiter = { accepts, resolve: null };
      const done = (reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const set = this.waiters.get(addr);
        if (set) {
          set.delete(waiter);
          if (!set.size) this.waiters.delete(addr);
        }
        resolve(reply);
      };
      waiter.resolve = done;
      const timer = setTimeout(() => done(null), timeoutMs);
      timer.unref?.();
      if (!this.waiters.has(addr)) this.waiters.set(addr, new Set());
      this.waiters.get(addr).add(waiter);
      try {
        this.sendDmp(pdu);
      } catch (err) {
        done(null);
        this.log('warn', `send failed: ${err.message}`);
      }
    });
  }

  /** GET one address: `{ vector, addr, value }`, or null when nothing came back. */
  get(addr, timeoutMs) {
    return this.request(dmpPdu(DMP.GET, addr), addr, timeoutMs, GET_ANSWERS);
  }

  /**
   * GET many addresses with a bounded number in flight. Silent addresses are
   * retried once: the device answers every GET (a reply or a GET_FAIL), so
   * silence is always a lost packet, never an absent property.
   */
  async getMany(addrs, { concurrency = 6, retries = 1, timeoutMs } = {}) {
    const result = new Map();
    let remaining = [...addrs];
    for (let attempt = 0; attempt <= retries && remaining.length; attempt += 1) {
      const queue = [...remaining];
      const worker = async () => {
        while (queue.length) {
          const addr = queue.shift();
          const reply = await this.get(addr, timeoutMs);
          if (reply) result.set(addr, reply);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
      remaining = remaining.filter((a) => !result.has(a));
      if (this.closed) break;
    }
    return { replies: result, unanswered: remaining };
  }

  /**
   * SET `addr` to `value`, then read it back. Returns `{ ok, after, refused }`
   * where `after` is the device's own account of the property and `ok` says
   * it equals what was written. The read-back is the point: a SET the device
   * silently ignores is otherwise indistinguishable from one that worked.
   *
   * A SET has no positive acknowledgement in DMP, only a SET_FAIL when the
   * device rejects it; `refused` is that reason byte (`DMP_FAIL_REASON` names
   * it) or null. The GET goes out right behind the SET, so a SET_FAIL must
   * not be taken as the GET's answer: the real unit sends the SET_FAIL and
   * then the GET_REPLY a millisecond later, and both are wanted.
   */
  async set(addr, value, timeoutMs) {
    if (!this.ready) return { ok: false, after: null, refused: null };
    let refused = null;
    const onDmp = (prop) => {
      if (prop.vector === DMP.SET_FAIL && prop.addr === addr && refused === null) refused = prop.value[0] ?? 1;
    };
    this.on('dmp', onDmp);
    try {
      this.sendDmp(dmpPdu(DMP.SET, addr, value));
      const reply = await this.get(addr, timeoutMs);
      const after = reply && reply.vector === DMP.GET_REPLY ? reply.value : null;
      return { ok: refused === null && after !== null && after.equals(Buffer.from(value)), after, reply, refused };
    } finally {
      this.off('dmp', onDmp);
    }
  }
}
