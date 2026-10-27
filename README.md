# Shure ADTQ — SoundBase plugin

Puts a Shure **ADTQ** four-channel Axient Digital PSM transmitter into
SoundBase's device monitoring, over the network, with no Wireless Workbench in
the loop: every channel's name, frequency, group/channel, RF power, gain,
audio mode and RF mute state on a card, and RF mute, frequency, RF power,
audio mode and name writable from it.

```
SoundBase ──spawns──► plugin (node) ──UDP: SLP + ACN SDT/DMP──► ADTQ
             HTTP/SSE                  the same protocol Workbench speaks
```

The plugin speaks ANSI E1.17 (ACN) directly — the SLP discovery, the SDT
session handshake, the encrypted DMP property channel — ported from a
reverse-engineered Python tool that mutes a real ADTQ, and pinned to that
tool's bytes by test vectors. [docs/adtq-protocol.md](docs/adtq-protocol.md)
is the wire; [docs/adtq-properties.md](docs/adtq-properties.md) is the property
map and the evidence behind every address.

---

## Try it

```sh
npm install
npm run doctor      # is everything wired up?
npm test            # 33 tests: crypto and PDU vectors, the driver against a
                    # fake ADTQ, the adapter through the real shell
npm run smoke       # boots main.js as SoundBase does and drives the fake
```

Nothing above needs hardware. The fake ADTQ (`driver/fake/fake-adtq.js`)
speaks the real wire protocol on loopback — SLP, the session prologue, the
encrypted DMP exchange, the CID check that drops a JOIN in silence — and holds
the property map observed on a real unit.

### With a real unit

The command-line tool talks to a unit through the plugin's own driver, with
SoundBase nowhere in the picture. It is the thing to reach for in the first
hour with real hardware:

```sh
npm run adtq -- discover                     # who answers service:esta.dmp?
npm run adtq -- status 10.10.1.175           # every mapped property, all four channels
npm run adtq -- watch  10.10.1.175           # print what the unit pushes when you change something
npm run adtq -- mute   10.10.1.175 1 on      # RF mute channel 1; confirmed by read-back
npm run adtq -- power  10.10.1.175 2 low
npm run adtq -- mode   10.10.1.175 2 mono
npm run adtq -- freq   10.10.1.175 3 500.125 # asks first: retuning drops the RF link
npm run adtq -- name   10.10.1.175 4 "Lead Vox"
```

Every write is followed by a read of the same property and reported as
`CONFIRMED` or `NOT APPLIED`, because a SET the device silently ignores is
otherwise indistinguishable from one that worked.

Then, with SoundBase, `SB_ADTQ_HOST=10.10.1.175 npm run smoke` adds the real
unit alongside the simulated one and reads it. It changes nothing on it.

### In SoundBase

Put the folder where SoundBase looks for plugins, or point `SB_PLUGIN_DIRS` at
its parent — [docs/running-in-soundbase.md](docs/running-in-soundbase.md).
Units on the machine's network segment are discovered by SLP multicast and
appear in the device setup drawer; units elsewhere can be added by IP address
or listed under **Additional ADTQ addresses** in the plugin's settings. Tick
**Simulate an ADTQ** to get a simulated unit with no hardware at all.

## What is exposed

| On the card | State key | Source | Writable |
|---|---|---|---|
| Channel name | `channelName` | `0x08fb`, confirmed | yes (`channelName`) — see *unverified* below |
| Frequency, MHz | `frequency` | `0x0804` kHz, confirmed | yes (`frequency`), 25 kHz raster |
| Group, channel | `groupChannel` `{ group, channel }` | `0x0802`, confirmed | no |
| RF mute | `mute`, and `rfState` = not muted | `0x080e`, confirmed by SET round trip | yes (`mute`) |
| RF power | `x.shure-adtq.txPowerMode` — `Normal` / `High` / `Low` | `0x0811` enum, confirmed over four transitions | yes (`txPowerMode`) |
| Gain, dB | `gain` | `0x0102` signed byte, confirmed | yes (`gain`), −20…+16 in 1 dB steps, the unit's own limits (ADTD, 2026-10-26) |
| Audio mode | `audioModes.txMode` — `stereo` / `mono` | `0x0613`, confirmed | yes (`audioMode`) |
| Encryption | `rfEncryption` `{ mode, enabled }`, device-wide | `0x2000`, confirmed | yes (`rfEncryption`) — every receiver re-syncs; written at the read address, applied by the unit ~2 s later (confirmed both ways on an ADTD, 2026-10-27) |
| Device ID | `deviceName` | `0x01000012`, the unit's name as the panel and Workbench show it | yes (`deviceName`) |
| Input selection | `x.shure-adtq.input.source` — Rear Panel / Dante, per channel | `0x017a`, from a decoded Workbench capture; written both ways on an ADTD with read-back (2026-10-27) | yes (`inputSource`) |
| Analog sensitivity | `x.shure-adtq.input.sensitivity` — Aux (+18 dBV FS) / Line (+28 dBV FS), per channel | `0x0612`, from the same capture; written both ways on an ADTD with read-back | yes (`analogSensitivity`) |
| Tone generator | `x.shure-adtq.tone` `{ level, frequency }` per channel | `0x0128` dB (`Off` = −128), `0x0127` Hz | yes (`toneLevel` Off / −60…0 in 6 dB, `toneFrequency` 400–1000 Hz) |
| Unit settings | `x.shure-adtq.unit` — model, serial, band, uptime, fan mode, panel lock, power lock | the device-class addresses the Axient Digital receivers use, read-confirmed on an ADTD | fan (`fanMode`), locks (`panelLock`, `powerLock`) |
| Operational preset | `x.shure-adtq.unit.operationalPreset`, the name as Workbench lists it | `0x0107000b`, the transmission-mode code, which is what Workbench writes (a decoded capture, 2026-10-26); the options are the codes the unit's band offers at `0x0107000c`, in menu order | yes (`operationalPreset`) — **the unit reboots to apply it** and every channel is off air for the restart; the session drops and reconnects |
| Band | `x.shure-adtq.unit.band` | `0x01070003`; a SET is refused (NOT_WRITABLE), and a band change from the panel resets the unit to DHCP and clears the preset | **no** |
| RF power table | `x.shure-adtq.unit.rfPower` — "Low (10 mW), Normal (20 mW), High (100 mW)" | `0x01070088`, keyed by the transmission-mode code at `0x0107000b` that the preset selects | no |

RF power is an extension key rather than SoundBase's `txPower` (milliwatts):
the ADTQ exposes an enum whose indices are identifiers, not a scale (`0` sits
between `2` and `1`), and the companion level property reads the same on
Normal and Low, so no honest mW figure exists for it.

**Two writes to think about before clicking.** Encryption is device-wide and
forces every receiver to re-sync. Gain is the level in someone's ears, so its
step is 1 dB and its limits are the unit's own. Both were read-only in earlier
versions for those reasons and are writable now.

**Wideband presets.** In a wideband preset several channels (mixes) share one
carrier: the unit answers frequency, group, RF power and mute only on the
carrier channel, and the name's read address there holds the composite of the
mixes' names. Each channel's card shows its own name, gain, audio mode, tone and
meters, plus the carrier's frequency, power and mute, and a "Carrier" cell with
the carrier's composite name; changing frequency, power or mute on any mix
changes the carrier. Verified on an ADTQ in "4-channel wideband, spatial
diversity", on SoundBase's cards (2026-10-27); the 2- and 4-frequency variants follow the same rule but have only
been exercised against the fake.

**The ADTD.** A second product, `plugin:shure-adtq/adtd`, with two channels;
discovery offers each unit as its own model. An ADTD answers channels 3 and 4
with a GET_FAIL, so the driver sizes every read to the model.

**Preset names.** The unit lists the mode codes its band offers in the order
Workbench's menu shows them, and the plugin names them from that menu (read
from Workbench for the ADTD and ADTQ). `npm run adtq -- preset <ip> list`
prints the unit's list with the current one marked; check it against
Workbench's menu before writing an entry below the fold.

**The card.** SoundBase places the layout's nodes itself, by type and in the
order the manifest lists them: the two audio meters as one stereo meter, then
audio mode, RF power and gain as the card's cells, and RF mute as its large
cell. Group/channel, the RF-on lamp and the panel dots are marked
`"region": "detail"`, which keeps them for the list view. In mono both meters
are labelled `M` rather than `L` and `R`, through `labelFrom` on
`audioModes.txMode`.

`meterStyle`, `region` and `labelFrom` are ChannelMonitoring 1.1 layout
properties, which is the version the manifest declares and needs SDK 0.12.2
or later. A SoundBase that predates 1.1 ignores them: the meters stay
`L`/`R` in mono and the RF-on lamp takes a fourth cell.

**Meters.** The card's left/right audio meters are the unit's post-gain
audio level at `0x0118`/`0x011a`, read every 100 ms by default (the "Meter
interval" setting, 50 to 1000 ms) on their own timer and
reported as the contract's `meters` reading. The sides are confirmed (a mono
channel reads both alike; feeding the right input only drops the left). The
figures are dB (a 36 dB gain sweep moved them exactly 36 dB); whether the
reference is full scale has not been checked with a tone. The unit's own
7-dot panel meter is read alongside, from `0x01d5`/`0x01d6`, as a bar and a
peak-hold dot per side, and shown in the list view as "L dots" / "R dots" out
of 7.
Two further dB pairs at `0x0117`/`0x0119` and `0x01d3`/`0x01d4` are identified
but not exposed: what distinguishes them from the first is not confirmed. The device's band limits are not readable over DMP, so
the frequency property spans UHF (400–1000 MHz); a value outside the unit's
band is refused by the unit and the card keeps showing what it actually holds.

## Verification status — read this before trusting it

| Layer | Proof |
|---|---|
| Session key, AES-CTR, SKIP32 tag, every PDU builder and parser, the SLP advert | byte-exact against the Python reference that has muted a real ADTQ (`__tests__/fixtures/acn-vectors.json`) |
| Session prologue, reads, writes with read-back, EVENTs, loss, silence, disconnect | against the fake, which is built from the same primitives and the captured behaviour |
| The adapter and the SoundBase contract | through the real `@soundbase/plugin-shell` over HTTP |
| **This plugin against a real ADTQ** | **reads and one kind of write.** `discover`, `status` and `name` have run against an ADTQ (2026-09-08/09): SLP lookup with CID, association, a decoded read of every mapped property and the audio meters on all four channels, and channel-name writes confirmed by read-back. RF mute, frequency, power and audio mode have not been written from this port; the Python tool it was ported from has muted the unit. `npm run adtq -- mute <ip> <ch> on` is the next thing to do with a unit in reach. |
| Writes on an ADTD (2026-10-26) | every writable property was written on channel 2 or the unit and read back, then restored: RF mute, RF power, audio mode, frequency, channel name, tone level and frequency, Device ID, fan mode, both locks, and gain at −20 and +16 (−21 and +17 refused with SET_FAIL 5). The operational preset write is the SET a decoded Workbench capture showed; written live from this plugin on the ADTD (2026-10-26, "SC narrowband" → "Narrowband"), the unit restarted and read the new preset back. |
| Channel-name writes | exercised on hardware (2026-09-08): a SET on the read address `0x08fb` is refused with SET_FAIL NOT_WRITABLE; the same SET on `0x0001` takes and both addresses read the new name back. The plugin writes `0x0001`. |

## Requirements

- Node 20 or newer; no native modules.
- The machine on the same network as the ADTQ, with UDP 8427 (SLP) open in
  both directions. The devices answer SLP **to port 8427**, not to the
  request's source port, so the plugin binds it; when Workbench already owns
  it discovery still works but is less reliable.
- **Wireless Workbench can stay open.** The plugin and Workbench each hold their
  own session with a unit and the unit serves both: discovery, reads, the meter
  stream and writes (gain, encryption, input selection, sensitivity, presets)
  all ran from this plugin while Workbench on the same Mac was connected to the
  same units (2026-10-26/27), and a change made in either shows in the other
  through the unit's EVENTs. Earlier versions of this README said the two could
  not be used together; that was never tested and is wrong.

## Scripts

| | |
|---|---|
| `npm start` | run the plugin |
| `npm test` | the suite |
| `npm run doctor` | is this plugin well-formed? with fixes for anything that isn't |
| `npm run smoke` | boot as a child process, handshake, drive the simulated unit — what the host does |
| `npm run adtq -- …` | discover, read and control a unit from the terminal |
| `npm run manifest` | validate `soundbase-plugin.json` against the contract schema |
| `npm run pack:release` | build the zip users install, and boot-check it |
| `npm run bump <x.y.z>` | move the version in every file that carries it; tag and push to release |

Environment knobs, mainly for tests and CI: `SB_ADTQ_SIMULATE=1` (the
simulated unit), `SB_ADTQ_SLP_PORT` (an SLP port other than 8427),
`SB_ADTQ_NO_MULTICAST=1`, `SB_ADTQ_NO_DISCOVERY=1`, `SB_ADTQ_HOST` (smoke
check against a real unit).

## Layout

```
soundbase-plugin.json   identity, the ADTQ product, its layout and config fields
main.js                 shell bootstrap — never edited
adapter.js              the device on the contract: discovery, state, commands
driver/
  netutil.js            interface selection, address parsing
  acn/crypto.js         session key, AES-CTR, SKIP32 tag
  acn/pdu.js            ACN root / SDT / DMP codec and builders
  acn/slp.js            discovery request, controller advert, reply parser, the standing browse
  acn/session.js        the held-open SDT session: prologue, acks, NAKs, request/reply
  adtq/properties.js    the address map and value codecs
  adtq/device.js        typed reads and writes with read-back, the change feed
  fake/fake-adtq.js     a fake unit on the same wire, for tests and the simulator
__tests__/              vectors, driver against the fake, adapter through the shell
scripts/                adtq CLI, smoke, doctor, manifest, rename, bump, pack
docs/                   the SDK guide set, plus adtq-protocol.md and adtq-properties.md
```

## Licence

Business Source License 1.1 — see `LICENSE`. Protocol knowledge here comes
from observing an operator-owned ADTQ with Wireless Workbench; no Shure
software is included or required.
