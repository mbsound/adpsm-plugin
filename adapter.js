// The Shure ADTQ as a SoundBase monitored device: discovery over SLP, one
// held-open ACN session per unit, every mapped property pushed as state, and
// the writable ones exposed through PropertyControl. Everything about the
// wire lives in driver/; this file maps the device onto the contract.
//
//   discoverDevices          a standing SLP browse of the segment (plus any
//                            addresses the plugin config lists)
//   createMonitoringAdapter  open -> connect, read everything, report it,
//                            then refresh on a timer and on device EVENTs,
//                            with the audio meters on their own faster timer;
//                            setProperty -> write, read back, report what
//                            the device now holds

import { HttpError } from '@soundbase/plugin-shell';
import { AdtqDevice } from './driver/adtq/device.js';
import {
  AUDIO_MODES,
  CHANNEL_NAME_MAX,
  MODELS,
  channelsFor,
  FREQ_MAX_KHZ,
  FREQ_MIN_KHZ,
  FREQ_RASTER_KHZ,
  TX_POWER_MODES,
} from './driver/adtq/properties.js';
import * as P from './driver/adtq/properties.js';
import { SLP_PORT, SlpBrowser, describeUacn } from './driver/acn/slp.js';
import { FakeAdtq } from './driver/fake/fake-adtq.js';
import { isIpv4, parseAddressList } from './driver/netutil.js';

export const PRODUCT = 'plugin:shure-adtq/adtq';
/** The two-channel ADTD, announced as its own product; the card is the ADTQ's. */
export const PRODUCT_ADTD = 'plugin:shure-adtq/adtd';
/** The product a unit is announced as, from the model it advertises in `acn-fctn`. */
export const productFor = (fctn) => (channelsFor(fctn) === MODELS.ADTD ? PRODUCT_ADTD : PRODUCT);
/** The channel count of a product; anything not recognised is the four-channel ADTQ. */
export const channelsOfProduct = (product) => (product === PRODUCT_ADTD ? MODELS.ADTD : MODELS.ADTQ);
export const TX_POWER_KEY = 'x.shure-adtq.txPowerMode';
export const AF_DOTS_KEY = 'x.shure-adtq.afDots';
/** The unit as a whole: model, serial, band, uptime, Device ID, fan mode, locks. */
export const UNIT_KEY = 'x.shure-adtq.unit';
/** Per channel: the carrier channel its RF side lives on (itself in a narrowband preset) and that carrier's composite name. */
export const CARRIER_KEY = 'x.shure-adtq.carrier';
/** Per channel: `{ source, sensitivity }` — the input selection and the analog sensitivity. */
export const INPUT_KEY = 'x.shure-adtq.input';
/** The tone generator per channel: { level: 'Off' | dB, frequency: Hz }. */
export const TONE_KEY = 'x.shure-adtq.tone';
export const FAN_MODES = Object.freeze(['Automatic', 'Always on']);
const fanModeOf = (alwaysOn) => (alwaysOn == null ? undefined : alwaysOn ? FAN_MODES[1] : FAN_MODES[0]);
/** The settings that live on the unit rather than on a channel. */
const DEVICE_PROPERTIES = new Set(['deviceName', 'fanMode', 'powerLock', 'panelLock', 'operationalPreset', 'rfEncryption']);
export const NET_ID_PREFIX = 'net:';
export const SIM_DEVICE_ID = 'sim:adtq';

const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = 30000;
// the audio meters: sixteen GETs per tick, no retry, reported as `meters`;
// a tick costs the unit ~30 ms, so 100 ms leaves room for the settings refresh
const DEFAULT_METER_MS = 100;
const MIN_METER_MS = 50;
const MAX_METER_MS = 1000;
// how long the SLP browse keeps running after the shell last asked
const BROWSE_IDLE_MS = 90_000;
// the fake needs none of Workbench's advert-to-JOIN pause
const SIMULATED_SESSION = { advertGapMs: 5, joinDelayMs: 50, writeGateMs: 50, connectTimeoutMs: 5000, requestTimeoutMs: 150 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const log = (level, message) => {
  process.stderr.write(`[shure-adtq] [${level}] ${message}\n`);
};

const env = (name) => process.env[name];
const envSlpPort = () => {
  const n = Number(env('SB_ADTQ_SLP_PORT'));
  return Number.isInteger(n) && n > 0 ? n : SLP_PORT;
};

// ---------------------------------------------------------------------------
// the simulator: a fake ADTQ on loopback, started on demand
// ---------------------------------------------------------------------------

let simulator = null;
let simulatorStarting = null;

const simulateWanted = (pluginConfig) =>
  pluginConfig?.simulate === true || env('SB_ADTQ_SIMULATE') === '1';

/** The running fake, for tests and the smoke check; null until simulation is on. */
export function getSimulator() {
  return simulator;
}

async function ensureSimulator() {
  if (simulator) return simulator;
  if (!simulatorStarting) {
    simulatorStarting = (async () => {
      const fake = new FakeAdtq({ uacn: 'ADTQ (simulated)' });
      await fake.listen();
      log('info', `simulated ADTQ listening on 127.0.0.1 (SLP ${fake.slpPort}, control ${fake.controlPort})`);
      simulator = fake;
      return fake;
    })().finally(() => {
      simulatorStarting = null;
    });
  }
  return simulatorStarting;
}

async function stopSimulator() {
  const fake = simulator;
  simulator = null;
  if (fake) await fake.stop();
}

const simulatedDevice = (fake) => ({
  id: SIM_DEVICE_ID,
  name: 'ADTQ (simulated)',
  product: PRODUCT,
  transport: { kind: 'simulated', host: '127.0.0.1', port: fake.controlPort },
  config: { host: '127.0.0.1', slpPort: fake.slpPort, simulated: true },
});

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

let browser = null;
let lastDiscoverAt = 0;

// the ADTQ and the two-channel ADTD speak the same map
const isAdtq = (reply) => /^adt[qd]$/i.test(reply.fctn ?? '');

function ensureBrowser(pluginConfig) {
  const targets = parseAddressList(pluginConfig?.addresses);
  if (!browser) {
    browser = new SlpBrowser({
      targets,
      multicast: env('SB_ADTQ_NO_MULTICAST') !== '1',
      port: envSlpPort(),
      log,
      filter: isAdtq,
    });
    browser.on('found', (r) => log('info', `found ${r.fctn} "${r.uacn}" at ${r.ip}:${r.port} (${r.cidText})`));
    browser.on('lost', (r) => log('info', `lost ${r.fctn} "${r.uacn}" at ${r.ip}`));
  } else {
    browser.setTargets(targets);
  }
  browser.start();
  return browser;
}

const idleCheck = () => {
  if (browser && Date.now() - lastDiscoverAt > BROWSE_IDLE_MS) browser.stop();
};

export const discoveredDevice = (reply) => ({
  id: `${NET_ID_PREFIX}${reply.ip}`,
  // the model and band the unit advertises; the variant tag after them is not shown
  name: `${describeUacn(reply.uacn).label ?? reply.fctn ?? 'ADTQ'} (${reply.ip})`,
  product: productFor(reply.fctn),
  transport: { kind: 'network', host: reply.ip, port: reply.port },
  config: { host: reply.ip },
});

/**
 * What the SLP browse has heard from lately. Returns at once: the browse runs
 * in the background at its own cadence, and this is polled once a second.
 */
export async function discoverDevices(pluginConfig = {}) {
  lastDiscoverAt = Date.now();
  const found = [];
  if (simulateWanted(pluginConfig)) {
    found.push(simulatedDevice(await ensureSimulator()));
  } else if (simulator) {
    await stopSimulator();
  }
  if (env('SB_ADTQ_NO_DISCOVERY') === '1') return found;
  const b = ensureBrowser(pluginConfig);
  setTimeout(idleCheck, BROWSE_IDLE_MS + 1000).unref?.();
  for (const reply of b.devices()) found.push(discoveredDevice(reply));
  return found;
}

/** Stops the background browse and the simulator (for tests and shutdown). */
export async function shutdownDiscovery() {
  browser?.stop();
  browser = null;
  await stopSimulator();
}

// ---------------------------------------------------------------------------
// the monitoring adapter
// ---------------------------------------------------------------------------

/** The unit's address: `device.config.host`, else the `net:<ip>` id. */
export function resolveHost(device) {
  const configured = device?.config?.host;
  if (typeof configured === 'string' && configured.trim()) {
    const host = configured.trim();
    if (!isIpv4(host)) throw new Error(`"${host}" is not an IPv4 address; the ADTQ is addressed by IP`);
    return host;
  }
  const id = typeof device?.id === 'string' ? device.id : '';
  if (id.startsWith(NET_ID_PREFIX) && isIpv4(id.slice(NET_ID_PREFIX.length))) return id.slice(NET_ID_PREFIX.length);
  throw new Error('an ADTQ needs an IP address (the "IP address" field)');
}

const propertyDescriptors = (model, modeList) => {
  const channel = (id, value, extra = {}) => ({
    id,
    scope: 'channel',
    access: 'readWrite',
    stateBinding: { key: id },
    value,
    ...extra,
  });
  return [
    channel('mute', { type: 'boolean' }),
    channel('txPowerMode', { type: 'enum', options: [...TX_POWER_MODES] }, { stateBinding: { key: TX_POWER_KEY } }),
    channel('audioMode', { type: 'enum', options: [...AUDIO_MODES] }, { stateBinding: { key: 'audioModes', path: ['txMode'] } }),
    channel('frequency', {
      type: 'number',
      min: FREQ_MIN_KHZ / 1000,
      max: FREQ_MAX_KHZ / 1000,
      step: FREQ_RASTER_KHZ / 1000,
      unit: 'MHz',
    }),
    channel('channelName', { type: 'string', maxLength: CHANNEL_NAME_MAX }),
    channel('toneLevel', { type: 'enum', options: ['Off', ...P.TONE_LEVELS_DB], unit: 'dB' }, { stateBinding: { key: TONE_KEY, path: ['level'] } }),
    channel('toneFrequency', { type: 'number', min: P.TONE_FREQ_MIN_HZ, max: P.TONE_FREQ_MAX_HZ, step: 1, unit: 'Hz' }, { stateBinding: { key: TONE_KEY, path: ['frequency'] } }),
    // gain is writable (the unit takes -20..+16 dB; verified on an ADTD) — it is the level in
    // someone's ears, so the step is 1 dB and the limits are the unit's own. Encryption stays
    // read-only: it is device-wide and forces every receiver to re-sync.
    channel('gain', { type: 'number', min: P.GAIN_MIN_DB, max: P.GAIN_MAX_DB, step: 1, unit: 'dB' }),
    channel('inputSource', { type: 'enum', options: [...P.INPUT_SOURCES] }, { stateBinding: { key: INPUT_KEY, path: ['source'] } }),
    channel('analogSensitivity', { type: 'enum', options: [...P.ANALOG_SENSITIVITIES] }, { stateBinding: { key: INPUT_KEY, path: ['sensitivity'] } }),
    // device-wide: every receiver re-syncs; written at the read address like the other unit settings
    {
      id: 'rfEncryption',
      scope: 'device',
      access: 'readWrite',
      stateBinding: { key: 'rfEncryption', path: ['enabled'] },
      value: { type: 'boolean' },
    },
    // the unit's own settings, at the addresses the Axient Digital receivers use (read-confirmed on an ADTD)
    { id: 'deviceName', scope: 'device', access: 'readWrite', stateBinding: { key: 'deviceName' }, value: { type: 'string', maxLength: P.DEVICE_NAME_MAX } },
    { id: 'fanMode', scope: 'device', access: 'readWrite', stateBinding: { key: UNIT_KEY, path: ['fanMode'] }, value: { type: 'enum', options: [...FAN_MODES] } },
    { id: 'powerLock', scope: 'device', access: 'readWrite', stateBinding: { key: UNIT_KEY, path: ['powerLock'] }, value: { type: 'boolean' } },
    { id: 'panelLock', scope: 'device', access: 'readWrite', stateBinding: { key: UNIT_KEY, path: ['panelLock'] }, value: { type: 'boolean' } },
    // device-wide, written as Workbench writes it (the mode code); the unit reboots to apply a
    // change and every channel goes off air for the restart. The options are the presets this
    // unit's band offers, read from the unit at open.
    { id: 'operationalPreset', scope: 'device', access: 'readWrite', stateBinding: { key: UNIT_KEY, path: ['operationalPreset'] }, value: { type: 'enum', options: P.presetMenu(model, modeList).map((p) => p.name) } },
  ];
};

const badValue = (propertyId, expected) =>
  new HttpError(400, 'bad_value', `${propertyId} expects ${expected}`);

class AdtqMonitoringAdapter {
  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.host = null;
    this.hostError = null;
    // the simulated unit is addressed by its id alone, so a host that re-adds
    // it with an empty config (as it does for any discovered device) still
    // lands on the fake rather than on a real SLP port
    this.simulated = device?.id === SIM_DEVICE_ID || device?.config?.simulated === true;
    if (this.simulated) {
      this.host = '127.0.0.1';
    } else {
      try {
        this.host = resolveHost(device);
      } catch (err) {
        this.hostError = err;
      }
    }
    this.slpPort = Number.isInteger(device?.config?.slpPort) ? device.config.slpPort : envSlpPort();
    // the product fixes the channel count the host expects; the unit's advert confirms it at open
    this.channels = channelsOfProduct(device?.product);
    const poll = Number(pluginConfig.pollIntervalMs);
    this.pollIntervalMs = isNum(poll) ? clamp(poll, MIN_POLL_MS, MAX_POLL_MS) : DEFAULT_POLL_MS;
    const meter = Number(pluginConfig.meterIntervalMs);
    this.meterIntervalMs = isNum(meter) ? clamp(meter, MIN_METER_MS, MAX_METER_MS) : DEFAULT_METER_MS;
    this.unit = null;
    this.identity = null;
    this.state = { channels: {}, device: {} };
    this.pollTimer = null;
    this.polling = null;
    this.meterTimer = null;
    this.metering = null;
    this.closed = false;
    this.lastRefreshAt = 0;
    // assigned by the shell before open()
    this.onState = null;
    this.onWarnings = null;
    this.onFatal = null;
  }

  log(level, message) {
    log(level, `[${this.device.id}] ${message}`);
  }

  async open() {
    if (this.hostError) throw this.hostError;
    if (this.simulated) this.slpPort = (await ensureSimulator()).slpPort;
    const unit = new AdtqDevice({
      host: this.host,
      slpPort: this.slpPort,
      multicast: !this.simulated && env('SB_ADTQ_NO_MULTICAST') !== '1',
      unicastSlp: this.simulated,
      session: this.simulated ? SIMULATED_SESSION : {},
      channels: this.channels,
      log: (level, message) => this.log(level, message),
    });
    unit.on('change', (change) => this.applyChange(change));
    unit.on('dropped', () => this.fatal(new Error(`the control session with the ADTQ at ${this.host} dropped`)));
    unit.on('leaving', () => this.fatal(new Error(`the ADTQ at ${this.host} left the session`)));
    unit.on('error', (err) => this.log('warn', `session: ${err?.message || err}`));
    this.unit = unit;
    this.identity = await unit.connect();
    if (channelsFor(this.identity.model) !== this.channels) {
      this.log('warn', `${this.host} advertises as ${this.identity.model} (${channelsFor(this.identity.model)} channels) but was added as a ${this.channels}-channel product; remove it and add it again`);
    }
    if (this.closed) {
      await unit.close();
      throw new Error('closed while connecting');
    }
    this.onState?.('deviceName', this.identity.label ?? this.identity.model ?? 'ADTQ');
    this.onState?.('connection', { connected: true, since: new Date().toISOString() });
    await this.refresh({ initial: true });
    this.pollTimer = setInterval(() => this.refresh().catch(() => {}), this.pollIntervalMs);
    this.pollTimer.unref?.();
    this.meterTimer = setInterval(() => this.pollMeters().catch(() => {}), this.meterIntervalMs);
    this.meterTimer.unref?.();
    return {
      channelCount: this.channels,
      properties: propertyDescriptors(this.identity.model, this.state.device.rfModeList),
      identity: { model: this.identity.model ?? 'ADTQ', firmware: null },
    };
  }

  async close() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    const unit = this.unit;
    this.unit = null;
    if (unit) await unit.close();
  }

  fatal(err) {
    if (this.closed) return;
    this.log('error', err.message);
    this.onFatal?.(err);
  }

  // -- state --------------------------------------------------------------------------------

  /** Re-reads every channel and the device; reports what changed. */
  async refresh({ initial = false } = {}) {
    if (this.polling) return this.polling;
    if (!this.unit?.connected) return null;
    this.polling = (async () => {
      const all = await this.unit.readAll();
      if (this.closed) return;
      if (all.unanswered === all.asked) {
        // nothing at all came back: one more cheap probe, then call it dead
        const probe = await this.unit.readChannels([1]);
        if (probe.unanswered === probe.asked) {
          this.fatal(new Error(`the ADTQ at ${this.host} stopped answering`));
          return;
        }
      }
      this.lastRefreshAt = Date.now();
      for (const [n, props] of Object.entries(all.channels)) this.mergeChannel(Number(n), props);
      for (const [k, v] of Object.entries(all.device)) if (v !== null) this.state.device[k] = v;
      this.emitAll();
      const warnings = [];
      if (all.unanswered > 0) {
        warnings.push({
          id: 'unanswered-reads',
          severity: all.unanswered > all.asked / 4 ? 'warning' : 'info',
          message:
            `${all.unanswered} of ${all.asked} property reads went unanswered on the last refresh. ` +
            'The network between this machine and the ADTQ is dropping packets; values shown may be stale.',
        });
      }
      this.onWarnings?.(warnings);
      if (initial) this.log('info', `${this.identity.name ?? this.host}: ${all.asked - all.unanswered}/${all.asked} properties read`);
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /**
   * One meter tick: the left/right audio level of every channel as the
   * contract's `meters` reading (`af`, `afR`, in dB), and the panel's 7-dot
   * meters as the extension key `x.shure-adtq.afDots` (`{ left, right }`, each
   * `{ bar, peak }` in dots). Channels that did not answer this tick are left
   * out rather than repeated stale. A tick still in flight when the next is
   * due is left to finish; the next fires on the timer after it.
   */
  async pollMeters() {
    if (this.metering || this.closed || !this.unit?.connected) return this.metering;
    this.metering = (async () => {
      const { channels } = await this.unit.readMeters();
      if (this.closed) return;
      const out = {};
      const dots = {};
      for (const [n, m] of Object.entries(channels)) {
        const reading = {};
        if (m.afDb !== null) reading.af = m.afDb;
        if (m.afRDb !== null) reading.afR = m.afRDb;
        if (Object.keys(reading).length) out[n] = reading;
        const d = {};
        if (m.afDots) d.left = m.afDots;
        if (m.afRDots) d.right = m.afRDots;
        if (Object.keys(d).length) dots[n] = d;
      }
      if (Object.keys(out).length) this.onState?.('meters', { timestamp: Date.now(), channels: out });
      if (Object.keys(dots).length) this.onState?.(AF_DOTS_KEY, { channels: dots });
    })().finally(() => {
      this.metering = null;
    });
    return this.metering;
  }

  mergeChannel(n, props) {
    const ch = (this.state.channels[n] ??= { index: n });
    for (const [key, value] of Object.entries(props)) if (value !== null) ch[key] = value;
  }

  /** An EVENT the unit pushed: someone changed it on the panel or in Workbench. */
  applyChange({ channel, key, value }) {
    if (this.closed) return;
    if (channel === null) {
      if (value !== null) this.state.device[key] = value;
    } else {
      this.mergeChannel(channel, { [key]: value });
    }
    this.emitAll();
  }

  channelMap(pick) {
    const channels = {};
    for (const [n, ch] of Object.entries(this.state.channels)) {
      const v = pick(ch);
      if (v !== undefined && v !== null) channels[n] = v;
    }
    return { channels };
  }

  /** Every key, from the cache; the shell drops the ones that did not change. */
  emitAll() {
    const emit = (key, value) => this.onState?.(key, value);
    emit('channelName', this.channelMap((ch) => ch.name));
    emit(CARRIER_KEY, this.channelMap((ch) => (ch.carrier == null ? undefined : { channel: ch.carrier, name: ch.carrierName ?? undefined, shared: ch.carrier !== ch.index })));
    emit('frequency', this.channelMap((ch) => ch.frequencyMhz));
    emit('groupChannel', this.channelMap((ch) => ch.groupChannel));
    emit('mute', this.channelMap((ch) => ch.muted));
    emit('rfState', this.channelMap((ch) => (typeof ch.muted === 'boolean' ? !ch.muted : undefined)));
    emit('gain', this.channelMap((ch) => ch.gainDb));
    emit('audioModes', this.channelMap((ch) => (ch.audioMode ? { txMode: ch.audioMode } : undefined)));
    emit(TX_POWER_KEY, this.channelMap((ch) => ch.txPowerMode));
    const enc = this.state.device.encryption;
    if (enc) emit('rfEncryption', { mode: enc, enabled: enc === 'On' });
    emit(INPUT_KEY, this.channelMap((ch) => (ch.inputSource == null && ch.analogSensitivity == null ? undefined : { source: ch.inputSource ?? undefined, sensitivity: ch.analogSensitivity ?? undefined })));
    emit(TONE_KEY, this.channelMap((ch) => (ch.toneLevelDb == null && ch.toneFreqHz == null ? undefined : { level: P.toneLevelLabel(ch.toneLevelDb) ?? undefined, frequency: ch.toneFreqHz ?? undefined })));
    const dev = this.state.device;
    if (dev.name) emit('deviceName', dev.name);
    if (dev.model || dev.band || dev.fanAlwaysOn != null) {
      emit(UNIT_KEY, {
        model: dev.model, serial: dev.serial, band: dev.band, uptime: dev.uptime, deviceId: dev.name,
        fanMode: fanModeOf(dev.fanAlwaysOn), powerLock: dev.powerLock, panelLock: dev.panelLock,
        operationalPreset: P.presetName(dev.model, dev.rfModeList, dev.rfModeCode) ?? undefined,
        rfPower: dev.rfPowerTable && dev.rfModeCode != null ? dev.rfPowerTable[String(dev.rfModeCode)] : undefined,
      });
    }
  }

  // -- PropertyControl ------------------------------------------------------------------------

  async setProperty({ propertyId, channelIndex, value }) {
    const unit = this.unit;
    if (!unit?.connected)
      throw new HttpError(503, 'device_unavailable', `no live session with the ADTQ at ${this.host}`);
    const perChannel = ['mute', 'txPowerMode', 'audioMode', 'frequency', 'channelName', 'toneLevel', 'toneFrequency', 'gain', 'inputSource', 'analogSensitivity'];
    if (perChannel.includes(propertyId)) {
      if (!Number.isInteger(channelIndex) || channelIndex < 1 || channelIndex > this.channels) {
        throw new HttpError(400, 'unknown_channel', `${propertyId} is per channel; channelIndex must be 1..${this.channels}`);
      }
    }
    // in a wideband preset the RF side of a mix is its carrier channel's
    const rfChannel = this.state.channels[channelIndex]?.carrier ?? channelIndex;
    let result;
    let key;
    switch (propertyId) {
      case 'mute':
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        result = await unit.setMute(rfChannel, value);
        key = 'muted';
        break;
      case 'txPowerMode':
        if (typeof value !== 'string' || !TX_POWER_MODES.some((m) => m.toLowerCase() === value.toLowerCase()))
          throw badValue(propertyId, `one of ${TX_POWER_MODES.join(', ')}`);
        result = await unit.setTxPowerMode(rfChannel, value);
        key = 'txPowerMode';
        break;
      case 'audioMode':
        if (typeof value !== 'string' || !AUDIO_MODES.some((m) => m === value.toLowerCase().split(/\s+/)[0]))
          throw badValue(propertyId, `one of ${AUDIO_MODES.join(', ')}`);
        result = await unit.setAudioMode(channelIndex, value);
        key = 'audioMode';
        break;
      case 'frequency':
        if (!isNum(value)) throw badValue(propertyId, 'a number in MHz');
        result = await unit.setFrequencyMhz(rfChannel, value);
        key = 'frequencyMhz';
        break;
      case 'channelName':
        if (typeof value !== 'string') throw badValue(propertyId, 'a string');
        result = await unit.setChannelName(channelIndex, value);
        key = 'name';
        break;
      case 'toneLevel':
        if (!(value === 'Off' || P.TONE_LEVELS_DB.includes(Number(value)))) throw badValue(propertyId, `Off or one of ${P.TONE_LEVELS_DB.join(', ')} dB`);
        result = await unit.setToneLevel(channelIndex, value);
        key = 'toneLevelDb';
        result = { ...result, value: result.value === 'Off' ? P.TONE_OFF_DB : result.value };
        break;
      case 'toneFrequency':
        if (!isNum(value) || value < P.TONE_FREQ_MIN_HZ || value > P.TONE_FREQ_MAX_HZ) throw badValue(propertyId, `${P.TONE_FREQ_MIN_HZ}..${P.TONE_FREQ_MAX_HZ} Hz`);
        result = await unit.setToneFrequencyHz(channelIndex, value);
        key = 'toneFreqHz';
        break;
      case 'deviceName':
        if (typeof value !== 'string') throw badValue(propertyId, 'a string');
        result = await unit.setDeviceName(value);
        key = 'name';
        break;
      case 'fanMode':
        if (!FAN_MODES.includes(value)) throw badValue(propertyId, `one of ${FAN_MODES.join(', ')}`);
        result = await unit.setFanAlwaysOn(value === FAN_MODES[1]);
        key = 'fanAlwaysOn';
        break;
      case 'powerLock':
      case 'panelLock':
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        result = propertyId === 'powerLock' ? await unit.setPowerLock(value) : await unit.setPanelLock(value);
        key = propertyId;
        break;
      case 'operationalPreset': {
        const menu = P.presetMenu(this.identity?.model, this.state.device.rfModeList);
        const code = P.presetCode(this.identity?.model, this.state.device.rfModeList, value);
        if (code === null) throw badValue(propertyId, `one of ${menu.map((p) => p.name).join(' | ')}`);
        result = await unit.setOperationalPreset(code);
        if (result.restarting) this.log('info', `${this.host}: operational preset set to ${JSON.stringify(value)}; the unit is restarting to apply it and the session will drop until it is back`);
        key = 'rfModeCode';
        break;
      }
      case 'inputSource':
        if (!P.INPUT_SOURCES.includes(value)) throw badValue(propertyId, `one of ${P.INPUT_SOURCES.join(', ')}`);
        result = await unit.setInputSource(channelIndex, value);
        key = 'inputSource';
        break;
      case 'analogSensitivity':
        if (!P.ANALOG_SENSITIVITIES.includes(value)) throw badValue(propertyId, `one of ${P.ANALOG_SENSITIVITIES.join(', ')}`);
        result = await unit.setAnalogSensitivity(channelIndex, value);
        key = 'analogSensitivity';
        break;
      case 'gain':
        if (!isNum(value) || value < P.GAIN_MIN_DB || value > P.GAIN_MAX_DB) throw badValue(propertyId, `${P.GAIN_MIN_DB}..${P.GAIN_MAX_DB} dB`);
        result = await unit.setGainDb(channelIndex, value);
        key = 'gainDb';
        break;
      case 'rfEncryption':
        if (typeof value !== 'boolean') throw badValue(propertyId, 'true or false');
        result = await unit.setEncryption(value);
        key = 'encryption';
        break;
      default:
        throw new HttpError(400, 'unknown_property', `No property ${propertyId} on ${PRODUCT}`);
    }
    if (result.refused) {
      this.log('warn', `${propertyId} on channel ${channelIndex}: the unit refused ${JSON.stringify(value)} (SET_FAIL ${result.refused})`);
    }
    if (result.value === null) {
      this.log('warn', `${propertyId} on channel ${channelIndex}: no read-back from the unit; state unconfirmed`);
      return;
    }
    if (!result.ok && !result.refused) {
      this.log('warn', `${propertyId} on channel ${channelIndex}: the unit did not take ${JSON.stringify(value)}; it reads ${JSON.stringify(result.value)}`);
    }
    // the device is the truth: report what it holds, whether or not that is what was asked
    if (DEVICE_PROPERTIES.has(propertyId)) this.state.device[key] = result.value;
    else if (['muted', 'txPowerMode', 'frequencyMhz'].includes(key)) {
      // every mix on that carrier shares the value
      for (const [n, ch] of Object.entries(this.state.channels)) if ((ch.carrier ?? Number(n)) === rfChannel) this.mergeChannel(Number(n), { [key]: result.value });
    } else this.mergeChannel(channelIndex, { [key]: result.value });
    this.emitAll();
  }
}

export function createMonitoringAdapter(device, pluginConfig) {
  return new AdtqMonitoringAdapter(device, pluginConfig);
}
