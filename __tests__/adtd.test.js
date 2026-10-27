// The two-channel ADTD: discovered as its own product, read as two channels,
// and refused — as the real unit refuses — for the channels it does not have.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AdtqDevice } from '../driver/adtq/device.js';
import { FakeAdtq } from '../driver/fake/fake-adtq.js';
import { MODELS, OBJ, chanAddr, channelsFor } from '../driver/adtq/properties.js';
import { PRODUCT, PRODUCT_ADTD, channelsOfProduct, discoveredDevice, productFor } from '../adapter.js';
import { DMP } from '../driver/acn/pdu.js';

const FAST = { advertGapMs: 5, joinDelayMs: 50, writeGateMs: 50, connectTimeoutMs: 5000, requestTimeoutMs: 150 };

async function startFake(t, options) {
  const fake = new FakeAdtq(options);
  await fake.listen();
  t.after(() => fake.stop());
  return fake;
}

const connect = async (t, fake, extra = {}) => {
  const device = new AdtqDevice({ host: '127.0.0.1', slpPort: fake.slpPort, multicast: false, unicastSlp: true, session: FAST, ...extra });
  t.after(() => device.close());
  await device.connect();
  return device;
};

test('the models and their channel counts', () => {
  assert.deepEqual(MODELS, { ADTQ: 4, ADTD: 2 });
  assert.equal(channelsFor('ADTD'), 2);
  assert.equal(channelsFor('adtq'), 4);
  assert.equal(channelsFor('ADXYZ'), 4, 'an unknown model is read as the largest');
  assert.equal(productFor('ADTD'), PRODUCT_ADTD);
  assert.equal(productFor('ADTQ'), PRODUCT);
  assert.equal(channelsOfProduct(PRODUCT_ADTD), 2);
  assert.equal(channelsOfProduct(PRODUCT), 4);
  assert.equal(channelsOfProduct(undefined), 4);
});

test('an ADTD advert becomes the two-channel product, named by what it advertises', () => {
  const d = discoveredDevice({ ip: '10.242.240.164', port: 57383, fctn: 'ADTD', uacn: 'ADTD K54 NACLOCK', cidText: 'x' });
  assert.equal(d.product, PRODUCT_ADTD);
  assert.match(d.name, /^ADTD K54 \(10\.242\.240\.164\)$/);
  const q = discoveredDevice({ ip: '10.242.240.163', port: 57383, fctn: 'ADTQ', uacn: 'ADTQ G56 NACLOCK', cidText: 'x' });
  assert.equal(q.product, PRODUCT);
});

test('an ADTD is read as two channels, and refuses the other two as the real unit does', async (t) => {
  const fake = await startFake(t, { fctn: 'ADTD', uacn: 'ADTD K54 NACLOCK' });
  const device = await connect(t, fake);
  assert.equal(device.identity.model, 'ADTD');
  assert.equal(device.channels, 2);
  const all = await device.readAll();
  assert.deepEqual(Object.keys(all.channels), ['1', '2']);
  assert.equal(all.unanswered, 0, 'nothing is asked of channels it does not have');
  assert.equal(all.channels[2].name, 'Channel2');
  const meters = await device.readMeters();
  assert.deepEqual(Object.keys(meters.channels), ['1', '2']);
  // a read of channel 3 is answered, with GET_FAIL, not left in silence (seen on an ADTD, 2026-10-26)
  const r = await device.session.getMany([chanAddr(3, OBJ.CHAN_NAME)], { retries: 0 });
  assert.equal(r.unanswered.length, 0);
  assert.equal([...r.replies.values()][0].vector, DMP.GET_FAIL);
});

test('a unit asked for more channels than it has reports them as unanswered-by-refusal, not as silence', async (t) => {
  const fake = await startFake(t, { fctn: 'ADTD', uacn: 'ADTD K54 NACLOCK' });
  const device = await connect(t, fake, { channels: 4 });
  const all = await device.readAll();
  assert.deepEqual(Object.keys(all.channels), ['1', '2', '3', '4']);
  assert.equal(all.unanswered, 0, 'GET_FAIL is an answer');
  assert.equal(all.channels[3].name, null);
});

test('the unit-level settings and the tone generator read and write at the receivers\' addresses', async (t) => {
  const fake = await startFake(t, { fctn: 'ADTD', uacn: 'ADTD K54 NACLOCK' });
  const device = await connect(t, fake);
  const all = await device.readAll();
  assert.deepEqual(
    { model: all.device.model, name: all.device.name, band: all.device.band, fan: all.device.fanAlwaysOn, panel: all.device.panelLock, power: all.device.powerLock, uptime: all.device.uptime },
    { model: 'ADTD', name: 'ADTD', band: 'G57', fan: false, panel: false, power: false, uptime: '0:07:08' }
  );
  assert.deepEqual([all.channels[1].toneFreqHz, all.channels[1].toneLevelDb], [400, -128]);
  // every write reads back
  assert.deepEqual(await device.setToneLevel(1, -30), { ok: true, value: -30 });
  assert.deepEqual(await device.setToneFrequencyHz(1, 1000), { ok: true, value: 1000 });
  assert.deepEqual(await device.setToneLevel(1, 'Off'), { ok: true, value: 'Off' });
  await assert.rejects(device.setToneLevel(1, -31), /tone level must be/);
  await assert.rejects(device.setToneFrequencyHz(1, 20), /tone frequency must be/);
  assert.deepEqual(await device.setDeviceName('FOH RACK'), { ok: true, value: 'FOH RACK' });
  assert.deepEqual(await device.setFanAlwaysOn(true), { ok: true, value: true });
  assert.deepEqual(await device.setPanelLock(true), { ok: true, value: true });
  assert.deepEqual(await device.setPowerLock(true), { ok: true, value: true });
  const after = await device.readDevice();
  assert.deepEqual([after.name, after.fanAlwaysOn, after.panelLock, after.powerLock], ['FOH RACK', true, true, true]);
});

test('gain is written in whole dB within the limits the unit enforces, and refused outside them as the unit does', async (t) => {
  const fake = await startFake(t, { fctn: 'ADTD', uacn: 'ADTD K54 NACLOCK' });
  const device = await connect(t, fake);
  assert.deepEqual(await device.setGainDb(1, 16), { ok: true, value: 16 });
  assert.deepEqual(await device.setGainDb(1, -20), { ok: true, value: -20 });
  await assert.rejects(device.setGainDb(1, 17), /gain must be -20\.\.16 dB/);
  // the fake refuses what the unit refuses when the driver is bypassed
  const { OBJ: O, chanAddr: ca, encodeI8 } = await import('../driver/adtq/properties.js');
  const r = await device.session.set(ca(1, O.AUDIO_GAIN_DB), encodeI8(17));
  assert.equal(r.refused, 5);
  assert.equal(r.after.readInt8(0), -20, 'the unit keeps what it had');
});

test('the operational preset is the mode code Workbench writes, one of the list the band offers', async (t) => {
  const fake = await startFake(t, { fctn: 'ADTD', uacn: 'ADTD K54 NACLOCK' });
  const device = await connect(t, fake);
  const before = await device.readDevice();
  assert.deepEqual([before.opPreset, before.rfModeCode, before.rfModeList, before.rfPowerTable?.['45']], [5, 45, [45, 46, 32, 31, 3, 2, 5, 0, 1, 10, 9], 'Low (10 mW), Normal (20 mW), High (100 mW)']);
  assert.deepEqual(await device.setOperationalPreset(31), { ok: true, value: 31 });
  const after = await device.readDevice();
  assert.deepEqual([after.opPreset, after.rfModeCode], [3, 31]);
  await assert.rejects(device.setOperationalPreset(99), /preset must be one of 45, 46/);
});

test('in a wideband preset a mix keeps its own name and inherits frequency, group, power and mute from its carrier', async (t) => {
  const fake = await startFake(t, { fctn: 'ADTQ', uacn: 'ADTQ G57 NACLOCK' });
  const device = await connect(t, fake);
  assert.deepEqual(await device.setOperationalPreset(18), { ok: true, value: 18 }); // "4-channel wideband": one carrier
  const { channels } = await device.readChannels();
  assert.equal(channels[1].carrier, 1);
  assert.equal(channels[1].carrierName, 'Channel1,Channel2,Channel3,Channel4');
  for (const ch of [2, 3, 4]) {
    assert.equal(channels[ch].name, `Channel${ch}`);
    assert.equal(channels[ch].carrier, 1);
    assert.equal(channels[ch].frequencyMhz, channels[1].frequencyMhz);
    assert.equal(channels[ch].muted, channels[1].muted);
    assert.equal(channels[ch].txPowerMode, channels[1].txPowerMode);
    assert.deepEqual(channels[ch].groupChannel, channels[1].groupChannel);
  }
  assert.deepEqual(await device.setOperationalPreset(42), { ok: true, value: 42 }); // "…, 2 frequencies": carriers 1 and 3
  const two = (await device.readChannels()).channels;
  assert.deepEqual([two[1].carrier, two[2].carrier, two[3].carrier, two[4].carrier], [1, 1, 3, 3]);
  assert.equal(two[3].carrierName, 'Channel3,Channel4');
  assert.notEqual(two[3].frequencyMhz, two[1].frequencyMhz);
  assert.equal(two[4].frequencyMhz, two[3].frequencyMhz);
});

test('an ADTD in a narrowband preset: every channel is its own carrier and channels 3-4 stay empty', async (t) => {
  const fake = await startFake(t, { fctn: 'ADTD', uacn: 'ADTD K54 NACLOCK' });
  const device = await connect(t, fake);
  const { channels } = await device.readChannels();
  assert.deepEqual([channels[1].carrier, channels[2].carrier], [1, 2]);
  assert.equal(channels[3], undefined, 'an ADTD reads two channels');
});

test('encryption is written device-wide at the read address and every channel reads the new value', async (t) => {
  const fake = await startFake(t, { fctn: 'ADTD', uacn: 'ADTD K54 NACLOCK' });
  const device = await connect(t, fake);
  assert.deepEqual(await device.setEncryption(true), { ok: true, value: 'On', copies: { 1: 'On', 2: 'On' } });
  assert.deepEqual(await device.setEncryption(false), { ok: true, value: 'Off', copies: { 1: 'Off', 2: 'Off' } });
});

test('input selection and analog sensitivity are per channel and read back', async (t) => {
  const fake = await startFake(t, { fctn: 'ADTD', uacn: 'ADTD K54 NACLOCK' });
  const device = await connect(t, fake);
  assert.deepEqual(await device.setInputSource(2, 'Dante'), { ok: true, value: 'Dante' });
  assert.deepEqual(await device.setAnalogSensitivity(1, 'Aux (+18 dBV FS)'), { ok: true, value: 'Aux (+18 dBV FS)' });
  const { channels } = await device.readChannels();
  assert.deepEqual([channels[1].inputSource, channels[2].inputSource], ['Rear Panel', 'Dante']);
  assert.deepEqual([channels[1].analogSensitivity, channels[2].analogSensitivity], ['Aux (+18 dBV FS)', 'Line (+28 dBV FS)']);
  await assert.rejects(device.setInputSource(1, 'USB'), /input must be/);
});
