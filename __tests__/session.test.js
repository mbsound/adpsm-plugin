// The driver against the fake ADTQ: discovery, the session prologue, reads,
// writes with read-back, EVENTs, and the failure paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdtq, FAKE_CID } from '../driver/fake/fake-adtq.js';
import { AdtqDevice, discoverAdtq } from '../driver/adtq/device.js';
import { AcnSession } from '../driver/acn/session.js';
import { OBJ, chanAddr, decodeDots } from '../driver/adtq/properties.js';

test('the panel meter byte decodes as a bar of dots with a peak-hold dot', () => {
  // values read off the unit while its panel was watched
  assert.deepEqual(decodeDots(Buffer.from([0b0011111])), { bar: 5, peak: 5 }); // 5 dots, as seen
  assert.deepEqual(decodeDots(Buffer.from([0b0001111])), { bar: 4, peak: 4 });
  assert.deepEqual(decodeDots(Buffer.from([0b0000001])), { bar: 1, peak: 1 });
  assert.deepEqual(decodeDots(Buffer.from([0])), { bar: 0, peak: 0 });
  assert.deepEqual(decodeDots(Buffer.from([0b0010111])), { bar: 3, peak: 5 }); // 23: bar 3, peak dot 5
  assert.deepEqual(decodeDots(Buffer.from([0b0101111])), { bar: 4, peak: 6 }); // 47
  assert.deepEqual(decodeDots(Buffer.from([0b0001011])), { bar: 2, peak: 4 }); // 11
  assert.equal(decodeDots(Buffer.from([1, 2])), null);
});

// the prologue's fixed delays, shortened for tests
const FAST = { advertGapMs: 5, joinDelayMs: 20, writeGateMs: 20, connectTimeoutMs: 3000, requestTimeoutMs: 400 };

async function startFake(t, options) {
  const fake = new FakeAdtq(options);
  await fake.listen();
  t.after(() => fake.stop());
  return fake;
}

const connect = async (t, fake, extra = {}) => {
  const device = new AdtqDevice({
    host: '127.0.0.1',
    slpPort: fake.slpPort,
    multicast: false,
    unicastSlp: true,
    session: FAST,
    ...extra,
  });
  t.after(() => device.close());
  await device.connect();
  return device;
};

test('SLP discovery yields the control port and the CID', async (t) => {
  const fake = await startFake(t);
  const found = await discoverAdtq('127.0.0.1', { slpPort: fake.slpPort, timeoutMs: 500 });
  assert.equal(found.port, fake.controlPort);
  assert.equal(found.cid.toString('hex'), FAKE_CID.toString('hex'));
  assert.equal(found.cidText, 'DD2D453E-0000-11DD-A000-000EDDCCCCCC');
  assert.equal(found.fctn, 'ADTQ');
  assert.equal(found.uacn, 'ADTQ G57 NACLOCK');
});

test('the lookup asks the multicast group too and returns as soon as the unit answers', async (t) => {
  // The real ADTQ only answers a request sent to 239.255.254.253; the fake on
  // loopback only hears the unicast one. Both go out; the first matching reply
  // ends the wait, well inside the timeout.
  const fake = await startFake(t);
  const t0 = Date.now();
  const found = await discoverAdtq('127.0.0.1', { slpPort: fake.slpPort, multicast: true, timeoutMs: 2000 });
  assert.equal(found.port, fake.controlPort);
  assert.equal(found.cidText, 'DD2D453E-0000-11DD-A000-000EDDCCCCCC');
  assert.ok(Date.now() - t0 < 1500, 'resolved on the reply, not on the timeout');
});

test('a device that does not answer SLP is a clear error, not a hang', async (t) => {
  const fake = await startFake(t);
  fake.answerSlp = false;
  await assert.rejects(
    () => discoverAdtq('127.0.0.1', { slpPort: fake.slpPort, timeoutMs: 100, attempts: 1 }),
    /No ACN device answered at 127\.0\.0\.1/
  );
});

test('a JOIN with the wrong CID is ignored in silence, as the device does', async (t) => {
  const fake = await startFake(t);
  let ignored = 0;
  fake.on('ignored-join', () => (ignored += 1));
  const session = new AcnSession({
    host: '127.0.0.1',
    port: fake.controlPort,
    deviceCid: Buffer.from('00000000000011dda000000eddcccccc', 'hex'),
    slpPort: fake.slpPort,
    multicast: false,
    unicastSlp: true,
    ...FAST,
    connectTimeoutMs: 300,
  });
  await assert.rejects(() => session.open(), /Could not associate/);
  assert.equal(ignored, 1);
  assert.equal(session.closed, true);
});

test('the session associates and every mapped property reads back decoded', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);
  assert.equal(device.identity.model, 'ADTQ');
  assert.equal(device.identity.name, 'ADTQ G57 NACLOCK');
  assert.equal(device.identity.label, 'ADTQ G57');
  assert.equal(device.identity.band, 'G57');
  assert.equal(device.session.protoOk, true);
  assert.equal(device.session.recipAssocSent, true);

  const all = await device.readAll();
  assert.equal(all.unanswered, 0);
  assert.deepEqual(all.channels[1], {
    name: 'Channel1',
    carrierName: 'Channel1',
    carrier: 1,
    groupChannel: { group: 1, channel: 1 },
    frequencyMhz: 470.625,
    muted: false,
    txPowerMode: 'High',
    gainDb: 16,
    audioMode: 'stereo',
    rfStatus: 1,
    toneFreqHz: 400,
    toneLevelDb: -128,
    inputSource: 'Rear Panel',
    analogSensitivity: 'Line (+28 dBV FS)',
  });
  assert.equal(all.channels[2].audioMode, 'mono');
  assert.equal(all.channels[3].frequencyMhz, 471.725);
  assert.equal(all.channels[4].txPowerMode, 'Normal');
  assert.deepEqual(all.device, { encryption: 'Off', model: 'ADTQ', serial: 'VT000000000', name: 'ADTQ', powerLock: false, fanAlwaysOn: false, uptime: '0:07:08', band: 'G57', panelLock: false, opPreset: 1, rfModeCode: 14, rfModeList: [20, 18, 40, 41, 42, 43, 28, 14, 13, 26, 16, 11, 12, 23, 22], rfPowerTable: { 31: 'Low (10 mW), Normal (40 mW), High (126 mW)', 45: 'Low (10 mW), Normal (20 mW), High (100 mW)' } });
});

test('the audio meters read as left/right dB per channel, apart from the settings read', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);
  const m = await device.readMeters();
  assert.equal(m.unanswered, 0);
  for (const ch of [1, 2, 3, 4]) {
    assert.equal(typeof m.channels[ch].afDb, 'number', `ch${ch} left`);
    assert.equal(typeof m.channels[ch].afRDb, 'number', `ch${ch} right`);
  }
  assert.ok(m.channels[1].afDb > -40 && m.channels[1].afDb < 0, 'programme on CH1');
  assert.equal(m.channels[3].afDb, -255, 'nothing connected reads -255');
  // the panel's 7-dot meter: a bar that follows the level, a peak dot above it
  assert.equal(m.asked, 16);
  assert.ok(m.channels[1].afDots.bar >= 3 && m.channels[1].afDots.bar <= 7, 'CH1 bar lit');
  assert.ok(m.channels[1].afDots.peak >= m.channels[1].afDots.bar, 'peak at or above the bar');
  assert.deepEqual(m.channels[3].afDots, { bar: 0, peak: 0 });
  assert.deepEqual(m.channels[3].afRDots, { bar: 0, peak: 0 });
  assert.equal('afDb' in (await device.readChannel(1)), false, 'meters are not part of the settings read');
});

test('writes are confirmed by read-back, and a refused write is reported as not applied', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);

  assert.deepEqual(await device.setMute(2, true), { ok: true, value: true });
  assert.equal(fake.muted(2), true);
  assert.deepEqual(await device.setMute(2, false), { ok: true, value: false });

  const freq = await device.setFrequencyMhz(3, 500.1);
  assert.deepEqual(freq, { ok: true, requestedMhz: 500.1, value: 500.1 });
  assert.equal(fake.frequencyKhz(3), 500100);
  // off-raster is quantised before it is sent
  assert.equal((await device.setFrequencyMhz(3, 500.113)).value, 500.125);
  // outside the band: the device ignores it and the read-back says so
  const outside = await device.setFrequencyMhz(3, 700);
  assert.equal(outside.ok, false);
  assert.equal(outside.value, 500.125);

  assert.deepEqual(await device.setTxPowerMode(1, 'low'), { ok: true, value: 'Low' });
  assert.deepEqual(await device.setAudioMode(2, 'Stereo'), { ok: true, value: 'stereo' });
  assert.deepEqual(await device.setChannelName(4, 'Lead Vox'), { ok: true, value: 'Lead Vox' });
  assert.equal(fake.channelName(4), 'Lead Vox');

  // the read address of the name is not writable: the unit answers SET_FAIL
  // NOT_WRITABLE and then still answers the read-back GET, and both are kept
  const refused = await device.session.set(chanAddr(4, OBJ.CHAN_NAME), Buffer.from('0006abcd', 'hex'));
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, 4);
  assert.equal(refused.reply.vector, 3, 'the GET_REPLY behind the SET_FAIL is the read-back');
  assert.ok(refused.after, 'a refusal still comes with the read-back');
  assert.equal(fake.channelName(4), 'Lead Vox');

  fake.rejectWrites = true;
  assert.deepEqual(await device.setMute(1, true), { ok: false, value: false });
});

test('a change made elsewhere arrives as an EVENT on the change feed', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);
  const changes = [];
  device.on('change', (c) => changes.push(c));
  // the front panel mutes channel 3
  fake.setRaw(chanAddr(3, OBJ.RF_MUTE), Buffer.from([1]));
  fake.setRaw(chanAddr(1, OBJ.FREQ_KHZ), Buffer.from([0, 0x07, 0x2e, 0x61]));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(changes, [
    { channel: 3, key: 'muted', value: true },
    { channel: 1, key: 'frequencyMhz', value: 470.625 },
  ]);
});

// mulberry32: a seeded draw, so the lossy read loses the same datagrams every run
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('lost datagrams are retried, and a device that stops answering times out cleanly', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);
  fake.dropInbound = 0.3;
  fake.random = seeded(57);
  const all = await device.readChannels([1, 2]);
  // two attempts at 30% loss leave almost everything answered (9% per address expected);
  // what is not is counted. Relative to `asked`, so new properties do not tighten it.
  assert.ok(all.unanswered < all.asked * 0.2, `${all.unanswered} of ${all.asked} unanswered`);
  fake.dropInbound = 0;

  fake.silent = true;
  const gone = await device.readChannels([1]);
  assert.equal(gone.unanswered, gone.asked);
  assert.equal(await device.session.get(chanAddr(1, OBJ.RF_MUTE), 100), null);
});

test('closing sends the disconnect sequence and the fake forgets the session', async (t) => {
  const fake = await startFake(t);
  const device = await connect(t, fake);
  assert.equal(fake.sessions.size, 1);
  const left = new Promise((r) => fake.once('left', r));
  await device.close();
  await left;
  assert.equal(fake.sessions.size, 0);
});
