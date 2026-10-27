# ADTQ DMP property map

Observed on a **Shure ADTQ, "ADTQ G57 NACLOCK"** (10.10.1.175, CID
`DD2D453E-0000-11DD-A000-000EDDCCCCCC`) by enumeration with
[`adtq_explore.py`](adtq_explore.py). Regenerate with:

```bash
python3 adtq_explore.py scan --ch 1 --from 0000 --to 1fff --out map.txt
```

## Address structure

    0x02 <CH> <OBJ_HI> <OBJ_LO>
      byte 0     0x02       device class
      byte 1     0x00-0x03  channel index (0 = CH1 … 3 = CH4)
      bytes 2-3  object + property index

Every object below is per-channel: add `0x00010000` per channel, so CH1 frequency is
`0x02000804` and CH3 frequency is `0x02020804`.

## Value encodings

| Kind | Format | Example |
|---|---|---|
| Integer | big-endian, 1-4 bytes | `0014` = 20 |
| Signed | two's complement | `ffffff9a` = -102 |
| String | 2-byte big-endian TOTAL length (header included), then ASCII | `000a` + `Channel1` |

## Confirmed

Verified by evidence, not inference.

| Object | Bytes | Meaning | Evidence |
|---|---|---|---|
| `0x080e` | 1 | **RF mute** (`01` = muted, `00` = unmuted) | Round-tripped SET/GET in both directions on all 4 channels |
| `0x0804` | 4 | **Frequency, kHz** | Four distinct in-band values (470.625 / 471.225 / 471.725 / 472.300 MHz), all on Shure's 25 kHz raster, for a G57 unit |
| `0x0802` | str | **Group,channel** | `"1,1"` `"1,2"` `"1,3"` `"1,4"` — tracks channel index |
| `0x08fb` | str | **Channel name** (read; not writable) | `"Channel1"` … `"Channel4"`. A SET here is answered with SET_FAIL `0x04` NOT_WRITABLE (CH1, 2026-09-08). |
| `0x0001` | str | **Channel name, writable** | Same value as `0x08fb`, both channels checked. Writing `"EDITED"` here on CH1 read back on `0x0001` within 6 ms and on `0x08fb` within 1.5 s, so this is the address the plugin writes and `0x08fb` mirrors it. |
| `0x0102` | 1 | **Digital audio gain, dB** — signed, raw value = dB | 16 dB -> 9 dB moved it `0x10` -> `0x09`; a full 117-property diff of that change touched only this and the encryption byte, 0 unread. Negative confirmed separately: CH2 set to -8 dB reads `0xf8`. |
| `0x0613` | 1 | **Audio mode** — `01` = Stereo, `00` = Mono (summed). Per channel. | Found by cross-channel comparison (CH2 mono was the only unexplained difference against CH3 == CH4, from 468 addresses, 0 unread), then confirmed by a prediction stated in advance: flipping CH3 to mono would move `0x02020613` `01` -> `00`. It did, while CH2 and CH4 held. |
| `0x2000` | 1 | **Encryption** (`00` = off, `03` = on). Device-wide: WWB warns the setting applies to all channels, and all four channels read identically. | Three independent readings: `00` before it was ever touched, `03` with encryption on, `00` again after turning it off. A full 117-property diff of the on->off transition moved this address and **nothing else**, with 0 addresses unread. |
| `0x0811` | 1 | **Transmit power** (enum index) | `00` = Normal, `01` = High, `02` = Low. Tracked the WWB setting across four transitions. A full-map diff of Low -> Normal moved this address and **nothing else** (1 change in 111 properties). |
| `0x0814`, `0x0884`, `0x0885` | 2 | **Power level, High vs not** | All three read 20 on High and 10 on both Normal and Low. They distinguish High from the other two but do NOT separate Normal from Low, so they cannot encode the setting on their own — `0x0811` does that. |
| `0x0117` L, `0x0119` R | 4 | **Audio level, pair A**, dB, signed, post-gain | Live; moves only on the channel carrying audio. Mono made L and R identical in 41/41 samples and stereo split them again; right-only input dropped L to -85 while R held -18. ~12-14 dB under pair B on music and on idle noise alike, so average-like — that last part is a hypothesis. See "Audio levels". |
| `0x0118` L, `0x011a` R | 4 | **Audio level, pair B**, dB, signed, post-gain | Same two predictions held (right-only: L -78, R -13). The highest of the three pairs, so peak-like — hypothesis. A gain change moves it; -255 on a channel with nothing connected. **Exposed** as the card's meters (`meters.af` / `meters.afR`), polled every 100 ms by default. |
| `0x01d3` L, `0x01d4` R | 4 | **Audio level, pair C**, dB, signed, post-gain | Same two predictions held (right-only: L -78, R -13). Sits 1-3 dB under pair B at every gain on every channel; what separates it from B is unknown. |
| `0x01d5` L, `0x01d6` R | 1 | **Front-panel audio meter, 7 dots, as a bitmask** — bit n lit = dot n+1 lit; the solid low run is the bar, a lone higher bit the peak-hold dot | Sides confirmed like the dB pairs (right-only: L 0, R 31). The operator read 5 dots on the panel while the byte read 31 = `0011111`; a gain sweep then walked it 31 → 15 → 7 → 3 → 1 (5, 4, 3, 2, 1 dots) as pair B fell -13 → -49 dB. 23, 39, 47 and 11 are a bar plus one higher bit: the peak-hold dot. **Exposed** as `x.shure-adtq.afDots`. |

## Probable

Consistent with the evidence but NOT confirmed. Verify with
`python3 adtq_explore.py watch --ch 1` before relying on any of these.

| Object | Bytes | Hypothesis | Why, and what's unproven |
|---|---|---|---|
| `0x0805` | 1 | Unknown | Reads `02` on all 4 channels. Was the leading TX-power candidate on shape alone; a live power change **disproved it** — it did not move. Left unidentified. |
| `0x081f` | 1 | RF status | Reads `01` while `0x080e` reads `00`, so it is NOT a mute mirror |
| `0x0f10`-`0x0f17` | 16 | Linked-device CIDs | Slot 0 = `ff2db752-0000-11dd-a000-000eddcccccc`, Shure CID format; slots 1-7 zero. That CID advertises nowhere on the LAN. |
| `0x0f20`-`0x0f27` | 16 | Linked-device class IDs | Slot 0 ends `0015c5f3f612`, the same suffix as every DCID in the SLP adverts; slots 1-7 zero |
| `0x1000` | str | Model / slot label | `"ADXR-A"`; `0x1001`-`0x1007` all read `0002` |
| `0x1600`-`0x1632` | 1-2 | Unassigned table | All read `ff` / `00ff` (= -1 / 255), the usual "empty slot" idiom |

### TX power enum (`0x0811`) — complete

| Index | WWB label | `0x0814` / `0x0884` / `0x0885` |
|---|---|---|
| `00` | Normal | 10 |
| `01` | High | 20 |
| `02` | Low | 10 |

All three verified against the WWB display, across four transitions:
initial (High) -> Normal -> Low -> Normal -> High. The High reading was confirmed by a
prediction stated *before* the test (`0x0811` -> `01`, `0x0814` -> 20); both landed.

Full-map diffs (111 properties, 0 unanswered) at each step:

| Transition | Addresses changed |
|---|---|
| Low -> Normal | 1 — `0x0811` alone |
| Normal -> High | 4 — `0x0811`, `0x0814`, `0x0884`, `0x0885` |
| initial state -> High (round trip) | **0** — byte-for-byte identical |

The round trip is the strongest single piece of evidence here: after four setting changes
the device returned to a state indistinguishable from the first scan across every
property. That confirms the initial state was High and that nothing else drifted.

**Do not read the index as an ordering.** `00` = Normal sits between `02` = Low and
`01` = High. The values are identifiers, not a scale.

`0x0814` and its two companions read 20 on High and 10 on **both** Normal and Low, so
they track power but cannot distinguish Normal from Low. Only `0x0811` identifies the
setting uniquely. Whether 20/10 are milliwatts is unconfirmed — plausible for High and
Normal, but a "Low" that also reads 10 does not fit that reading cleanly.

## Identifying a property

Two cautionary tales here, and the second is the sharper one.

`0x0805` reads `02` on every channel — a constant single byte sitting two addresses from
frequency, exactly what a power enum looks like. It is not. A live power change left it
untouched. Value *shape* generates hypotheses, never evidence.

`0x0814` is the subtler trap: it moved 20 -> 10 in lockstep with the first power change,
on the right channel, while 416 other properties stayed still. "Power in mW" fit
perfectly. It was still wrong — the next change (Normal -> Low) moved `0x0811` and left
`0x0814` alone. It turned out to be power-related but unable to separate Normal from Low.
**One correlated change is not identification.** Take a second data point on a different
transition before believing an address.

The third lesson cost the most time and had nothing to do with the device: a state was
reported as "High" when WWB was actually displaying "Normal". The device had been
self-consistent throughout; the label was wrong. Before concluding that hardware is
behaving contradictorily, re-verify what the control surface actually shows. The fix was
to state a falsifiable prediction *before* the next test — `0x0811` -> `01` and
`0x0814` -> 20 — and check it, rather than fitting a story to whatever arrived.

To identify a property, watch the whole known map and change the control:

```bash
python3 adtq_explore.py watch --objects objects.txt
```

Two practical notes. Change the setting on **one channel** if you can — the per-channel
address falls straight out of it. And `watch` suppresses the audio level readings by default
(`--ignore`), because they move a few dB every poll and otherwise bury the single
discrete change you are looking for in a wall of noise.

### Audio mode (`0x0613`)

| Value | Mode |
|---|---|
| `01` | Stereo |
| `00` | Mono (summed) |

Per channel, unlike encryption. Confirmed on two channels independently.

`0x0612` sits adjacent and is **not** part of this: it reads `00` on CH1 and `01` on
CH2/3/4 regardless of mode (CH4 is stereo and reads `01`, CH1 is stereo and reads `00`).
It tracks something CH1-specific and remains unidentified.

### Audio levels (`0x0117`-`0x011a`, `0x01d3`-`0x01d6`)

Earlier sweeps graded `0x0117`-`0x011a` and `0x01d3`/`0x01d4` as "RF level, dBm"
because they drifted. On 2026-09-09, with programme audio fed to CH1 only, a full
117-property sweep sampled six times found exactly eight addresses moving, all on CH1:
those six plus `0x01d5`/`0x01d6`. CH2-4, with no audio, held steady at noise-floor
values (CH3, with nothing connected, read -255 everywhere and 0 on the coarse pair).

A prediction stated before the second data point: if these are left/right audio meters,
switching CH1 to mono (summed) makes each pair read the same value, and switching back
separates them. Sampled at ~7 Hz through stereo → mono → stereo:

| Phase | `0x0117` / `0x0119` | `0x0118` / `0x011a` | `0x01d3` / `0x01d4` | `0x01d5` / `0x01d6` |
|---|---|---|---|---|
| stereo | -24 / -26, -25 / -28, -26 / -30 … | -13 / -14, -11 / -12 … | -14 / -17, -15 / -19 … | 47 / 23, 39 / 23, 31 / 23 … |
| mono | identical in all 41 samples | identical in all 41 samples | identical in all 41 samples | identical in all 41 samples |
| stereo again | -27 / -24, -25 / -23 … | -13 / -14, -14 / -15 … | -14 / -15 … | 23 / 31 … |

So each pair is one measurement taken on both sides of the channel. The source was a
near-centre stereo programme, which is why the sides differ by only a few dB in stereo.
Both modes are therefore described by the same addresses: in mono the two sides agree.

All three dB pairs sit **after the gain stage**: taking CH1's gain from +9 to -8 dB moved
every pair down together (pair A -24 → -49, B -12 → -35, C -14 → -38 at the median) while
their spacing held, and the coarse pair fell from 23..47 to a steady 3. The drop exceeded
the 17 dB gain change, so the programme level moved as well; the gain alone cannot be
read off these numbers, but no pair is a pre-gain input reading.

**Sides.** Prediction stated before the reading: with only the right side fed, one member
of each pair stays at programme level and the other falls to the noise floor, and the one
that stays is right. With CH1 at 16 dB gain and the right input only, 40 samples:

| Pair | first address | second address |
|---|---|---|
| A | `0x0117`: -85 | `0x0119`: -17..-18 |
| B | `0x0118`: -77..-79 | `0x011a`: -13 |
| C | `0x01d3`: -77..-80 | `0x01d4`: -13 |
| coarse | `0x01d5`: 0 | `0x01d6`: 31 |

So in every pair the lower address is **left** and the higher is **right**.

**The dot meter.** The operator watched the panel: 5 dots lit while `0x01d6` read 31,
which is `0011111`. A gain sweep from +16 to -20 dB with the right input fed then gave:

| Gain | pair B right (dB) | `0x01d6` | binary | dots |
|---|---|---|---|---|
| 16..11 | -13..-17 | 31 | `0011111` | 5 |
| 10..4 | -19..-22 | 15 | `0001111` | 4 |
| 3 | -22 | 11 | `0001011` | bar 2, peak dot 4 |
| 2..-6 | -27..-30 | 7 | `0000111` | 3 |
| -7..-18 | -36..-42 | 3 | `0000011` | 2 |
| -19, -20 | -48, -49 | 1 | `0000001` | 1 |

So the byte is the panel's 7-dot column as a bitmask, bit n for dot n+1: the solid run
of low bits is the level bar and a lone higher bit is the peak-hold dot (23, 39, 47 from
the earlier runs are bars of 3 or 4 with the peak dot at 5 or 6). `decodeDots` in
`properties.js` returns `{ bar, peak }`. Dot thresholds against pair B, from where each
dot went out, are roughly -18 (dot 5), -24 (4), -33 (3), -45 (2), below -50 (1); the
thresholds for dots 6 and 7 were not reached.

The same sweep pins pair B's unit: a 36 dB gain change moved it exactly 36 dB, so it is
dB one-for-one with gain.

What is **not** confirmed: what distinguishes the three dB pairs (pair B sits ~12-14 dB
above pair A on music and on idle noise alike, a crest factor; pair C sits 1-3 dB under
pair B at every gain), and the dB reference. Whether the figures are dBFS is untested; a
tone at a known level into the channel would settle it.

### Digital gain (`0x0102`)

Single byte, value **is** the dB figure — 16 dB reads `0x10`, 9 dB reads `0x09`. Per
channel: CH2-4 read `00` (0 dB) while CH1 was set.

**Negative gain confirmed** as two's complement: CH2 set to -8 dB reads `0xf8`. Decode
the byte as signed, not unsigned — an unsigned read reports 248 dB. Range is therefore
-128..127 dB nominally, though the device's own usable range will be narrower.

### Encryption (`0x2000`)

| Value | State |
|---|---|
| `00` | off (confirmed) |
| `03` | on (confirmed) |

`03` rather than `01` suggests an enum or bitmask — possibly a cipher/mode selector — so
do not assume any non-zero value means "on", and do not assume `01` is valid. Only these
two values have been observed.

WWB warns that the setting applies to **all channels**, and all four channels read the
same value. Whether the device stores one shared value or four replicated copies is
untested; writing a single channel's copy would distinguish them, but that is a
device-wide security setting and was not written here.

This property sits at object `0x2000`, **outside** the `0x0000`-`0x1fff` range that every
earlier sweep covered. It was only findable because a sparse probe of `0x2000`-`0xffff`
turned up isolated properties at `0x2000` and `0x4000`. Had the diff been run over the
original range it would have come back empty, and the obvious (wrong) conclusion would
have been that encryption is not exposed over DMP at all. Absence of evidence is only
evidence of absence once the search space is known.

## Scanning caveat

The device answers **every** GET — `GET_REPLY` (vec 3) if the property exists,
`GET_FAIL` (vec 9, reason `0x02`) if it does not. Silence therefore always means a lost
packet, never an absent property.

This matters. A first sweep at a flat 16-GETs-per-20ms lost **41% of its probes** and
reported 84 properties; with retries the same range returns **111 properties and zero
unanswered**. The 27 recovered addresses were an entire contiguous block (`0x1600`+)
that the fast sweep missed completely. `scan()` now re-fires anything that stays silent,
halving the burst and doubling the gap each round, and reports whatever is still
unanswered as UNKNOWN rather than absent.

## Note on the DDL

The SLP advert points at `tftp://<ip>/$.ddl`, which would name every property, but the
ADTQ runs no TFTP server (and no open TCP ports at all), so it cannot be fetched from
the device. Wireless Workbench ships the same data locally at
`Wireless Workbench.app/Contents/Resources/Data/DDL.dat`, but it is an AES-encrypted ZIP.
Enumeration plus `watch` is the route used here.

## Added 2026-10-26: the settings shared with the Axient Digital receivers

Read on an ADTD ("ADTD K54 NACLOCK", firmware as shipped) at the addresses the Shure AD4Q/AD4D
use for the same settings; every one answered with the value its name says. Writes are
exercised against the fake and on the unit as noted.

| Address | Bytes | Meaning | Evidence |
|---|---|---|---|
| `0x01000000` | str | Model | reads `"ADTD"` |
| `0x01000002` | str | Serial | reads `"VT262460384"` |
| `0x01000012` | str | Device ID (the unit's name) | reads `"ADTD"` (default = model). **Exposed**, writable (`deviceName`) |
| `0x01000023` | 1 | Power Lock | reads `00` unlocked. **Exposed**, writable (`powerLock`) |
| `0x01000025` | 1 | Fan Mode (`00` Auto, `01` On) | reads `00`. **Exposed**, writable (`fanMode`) |
| `0x0100002b` | str | Uptime | reads `"0:07:08"` |
| `0x01070003` | str | Band | reads `"K54"` |
| `0x010c0010` | 1 | Front Panel Lock | reads `00`. **Exposed**, writable (`panelLock`) |
| `0x0127` (per channel) | 2 | Tone Frequency, Hz | reads `0190` = 400, the default. **Exposed**, writable 400–1000 (`toneFrequency`) |
| `0x0128` (per channel) | 1 | Tone Level, dB signed; `80` = −128 = Off | reads `80`. **Exposed**, writable Off / −60…0 in 6 dB (`toneLevel`) |

Refused on the ADTD (GET_FAIL 0x02), so receiver-only: `0x01070004` HD mode, `0x01070405`
antenna bias, channel `0x0104` audio mute, `0x0114` audio level, `0x0125` overload hold,
`0x0126` tone active, `0x0812`/`0x0813` RF levels, `0x0860` diversity, `0x1212`, `0x110f`/`0x1111`
transmitter roster.

**Digital gain `0x0102`, write limits** (ADTD, 2026-10-26): −20 … +16 dB taken and read back; −21 and
+17 refused with SET_FAIL 0x05. Exposed writable as `gain`, step 1 dB.

**Operational preset, the RF block** (ADTD, 2026-10-26). A sweep of every device-class address
before and after Workbench switched the unit from "SC narrowband" to "2-channel wideband" moved
exactly these, besides the uptime (the unit rebooted) and the temperature-looking byte
`0x01000024`; a decoded capture of Workbench then showed how it makes the change: **one SET of
`0x0107000b`** (value 45 for "SC narrowband"), followed by the unit's EVENT on the same address
and its reboot.

| Address | Before | After | Meaning |
|---|---|---|---|
| `0x0107000b` | `2d` (45) | `1f` (31) | **The operational preset, as a transmission-mode code.** This is what Workbench writes. **Exposed**, writable (`operationalPreset`); the unit reboots to apply it. Written live by the plugin's `preset` command (45 → 3, "Narrowband"): the unit restarted and read 3 back |
| `0x0107000c` | — | — | the mode codes this band offers, **in Workbench's menu order**: ADTD K54 `45,46,32,31,3,2,5,0,1,10,9` (11 = the ADTD menu), ADTQ G57 `20,18,40,41,42,43,28,14,13,26,16,11,12,23,22` (15 = the ADTQ menu). u16 total length, u32 count, a type byte `07`, then u32 codes. Checks: 45 is entry 1 "SC narrowband" and 31 entry 4 "2-channel wideband" on the ADTD, 20 entry 1 "4-channel wideband, spatial diversity" on the ADTQ, and every "combined" entry lands on a 20 mW High entry of the power table |
| `0x01070052` | `05` | `03` | a derived preset identifier; a SET here is refused with SET_FAIL NOT_WRITABLE. Shown as `id` by the CLI, not exposed |
| `0x0107000e`, `0x0107000f` | `02` | `01` | move with the preset (carriers and antennas in use?); not exposed |
| `0x01070088` | — | — | **RF power table**, mode code → "Low (10 mW), Normal (20 mW), High (100 mW)" (31 → 10/40/126 mW; 18 → 10/40/200). u16 length, u32 count, `0e 0e`, then u32-length-prefixed key and label strings; the length counts its own four bytes. Shown as `rfPower` |

**Wideband presets** (ADTQ in "4-channel wideband, spatial diversity", channels 1 and 2 swept
2026-10-27): every channel keeps its own name at `0x0001` (the name's write address: "Channel2"),
gain, audio mode, tone and meters, and the `0x0f00`–`0x0f37` block. The RF objects — `0x0802`
group/channel, `0x0804` frequency, `0x0805`, `0x0809`, `0x080e` mute, `0x0811` power, `0x0814`,
`0x081f`, `0x0830`, `0x0881`–`0x0885`, `0x08f9`, `0x08fb` (the name's read address, now the
composite "Channel1,Channel2,Channel3,Channel4"), `0x1000`–`0x1007`, `0x1040`–`0x1047` and
`0x1600`–`0x1632` — answer only on the carrier channel and are refused (GET_FAIL 0x02, not
silence) on a mix. The plugin reads the name from `0x0001`, keeps `0x08fb` as `carrierName`, and
gives a mix its carrier's RF values (`carrier` names the channel); writes of frequency, power and
mute from a mix go to the carrier. Presets with "2 frequencies" or "4 frequencies" have more than
one carrier; the rule is the same (a channel that answers `0x0804` is a carrier; one refused belongs
to the nearest carrier below it) and is tested against the fake only for those.

The capture also lists what Workbench subscribes to and reads at connect, including addresses
outside every sweep so far: device classes `0x0120`, `0x0130`, `0x0140`, `0x01de`; channel objects
`0x0f16`–`0x0f27`, `0x1000`–`0x1007`, `0x1605`–`0x1622`, and `0x4001` on channels up to 16. Most of
the capture's small blocks (32/33/44 bytes, counters near 0x1000 from the first packet on) do not
decode with the session key and are not understood yet.

**Band change** (ADTD, 2026-10-27, K54 → K60 from the panel's hidden menu): the unit rebooted, came
back on a link-local address (its static configuration cleared to DHCP), and reset its preset to
"SC narrowband". Besides the uptime and the temperature byte, these moved:

| Address | K54 | K60 | Meaning |
|---|---|---|---|
| `0x01070003` | `"K54"` | `"K60"` | the band string |
| `0x01030020` | `059ca35a-fd5a-11e3-8dae-0015c5f3f612` | `3233fa64-2932-11ed-8bbf-0015c5f3f612` | a UUID that follows the band — the band definition's id? |
| `0x0107000c` | 11 codes | 17 codes: `45,46,32,31,33,34,8,6,27,30,3,2,5,0,1,10,9` | the preset list is per band; 33, 34, 8, 6, 27, 30 are not named yet |
| `0x01070060` | `"Low Normal High"` | `"Low"` | the RF power levels the band allows |
| `0x01070088` | three levels per mode | `Low (7 mW)` for every mode | the power table |

So preset names must be keyed by code, not by position (`PRESET_NAMES`). A SET of `0x01070003`
("K54" while on K60) is refused with SET_FAIL NOT_WRITABLE (2026-10-27), and no controller writes the
band anywhere a capture could show, so **the band is read-only from the network**; the `band`
command stays as the record of the experiment. The network reset would make a band write unsuitable
for the plugin's card in any case.

**Encryption, how it is written** (ADTD, 2026-10-27). `0x2000` on channel 1 **is the switch**: a SET of
`03` or `00` is accepted, the read straight behind it still shows the old value, and 2.5 s later every
channel reads the new one (probed both ways, 15 s watch each). The first attempt looked ignored only
because the read-back was immediate. The plugin writes `0x2000` and polls it for up to 4 s.

**Input selection and analog sensitivity** (ADTD, 2026-10-27, decoded capture of Workbench):

| Address | Values | Evidence |
|---|---|---|
| `0x017a` per channel | `00` Rear Panel, `01` Dante | Workbench SET `01` then `00` on channel 2, each answered by EVENTs on `0x017a` and `0x0179`. **Exposed**, writable (`inputSource`) |
| `0x0179` per channel | `03` with Dante selected, `01` with Rear Panel; `02` on an ADTQ | the unit's state for the selection; read only |
| `0x0612` per channel | `01` Line (+28 dBV FS), `00` Aux (+18 dBV FS) | Workbench SET `01` for Line on channel 1, EVENT back; `00` read on a channel on Aux in the 2026-09 notes. **Exposed**, writable (`analogSensitivity`) |
| `0x01200006` | `01` while channel 1 is on Dante, `00` otherwise; unchanged by channel 2 | a Dante-side flag, not the selection |

A detour worth recording: an earlier capture labelled "encryption on" held a SET of channel 1's
`0x017a` = `01`, which is this input selection, so for a while `0x017a` was mistaken for an
encryption trigger. Workbench sends `0x01d8` = `00` on a channel whenever its panel is opened
(peak-hold reset or similar); it is not a setting.
