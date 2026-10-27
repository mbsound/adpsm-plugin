// ANSI E1.17 (ACN) PDU codec, the SDT session PDUs and the DMP property PDUs
// the ADTQ speaks, ported from the validated Python reference
// (ADTQ Mute/engine/ad600_native.py). Byte-for-byte parity with that reference
// is pinned by __tests__/pdu.test.js.
//
// Layout of everything on the wire:
//
//   root layer   00 10 00 00 "ASC-E1.17" 00 00 00  [PDU vector=1 (SDT) cid=16 …]
//   SDT PDU      [flags|len (12-bit)] [vector 1B] [data]
//   client block [flags|len] [mid 2B] [protocol 4B] [assoc 2B] [payload]
//   DMP PDU      [flags|len] [vector 1B] [addr header 0x02] [addr 4B BE] [value…]

import { Keystream, aesCtrAt } from './crypto.js';

export const ROOT_PREAMBLE = Buffer.concat([
  Buffer.from([0x00, 0x10, 0x00, 0x00]),
  Buffer.from('ASC-E1.17\x00\x00\x00', 'latin1'),
]);
export const VECTOR_ROOT_SDT = 1;
export const PROTO_SDT = 1;
export const PROTO_DMP = 0x102;

export const SDT_VEC = {
  REL_WRAP: 1,
  UNREL_WRAP: 2,
  CHAN_PARAMS: 3,
  JOIN: 4,
  JOIN_REFUSE: 5,
  JOIN_ACCEPT: 6,
  LEAVING: 7,
  NAK: 8,
  GET_SESSIONS: 9,
  SESSIONS: 10,
  ACK: 11,
};
export const SDT_VEC_NAME = Object.fromEntries(
  Object.entries(SDT_VEC).map(([name, vec]) => [vec, name])
);

export const JOIN_REFUSE_REASON = {
  1: 'NONSPECIFIC',
  2: 'ILLEGAL_PARAMS',
  3: 'LOW_RESOURCES',
  4: 'ALREADY_MEMBER',
  5: 'BAD_ADDR',
  6: 'NO_RECIPROCAL',
  7: 'CHANNEL_EXPIRED',
  8: 'LOST_SEQUENCE',
};

// DMP SET_FAIL / GET_FAIL reason byte (ANSI E1.17 DMP, table of failure codes)
export const DMP_FAIL_REASON = {
  1: 'NONSPECIFIC',
  2: 'NOT_A_PROPERTY',
  3: 'WRITE_ONLY',
  4: 'NOT_WRITABLE',
  5: 'DATA_ERROR',
  6: 'MAPS_NOT_SUPPORTED',
  7: 'SPACE_NOT_AVAILABLE',
  8: 'PROP_NOT_MAPPED',
  9: 'MAP_NOT_ALLOCATED',
  10: 'SUBSCRIPTION_NOT_SUPPORTED',
  11: 'NO_SUBSCRIPTIONS_SUPPORTED',
};

// DMP vectors (ANSI E1.17 standard codes)
export const DMP = {
  GET: 1,
  SET: 2,
  GET_REPLY: 3,
  EVENT: 4,
  SUBSCRIBE: 7,
  GET_FAIL: 9,
  SET_FAIL: 10,
  SUB_ACCEPT: 12,
  SUB_REJECT: 13,
};
export const DMP_ADDR_HDR = 0x02; // one absolute 4-byte address

// session-management vectors inside a proto-1 client block
export const MGMT = {
  DECLARE: 0x09, // 70 07 09 00000102 — "I speak protocol 0x102"
  ASSOCIATE: 0x0a, // 70 07 0a 00000102 — "accepted"
  DISASSOCIATE: 0x0c,
  ACK: 0x0e, // 70 07 0e 0000xxxx — cumulative reliable ack
};

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff, 0);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
export { u16, u32 };

// -- generic PDU ---------------------------------------------------------------

/** One ACN PDU with the V|H|D flags set and a 2-octet, 12-bit length. */
export function pduEncode(vector, header, data, vecSize = 1) {
  const parts = [];
  if (vector !== null && vector !== undefined) {
    const v = Buffer.alloc(vecSize);
    v.writeUIntBE(vector, 0, vecSize);
    parts.push(v);
  }
  if (header) parts.push(Buffer.from(header));
  if (data) parts.push(Buffer.from(data));
  const body = Buffer.concat(parts);
  const total = 2 + body.length;
  if (total > 0x0fff) throw new Error('PDU too long for a 12-bit length');
  return Buffer.concat([Buffer.from([0x70 | (total >> 8), total & 0xff]), body]);
}

/**
 * Reads the PDU header at `i`. Returns `{ flags, dataStart, end }` or null
 * when the bytes do not describe a PDU that fits inside `b`.
 */
export function pduDecode(b, i) {
  if (i + 2 > b.length) return null;
  const flags = b[i] >> 4;
  let len;
  let dataStart;
  if (flags & 0x8) {
    if (i + 3 > b.length) return null;
    len = ((b[i] & 0x0f) << 16) | (b[i + 1] << 8) | b[i + 2];
    dataStart = i + 3;
  } else {
    len = ((b[i] & 0x0f) << 8) | b[i + 1];
    dataStart = i + 2;
  }
  if (len < dataStart - i || i + len > b.length) return null;
  return { flags, dataStart, end: i + len };
}

// -- root layer ----------------------------------------------------------------

export function rootWrap(srcCid, sdtPdu) {
  const inner = Buffer.concat([u32(VECTOR_ROOT_SDT), Buffer.from(srcCid), sdtPdu]);
  const total = 2 + inner.length;
  return Buffer.concat([
    ROOT_PREAMBLE,
    Buffer.from([0x70 | (total >> 8), total & 0xff]),
    inner,
  ]);
}

/** `{ cid, sdt }` — the sender's CID and the SDT block — or null. */
export function rootParse(pkt) {
  if (pkt.length < 18 || pkt.subarray(4, 13).toString('latin1') !== 'ASC-E1.17')
    return null;
  const r = pduDecode(pkt, 16);
  if (!r) return null;
  const { dataStart, end } = r;
  if (end - dataStart < 20) return null;
  return {
    cid: Buffer.from(pkt.subarray(dataStart + 4, dataStart + 20)),
    sdt: Buffer.from(pkt.subarray(dataStart + 20, end)),
  };
}

/** Every `{ vector, data }` SDT PDU in an SDT block, in order. */
export function sdtPdus(sdt) {
  const out = [];
  let off = 0;
  while (off < sdt.length) {
    const r = pduDecode(sdt, off);
    if (!r) break;
    out.push({
      vector: sdt[r.dataStart],
      data: Buffer.from(sdt.subarray(r.dataStart + 1, r.end)),
    });
    off = r.end;
  }
  return out;
}

// -- SDT session PDUs ------------------------------------------------------------

// channel parameters, verbatim from the Wireless Workbench template
const JOIN_PARAMS = Buffer.from([0x00, 0x05, 0x00, 0x00, 0x02, 0x00, 0x32, 0x00, 0x14, 0xff]);

/**
 * JOIN: the leader (`srcCid`) invites `memberCid` onto channel `chan`. The
 * reliable sequence base is advertised as `chan` itself, so the first
 * reliable wrapper is expected at chan+1 — Workbench's scheme, which the
 * device's NAK logic assumes.
 */
export function buildJoin(srcCid, memberCid, chan, mid = 1) {
  const seq = chan & 0xffff;
  const data = Buffer.concat([
    Buffer.from(memberCid),
    u16(mid),
    u16(chan),
    Buffer.from([0, 0]),
    u32(seq),
    u32(seq),
    JOIN_PARAMS,
  ]);
  return rootWrap(srcCid, pduEncode(SDT_VEC.JOIN, null, data, 1));
}

/** Fields of a JOIN's data, as the device sends it to us reciprocally. */
export function parseJoin(data) {
  if (data.length < 30) return null;
  return {
    memberCid: Buffer.from(data.subarray(0, 16)),
    mid: data.readUInt16BE(16),
    chan: data.readUInt16BE(18),
    relSeq: data.readUInt32BE(26) & 0xffff,
  };
}

export function buildJoinAccept(srcCid, leaderCid, leaderChan, relSeq, recipChan, mid = 1) {
  const data = Buffer.concat([
    Buffer.from(leaderCid),
    u16(leaderChan),
    u16(mid),
    Buffer.from([0, 0]),
    u16(relSeq),
    u16(recipChan),
  ]);
  return rootWrap(srcCid, pduEncode(SDT_VEC.JOIN_ACCEPT, null, data, 1));
}

/** The reciprocal channel number a JOIN_ACCEPT carries (its last two bytes). */
export function parseJoinAccept(data) {
  if (data.length < 24) return null;
  return {
    leaderCid: Buffer.from(data.subarray(0, 16)),
    leaderChan: data.readUInt16BE(16),
    relSeq: data.readUInt16BE(22),
    recipChan: data.readUInt16BE(data.length - 2),
  };
}

export function buildJoinRefuse(srcCid, leaderCid, leaderChan, reason, mid = 1) {
  const data = Buffer.concat([
    Buffer.from(leaderCid),
    u16(leaderChan),
    u16(mid),
    Buffer.from([reason & 0xff]),
  ]);
  return rootWrap(srcCid, pduEncode(SDT_VEC.JOIN_REFUSE, null, data, 1));
}

export function clientBlock(mid, proto, assoc, payload) {
  const body = Buffer.concat([u16(mid), u32(proto), u16(assoc), Buffer.from(payload)]);
  const total = 2 + body.length;
  return Buffer.concat([Buffer.from([0x70 | (total >> 8), total & 0xff]), body]);
}

export const TRAILER_FIRST_RELIABLE = Buffer.from([0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);
export const TRAILER_PLAIN = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);

export function buildWrapper(srcCid, chan, total, rel, oldest, blocks, reliable = true, trailer = TRAILER_PLAIN) {
  const hdr = Buffer.concat([u16(chan), u32(total), u32(rel), u32(oldest), trailer]);
  const vec = reliable ? SDT_VEC.REL_WRAP : SDT_VEC.UNREL_WRAP;
  return rootWrap(srcCid, pduEncode(vec, null, Buffer.concat([hdr, ...blocks]), 1));
}

/**
 * `{ chan, total, rel, oldest, blocks: [{ proto, payload }] }` of a wrapper's
 * data, or null. A block's `proto` is null when its header is inherited.
 */
export function parseWrapper(vdata) {
  if (vdata.length < 20) return null;
  const chan = vdata.readUInt16BE(0);
  const total = vdata.readUInt32BE(2);
  const rel = vdata.readUInt32BE(6);
  const oldest = vdata.readUInt32BE(10);
  const cb = vdata.subarray(20);
  const blocks = [];
  let j = 0;
  while (j < cb.length) {
    const r = pduDecode(cb, j);
    if (!r) break;
    const body = cb.subarray(r.dataStart, r.end);
    let q = r.flags & 0x4 ? 2 : 0;
    let proto = null;
    if (r.flags & 0x2 && body.length >= q + 6) {
      proto = body.readUInt32BE(q);
      q += 6;
    }
    blocks.push({ proto, payload: Buffer.from(body.subarray(q)) });
    j = r.end;
  }
  return { chan, total, rel, oldest, blocks };
}

export const mgmtAck = (seq) => pduEncode(MGMT.ACK, null, u32(seq), 1);
export const mgmtDeclare = () => pduEncode(MGMT.DECLARE, null, u32(PROTO_DMP), 1);
export const mgmtAssociate = () => pduEncode(MGMT.ASSOCIATE, null, u32(PROTO_DMP), 1);
export const mgmtDisassociate = () => pduEncode(MGMT.DISASSOCIATE, null, u32(PROTO_DMP), 1);
export const sdtLeaving = () => pduEncode(SDT_VEC.LEAVING, null, Buffer.alloc(0), 1);

// the root-layer leave Workbench sends after LEAVING; the tail is verbatim
const LEAVE_TAIL = Buffer.from('b2b000010001207a06', 'hex');
export const rootLeave = (srcCid, deviceCid) =>
  rootWrap(srcCid, pduEncode(SDT_VEC.NAK, null, Buffer.concat([Buffer.from(deviceCid), LEAVE_TAIL]), 1));

/** Which management PDU a proto-1 block carries, if any. */
export function parseMgmt(payload) {
  if (payload.length < 3 || payload[0] !== 0x70) return null;
  const vec = payload[2];
  if (vec === MGMT.ACK && payload.length >= 7)
    return { vec, seq: payload.readUInt16BE(payload.length - 2) };
  if ((vec === MGMT.DECLARE || vec === MGMT.ASSOCIATE || vec === MGMT.DISASSOCIATE) && payload.length >= 7)
    return { vec, proto: payload.readUInt32BE(3) };
  return { vec };
}

// -- DMP -------------------------------------------------------------------------

/** One DMP PDU: vector, the 4-byte absolute address header, address, value. */
export function dmpPdu(vector, addr, value = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from([vector, DMP_ADDR_HDR]), u32(addr), Buffer.from(value)]);
  let total = 2 + body.length;
  if (total <= 0x0fff) {
    return Buffer.concat([Buffer.from([0x70 | (total >> 8), total & 0xff]), body]);
  }
  total = 3 + body.length;
  return Buffer.concat([
    Buffer.from([0xf0 | (total >> 16), (total >> 8) & 0xff, total & 0xff]),
    body,
  ]);
}

/**
 * Every `{ vector, addr, value }` in a decrypted DMP block whose PDU carries
 * an absolute address. Other PDUs (string-addressed, tags) are skipped.
 */
export function dmpProps(dec) {
  const out = [];
  let i = 0;
  while (i < dec.length) {
    const r = pduDecode(dec, i);
    if (!r) break;
    const { dataStart, end } = r;
    i = end;
    if (end - dataStart < 6) continue;
    if (dec[dataStart + 1] !== DMP_ADDR_HDR) continue;
    out.push({
      vector: dec[dataStart],
      addr: dec.readUInt32BE(dataStart + 2),
      value: Buffer.from(dec.subarray(dataStart + 6, end)),
    });
  }
  return out;
}

const DMP_VECS = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13]);

/**
 * True when `pt` begins with a well-formed DMP PDU that fits in `exactLen`
 * bytes. This is the discriminator the stream-position search relies on.
 */
export function validDmpHead(pt, exactLen) {
  if (!pt || !pt.length) return false;
  const flags = pt[0] >> 4;
  if (flags !== 0x7 && flags !== 0xf) return false;
  const r = pduDecode(pt, 0);
  if (!r) return false;
  const { dataStart, end } = r;
  if (end < dataStart + 2) return false;
  if (exactLen !== undefined && end > exactLen) return false;
  const v = pt[dataStart];
  if (!DMP_VECS.has(v)) return false;
  const hdr = pt[dataStart + 1];
  if (hdr !== 0x02 && hdr !== 0x07 && v !== 9 && v !== 10 && v !== 13) return false;
  return true;
}

/**
 * Finds where in the (key, nonce) stream `ct` was encrypted, searching a
 * window around `hint`. Returns `{ pos, pt }` or null. Robust to drift from
 * device blocks we never saw (retransmits, lost datagrams).
 */
export function findCtrPos(keystream, ct, hint, back = 64, fwd = 2048) {
  const lo = Math.max(0, hint - back);
  keystream.ensure(Math.max(hint + fwd, hint + ct.length) + ct.length + 16);
  const order = [hint];
  for (let p = lo; p < hint + fwd; p += 1) if (p !== hint) order.push(p);
  for (const p of order) {
    const pt = keystream.xorAt(p, ct);
    if (validDmpHead(pt, ct.length)) return { pos: p, pt };
  }
  return null;
}

/**
 * Encrypts one DMP PDU as a proto-0x102 client-block payload at stream
 * position `pos`: `01 01 <len> <nonce8> <ctr8> <ciphertext> <tag4>`. The
 * on-wire counter is ceil(pos/16) while the keystream is taken from floor —
 * exactly what Workbench does, and what the device expects.
 */
export function encryptDmp(key, nonce8, pos, pdu) {
  const ct = aesCtrAt(key, nonce8, pos, pdu);
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor((pos + 15) / 16)), 0);
  const cb = Buffer.concat([Buffer.from([0x01, 0x01]), u16(16 + pdu.length), Buffer.from(nonce8), ctr, ct]);
  return cb;
}

/** `{ nonce, ct }` of an encrypted DMP payload, or null. */
export function splitEncryptedDmp(payload) {
  if (payload.length < 20 || payload[0] !== 0x01) return null;
  const len = payload.readUInt16BE(2);
  const nonce = Buffer.from(payload.subarray(4, 12));
  const ct = Buffer.from(payload.subarray(20, 4 + len));
  if (!ct.length) return null;
  return { nonce, ct };
}

/**
 * One direction of the DMP stream as a receiver sees it: a continuous
 * position that self-heals when a device block goes missing.
 */
export class DmpDecoder {
  constructor(key) {
    this.key = Buffer.from(key);
    this.pos = 0;
    this.streams = new Map(); // nonce hex -> Keystream
    this.seen = new Map(); // ct hex -> pos (retransmit-safe)
  }

  keystream(nonce) {
    const id = nonce.toString('hex');
    let ks = this.streams.get(id);
    if (!ks) {
      ks = new Keystream(this.key, nonce);
      this.streams.set(id, ks);
    }
    return ks;
  }

  /** The decrypted block, or null when no position in the window decodes it. */
  decode(payload) {
    const split = splitEncryptedDmp(payload);
    if (!split) return null;
    const { nonce, ct } = split;
    const ks = this.keystream(nonce);
    const ctId = ct.toString('hex');
    let pos;
    let pt;
    if (this.seen.has(ctId)) {
      pos = this.seen.get(ctId);
      pt = ks.xorAt(pos, ct);
    } else {
      pos = this.pos;
      pt = ks.xorAt(pos, ct);
      if (!validDmpHead(pt, ct.length)) {
        const found = findCtrPos(ks, ct, this.pos);
        if (found) ({ pos, pt } = found);
      }
      if (pt && validDmpHead(pt, ct.length)) {
        this.seen.set(ctId, pos);
        this.pos = Math.max(this.pos, pos + ct.length);
      }
    }
    if (pt && (validDmpHead(pt, ct.length) || pt[0] === 0x70)) return pt;
    return null;
  }
}
