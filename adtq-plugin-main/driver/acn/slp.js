// SLP (RFC 2608) as the Shure ACN devices use it: how the ADTQ is found on the
// network, and how a controller announces itself before joining.
//
// Two facts that cost the reference tool real time and are easy to get wrong:
//
//   - The service type is `service:esta.dmp`. `esta.sdt` is only the transport
//     URL inside the attribute list; a request for it returns nothing.
//   - The devices answer on UDP/8427. An ADTQ and an ADTD on 2026-10-26 sent
//     their replies to the multicast group itself (239.255.254.253:8427), so
//     every socket that has joined the group on the right interface hears
//     them, whoever else holds the port (SoundBase does, for its own Shure
//     support). What matters is the interface: a request that leaves by the
//     default route and a membership on that interface alone miss a unit on a
//     second adapter, so the browse asks and listens on every interface.
//   - The ADTQ answers a request sent to the multicast group and ignores the
//     same request unicast to its own address. Looking one unit up therefore
//     still asks the group (and the unit, for fakes on loopback) and picks
//     the wanted reply out of whatever the segment sends back. Verified on
//     "ADTQ G57 NACLOCK": three seconds of unicast, nothing; the group
//     request, answered in 100 ms.
//
// A reply carries everything a session needs:
//
//   (cid=DD2D453E-0000-11DD-A000-000EDDCCCCCC),(acn-fctn=ADTQ),
//   (acn-uacn=ADTQ G57 NACLOCK),(csl-esta.dmp=esta.sdt/10.10.1.175:57383;…)
//
// The CID is mandatory: a JOIN addressed to a CID the device does not own is
// discarded with no reply of any kind.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { localAddresses, localIpToward } from '../netutil.js';

export const SLP_PORT = 8427;
export const SLP_GROUP = '239.255.254.253';
export const SLP_SERVICE = 'service:esta.dmp';

// Shure derives a device's ACN CID from its MAC address:
// 00:0e:dd:2d:45:3e -> DD2D453E-0000-11DD-A000-000EDDCCCCCC
export const SHURE_CID_TAIL = '000011dda000000eddcccccc';

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const lenPrefixed = (b) => Buffer.concat([u16(b.length), b]);
const u24 = (n) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

/** An SLPv2 Service Request for `service` in the DEFAULT scope. */
export function buildSrvRqst(service = SLP_SERVICE, xid = 1) {
  const body = Buffer.concat([
    Buffer.from([0, 0]), // flags
    Buffer.from([0, 0, 0]), // extension offset
    u16(xid),
    lenPrefixed(Buffer.from('en')),
    lenPrefixed(Buffer.alloc(0)), // previous responders
    lenPrefixed(Buffer.from(service)),
    lenPrefixed(Buffer.from('DEFAULT')),
    lenPrefixed(Buffer.alloc(0)), // predicate
  ]);
  return Buffer.concat([Buffer.from([0x02, 0x01]), u24(2 + 3 + body.length), body]);
}

export const isSrvRqst = (pkt) => pkt.length > 5 && pkt[0] === 0x02 && pkt[1] === 0x01;

/** `DD2D453E-0000-11DD-A000-000EDDCCCCCC` from 16 CID bytes. */
export function cidToString(cid) {
  const h = Buffer.from(cid).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

/** 16 CID bytes from any hex spelling, or null. */
export function cidFromString(text) {
  if (typeof text !== 'string') return null;
  const h = text.replace(/[-:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) return null;
  return Buffer.from(h, 'hex');
}

/** The CID a Shure device with this MAC advertises (last-resort derivation). */
export function cidFromMac(mac) {
  const m = String(mac).match(/([0-9a-f]{1,2})(?::([0-9a-f]{1,2})){5}/i);
  if (!m) return null;
  const octets = m[0].split(':').map((x) => parseInt(x, 16));
  return Buffer.from(
    octets.slice(2, 6).map((o) => o.toString(16).padStart(2, '0')).join('') + SHURE_CID_TAIL,
    'hex'
  );
}

/**
 * The component advert Wireless Workbench multicasts before joining. The
 * device builds its table of known controllers from these and only fully
 * serves the ones it recognises. Byte-exact with the reference.
 */
export function buildAdvert({ cid, ip, port }) {
  const attrs =
    `(cid=${cidToString(cid)}),(acn-fctn=WWB6),(acn-uacn=WWB 6X),(acn-services=esta.dmp),` +
    `(csl-esta.dmp=esta.sdt/${ip}:${port};esta.dmp/cd:CCDA8E0A-E139-11DF-8C7A-0015C5F3F612),` +
    `(device-description=$:tftp://${ip}/$.ddl),` +
    `(csl-esta.dmp.values=version:1_interfaceId:1_extVersion:1)`;
  const ab = Buffer.from(attrs, 'latin1');
  const after = Buffer.concat([
    Buffer.from([0, 0]),
    Buffer.from([0, 0, 0]),
    Buffer.from([0x22, 0x3d]),
    Buffer.from([0, 2]),
    Buffer.from('en'),
    Buffer.from([0, 0]),
    u16(ab.length),
    ab,
    Buffer.from([0]),
  ]);
  return Buffer.concat([Buffer.from([0x02, 0x07]), u24(2 + 3 + after.length), after]);
}

/**
 * A device's SLP reply (or an attribute list in the same format) as a
 * `{ ip, port, cid, cidText, fctn, uacn }` record, or null when it names no
 * esta.sdt endpoint.
 */
export function parseSlpReply(pkt) {
  const text = Buffer.from(pkt).toString('latin1');
  const m = /esta\.sdt\/(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/.exec(text);
  if (!m) return null;
  const cidMatch = /\(cid=([0-9A-Fa-f-]{32,40})\)/.exec(text);
  const cid = cidMatch ? cidFromString(cidMatch[1]) : null;
  return {
    ip: m[1],
    port: Number(m[2]),
    cid,
    cidText: cid ? cidToString(cid) : null,
    // a value may itself contain a ')' ("ADTQ (stage left)"); an attribute
    // ends at the ')' that is followed by the next attribute or the end
    fctn: /\(acn-fctn=(.*?)\)(?=,\(|\x00|$)/s.exec(text)?.[1] ?? null,
    uacn: /\(acn-uacn=(.*?)\)(?=,\(|\x00|$)/s.exec(text)?.[1] ?? null,
  };
}

// A Shure band code: `A`, `B`, `G57`, `K54`, `G50`, `G10`, `J50A`, `G57+`.
const BAND = /^[A-Z](\d{1,2}[A-Z+]?)?$/;

/**
 * What a unit's `acn-uacn` says it is. ACN calls the attribute a user-assigned
 * name, but nobody assigns it on Shure hardware: the unit fills it with its
 * model, its band and sometimes a variant tag that Wireless Workbench shows
 * nowhere. Every unit heard on one segment (2026-10-07):
 *
 *   ADTQ G57 NACLOCK   ADTD K54 NACLOCK   ULXD4Q G50 REV5   ULXD4D G50 REV2
 *   AD4Q A             AD4D B             P10T G10          AD600   AD610
 *
 * The band is worth showing and the variant tag is not, so `label` is the
 * model and band alone. A string with no band in second place is not in this
 * form and is passed through whole.
 *
 * @param {string|null|undefined} uacn
 * @returns {{ label: string|null, band: string|null }}
 */
export function describeUacn(uacn) {
  const text = typeof uacn === 'string' ? uacn.trim() : '';
  const [model, second] = text.split(/\s+/);
  if (model && second && BAND.test(second)) return { label: `${model} ${second}`, band: second };
  return { label: text || null, band: null };
}

/** A device's reply: `(cid=…),(acn-fctn=…),…` framed as an SLP SrvRply. */
export function buildDeviceAdvert({ cid, fctn, uacn, ip, port }) {
  const attrs =
    `(cid=${cidToString(cid)}),(acn-fctn=${fctn}),(acn-uacn=${uacn}),(acn-services=esta.dmp),` +
    `(csl-esta.dmp=esta.sdt/${ip}:${port};esta.dmp/cd:05B2AB78-FD5A-11E3-B473-0015C5F3F612),` +
    `(device-description=$:tftp://${ip}/$.ddl),` +
    `(csl-esta.dmp.values=version:1_interfaceId:1_extVersion:1)`;
  const ab = Buffer.from(attrs, 'latin1');
  const body = Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 0, 1]),
    lenPrefixed(Buffer.from('en')),
    Buffer.from([0, 0]),
    u16(ab.length),
    ab,
    Buffer.from([0]),
  ]);
  return Buffer.concat([Buffer.from([0x02, 0x02]), u24(2 + 3 + body.length), body]);
}

const bindSocket = (port, options = {}) =>
  new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.once('error', reject);
    sock.bind(port, options.address, () => {
      sock.removeListener('error', reject);
      resolve(sock);
    });
  });

/**
 * Opens the sockets discovery listens on: the well-known SLP port when it can
 * be had, always an ephemeral one. Both join the multicast group on every
 * interface in `localIps` (best effort; no network is a normal case).
 */
async function openSlpSockets({ port, localIps, multicast, log }) {
  const socks = [];
  try {
    socks.push(await bindSocket(port));
  } catch (err) {
    log?.('debug', `could not bind :${port} (${err.message}); replies on it will be missed`);
  }
  socks.push(await bindSocket(0));
  for (const sock of socks) {
    try {
      sock.setMulticastTTL(4);
    } catch {
      // not a multicast-capable socket; nothing to set
    }
    if (!multicast) continue;
    for (const localIp of localIps) {
      try {
        sock.addMembership(SLP_GROUP, localIp);
      } catch (err) {
        log?.('debug', `multicast membership failed on ${localIp}: ${err.message}`);
      }
    }
  }
  return socks;
}

/**
 * Asks the wire for `service:esta.dmp` agents and collects the replies.
 *
 * @param {object} options
 * @param {string[]} [options.targets] addresses to ask directly (unicast)
 * @param {boolean} [options.multicast=true] also ask the whole segment
 * @param {number} [options.port=8427] the SLP port the devices listen on
 * @param {number} [options.timeoutMs=1500]
 * @param {string} [options.localIp] the one interface to ask on; every interface when absent
 * @param {boolean} [options.stopWhenTargetsAnswer] resolve as soon as every
 *   target has answered instead of waiting out the timeout; defaults to true
 *   for a unicast-only ask and false for a browse, which wants the whole segment
 * @param {(level: string, msg: string) => void} [options.log]
 * @returns {Promise<Array<ReturnType<typeof parseSlpReply> & { from: string }>>}
 */
export async function slpDiscover({
  targets = [],
  multicast = true,
  port = SLP_PORT,
  timeoutMs = 1500,
  localIp,
  stopWhenTargetsAnswer = !multicast,
  log,
} = {}) {
  // the interface a target lives on, plus every other one: a unit on a second adapter answers there
  const localIps = localIp ? [localIp] : [...new Set([localIpToward(targets[0] ?? SLP_GROUP), ...localAddresses()].filter(Boolean))];
  const socks = await openSlpSockets({ port, localIps, multicast, log });
  const found = new Map();
  const rqst = buildSrvRqst();
  const destinations = [];
  if (multicast) destinations.push(SLP_GROUP);
  for (const t of targets) if (!destinations.includes(t)) destinations.push(t);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of socks) {
        try {
          s.close();
        } catch {
          // already closed
        }
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);
    for (const s of socks) {
      s.on('message', (msg, rinfo) => {
        const reply = parseSlpReply(msg);
        if (!reply) return;
        const key = reply.cidText ?? `${reply.ip}:${reply.port}`;
        if (!found.has(key)) found.set(key, { ...reply, from: rinfo.address });
        // every direct target has answered: no need to wait out the timer
        if (
          stopWhenTargetsAnswer &&
          targets.length &&
          targets.every((t) => [...found.values()].some((f) => f.from === t || f.ip === t))
        )
          finish();
      });
      s.on('error', () => {});
      for (const dst of destinations) {
        if (dst !== SLP_GROUP) {
          s.send(rqst, port, dst, () => {});
          continue;
        }
        // the group request goes out of every interface, not only the default route's
        for (const localIp of localIps) {
          try {
            s.setMulticastInterface(localIp);
          } catch {
            // an interface that will not send multicast is skipped
          }
          s.send(rqst, port, dst, () => {});
        }
      }
    }
  });
}

/**
 * A standing SLP browse: asks the segment every `intervalMs`, keeps a table
 * of who answered and when, and forgets anyone silent for `expireMs`. The
 * adapter's discoverDevices reads the table and returns at once, which is
 * what a once-a-second poll from the shell needs.
 */
export class SlpBrowser extends EventEmitter {
  constructor({ targets = [], multicast = true, port = SLP_PORT, intervalMs = 3000, expireMs = 15000, timeoutMs = 1200, log, filter } = {}) {
    super();
    this.targets = targets;
    this.multicast = multicast;
    this.port = port;
    this.intervalMs = intervalMs;
    this.expireMs = expireMs;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.filter = filter ?? (() => true);
    this.table = new Map();
    this.timer = null;
    this.inFlight = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setTargets(targets) {
    this.targets = [...targets];
  }

  tick() {
    if (this.inFlight || !this.running) return;
    this.inFlight = slpDiscover({
      targets: this.targets,
      multicast: this.multicast,
      port: this.port,
      timeoutMs: this.timeoutMs,
      log: this.log,
    })
      .then((replies) => {
        const now = Date.now();
        for (const reply of replies) {
          if (!this.filter(reply)) continue;
          const key = reply.cidText ?? `${reply.ip}:${reply.port}`;
          const known = this.table.get(key);
          this.table.set(key, { ...reply, lastSeen: now, firstSeen: known?.firstSeen ?? now });
          if (!known) this.emit('found', reply);
        }
        for (const [key, entry] of this.table) {
          if (now - entry.lastSeen > this.expireMs) {
            this.table.delete(key);
            this.emit('lost', entry);
          }
        }
      })
      .catch((err) => this.log?.('warn', `SLP browse failed: ${err?.message || err}`))
      .finally(() => {
        this.inFlight = null;
      });
  }

  /** Everyone heard from within the expiry window. */
  devices() {
    return [...this.table.values()];
  }
}
