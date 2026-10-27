// The cryptographic primitives of Shure's ACN control channel, ported from the
// validated Python reference (ADTQ Mute/engine/ad600_native.py). Every function
// here is pinned to vectors that reference produced — see
// __tests__/crypto.test.js — so a port error is a failing test, not a device
// that silently ignores us.
//
//   skUtil      the session-key derivation: SHA-256, then N rounds of a
//               byte permutation, then SHA-256 again. The 16-byte session key
//               is the first half of the result over
//               ourCid || deviceCid || LE16(ourChan) || LE16(deviceChan).
//   aesCtrAt    AES-128-CTR keystream from an absolute byte position of one
//               continuous stream per direction (8-byte nonce, 64-bit block
//               counter). Both directions keep a running position; a DMP block
//               is encrypted wherever the stream has got to.
//   skip32      Shure's SKIP32 variant — 12 rounds, not the standard 24 —
//               used to turn a CRC32 into the 4-byte tag on each client block.

import { createCipheriv, createHash } from 'node:crypto';

// -- session key -------------------------------------------------------------

const TRI = [
  [0, 0], [1, 0], [1, 1], [2, 0], [2, 1], [2, 2], [3, 0], [3, 1], [3, 2], [3, 3],
];
const CROSS = [
  [0, 3], [4, 7], [8, 11], [12, 15], [2, 1], [6, 5], [10, 9], [14, 13],
];

const sha256 = (buf) => createHash('sha256').update(buf).digest();

/**
 * @param {Buffer|Uint8Array} blob
 * @returns {Buffer} 32 bytes; the session key is the first 16
 */
export function skUtil(blob) {
  const h = sha256(Buffer.from(blob));
  let state = Buffer.from(h);
  const v = (h[30] << 8) | h[31];
  const rounds = ((v ^ 2) % 7) + 10;
  for (let i = 1; i <= rounds; i += 1) {
    const P = Buffer.from(state.subarray(0, 16));
    const Q = Buffer.from(state.subarray(16, 32));
    const p = [0, 1, 2, 3].map((t) => (i + t) & 3);
    for (const [row, col] of TRI) {
      const a = 4 * row + col;
      const b = 4 * p[col] + p[row];
      [P[a], P[b]] = [P[b], P[a]];
    }
    for (const [row, col] of TRI) {
      const a = 4 * row + col;
      const b = 4 * p[col] + p[row];
      [Q[a], Q[b]] = [Q[b], Q[a]];
    }
    for (const [pi, qi] of CROSS) {
      [P[pi], Q[qi]] = [Q[qi], P[pi]];
    }
    P.copy(state, 0);
    Q.copy(state, 16);
    const rot = Buffer.alloc(32);
    for (let k = 0; k < 32; k += 1) rot[k] = state[(k + i) % 32];
    const next = Buffer.alloc(32);
    for (let k = 0; k < 32; k += 1) next[k] = state[k] ^ rot[k];
    state = next;
  }
  return sha256(state);
}

/** The 16-byte session key both sides derive from the on-wire join values. */
export function sessionKey(ourCid, deviceCid, ourChan, deviceChan) {
  const blob = Buffer.alloc(36);
  Buffer.from(ourCid).copy(blob, 0);
  Buffer.from(deviceCid).copy(blob, 16);
  blob.writeUInt16LE(ourChan & 0xffff, 32);
  blob.writeUInt16LE(deviceChan & 0xffff, 34);
  return skUtil(blob).subarray(0, 16);
}

// -- AES-128-CTR on a continuous stream ---------------------------------------

/** One AES-128 block encryption; the CTR keystream is built from these. */
function aesBlock(key, block16) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block16), cipher.final()]);
}

const counterBlock = (nonce8, blockIndex) => {
  const ctr = Buffer.alloc(16);
  Buffer.from(nonce8).copy(ctr, 0, 0, 8);
  ctr.writeBigUInt64BE(BigInt(blockIndex) & 0xffffffffffffffffn, 8);
  return ctr;
};

/**
 * XOR `data` with the keystream starting at absolute byte `pos` of the
 * (key, nonce) stream. Encrypt and decrypt are the same operation.
 */
export function aesCtrAt(key, nonce8, pos, data) {
  const out = Buffer.alloc(data.length);
  let block = Math.floor(pos / 16);
  let offset = pos % 16;
  let produced = 0;
  while (produced < data.length) {
    const ks = aesBlock(key, counterBlock(nonce8, block));
    for (let i = offset; i < 16 && produced < data.length; i += 1) {
      out[produced] = data[produced] ^ ks[i];
      produced += 1;
    }
    block += 1;
    offset = 0;
  }
  return out;
}

/**
 * A growable keystream cache for one (key, nonce), for the position search in
 * pdu.js's findCtrPos: decoding a device block whose stream position we have
 * lost means trying a window of positions, and recomputing AES for each would
 * be wasteful.
 */
export class Keystream {
  constructor(key, nonce8) {
    this.key = Buffer.from(key);
    this.nonce = Buffer.from(nonce8);
    this.buf = Buffer.alloc(0);
  }

  ensure(length) {
    if (this.buf.length >= length) return this.buf;
    const chunks = [this.buf];
    let block = this.buf.length / 16;
    let have = this.buf.length;
    while (have < length) {
      chunks.push(aesBlock(this.key, counterBlock(this.nonce, block)));
      block += 1;
      have += 16;
    }
    this.buf = Buffer.concat(chunks);
    return this.buf;
  }

  xorAt(pos, data) {
    const ks = this.ensure(pos + data.length);
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = data[i] ^ ks[pos + i];
    return out;
  }
}

// -- CRC32 + SKIP32 auth tag ---------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (zlib.crc32), as an unsigned 32-bit integer. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const FTABLE = Buffer.from(
    'a3d70983f848f6f4b321157899b1aff9e72d4d8ace4cca2e5295d91e4e384428' +
    '0adf02a017f1606812b77ac3e9fa3d5396846bbaf2639a197caee5f5f7166aa2' +
    '39b67b0fc193811beeb41aead0912fb855b9da853f41bfe05a58805f660bd890' +
    '35d5c0a733066569450094566d989b7697fcb2c2b0fedb20e1ebd6e4dd474a1d' +
    '42ed9e6e493ccd4327d207d4dec7671889cb301f8dc68faac874dcc95d5c31a4' +
    '7088612c9f0d2b8750825464267d0340344b1c73d1c4fd3bccfb7fabe63e5ba5' +
    'ad04239c145122f02979717eff8c0ee20cefbc72756f37a1ecd38e628b8610e8' +
    '087711be924f24c532369dcff3a6bbac5e6ca9135725b5e3bda83a0105592a46',
  'hex'
);

function g(key10, k, w) {
  const g1 = (w >> 8) & 0xff;
  const g2 = w & 0xff;
  const g3 = FTABLE[g2 ^ key10[(4 * k) % 10]] ^ g1;
  const g4 = FTABLE[g3 ^ key10[(4 * k + 1) % 10]] ^ g2;
  const g5 = FTABLE[g4 ^ key10[(4 * k + 2) % 10]] ^ g3;
  const g6 = FTABLE[g5 ^ key10[(4 * k + 3) % 10]] ^ g4;
  return ((g5 << 8) | g6) & 0xffff;
}

/**
 * Shure's SKIP32: 12 rounds (six Feistel pairs), big-endian halves. The
 * device's tag is the encryption of the block's CRC32.
 */
export function skip32(key10, block32, encrypt = true) {
  let k = encrypt ? 0 : 23;
  const step = encrypt ? 1 : -1;
  let wl = (block32 >>> 16) & 0xffff;
  let wr = block32 & 0xffff;
  for (let i = 0; i < 6; i += 1) {
    wr = (wr ^ g(key10, k, wl) ^ k) & 0xffff;
    k += step;
    wl = (wl ^ g(key10, k, wr) ^ k) & 0xffff;
    k += step;
  }
  return (((wr << 16) | wl) >>> 0);
}

/** The 4-byte tag appended to every encrypted client block. */
export function authTag(key16, message) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32BE(skip32(Buffer.from(key16).subarray(0, 10), crc32(message), true), 0);
  return tag;
}
