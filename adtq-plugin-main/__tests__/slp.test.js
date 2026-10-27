// SLP: the request and advert bytes against the reference, and the reply parser.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdvert,
  buildDeviceAdvert,
  buildSrvRqst,
  cidFromMac,
  cidFromString,
  cidToString,
  describeUacn,
  parseSlpReply,
} from '../driver/acn/slp.js';
import { localIpToward, parseAddressList, sameSubnet } from '../driver/netutil.js';

const CID = Buffer.from('71ea5337000011dda000000eddcccccc', 'hex');

test('the service request is byte-exact with the reference', () => {
  assert.equal(
    buildSrvRqst().toString('hex'),
    '020100002f000000000000010002656e00000010736572766963653a657374612e646d70000744454641554c540000'
  );
});

test('the controller advert is byte-exact with the reference', () => {
  const pkt = buildAdvert({ cid: CID, ip: '10.10.1.50', port: 51234 });
  assert.equal(
    pkt.toString('hex'),
    '020700013d0000000000223d0002656e00000128286369643d37314541353333372d303030302d313144442d413030302d303030454444434343434343292c2861636e2d6663746e3d57574236292c2861636e2d7561636e3d575742203658292c2861636e2d73657276696365733d657374612e646d70292c2863736c2d657374612e646d703d657374612e7364742f31302e31302e312e35303a35313233343b657374612e646d702f63643a43434441384530412d453133392d313144462d384337412d303031354335463346363132292c286465766963652d6465736372697074696f6e3d243a746674703a2f2f31302e31302e312e35302f242e64646c292c2863736c2d657374612e646d702e76616c7565733d76657273696f6e3a315f696e7465726661636549643a315f65787456657273696f6e3a312900'
  );
});

test('a device reply yields port, CID, function and name — parentheses in the name included', () => {
  const text =
    '(cid=DD2D453E-0000-11DD-A000-000EDDCCCCCC),(acn-fctn=ADTQ),(acn-uacn=ADTQ G57 NACLOCK),' +
    '(acn-services=esta.dmp),(csl-esta.dmp=esta.sdt/10.10.1.175:57383;esta.dmp/cd:05B2AB78-FD5A-11E3-B473-0015C5F3F612)';
  const r = parseSlpReply(Buffer.from(text));
  assert.equal(r.ip, '10.10.1.175');
  assert.equal(r.port, 57383);
  assert.equal(r.cid.toString('hex'), 'dd2d453e000011dda000000eddcccccc');
  assert.equal(r.cidText, 'DD2D453E-0000-11DD-A000-000EDDCCCCCC');
  assert.equal(r.fctn, 'ADTQ');
  assert.equal(r.uacn, 'ADTQ G57 NACLOCK');

  const framed = buildDeviceAdvert({ cid: r.cid, fctn: 'ADTQ', uacn: 'ADTQ (stage left)', ip: '10.0.0.9', port: 57384 });
  const p = parseSlpReply(framed);
  assert.equal(p.uacn, 'ADTQ (stage left)');
  assert.equal(p.port, 57384);
  assert.equal(parseSlpReply(Buffer.from('nothing here')), null);
});

test("a unit's advertised name is read as its model and band, without the variant tag", () => {
  // every Shure unit heard on one segment, 2026-10-07
  const heard = {
    'ADTQ G57 NACLOCK': { label: 'ADTQ G57', band: 'G57' },
    'ADTD K54 NACLOCK': { label: 'ADTD K54', band: 'K54' },
    'ULXD4Q G50 REV5': { label: 'ULXD4Q G50', band: 'G50' },
    'AD4Q A': { label: 'AD4Q A', band: 'A' },
    'P10T G10': { label: 'P10T G10', band: 'G10' },
    AD600: { label: 'AD600', band: null },
  };
  for (const [uacn, expected] of Object.entries(heard)) assert.deepEqual(describeUacn(uacn), expected, uacn);
  // anything not in that form is passed through whole
  assert.deepEqual(describeUacn('ADTQ (simulated)'), { label: 'ADTQ (simulated)', band: null });
  assert.deepEqual(describeUacn(null), { label: null, band: null });
});

test('CID spellings and the MAC derivation', () => {
  assert.equal(cidToString(CID), '71EA5337-0000-11DD-A000-000EDDCCCCCC');
  assert.equal(cidFromString('71EA5337-0000-11DD-A000-000EDDCCCCCC').toString('hex'), CID.toString('hex'));
  assert.equal(cidFromString('nope'), null);
  assert.equal(cidFromMac('00:0e:dd:2d:45:3e').toString('hex'), 'dd2d453e000011dda000000eddcccccc');
});

test('the local interface facing a target, and address lists', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    en0: [{ address: '192.168.0.176', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    en7: [{ address: '10.10.1.50', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
  };
  assert.equal(localIpToward('10.10.1.175', ifaces), '10.10.1.50');
  assert.equal(localIpToward('192.168.0.20', ifaces), '192.168.0.176');
  assert.equal(localIpToward('172.16.4.4', ifaces), '192.168.0.176', 'off-subnet falls back to the first interface');
  assert.equal(localIpToward('127.0.0.1', ifaces), '127.0.0.1');
  assert.equal(localIpToward('not-an-ip', ifaces), null);
  assert.ok(sameSubnet('10.10.1.1', '10.10.200.9', '255.255.0.0'));
  assert.ok(!sameSubnet('10.10.1.1', '10.11.1.1', '255.255.0.0'));
  assert.deepEqual(parseAddressList(' 10.10.1.175, 10.10.1.176;bogus 10.10.1.175'), ['10.10.1.175', '10.10.1.176']);
});
