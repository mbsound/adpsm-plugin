// The ADTQ as a device: discovery by SLP, one held-open ACN session, typed
// accessors for the mapped properties, and a change feed. Everything the
// adapter needs and nothing about SoundBase.

import { EventEmitter } from 'node:events';
import * as P from './properties.js';
import { AcnSession } from '../acn/session.js';
import { DMP, DMP_FAIL_REASON } from '../acn/pdu.js';
import { SLP_PORT, describeUacn, slpDiscover } from '../acn/slp.js';
import {
  CHANNEL_COUNT,
  channelList,
  channelsFor,
  CHANNEL_NAME_MAX,
  CHANNEL_PROPS,
  DEVICE_PROPS,
  METER_PROPS,
  OBJ,
  audioModeIndex,
  audioModeLabel,
  chanAddr,
  clampKhz,
  decodeProp,
  encryptionLabel,
  decodeString,
  encodeString,
  encodeU32,
  encodeU8,
  khzToMhz,
  mhzToKhz,
  quantizeKhz,
  txPowerIndex,
  txPowerLabel,
} from './properties.js';

const noop = () => {};

/**
 * Finds the ADTQ at `host`: its control port and — mandatory — its CID.
 * Returns `{ port, cid, cidText, fctn, uacn }`.
 *
 * The request goes to the SLP multicast group as well as to `host`: the real
 * unit only answers the group request (a unicast one is dropped), while a
 * fake on loopback only hears the unicast one. Resolves as soon as `host`
 * has answered; the rest of the segment's replies are ignored.
 */
export async function discoverAdtq(
  host,
  { slpPort = SLP_PORT, multicast = true, attempts = 2, timeoutMs = 3000, log = noop } = {}
) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    const replies = await slpDiscover({
      targets: [host],
      multicast,
      port: slpPort,
      timeoutMs,
      stopWhenTargetsAnswer: true,
      log,
    });
    const reply = replies.find((r) => r.from === host || r.ip === host);
    if (reply) {
      last = reply;
      if (reply.cid) break;
    }
  }
  if (!last) {
    throw new Error(
      `No ACN device answered at ${host}. Check that the ADTQ is powered, that this machine is on ` +
        `the unit's network segment (the lookup is an SLP multicast the unit will not answer by unicast), ` +
        `and that UDP/${slpPort} is not blocked between this machine and the device.`
    );
  }
  if (!last.cid) {
    throw new Error(
      `${host} answered but did not advertise its CID. Without the device's real CID a session ` +
        'request is silently ignored, so nothing can be controlled. Check for a firewall on UDP/8427.'
    );
  }
  return last;
}

export class AdtqDevice extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} [options.slpPort=8427]
   * @param {boolean} [options.multicast=true]
   * @param {boolean} [options.unicastSlp=false]
   * @param {object} [options.session] extra AcnSession options (timing overrides)
   * @param {(level: string, msg: string) => void} [options.log]
   */
  constructor({ host, slpPort = SLP_PORT, multicast = true, unicastSlp = false, session = {}, channels = null, log = noop }) {
    super();
    this.host = host;
    // the channel count is taken from the model the unit advertises, unless given
    this.channelsGiven = channels;
    this.channels = channels ?? CHANNEL_COUNT;
    this.slpPort = slpPort;
    this.multicast = multicast;
    this.unicastSlp = unicastSlp;
    this.sessionOptions = session;
    this.log = log;
    this.identity = null;
    this.session = null;
    this.closed = false;
  }

  get connected() {
    return Boolean(this.session?.ready) && !this.closed;
  }

  /** SLP discovery, then the session prologue. Resolves with the identity. */
  async connect() {
    if (this.session) throw new Error('already connected');
    const found = await discoverAdtq(this.host, { slpPort: this.slpPort, multicast: this.multicast, log: this.log });
    // an ADTD has two channels; asking it for four leaves reads that are never answered
    this.channels = this.channelsGiven ?? channelsFor(found.fctn);
    this.identity = {
      host: this.host,
      port: found.port,
      cid: found.cid,
      cidText: found.cidText,
      model: found.fctn,
      channels: this.channels,
      // what the unit advertises, whole; `label` and `band` are what it means
      name: found.uacn,
      ...describeUacn(found.uacn),
    };
    this.log('info', `${this.host}: ${found.fctn ?? '?'} "${found.uacn ?? '?'}" port ${found.port} cid ${found.cidText}`);
    const session = new AcnSession({
      host: this.host,
      port: found.port,
      deviceCid: found.cid,
      slpPort: this.slpPort,
      multicast: this.multicast,
      unicastSlp: this.unicastSlp,
      log: this.log,
      ...this.sessionOptions,
    });
    session.on('dmp', (prop) => {
      if (prop.vector !== DMP.EVENT) return;
      const decoded = decodeProp(prop.addr, prop.value);
      if (decoded && decoded.value !== null) this.emit('change', decoded);
    });
    session.on('leaving', () => this.emit('leaving'));
    session.on('close', () => {
      if (!this.closed) this.emit('dropped');
    });
    session.on('error', (err) => this.emit('error', err));
    this.session = session;
    await session.open();
    return this.identity;
  }

  async close() {
    this.closed = true;
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }

  requireSession() {
    if (!this.session?.ready) throw new Error(`no live session with ${this.host}`);
    return this.session;
  }

  // -- reads ---------------------------------------------------------------------------

  /** Every mapped property of one channel; a null field means no answer. */
  async readChannel(channel) {
    const all = await this.readChannels([channel]);
    return all.channels[channel];
  }

  /**
   * All mapped properties of the given channels in one pass.
   * Returns `{ channels: { n: {...} }, unanswered: number, asked: number }`.
   */
  async readChannels(channels = channelList(this.channels)) {
    const session = this.requireSession();
    const addrs = [];
    const plan = new Map();
    for (const ch of channels) {
      for (const prop of CHANNEL_PROPS) {
        const addr = chanAddr(ch, prop.obj);
        addrs.push(addr);
        plan.set(addr, { ch, prop });
      }
    }
    const { replies, unanswered } = await session.getMany(addrs);
    const out = {};
    for (const ch of channels) {
      out[ch] = Object.fromEntries(CHANNEL_PROPS.map((p) => [p.key, null]));
    }
    for (const [addr, reply] of replies) {
      const { ch, prop } = plan.get(addr);
      if (reply.vector === DMP.GET_REPLY) out[ch][prop.key] = prop.decode(reply.value);
    }
    // Wideband presets: a mix channel is refused (GET_FAIL, not silence) on every RF object and
    // belongs to the nearest carrier channel below it, whose frequency, group, power and mute it
    // shares. `carrier` names that channel; on a carrier, or in a narrowband preset, it is the
    // channel itself. An ADTD's channels 3-4 are refused on everything and stay empty.
    let carrier = null;
    for (const ch of [...channels].sort((a, b) => a - b)) {
      const freq = replies.get(chanAddr(ch, OBJ.FREQ_KHZ));
      if (freq && freq.vector === DMP.GET_REPLY) { carrier = ch; out[ch].carrier = ch; continue; }
      if (freq && freq.vector === DMP.GET_FAIL && carrier !== null && out[ch].name !== null) {
        for (const prop of CHANNEL_PROPS) if (prop.rf) out[ch][prop.key] = out[carrier][prop.key];
        out[ch].carrier = carrier;
      } else out[ch].carrier = null;
    }
    return { channels: out, unanswered: unanswered.length, asked: addrs.length };
  }

  /**
   * The audio meters of the given channels, one quick pass with no retry: a
   * meter reading that arrives late is worse than a tick skipped. Returns
   * `{ channels: { n: { afDb, afRDb, afDots, afRDots } }, unanswered, asked }`;
   * a null field means no answer this tick. The dots are `{ bar, peak }`.
   */
  async readMeters(channels = channelList(this.channels), { timeoutMs = 400 } = {}) {
    const session = this.requireSession();
    const addrs = [];
    const plan = new Map();
    for (const ch of channels) {
      for (const prop of METER_PROPS) {
        const addr = chanAddr(ch, prop.obj);
        addrs.push(addr);
        plan.set(addr, { ch, prop });
      }
    }
    const { replies, unanswered } = await session.getMany(addrs, { concurrency: 8, retries: 0, timeoutMs });
    const out = {};
    for (const ch of channels) out[ch] = Object.fromEntries(METER_PROPS.map((p) => [p.key, null]));
    for (const [addr, reply] of replies) {
      const { ch, prop } = plan.get(addr);
      if (reply.vector === DMP.GET_REPLY) out[ch][prop.key] = prop.decode(reply.value);
    }
    return { channels: out, unanswered: unanswered.length, asked: addrs.length };
  }

  /** Device-wide properties: `{ encryption }`. */
  async readDevice() {
    const session = this.requireSession();
    const out = {};
    for (const prop of DEVICE_PROPS) {
      const reply = await session.get(prop.addr ?? chanAddr(prop.channel, prop.obj));
      out[prop.key] = reply && reply.vector === DMP.GET_REPLY ? prop.decode(reply.value) : null;
    }
    return out;
  }

  async readAll() {
    const channels = await this.readChannels();
    const device = await this.readDevice();
    return { ...channels, device };
  }

  // -- writes ---------------------------------------------------------------------------
  // Every setter writes, reads back, and reports what the device now holds.
  // `ok` is false when the device did not take the value; `value` is the
  // decoded read-back (null when nothing came back at all). When the device
  // answered the SET with a SET_FAIL, `refused` names the reason (for
  // example 'NOT_WRITABLE'); it is absent otherwise.

  async setMute(channel, muted) {
    const session = this.requireSession();
    const r = await session.set(chanAddr(channel, OBJ.RF_MUTE), encodeU8(muted ? 1 : 0));
    return writeResult(r, r.after && r.after.length === 1 ? r.after[0] === 1 : null);
  }

  /** Frequency in MHz, quantised to the 25 kHz raster and clamped to UHF. */
  async setFrequencyMhz(channel, mhz) {
    const session = this.requireSession();
    const khz = clampKhz(quantizeKhz(mhzToKhz(mhz)));
    const r = await session.set(chanAddr(channel, OBJ.FREQ_KHZ), encodeU32(khz));
    return {
      ...writeResult(r, r.after && r.after.length === 4 ? khzToMhz(r.after.readUInt32BE(0)) : null),
      requestedMhz: khzToMhz(khz),
    };
  }

  async setTxPowerMode(channel, mode) {
    const session = this.requireSession();
    const idx = typeof mode === 'number' ? mode : txPowerIndex(mode);
    if (idx === null || idx === undefined) throw new RangeError(`unknown TX power mode ${mode}`);
    const r = await session.set(chanAddr(channel, OBJ.TX_POWER), encodeU8(idx));
    return writeResult(r, r.after && r.after.length === 1 ? txPowerLabel(r.after[0]) : null);
  }

  async setAudioMode(channel, mode) {
    const session = this.requireSession();
    const idx = typeof mode === 'number' ? mode : audioModeIndex(mode);
    if (idx === null || idx === undefined) throw new RangeError(`unknown audio mode ${mode}`);
    const r = await session.set(chanAddr(channel, OBJ.AUDIO_MODE), encodeU8(idx));
    return writeResult(r, r.after && r.after.length === 1 ? audioModeLabel(r.after[0]) : null);
  }

  /**
   * The name is read from 0x08fb but written through 0x0001: the unit answers a
   * SET on 0x08fb with SET_FAIL NOT_WRITABLE, and a SET on 0x0001 shows up on
   * both addresses at once (ADTQ G57 NACLOCK, 2026-09-08).
   */
  async setChannelName(channel, name) {
    const session = this.requireSession();
    const clean = String(name).replace(/[^\x20-\x7e]/g, '').slice(0, CHANNEL_NAME_MAX);
    const r = await session.set(chanAddr(channel, OBJ.CHAN_NAME_ALT), encodeString(clean));
    return writeResult(r, r.after ? decodeString(r.after) : null);
  }

  /** Input selection per channel: 'Rear Panel' or 'Dante'. */
  async setInputSource(channel, source) {
    const session = this.requireSession();
    const i = P.INPUT_SOURCES.indexOf(source);
    if (i < 0) throw new RangeError(`input must be one of ${P.INPUT_SOURCES.join(', ')}`);
    const r = await session.set(chanAddr(channel, OBJ.INPUT_SELECT), encodeU8(i));
    return writeResult(r, r.after && r.after.length === 1 ? P.INPUT_SOURCES[r.after[0]] ?? null : null);
  }

  /** Analog sensitivity per channel: 'Aux (+18 dBV FS)' or 'Line (+28 dBV FS)'. */
  async setAnalogSensitivity(channel, level) {
    const session = this.requireSession();
    const i = P.ANALOG_SENSITIVITIES.indexOf(level);
    if (i < 0) throw new RangeError(`sensitivity must be one of ${P.ANALOG_SENSITIVITIES.join(', ')}`);
    const r = await session.set(chanAddr(channel, OBJ.ANALOG_SENSITIVITY), encodeU8(i));
    return writeResult(r, r.after && r.after.length === 1 ? P.ANALOG_SENSITIVITIES[r.after[0]] ?? null : null);
  }

  /** Digital gain in whole dB; the unit refuses anything outside GAIN_MIN_DB..GAIN_MAX_DB. */
  async setGainDb(channel, db) {
    const session = this.requireSession();
    const n = Math.round(Number(db));
    if (!Number.isFinite(n) || n < P.GAIN_MIN_DB || n > P.GAIN_MAX_DB) throw new RangeError(`gain must be ${P.GAIN_MIN_DB}..${P.GAIN_MAX_DB} dB`);
    const r = await session.set(chanAddr(channel, OBJ.AUDIO_GAIN_DB), P.encodeI8(n));
    return writeResult(r, r.after && r.after.length === 1 ? r.after.readInt8(0) : null);
  }

  // -- the settings shared with the Axient Digital receivers (addresses read-confirmed on an ADTD) --

  /** Tone generator level: 'Off' or a dB figure from TONE_LEVELS_DB. */
  async setToneLevel(channel, level) {
    const session = this.requireSession();
    const db = typeof level === 'string' && /^off$/i.test(level) ? P.TONE_OFF_DB : Number(level);
    if (db !== P.TONE_OFF_DB && !P.TONE_LEVELS_DB.includes(db)) throw new RangeError(`tone level must be Off or one of ${P.TONE_LEVELS_DB.join(', ')} dB`);
    const r = await session.set(chanAddr(channel, OBJ.TONE_LEVEL_DB), P.encodeI8(db));
    return writeResult(r, r.after && r.after.length === 1 ? P.toneLevelLabel(r.after.readInt8(0)) : null);
  }

  async setToneFrequencyHz(channel, hz) {
    const session = this.requireSession();
    const n = Math.round(Number(hz));
    if (!Number.isFinite(n) || n < P.TONE_FREQ_MIN_HZ || n > P.TONE_FREQ_MAX_HZ) throw new RangeError(`tone frequency must be ${P.TONE_FREQ_MIN_HZ}..${P.TONE_FREQ_MAX_HZ} Hz`);
    const r = await session.set(chanAddr(channel, OBJ.TONE_FREQ_HZ), P.encodeU16(n));
    return writeResult(r, r.after && r.after.length === 2 ? r.after.readUInt16BE(0) : null);
  }

  /** The Device ID shown on the panel and in Workbench. */
  async setDeviceName(name) {
    const session = this.requireSession();
    const clean = String(name).replace(/[^\x20-\x7e]/g, '').slice(0, P.DEVICE_NAME_MAX);
    const r = await session.set(P.DEV.NAME, encodeString(clean));
    return writeResult(r, r.after ? decodeString(r.after) : null);
  }

  #setDeviceFlag(addr, on) {
    const session = this.requireSession();
    return session.set(addr, encodeU8(on ? 1 : 0)).then((r) => writeResult(r, r.after && r.after.length === 1 ? r.after[0] === 1 : null));
  }

  setPowerLock(on) {
    return this.#setDeviceFlag(P.DEV.POWER_LOCK, on);
  }

  setPanelLock(on) {
    return this.#setDeviceFlag(P.DEV.PANEL_LOCK, on);
  }

  /**
   * The operational preset, as the transmission-mode code Workbench writes (one of the unit's
   * RF_MODE_LIST). The unit reboots to apply it, so the read-back usually never comes: a SET that
   * is not refused is reported as taken with `restarting: true`, and the session will drop while
   * the unit restarts.
   */
  async setOperationalPreset(code) {
    const session = this.requireSession();
    const listReply = await session.get(P.DEV.RF_MODE_LIST);
    const codes = listReply && listReply.vector === DMP.GET_REPLY ? P.decodeModeList(listReply.value) : null;
    const n = Number(code);
    if (!codes) throw new Error('the unit did not give its preset list');
    if (!codes.includes(n)) throw new RangeError(`preset must be one of ${codes.join(', ')}`);
    const r = await session.set(P.DEV.RF_MODE_CODE, encodeU8(n), 1500);
    if (r.refused) return writeResult(r, r.after && r.after.length === 1 ? r.after[0] : null);
    if (r.after && r.after.length === 1) return { ok: r.after[0] === n, value: r.after[0] };
    return { ok: true, value: n, restarting: true };
  }

  /**
   * EXPERIMENT, command line only: write the band string at its read address. On the unit a band
   * change (from the panel's hidden menu) reboots it, resets its network configuration to DHCP and
   * resets the preset; whether this address takes a SET is what the command finds out.
   */
  async setBandExperimental(band) {
    const session = this.requireSession();
    const clean = String(band).trim().toUpperCase();
    if (!/^[A-Z][0-9]{1,2}[A-Z]?$/.test(clean)) throw new RangeError('a band looks like K54 or G57');
    const r = await session.set(P.DEV.BAND, encodeString(clean), 1500);
    if (r.refused) return writeResult(r, r.after ? decodeString(r.after) : null);
    if (r.after) return { ok: decodeString(r.after) === clean, value: decodeString(r.after) };
    return { ok: true, value: clean, restarting: true };
  }

  /**
   * Encryption, device-wide: `03` on, `00` off, written at the status object on channel 1. The
   * unit applies it a moment after the SET (the read straight after still shows the old value;
   * 2.5 s later every channel reads the new one — ADTD, 2026-10-27), so the status is polled.
   * `copies` is what every channel reads afterwards: they always agree.
   */
  async setEncryption(on) {
    const session = this.requireSession();
    const want = on ? 3 : 0;
    const r = await session.set(chanAddr(1, OBJ.ENCRYPTION), encodeU8(want));
    let status = r.after && r.after.length === 1 ? r.after[0] : null;
    for (let i = 0; i < 16 && !r.refused && status !== want; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const again = await session.get(chanAddr(1, OBJ.ENCRYPTION));
      if (again && again.vector === DMP.GET_REPLY && again.value.length === 1) status = again.value[0];
    }
    const result = writeResult({ ...r, ok: r.refused === null && status === want }, status === null ? null : encryptionLabel(status));
    const copies = {};
    for (const ch of channelList(this.channels)) {
      const reply = await session.get(chanAddr(ch, OBJ.ENCRYPTION));
      copies[ch] = reply && reply.vector === DMP.GET_REPLY ? encryptionLabel(reply.value[0]) : null;
    }
    return { ...result, copies };
  }

  /** Fan Mode: `true` for On (always), `false` for Auto. */
  setFanAlwaysOn(on) {
    return this.#setDeviceFlag(P.DEV.FAN_ALWAYS_ON, on);
  }
}

/** `{ ok, value }`, plus `refused` naming the SET_FAIL reason when the device sent one. */
function writeResult(r, value) {
  const out = { ok: r.ok, value };
  if (r.refused !== null && r.refused !== undefined) out.refused = DMP_FAIL_REASON[r.refused] ?? `code ${r.refused}`;
  return out;
}

export { CHANNEL_COUNT };
