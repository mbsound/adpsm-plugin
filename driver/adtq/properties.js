// The ADTQ's DMP property map — what is known about the device's address
// space, and the evidence grade of each entry. Everything here comes from the
// enumeration and watch work recorded in the research notes
// (ADTQ Mute/adtq_properties.md); nothing is inferred from value shape alone.
//
// Address structure:
//
//   0x02 <CH> <OBJ_HI> <OBJ_LO>
//     byte 0     0x02       device class
//     byte 1     0x00-0x03  channel index (0 = CH1 … 3 = CH4)
//     bytes 2-3  object + property index
//
// Value encodings: integers big-endian (signed where noted), strings as a
// 2-byte big-endian TOTAL length (header included) followed by ASCII.

export const CHANNEL_COUNT = 4;
export const DEVICE_CLASS = 0x02;

/** The models that speak this map and how many channels each has; an unknown model is read as the largest. */
export const MODELS = Object.freeze({ ADTQ: 4, ADTD: 2 });
/** Channels of a model as the unit advertises it in `acn-fctn` ("ADTQ", "ADTD"); 4 when unknown. */
export const channelsFor = (fctn) => MODELS[String(fctn ?? '').toUpperCase()] ?? CHANNEL_COUNT;
/** 1..n for a unit of n channels. */
export const channelList = (count) => Array.from({ length: count }, (_, i) => i + 1);

/** Object indices within a channel. `confirmed` means round-tripped or diffed live. */
export const OBJ = Object.freeze({
  CHAN_NAME_ALT: 0x0001, // confirmed mirror of CHAN_NAME
  AUDIO_GAIN_DB: 0x0102, // confirmed: signed byte, value is dB
  AUDIO_MODE: 0x0613, // confirmed: 01 stereo, 00 mono (summed)
  AF_LEVEL_L: 0x0118, // confirmed: audio level (pair B), left, signed 4-byte dB, post-gain; live
  AF_LEVEL_R: 0x011a, // confirmed: audio level (pair B), right; equals left in mono
  AF_DOTS_L: 0x01d5, // confirmed: the panel's 7-dot audio meter, left, as a bitmask (bit n = dot n+1)
  AF_DOTS_R: 0x01d6, // confirmed: the same, right
  GROUP_CHAN: 0x0802, // confirmed: string "group,channel"
  FREQ_KHZ: 0x0804, // confirmed: 4-byte kHz
  RF_MUTE: 0x080e, // confirmed: 01 muted, 00 unmuted (SET round-tripped)
  TX_POWER: 0x0811, // confirmed enum: 00 Normal, 01 High, 02 Low (identifiers, not a scale)
  POWER_LEVEL: 0x0814, // confirmed: 20 on High, 10 on Normal AND Low
  RF_STATUS: 0x081f, // probable: reads 01 while unmuted; NOT a mute mirror
  CHAN_NAME: 0x08fb, // confirmed: string
  MODEL: 0x1000, // probable: string "ADXR-A"
  ENCRYPTION: 0x2000, // confirmed: 00 off, 03 on; device-wide (all channels read alike). Writable on channel 1; applied ~2 s after the SET
  INPUT_SELECT: 0x017a, // per channel: 00 Rear Panel, 01 Dante (decoded capture 2026-10-27: Workbench SETs it both ways, the unit EVENTs it)
  INPUT_STATE: 0x0179, // per channel, the unit's answer to INPUT_SELECT: 03 with Dante selected, 01 with Rear Panel (02 on an ADTQ)
  ANALOG_SENSITIVITY: 0x0612, // per channel: 01 Line (+28 dBV FS), 00 Aux (+18 dBV FS) (capture: Workbench SET 01 for Line; 00 read on a channel on Aux)
  TONE_FREQ_HZ: 0x0127, // confirmed by read on an ADTD (2026-10-26): 2-byte Hz, 400 default; the AD4Q's address
  TONE_LEVEL_DB: 0x0128, // confirmed by read on an ADTD: signed byte dB, -128 = Off; the AD4Q's address
});

/**
 * Device-class addresses (0x01…), shared with the Axient Digital receivers: every one below
 * answered a read on an ADTD (2026-10-26) with the value its name says. Writes are verified
 * against the fake only until a unit confirms them.
 */
export const DEV = Object.freeze({
  MODEL: 0x01000000, // string: "ADTD"
  SERIAL: 0x01000002, // string: "VT262460384"
  NAME: 0x01000012, // string: the Device ID ("ADTD" by default)
  POWER_LOCK: 0x01000023, // byte: 1 locked
  FAN_ALWAYS_ON: 0x01000025, // byte: 0 Fan Mode Auto, 1 On
  UPTIME: 0x0100002b, // string: "0:07:08"
  BAND: 0x01070003, // string: "K54"
  PANEL_LOCK: 0x010c0010, // byte: 1 locked
  // the RF block. An operational preset is a transmission-mode code: Workbench changes the preset
  // with one SET of RF_MODE_CODE (a decoded capture, 2026-10-26: SET 0x0107000b = 45 for "SC
  // narrowband"), the unit reboots to apply it, and RF_MODE_LIST is the codes the band offers, in
  // Workbench's menu order (two observed pairs, 45 and 31 on an ADTD, 20 on an ADTQ, sit exactly
  // where their menu entries do). OP_PRESET is a derived identifier (5 for 45, 3 for 31) that
  // refuses a SET. RF_POWER_TABLE maps every mode code to its Low/Normal/High power in mW.
  OP_PRESET: 0x01070052, // byte: preset identifier, read-only
  RF_MODE_CODE: 0x0107000b, // byte: the transmission-mode code = the operational preset; writable
  RF_MODE_LIST: 0x0107000c, // list: the mode codes this band offers, in menu order
  RF_POWER_TABLE: 0x01070088, // table: mode code → "Low (10 mW), Normal (20 mW), High (100 mW)"
});
/**
 * Operational presets by transmission-mode code. The codes are stable; which ones a unit offers
 * depends on its model and band (RF_MODE_LIST, in Workbench's menu order): an ADTD on K54 lists
 * 11, the same ADTD on K60 lists 17 (33, 34, 8, 6, 27, 30 added after 31), an ADTQ on G57 lists
 * 15. Names were matched to codes from Workbench's menus on 2026-10-26/27; a code not named here
 * is shown as "Mode n" until a menu names it.
 */
export const PRESET_NAMES = Object.freeze({
  // ADTD
  45: 'SC narrowband', 46: 'SC narrowband, combined', 32: '2-channel wideband, spatial diversity', 31: '2-channel wideband',
  3: 'Narrowband', 2: 'Narrowband, combined', 5: 'Narrowband, spatial diversity', 0: 'Analog FM', 1: 'Analog FM, combined',
  10: 'Axient Digital Standard (PTP)', 9: 'Axient Digital Standard (PTP), combined',
  // ADTD on K60 (menu read 2026-10-27): 2-frequency variants and the 4-channel presets the band allows
  33: '2-channel wideband, 2 frequencies', 34: '2-channel wideband, 2 frequencies, combined',
  8: '4-channel wideband, spatial diversity', 6: '4-channel wideband', 27: '4-channel wideband, 2 frequencies', 30: '4-channel wideband, 2 frequencies, combined',
  // ADTQ
  20: '4-channel wideband, spatial diversity', 18: '4-channel wideband', 40: '4-channel wideband, spatial diversity, 2 frequencies',
  41: '4-channel wideband, spatial diversity, 2 frequencies, combined', 42: '4-channel wideband, 2 frequencies',
  43: '4-channel wideband, 2 frequencies, combined', 28: '4-channel wideband, 4 frequencies', 14: 'Narrowband', 13: 'Narrowband, combined',
  26: 'Narrowband, spatial diversity', 16: 'Narrowband, spatial diversity, combined', 11: 'Analog FM', 12: 'Analog FM, combined',
  23: 'Axient Digital Standard (PTP)', 22: 'Axient Digital Standard (PTP), combined',
});
/** RF_MODE_LIST: u16 total length, u32 count, a type byte, then u32 codes. */
export function decodeModeList(v) {
  if (!v || v.length < 7 || v.readUInt16BE(0) !== v.length) return null;
  const n = v.readUInt32BE(2);
  if (7 + 4 * n > v.length) return null;
  return Array.from({ length: n }, (_, i) => v.readUInt32BE(7 + 4 * i));
}
export function encodeModeList(codes) {
  const b = Buffer.alloc(7 + 4 * codes.length);
  b.writeUInt16BE(b.length, 0); b.writeUInt32BE(codes.length, 2); b[6] = 0x07;
  codes.forEach((c, i) => b.writeUInt32BE(c, 7 + 4 * i));
  return b;
}
/** `[{ code, name }]` for the unit's mode list, in the unit's order; an unnamed code is "Mode n". */
export const presetMenu = (model, codes) => (codes ?? []).map((code) => ({ code, name: PRESET_NAMES[code] ?? `Mode ${code}` }));
export const presetName = (model, codes, code) => (code == null ? null : PRESET_NAMES[code] ?? `Mode ${code}`);
/** A preset whose mixes share carriers: the RF side of a mix lives on its carrier channel. */
export const isWidebandCode = (code) => /wideband/i.test(PRESET_NAMES[code] ?? '');
export const presetCode = (model, codes, name) => presetMenu(model, codes).find((p) => p.name === name)?.code ?? null;
export const DEVICE_NAME_MAX = 31;
/** Digital gain limits the unit accepts (an ADTD, 2026-10-26: -20 and +16 taken, -21 and +17 refused with SET_FAIL 5). */
export const GAIN_MIN_DB = -20;
export const GAIN_MAX_DB = 16;
export const TONE_OFF_DB = -128;
export const TONE_LEVELS_DB = Object.freeze([-60, -54, -48, -42, -36, -30, -24, -18, -12, -6, 0]);
export const TONE_FREQ_MIN_HZ = 400;
export const TONE_FREQ_MAX_HZ = 1000;
/** 'Off' for the unit's -128, else the dB figure. */
export const toneLevelLabel = (db) => (db == null ? null : db === TONE_OFF_DB ? 'Off' : db);

/**
 * Live audio level readings, not RF, each as [left, right]: three pairs in dB
 * (signed 4-byte, measured after the gain stage) and one coarse pair (1 byte).
 * Confirmed by two stated predictions on a real unit: in mono each pair reads
 * identically (the summed signal feeds both sides), and with only the right
 * input fed the first member of every pair fell to the floor while the second
 * held programme level. What distinguishes pairs a, b and c, and the coarse
 * pair's scale, are not confirmed. See docs/adtq-properties.md, "Audio levels".
 */
export const OBJ_AUDIO_LEVELS = Object.freeze({
  a: [0x0117, 0x0119], // ~12 dB below pair b on music and on noise: average-like
  b: [0x0118, 0x011a], // the highest of the three: peak-like
  c: [0x01d3, 0x01d4], // 1-3 dB under pair b at every gain on every channel
  dots: [0x01d5, 0x01d6], // the panel's 7-dot meter as a bitmask; see decodeDots
});

export const TX_POWER_MODES = Object.freeze(['Normal', 'High', 'Low']);
const TX_POWER_BY_INDEX = Object.freeze({ 0: 'Normal', 1: 'High', 2: 'Low' });
const TX_POWER_INDEX = Object.freeze({ normal: 0, high: 1, low: 2 });

export const AUDIO_MODES = Object.freeze(['stereo', 'mono']);
const AUDIO_MODE_BY_INDEX = Object.freeze({ 1: 'stereo', 0: 'mono' });
const AUDIO_MODE_INDEX = Object.freeze({ stereo: 1, mono: 0 });

const ENCRYPTION_BY_INDEX = Object.freeze({ 0: 'Off', 3: 'On' });

export const FREQ_RASTER_KHZ = 25;
// the UHF sanity range the reference tool guards with; the band limits of a
// particular ADTQ are not readable over DMP, and the device refuses a
// frequency outside its band (the read-back then shows it unchanged)
export const FREQ_MIN_KHZ = 400_000;
export const FREQ_MAX_KHZ = 1_000_000;
export const CHANNEL_NAME_MAX = 8;
export const INPUT_SOURCES = Object.freeze(['Rear Panel', 'Dante']);
export const ANALOG_SENSITIVITIES = Object.freeze(['Aux (+18 dBV FS)', 'Line (+28 dBV FS)']);
const byIndex = (list) => (v) => (v && v.length === 1 && v[0] < list.length ? list[v[0]] : null);

export function chanAddr(channel, obj) {
  if (!Number.isInteger(channel) || channel < 1 || channel > CHANNEL_COUNT)
    throw new RangeError(`channel must be 1..${CHANNEL_COUNT} (got ${channel})`);
  return ((DEVICE_CLASS << 24) | ((channel - 1) << 16) | obj) >>> 0;
}

/** `{ channel, obj }` of an address in this device class, or null. */
export function splitAddr(addr) {
  if ((addr >>> 24) !== DEVICE_CLASS) return null;
  const ch = ((addr >>> 16) & 0xff) + 1;
  if (ch < 1 || ch > CHANNEL_COUNT) return null;
  return { channel: ch, obj: addr & 0xffff };
}

/** Shure string: 2-byte big-endian TOTAL length (header included), then ASCII. */
export function decodeString(v) {
  if (!v || v.length < 2) return null;
  if (v.readUInt16BE(0) !== v.length) return null;
  const body = v.subarray(2);
  for (const b of body) if (b < 0x20 || b > 0x7e) return null;
  return body.toString('ascii');
}

export function encodeString(s) {
  const body = Buffer.from(String(s), 'ascii');
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(out.length, 0);
  body.copy(out, 2);
  return out;
}

export function decodeInt(v, signed = false) {
  if (!v || !v.length || v.length > 6) return null;
  return signed ? v.readIntBE(0, v.length) : v.readUIntBE(0, v.length);
}

export const encodeU8 = (n) => Buffer.from([n & 0xff]);
export const encodeU16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
export const encodeI8 = (n) => Buffer.from([n & 0xff]);
export const encodeU32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

export const txPowerLabel = (raw) => TX_POWER_BY_INDEX[raw] ?? null;
export const txPowerIndex = (label) => TX_POWER_INDEX[String(label).trim().toLowerCase()] ?? null;
export const audioModeLabel = (raw) => AUDIO_MODE_BY_INDEX[raw] ?? null;
export const audioModeIndex = (label) => AUDIO_MODE_INDEX[String(label).trim().toLowerCase().split(/\s+/)[0]] ?? null;
export const encryptionLabel = (raw) => ENCRYPTION_BY_INDEX[raw] ?? null;

export const khzToMhz = (khz) => Math.round(khz) / 1000;
export const mhzToKhz = (mhz) => Math.round(mhz * 1000);
export const quantizeKhz = (khz) => Math.round(khz / FREQ_RASTER_KHZ) * FREQ_RASTER_KHZ;
export const clampKhz = (khz) => Math.min(FREQ_MAX_KHZ, Math.max(FREQ_MIN_KHZ, khz));

/** "1,3" -> { group: 1, channel: 3 } */
export function parseGroupChannel(s) {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(s ?? '');
  return m ? { group: Number(m[1]), channel: Number(m[2]) } : null;
}

/**
 * The per-channel objects the plugin reads, with how each decodes. `name` is the channel's own
 * name at the address the name is written to: in a wideband preset the unit answers the read
 * address only on a carrier channel, with the composite of its mixes' names ("Channel1,Channel2")
 * — that is `carrierName`. The objects marked `rf` answer only on a carrier channel in a wideband
 * preset (ADTQ in "4-channel wideband, spatial diversity", 2026-10-27); a mix channel inherits them
 * from its carrier in `readChannels`.
 */
export const CHANNEL_PROPS = Object.freeze([
  { key: 'name', obj: OBJ.CHAN_NAME_ALT, decode: decodeString },
  { key: 'carrierName', obj: OBJ.CHAN_NAME, decode: decodeString, rf: true },
  { key: 'groupChannel', obj: OBJ.GROUP_CHAN, decode: (v) => parseGroupChannel(decodeString(v)), rf: true },
  { key: 'frequencyMhz', obj: OBJ.FREQ_KHZ, decode: (v) => (v.length === 4 ? khzToMhz(decodeInt(v)) : null), rf: true },
  { key: 'muted', obj: OBJ.RF_MUTE, decode: (v) => (v.length === 1 ? v[0] === 1 : null), rf: true },
  { key: 'txPowerMode', obj: OBJ.TX_POWER, decode: (v) => txPowerLabel(decodeInt(v)), rf: true },
  { key: 'gainDb', obj: OBJ.AUDIO_GAIN_DB, decode: (v) => (v.length === 1 ? decodeInt(v, true) : null) },
  { key: 'audioMode', obj: OBJ.AUDIO_MODE, decode: (v) => audioModeLabel(decodeInt(v)) },
  { key: 'rfStatus', obj: OBJ.RF_STATUS, decode: (v) => decodeInt(v), rf: true },
  { key: 'toneFreqHz', obj: OBJ.TONE_FREQ_HZ, decode: (v) => (v.length === 2 ? decodeInt(v) : null) },
  { key: 'toneLevelDb', obj: OBJ.TONE_LEVEL_DB, decode: (v) => (v.length === 1 ? decodeInt(v, true) : null) },
  { key: 'inputSource', obj: OBJ.INPUT_SELECT, decode: byIndex(INPUT_SOURCES) },
  { key: 'analogSensitivity', obj: OBJ.ANALOG_SENSITIVITY, decode: byIndex(ANALOG_SENSITIVITIES) },
]);

const decodeBool = (v) => (v && v.length === 1 ? v[0] === 1 : null);
const decodeByte = (v) => (v && v.length === 1 ? v[0] : null);
/**
 * The RF power table: u16 total length, u32 entry count, two type bytes, then per entry a key and
 * a label, each a u32-length-prefixed string (the length counts its own 4 bytes). Returns
 * `{ '45': 'Low (10 mW), Normal (20 mW), High (100 mW)', … }`, or null when the bytes are not that.
 */
export function decodePowerTable(v) {
  if (!v || v.length < 8 || v.readUInt16BE(0) !== v.length) return null;
  const out = {};
  let i = 8;
  const str = () => { if (i + 4 > v.length) return null; const n = v.readUInt32BE(i); if (n < 4 || i + n > v.length) return null; const s = v.subarray(i + 4, i + n).toString('latin1'); i += n; return s; };
  while (i < v.length) { const k = str(); const label = str(); if (k === null || label === null) return null; out[k] = label; }
  return out;
}
export const encodePowerTable = (table) => {
  const parts = [];
  for (const [k, label] of Object.entries(table)) for (const s of [k, label]) { const b = Buffer.alloc(4 + s.length); b.writeUInt32BE(b.length, 0); b.write(s, 4, 'latin1'); parts.push(b); }
  const body = Buffer.concat(parts); const head = Buffer.alloc(8); head.writeUInt16BE(8 + body.length, 0); head.writeUInt32BE(Object.keys(table).length, 2); head[6] = 0x0e; head[7] = 0x0e;
  return Buffer.concat([head, body]);
};
export const DEVICE_PROPS = Object.freeze([
  { key: 'encryption', obj: OBJ.ENCRYPTION, channel: 1, decode: (v) => encryptionLabel(decodeInt(v)) },
  { key: 'model', addr: DEV.MODEL, decode: decodeString },
  { key: 'serial', addr: DEV.SERIAL, decode: decodeString },
  { key: 'name', addr: DEV.NAME, decode: decodeString },
  { key: 'powerLock', addr: DEV.POWER_LOCK, decode: decodeBool },
  { key: 'fanAlwaysOn', addr: DEV.FAN_ALWAYS_ON, decode: decodeBool },
  { key: 'uptime', addr: DEV.UPTIME, decode: decodeString },
  { key: 'band', addr: DEV.BAND, decode: decodeString },
  { key: 'panelLock', addr: DEV.PANEL_LOCK, decode: decodeBool },
  { key: 'opPreset', addr: DEV.OP_PRESET, decode: decodeByte },
  { key: 'rfModeCode', addr: DEV.RF_MODE_CODE, decode: decodeByte },
  { key: 'rfModeList', addr: DEV.RF_MODE_LIST, decode: decodeModeList },
  { key: 'rfPowerTable', addr: DEV.RF_POWER_TABLE, decode: decodePowerTable },
]);
const DEVICE_PROP_BY_ADDR = new Map(DEVICE_PROPS.filter((p) => p.addr).map((p) => [p.addr, p]));

/**
 * The live audio meters, read on their own fast cadence and never part of the
 * settings refresh. Pair B of the audio levels: the highest of the three dB
 * pairs, peak-like, with left/right confirmed. The dB reference is not
 * confirmed (dBFS is the contract's unit and the likely one).
 */
const decodeDb = (v) => (v.length === 4 ? v.readInt32BE(0) : null);

export const AF_DOT_COUNT = 7;

/**
 * The front-panel audio meter byte: bit n lit means dot n+1 lit. The solid
 * run of low bits is the level bar; a lone higher bit is the peak-hold dot.
 * 0b0011111 -> 5 dots; 0b0010111 -> a bar of 3 with the peak dot at 5.
 * Returns `{ bar, peak }` in dots (0..7), `peak` being the highest lit dot.
 */
export function decodeDots(v) {
  if (!v || v.length !== 1) return null;
  const bits = v[0];
  let bar = 0;
  while (bar < 8 && (bits >> bar) & 1) bar += 1;
  const peak = bits ? 32 - Math.clz32(bits) : 0;
  return { bar, peak };
}

export const METER_PROPS = Object.freeze([
  { key: 'afDb', obj: OBJ.AF_LEVEL_L, decode: decodeDb },
  { key: 'afRDb', obj: OBJ.AF_LEVEL_R, decode: decodeDb },
  { key: 'afDots', obj: OBJ.AF_DOTS_L, decode: decodeDots },
  { key: 'afRDots', obj: OBJ.AF_DOTS_R, decode: decodeDots },
]);

const CHANNEL_PROP_BY_OBJ = new Map(CHANNEL_PROPS.map((p) => [p.obj, p]));

/**
 * Decodes one property PDU's address and value into `{ channel, key, value }`
 * — null for an address the plugin does not model. Used both for read-backs
 * and for the EVENTs the device pushes when something changes.
 */
export function decodeProp(addr, value) {
  const dev = DEVICE_PROP_BY_ADDR.get(addr >>> 0);
  if (dev) return { channel: null, key: dev.key, value: dev.decode(value) };
  const split = splitAddr(addr);
  if (!split) return null;
  const prop = CHANNEL_PROP_BY_OBJ.get(split.obj);
  if (prop) return { channel: split.channel, key: prop.key, value: prop.decode(value) };
  if (split.obj === OBJ.ENCRYPTION)
    return { channel: null, key: 'encryption', value: encryptionLabel(decodeInt(value)) };
  return null;
}
