// A fake ADTQ: a UDP service that speaks the same SLP and ACN SDT/DMP wire as
// the device, built from the same primitives the driver uses, holding the
// same property map the real unit was observed to hold. It exists so the
// whole stack — shell, adapter, driver, sockets — runs with nothing attached,
// and so the failure paths (a device that stops answering, a write it
// refuses, a lost datagram) can be staged on demand.
//
// Fidelity notes: session handshake order, wrapper acks, the DECL/ASSOC
// exchange, GET_REPLY / GET_FAIL(0x02) / EVENT-after-SET and the mandatory
// CID check all follow the captures. What the real device does with a SET
// outside its band is unknown; this fake ignores it, which exercises the
// "not applied" read-back path.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { authTag, sessionKey } from '../acn/crypto.js';
import {
  DMP,
  DmpDecoder,
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
  parseJoin,
  parseJoinAccept,
  parseMgmt,
  parseWrapper,
  rootParse,
  sdtPdus,
} from '../acn/pdu.js';
import { buildDeviceAdvert, isSrvRqst, SHURE_CID_TAIL } from '../acn/slp.js';
import { CHANNEL_COUNT, DEV, DEVICE_NAME_MAX, GAIN_MAX_DB, GAIN_MIN_DB, OBJ, PRESET_NAMES, decodeModeList, encodeModeList, encodePowerTable, isWidebandCode, TONE_FREQ_MAX_HZ, TONE_FREQ_MIN_HZ, TONE_LEVELS_DB, TONE_OFF_DB, chanAddr, channelsFor, decodeString, encodeString, splitAddr } from '../adtq/properties.js';

const noop = () => {};
const u8 = (n) => Buffer.from([n & 0xff]);
const RF_OBJS = new Set([OBJ.CHAN_NAME, OBJ.GROUP_CHAN, OBJ.FREQ_KHZ, OBJ.RF_MUTE, OBJ.TX_POWER, OBJ.RF_STATUS]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

const i32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
};

/**
 * The panel's 7-dot meter byte for a level in dB: a solid bar of the dots
 * whose thresholds the level clears. Thresholds are where each dot went out
 * as CH1's gain was swept on the unit (pair B read-back), so approximate.
 */
const DOT_THRESHOLDS_DB = [-50, -45, -33, -24, -18, -12, -6];
export function dotsFromDb(db) {
  let bits = 0;
  DOT_THRESHOLDS_DB.forEach((t, i) => {
    if (db >= t) bits |= 1 << i;
  });
  return bits;
}

export const FAKE_CID = Buffer.from(`dd2d453e${SHURE_CID_TAIL}`, 'hex');

/** The property map observed on "ADTQ G57 NACLOCK", as raw values. */
export function defaultProperties(channels = CHANNEL_COUNT, model = 'ADTQ') {
  const props = new Map();
  // the unit's own settings, as an ADTD read them (2026-10-26)
  props.set(DEV.MODEL, encodeString(model));
  props.set(DEV.SERIAL, encodeString('VT000000000'));
  props.set(DEV.NAME, encodeString(model));
  props.set(DEV.POWER_LOCK, u8(0));
  props.set(DEV.FAN_ALWAYS_ON, u8(0));
  props.set(DEV.UPTIME, encodeString('0:07:08'));
  props.set(DEV.BAND, encodeString('G57'));
  props.set(DEV.PANEL_LOCK, u8(0));
  // the RF block as the units read it: ADTD preset 5 "SC narrowband" with mode code 45, ADTQ preset 1 with mode code 20
  // the fake boots in a narrowband preset (one carrier per channel); tests switch it to wideband
  props.set(DEV.OP_PRESET, u8(model === 'ADTD' ? 5 : 1));
  props.set(DEV.RF_MODE_CODE, u8(model === 'ADTD' ? 45 : 14));
  props.set(DEV.RF_MODE_LIST, encodeModeList(model === 'ADTD' ? [45, 46, 32, 31, 3, 2, 5, 0, 1, 10, 9] : [20, 18, 40, 41, 42, 43, 28, 14, 13, 26, 16, 11, 12, 23, 22]));
  props.set(DEV.RF_POWER_TABLE, encodePowerTable({ 45: 'Low (10 mW), Normal (20 mW), High (100 mW)', 31: 'Low (10 mW), Normal (40 mW), High (126 mW)' }));
  const set = (ch, obj, value) => props.set(chanAddr(ch, obj), Buffer.from(value));
  const freqs = [470625, 471225, 471725, 472300];
  const power = [1, 0, 0, 0];
  const gain = [16, 0, 0, 0];
  const mode = [1, 0, 1, 1];
  // audio level pair B as seen on the unit: programme on CH1, idle noise on
  // CH2/CH4, nothing connected on CH3 (-255)
  const afL = [-18, -118, -255, -106];
  const afR = [-21, -118, -255, -105];
  for (let ch = 1; ch <= channels; ch += 1) {
    set(ch, OBJ.AF_LEVEL_L, i32(afL[ch - 1]));
    set(ch, OBJ.AF_LEVEL_R, i32(afR[ch - 1]));
    set(ch, OBJ.AF_DOTS_L, u8(dotsFromDb(afL[ch - 1])));
    set(ch, OBJ.AF_DOTS_R, u8(dotsFromDb(afR[ch - 1])));
    set(ch, OBJ.CHAN_NAME, encodeString(`Channel${ch}`));
    set(ch, OBJ.CHAN_NAME_ALT, encodeString(`Channel${ch}`));
    set(ch, OBJ.GROUP_CHAN, encodeString(`1,${ch}`));
    set(ch, OBJ.FREQ_KHZ, u32(freqs[ch - 1]));
    set(ch, OBJ.RF_MUTE, u8(0));
    set(ch, OBJ.TX_POWER, u8(power[ch - 1]));
    set(ch, OBJ.POWER_LEVEL, Buffer.from([0, power[ch - 1] === 1 ? 20 : 10]));
    set(ch, OBJ.RF_STATUS, u8(1));
    set(ch, OBJ.AUDIO_GAIN_DB, u8(gain[ch - 1]));
    set(ch, OBJ.AUDIO_MODE, u8(mode[ch - 1]));
    set(ch, OBJ.MODEL, encodeString('ADXR-A'));
    set(ch, OBJ.ENCRYPTION, u8(0));
    set(ch, OBJ.INPUT_SELECT, u8(0));
    set(ch, OBJ.INPUT_STATE, u8(1));
    set(ch, OBJ.ANALOG_SENSITIVITY, u8(1));
    set(ch, 0x0805, u8(2));
    set(ch, OBJ.TONE_FREQ_HZ, Buffer.from([400 >> 8, 400 & 0xff]));
    set(ch, OBJ.TONE_LEVEL_DB, u8(TONE_OFF_DB & 0xff));
  }
  return props;
}

// the band this fake accepts frequencies in (a G57 unit)
export const FAKE_BAND_KHZ = [470_000, 616_000];

export class FakeAdtq extends EventEmitter {
  constructor({ cid = FAKE_CID, fctn = 'ADTQ', uacn = 'ADTQ G57 NACLOCK', host = '127.0.0.1', log = noop } = {}) {
    super();
    this.cid = Buffer.from(cid);
    this.fctn = fctn;
    this.uacn = uacn;
    this.host = host;
    this.log = log;
    // an ADTD fake has two channels; reads of the others get the GET_FAIL a real ADTD gives
    this.channels = channelsFor(fctn);
    this.props = defaultProperties(this.channels, fctn);
    this.slpSock = null;
    this.ctlSock = null;
    this.slpPort = 0;
    this.controlPort = 0;
    this.sessions = new Map(); // peer cid hex -> session state
    // test knobs
    this.silent = false; // answer nothing at all (the device went away)
    this.rejectWrites = false; // every SET is ignored
    this.dropInbound = 0; // probability of losing an inbound control datagram
    this.random = Math.random; // the loss draw; a test seeds it to lose the same datagrams every run
    this.answerSlp = true;
    this.programme = true; // CH1's meters move like music is playing
    this.counters = { joins: 0, gets: 0, sets: 0, events: 0 };
  }

  bind(sock, port) {
    return new Promise((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(port, this.host, () => {
        sock.removeListener('error', reject);
        resolve(sock.address().port);
      });
    });
  }

  async listen({ slpPort = 0, controlPort = 0 } = {}) {
    this.slpSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.ctlSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.slpPort = await this.bind(this.slpSock, slpPort);
    this.controlPort = await this.bind(this.ctlSock, controlPort);
    this.slpSock.on('message', (msg, rinfo) => this.onSlp(msg, rinfo));
    this.ctlSock.on('message', (msg, rinfo) => this.onControl(msg, rinfo));
    this.slpSock.on('error', noop);
    this.ctlSock.on('error', noop);
    return { slpPort: this.slpPort, controlPort: this.controlPort };
  }

  async stop() {
    for (const s of [this.slpSock, this.ctlSock]) {
      try {
        s?.close();
      } catch {
        // closed already
      }
    }
    this.slpSock = null;
    this.ctlSock = null;
    this.sessions.clear();
  }

  // -- property store ---------------------------------------------------------------------

  /** In a wideband preset: the carrier channels, as the unit lays them out (one per frequency). */
  carriers() {
    const code = this.props.get(DEV.RF_MODE_CODE)?.[0];
    if (!isWidebandCode(code)) return null;
    const name = PRESET_NAMES[code] ?? '';
    const perCarrier = /4 frequencies/.test(name) ? 1 : /2 frequencies/.test(name) ? this.channels / 2 : this.channels;
    const out = [];
    for (let ch = 1; ch <= this.channels; ch += perCarrier) out.push(ch);
    return { carriers: out, perCarrier };
  }

  get(addr) {
    const w = this.carriers();
    const sp = splitAddr(addr);
    if (w && sp && sp.channel <= this.channels) {
      // the unit: RF objects answer only on a carrier; the read-address name there is the composite of its mixes
      if (RF_OBJS.has(sp.obj) && !w.carriers.includes(sp.channel)) return null;
      if (sp.obj === OBJ.CHAN_NAME && w.carriers.includes(sp.channel)) {
        const names = [];
        for (let ch = sp.channel; ch < sp.channel + w.perCarrier; ch += 1) names.push(decodeString(this.props.get(chanAddr(ch, OBJ.CHAN_NAME_ALT))));
        return encodeString(names.join(','));
      }
    }
    const raw = this.props.get(addr) ?? null;
    const split = raw && splitAddr(addr);
    if (split && split.channel === 1 && this.programme) {
      // a slow swell and a faster flutter, the right side slightly out of step;
      // the dots follow the dB with a peak-hold dot one above the bar
      const right = split.obj === OBJ.AF_LEVEL_R || split.obj === OBJ.AF_DOTS_R;
      const t = Date.now() / 1000;
      const phase = right ? 0.9 : 0;
      const wobble = Math.round(4 * Math.sin(t * 2.1 + phase) + 3 * Math.sin(t * 5.3 + phase));
      if (split.obj === OBJ.AF_LEVEL_L || split.obj === OBJ.AF_LEVEL_R) return i32(raw.readInt32BE(0) + wobble);
      if (split.obj === OBJ.AF_DOTS_L || split.obj === OBJ.AF_DOTS_R) {
        const db = this.props.get(chanAddr(1, right ? OBJ.AF_LEVEL_R : OBJ.AF_LEVEL_L)).readInt32BE(0) + wobble;
        const bar = dotsFromDb(db);
        const peakBit = bar ? (bar + 1) << 1 : 0; // a floating peak dot two above the bar
        return u8((bar | peakBit) & 0x7f);
      }
    }
    return raw;
  }

  /** Sets a raw value directly (a front-panel change); emits an EVENT to every session. */
  setRaw(addr, value, { notify = true } = {}) {
    this.props.set(addr, Buffer.from(value));
    if (notify) for (const s of this.sessions.values()) this.sendDmp(s, dmpPdu(DMP.EVENT, addr, value));
  }

  /** Test convenience: mute state of a channel as the device holds it. */
  muted(ch) {
    return this.get(chanAddr(ch, OBJ.RF_MUTE))?.[0] === 1;
  }

  frequencyKhz(ch) {
    return this.get(chanAddr(ch, OBJ.FREQ_KHZ))?.readUInt32BE(0);
  }

  channelName(ch) {
    return decodeString(this.get(chanAddr(ch, OBJ.CHAN_NAME)));
  }

  /**
   * What a SET may change, and how the device sanitises it. Returns true when
   * applied, false when silently ignored, or `{ fail }` with the SET_FAIL
   * reason the real unit sends back.
   */
  applySet(addr, value) {
    if (this.rejectWrites) return false;
    const split = splitAddr(addr);
    if (!split) return this.#applyDeviceSet(addr >>> 0, value);
    const { obj } = split;
    switch (obj) {
      case OBJ.AUDIO_GAIN_DB: {
        // the unit: SET_FAIL 0x05 outside -20..+16 dB (ADTD, 2026-10-26)
        if (value.length !== 1) return false;
        const db = value.readInt8(0);
        if (db < GAIN_MIN_DB || db > GAIN_MAX_DB) return { fail: 0x05 };
        this.props.set(addr, Buffer.from(value));
        return true;
      }
      case OBJ.TONE_LEVEL_DB: {
        if (value.length !== 1) return false;
        const db = value.readInt8(0);
        if (db !== TONE_OFF_DB && !TONE_LEVELS_DB.includes(db)) return false;
        this.props.set(addr, Buffer.from(value));
        return true;
      }
      case OBJ.TONE_FREQ_HZ: {
        if (value.length !== 2) return false;
        const hz = value.readUInt16BE(0);
        if (hz < TONE_FREQ_MIN_HZ || hz > TONE_FREQ_MAX_HZ) return false;
        this.props.set(addr, Buffer.from(value));
        return true;
      }
      case OBJ.RF_MUTE:
        if (value.length !== 1 || value[0] > 1) return false;
        this.props.set(addr, Buffer.from(value));
        this.props.set(chanAddr(split.channel, OBJ.RF_STATUS), u8(value[0] ? 0 : 1));
        return true;
      case OBJ.FREQ_KHZ: {
        if (value.length !== 4) return false;
        const khz = value.readUInt32BE(0);
        if (khz < FAKE_BAND_KHZ[0] || khz > FAKE_BAND_KHZ[1] || khz % 25) return false;
        this.props.set(addr, Buffer.from(value));
        return true;
      }
      case OBJ.TX_POWER:
        if (value.length !== 1 || value[0] > 2) return false;
        this.props.set(addr, Buffer.from(value));
        this.props.set(chanAddr(split.channel, OBJ.POWER_LEVEL), Buffer.from([0, value[0] === 1 ? 20 : 10]));
        return true;
      case OBJ.AUDIO_MODE:
        if (value.length !== 1 || value[0] > 1) return false;
        this.props.set(addr, Buffer.from(value));
        return true;
      case OBJ.ENCRYPTION: {
        // device-wide, applied a moment after the SET: the read-back right behind it still shows the old value
        if (value.length !== 1 || ![0, 3].includes(value[0])) return { fail: 0x05 };
        setTimeout(() => { for (let ch = 1; ch <= this.channels; ch += 1) this.props.set(chanAddr(ch, OBJ.ENCRYPTION), Buffer.from(value)); }, 300);
        return true;
      }
      case OBJ.INPUT_SELECT: {
        // the unit EVENTs the selection and its state (03 Dante, 01 Rear Panel)
        if (value.length !== 1 || value[0] > 1) return { fail: 0x05 };
        this.props.set(addr, Buffer.from(value));
        this.props.set(chanAddr(split.channel, OBJ.INPUT_STATE), u8(value[0] === 1 ? 3 : 1));
        return true;
      }
      case OBJ.ANALOG_SENSITIVITY:
        if (value.length !== 1 || value[0] > 1) return { fail: 0x05 };
        this.props.set(addr, Buffer.from(value));
        return true;
      case OBJ.CHAN_NAME:
        // the real unit: SET_FAIL 0x04 (NOT_WRITABLE); the name is written via 0x0001
        return { fail: 0x04 };
      case OBJ.CHAN_NAME_ALT: {
        const s = decodeString(value);
        if (s === null || s.length > 8) return false;
        this.props.set(addr, encodeString(s));
        this.props.set(chanAddr(split.channel, OBJ.CHAN_NAME), encodeString(s));
        return true;
      }
      default:
        return false;
    }
  }

  /** The unit's own settings: the Device ID, the locks and the fan mode take a write; the rest are fixed. */
  #applyDeviceSet(addr, value) {
    switch (addr) {
      case DEV.NAME: {
        const s = decodeString(value);
        if (s === null || s.length > DEVICE_NAME_MAX) return false;
        this.props.set(addr, encodeString(s));
        return true;
      }
      case DEV.RF_MODE_CODE: {
        // the preset, as Workbench writes it; the unit reboots on this. A code the band does not
        // offer is refused; the derived identifier follows the two pairs seen on an ADTD
        const codes = decodeModeList(this.props.get(DEV.RF_MODE_LIST)) ?? [];
        if (value.length !== 1 || !codes.includes(value[0])) return { fail: 0x05 };
        this.props.set(addr, Buffer.from(value));
        this.props.set(DEV.OP_PRESET, u8(value[0] === 31 ? 3 : value[0] === 45 ? 5 : 0));
        return true;
      }
      case DEV.POWER_LOCK:
      case DEV.PANEL_LOCK:
      case DEV.FAN_ALWAYS_ON:
        if (value.length !== 1 || value[0] > 1) return false;
        this.props.set(addr, Buffer.from(value));
        return true;
      default:
        return false;
    }
  }

  // -- SLP --------------------------------------------------------------------------------

  onSlp(msg, rinfo) {
    if (this.silent || !this.answerSlp || !isSrvRqst(msg)) return;
    const reply = buildDeviceAdvert({ cid: this.cid, fctn: this.fctn, uacn: this.uacn, ip: this.host, port: this.controlPort });
    // the real device replies to the requester's IP on 8427; a fake on an
    // ephemeral port replies to the socket that asked, which the driver
    // listens on as well
    this.slpSock?.send(reply, rinfo.port, rinfo.address, noop);
  }

  // -- ACN --------------------------------------------------------------------------------

  onControl(msg, rinfo) {
    if (this.silent) return;
    if (this.dropInbound > 0 && this.random() < this.dropInbound) return;
    const root = rootParse(msg);
    if (!root) return;
    const peerId = root.cid.toString('hex');
    for (const { vector, data } of sdtPdus(root.sdt)) {
      switch (vector) {
        case SDT_VEC.JOIN:
          this.onJoin(root.cid, data, rinfo);
          break;
        case SDT_VEC.JOIN_ACCEPT:
          this.onJoinAccept(peerId, data);
          break;
        case SDT_VEC.REL_WRAP:
        case SDT_VEC.UNREL_WRAP:
          this.onWrapper(peerId, vector === SDT_VEC.REL_WRAP, data);
          break;
        case SDT_VEC.LEAVING:
        case SDT_VEC.NAK:
          // the root-layer leave arrives as vector 8 in Workbench's dialect
          if (this.sessions.has(peerId)) {
            this.sessions.delete(peerId);
            this.emit('left', peerId);
          }
          break;
        default:
      }
    }
  }

  onJoin(peerCid, data, rinfo) {
    const join = parseJoin(data);
    if (!join) return;
    // a JOIN addressed to a CID this device does not own is discarded with no
    // reply of any kind — the single most important behaviour to reproduce
    if (!join.memberCid.equals(this.cid)) {
      this.emit('ignored-join', peerCid.toString('hex'));
      return;
    }
    this.counters.joins += 1;
    const devChan = 0x1000 | (randomBytes(1)[0] << 4);
    const s = {
      peerCid: Buffer.from(peerCid),
      peerChan: join.chan,
      peerRel: join.relSeq,
      address: rinfo.address,
      port: rinfo.port,
      devChan,
      totalSeq: (devChan + 1) & 0xffff,
      relSeq: devChan & 0xffff,
      firstRelSeq: null,
      firstRel: true,
      key: sessionKey(peerCid, this.cid, join.chan, devChan),
      txNonce: randomBytes(8),
      txPos: 0,
      decoder: null,
      accepted: false,
      associated: false,
    };
    s.decoder = new DmpDecoder(s.key);
    this.sessions.set(peerCid.toString('hex'), s);
    this.send(s, buildJoinAccept(this.cid, peerCid, join.chan, join.relSeq, devChan));
    // the device joins us back on its own channel
    this.send(s, buildJoin(this.cid, peerCid, devChan));
    this.emit('join', s);
  }

  onJoinAccept(peerId, data) {
    const s = this.sessions.get(peerId);
    const accept = parseJoinAccept(data);
    if (!s || !accept) return;
    s.accepted = true;
    // declare that we speak DMP; the controller answers ASSOC0a
    this.sendReliable(s, [clientBlock(1, PROTO_SDT, s.peerChan, mgmtDeclare())]);
  }

  onWrapper(peerId, reliable, data) {
    const s = this.sessions.get(peerId);
    const w = parseWrapper(data);
    if (!s || !w) return;
    if (reliable) {
      s.peerRel = w.rel & 0xffff;
      this.sendUnreliable(s, [clientBlock(1, PROTO_SDT, s.peerChan, mgmtAck(s.peerRel))]);
    }
    for (const { proto, payload } of w.blocks) {
      if (proto === PROTO_SDT || proto === null) {
        const mgmt = parseMgmt(payload);
        if (!mgmt) continue;
        if (mgmt.vec === MGMT.DECLARE && mgmt.proto === PROTO_DMP) {
          this.sendReliable(s, [clientBlock(1, PROTO_SDT, s.peerChan, mgmtAssociate())]);
        } else if (mgmt.vec === MGMT.ASSOCIATE) {
          s.associated = true;
          this.emit('associated', s);
        } else if (mgmt.vec === MGMT.DISASSOCIATE) {
          s.associated = false;
        }
      } else if (proto === PROTO_DMP && payload[0] === 0x01) {
        const dec = s.decoder.decode(payload);
        if (!dec) {
          this.emit('undecodable', payload);
          continue;
        }
        for (const prop of dmpProps(dec)) this.onDmp(s, prop);
      }
    }
  }

  onDmp(s, { vector, addr, value }) {
    if (vector === DMP.GET) {
      this.counters.gets += 1;
      const current = this.get(addr);
      if (current) this.sendDmp(s, dmpPdu(DMP.GET_REPLY, addr, current));
      else this.sendDmp(s, dmpPdu(DMP.GET_FAIL, addr, u8(0x02)));
    } else if (vector === DMP.SET) {
      this.counters.sets += 1;
      this.emit('set', { addr, value });
      const applied = this.applySet(addr, value);
      if (applied && applied.fail) {
        this.sendDmp(s, dmpPdu(DMP.SET_FAIL, addr, u8(applied.fail)));
      } else if (applied) {
        this.counters.events += 1;
        this.sendDmp(s, dmpPdu(DMP.EVENT, addr, this.get(addr)));
      }
    }
  }

  // -- senders ------------------------------------------------------------------------------

  send(s, pkt) {
    this.ctlSock?.send(pkt, s.port, s.address, noop);
  }

  sendReliable(s, blocks) {
    const tot = s.totalSeq;
    s.totalSeq = (s.totalSeq + 1) & 0xffff;
    s.relSeq = (s.relSeq + 1) & 0xffff;
    if (s.firstRelSeq === null) s.firstRelSeq = s.relSeq;
    const trailer = s.firstRel ? TRAILER_FIRST_RELIABLE : TRAILER_PLAIN;
    s.firstRel = false;
    this.send(s, buildWrapper(this.cid, s.devChan, tot, s.relSeq, s.firstRelSeq, blocks, true, trailer));
  }

  sendUnreliable(s, blocks) {
    const tot = s.totalSeq;
    s.totalSeq = (s.totalSeq + 1) & 0xffff;
    this.send(s, buildWrapper(this.cid, s.devChan, tot, s.relSeq, s.relSeq, blocks, false, TRAILER_PLAIN));
  }

  sendDmp(s, pdu) {
    const cb = encryptDmp(s.key, s.txNonce, s.txPos, pdu);
    s.txPos += pdu.length;
    const block = Buffer.concat([cb, authTag(s.key, cb)]);
    this.sendReliable(s, [clientBlock(1, PROTO_DMP, s.peerChan, block)]);
  }
}
