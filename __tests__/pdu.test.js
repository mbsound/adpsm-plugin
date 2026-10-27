// The PDU builders and parsers against the reference's bytes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DMP,
  DmpDecoder,
  TRAILER_FIRST_RELIABLE,
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
  pduDecode,
  pduEncode,
  rootLeave,
  rootParse,
  sdtLeaving,
  sdtPdus,
  validDmpHead,
} from '../driver/acn/pdu.js';
import { authTag } from '../driver/acn/crypto.js';

const V = JSON.parse(
  readFileSync(new URL('./fixtures/acn-vectors.json', import.meta.url), 'utf8')
);
const hex = (b) => Buffer.from(b).toString('hex');
const buf = (h) => Buffer.from(h, 'hex');
const OUR = buf('71ea5337000011dda000000eddcccccc');
const DEV = buf('dd2d453e000011dda000000eddcccccc');
const KEY = buf(V.key);
const NONCE = buf('0102030405060708');

test('DMP GET and SET PDUs', () => {
  assert.equal(hex(dmpPdu(DMP.GET, 0x02020804)), V.dmp_get);
  const khz = Buffer.alloc(4);
  khz.writeUInt32BE(471225);
  assert.equal(hex(dmpPdu(DMP.SET, 0x02020804, khz)), V.dmp_set_freq);
  const [prop] = dmpProps(dmpPdu(DMP.SET, 0x02020804, khz));
  assert.deepEqual(prop, { vector: 2, addr: 0x02020804, value: khz });
});

test('JOIN advertises the reliable base as the channel itself', () => {
  assert.equal(hex(buildJoin(OUR, DEV, 0x8a30)), V.join);
  const { sdt } = rootParse(buf(V.join));
  const [{ vector, data }] = sdtPdus(sdt);
  assert.equal(vector, 4);
  assert.deepEqual(parseJoin(data), {
    memberCid: DEV,
    mid: 1,
    chan: 0x8a30,
    relSeq: 0x8a30,
  });
});

test('JOIN_ACCEPT, and the reciprocal channel it carries', () => {
  assert.equal(hex(buildJoinAccept(OUR, DEV, 0x1234, 0x0042, 0x8a30)), V.join_accept);
  const { cid, sdt } = rootParse(buf(V.join_accept));
  assert.equal(hex(cid), hex(OUR));
  const [{ vector, data }] = sdtPdus(sdt);
  assert.equal(vector, 6);
  assert.equal(parseJoinAccept(data).recipChan, 0x8a30);
  assert.equal(parseJoinAccept(data).relSeq, 0x0042);
});

test('an encrypted DMP client block in a reliable wrapper', () => {
  const pdu = dmpPdu(DMP.SET, 0x0200080e, Buffer.from([1]));
  const cb = encryptDmp(KEY, NONCE, 0, pdu);
  const block = Buffer.concat([cb, authTag(KEY, cb)]);
  assert.equal(hex(block), V.client_block);
  // an unaligned position: keystream from floor(pos/16), counter ceil(pos/16)
  const cb37 = encryptDmp(KEY, NONCE, V.client_block_37.pos, buf(V.client_block_37.pt));
  assert.equal(hex(Buffer.concat([cb37, authTag(KEY, cb37)])), V.client_block_37.block);
  const wrapper = buildWrapper(
    OUR, 0x8a30, 0x8a31, 0x8a31, 0x8a31,
    [clientBlock(1, 0x102, 0, block)], true, TRAILER_FIRST_RELIABLE
  );
  assert.equal(hex(wrapper), V.wrapper);

  const { sdt } = rootParse(wrapper);
  const [{ vector, data }] = sdtPdus(sdt);
  assert.equal(vector, V.parse_wrapper.vec);
  const parsed = parseWrapper(data);
  assert.equal(parsed.chan, V.parse_wrapper.chan);
  assert.equal(parsed.total, V.parse_wrapper.total);
  assert.equal(parsed.rel, V.parse_wrapper.rel);
  assert.equal(parsed.oldest, V.parse_wrapper.oldest);
  assert.deepEqual(
    parsed.blocks.map((b) => [b.proto, hex(b.payload)]),
    V.parse_wrapper.blocks
  );

  // the receiving side decodes it at stream position 0
  const decoder = new DmpDecoder(KEY);
  const pt = decoder.decode(parsed.blocks[0].payload);
  assert.equal(hex(pt), hex(pdu));
  assert.equal(decoder.pos, pdu.length);
});

test('the decoder recovers a block whose stream position drifted', () => {
  const decoder = new DmpDecoder(KEY);
  // the sender is 40 bytes ahead of where we think the stream is
  const pdu = dmpPdu(DMP.GET_REPLY, 0x02000804, Buffer.from([0, 7, 0x2e, 0x61]));
  const cb = encryptDmp(KEY, NONCE, 40, pdu);
  const pt = decoder.decode(cb);
  assert.equal(hex(pt), hex(pdu));
  assert.equal(decoder.pos, 40 + pdu.length);
  // a retransmit of the same ciphertext decodes at the remembered position
  assert.equal(hex(decoder.decode(cb)), hex(pdu));
  assert.equal(decoder.pos, 40 + pdu.length);
});

test('management PDUs and the session-close sequence', () => {
  const ack = buildWrapper(
    OUR, 0x8a30, 0x8a32, 0x8a31, 0x8a31,
    [clientBlock(1, 1, 0x1234, mgmtAck(0x0042))], false
  );
  assert.equal(hex(ack), V.unrel_ack);
  const decl = buildWrapper(
    OUR, 0x8a30, 0x8a31, 0x8a31, 0x8a31,
    [clientBlock(1, 1, 0, mgmtDeclare())], true, TRAILER_FIRST_RELIABLE
  );
  assert.equal(hex(decl), V.decl);
  assert.equal(hex(mgmtAssociate()), V.assoc0a);
  assert.equal(hex(mgmtDisassociate()), V.disassoc);
  assert.equal(hex(sdtLeaving()), V.leaving);
  assert.equal(hex(rootLeave(OUR, DEV)), V.root_leave);

  assert.deepEqual(parseMgmt(mgmtAck(0x0042)), { vec: 0x0e, seq: 0x42 });
  assert.deepEqual(parseMgmt(mgmtDeclare()), { vec: 0x09, proto: 0x102 });
  assert.deepEqual(parseMgmt(mgmtAssociate()), { vec: 0x0a, proto: 0x102 });
});

test('validDmpHead accepts replies and failures, rejects junk', () => {
  assert.ok(validDmpHead(dmpPdu(DMP.GET_REPLY, 1, Buffer.from([1]))));
  assert.ok(validDmpHead(buf('7006090000 02'.replace(' ', '')), 6));
  assert.ok(!validDmpHead(Buffer.from([0x12, 0x34, 0x56])));
  assert.ok(!validDmpHead(dmpPdu(DMP.GET_REPLY, 1, Buffer.from([1])), 4));
  const r = pduDecode(pduEncode(3, null, Buffer.from([1, 2]), 1), 0);
  assert.deepEqual(r, { flags: 7, dataStart: 2, end: 5 });
});
