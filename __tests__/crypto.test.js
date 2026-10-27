// The crypto primitives against vectors the Python reference produced
// (__tests__/fixtures/acn-vectors.json, generated from ADTQ Mute/engine).
// Any drift here would mean a session key the device does not share, and the
// symptom of that is total silence — no error, no reply, nothing to debug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Keystream,
  aesCtrAt,
  authTag,
  crc32,
  sessionKey,
  skUtil,
  skip32,
} from '../driver/acn/crypto.js';

const V = JSON.parse(
  readFileSync(new URL('./fixtures/acn-vectors.json', import.meta.url), 'utf8')
);
const hex = (b) => Buffer.from(b).toString('hex');
const buf = (h) => Buffer.from(h, 'hex');

test('skUtil matches the reference on three inputs', () => {
  for (const name of ['sk_util', 'sk_util_2', 'sk_util_3']) {
    assert.equal(hex(skUtil(buf(V[name].in))), V[name].out, name);
  }
});

test('the session key is the first 16 bytes of skUtil over the join values', () => {
  const key = sessionKey(
    buf('71ea5337000011dda000000eddcccccc'),
    buf('dd2d453e000011dda000000eddcccccc'),
    0x8a30,
    0x0123
  );
  assert.equal(hex(key), V.key);
});

test('AES-CTR at an absolute stream position, aligned and unaligned', () => {
  const key = buf(V.key);
  for (const name of ['aes_ctr_at_0', 'aes_ctr_at_37']) {
    const v = V[name];
    const ct = aesCtrAt(key, buf(v.nonce), v.pos, buf(v.pt));
    assert.equal(hex(ct), v.ct, name);
    // decrypt is the same operation
    assert.equal(hex(aesCtrAt(key, buf(v.nonce), v.pos, ct)), v.pt);
    // the cached keystream agrees with the direct computation
    const ks = new Keystream(key, buf(v.nonce));
    assert.equal(hex(ks.xorAt(v.pos, buf(v.pt))), v.ct);
  }
});

test('crc32 is zlib.crc32', () => {
  assert.equal(crc32(buf(V.crc32.in)), V.crc32.out);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('skip32 is the 12-round variant, both directions', () => {
  for (const v of V.skip32) {
    const key10 = buf(v.key10);
    assert.equal(skip32(key10, v.in, true), v.enc, `enc ${v.in}`);
    assert.equal(skip32(key10, v.enc, false), v.dec, `dec ${v.in}`);
  }
});

test('the auth tag is skip32 of the crc32 of the client block', () => {
  const key = buf(V.key);
  const cb = buf(V.crc32.in);
  const expected = buf(V.client_block).subarray(cb.length);
  assert.equal(hex(authTag(key, cb)), hex(expected));
});
