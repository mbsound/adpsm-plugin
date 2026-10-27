# The ADTQ on the wire

What this plugin speaks to the unit, in enough detail to debug it with a
packet capture. Everything below was established on an operator-owned ADTQ
("ADTQ G57 NACLOCK") from captures of Wireless Workbench 6 and from the
Python tool in `ADTQ Mute/` this driver was ported from; the byte-level
builders in `driver/acn/` are pinned to that tool's output by
`__tests__/fixtures/acn-vectors.json`.

## Discovery: SLP

The unit is an SLPv2 service agent. The plugin multicasts a Service Request
for `service:esta.dmp` in the `DEFAULT` scope to `239.255.254.253:8427`
(and unicasts it to any address it has been told about). The reply is an
attribute list:

```
(cid=DD2D453E-0000-11DD-A000-000EDDCCCCCC),(acn-fctn=ADTQ),(acn-uacn=ADTQ G57 NACLOCK),
(acn-services=esta.dmp),(csl-esta.dmp=esta.sdt/10.10.1.175:57383;esta.dmp/cd:05B2AB78-…),
(device-description=$:tftp://10.10.1.175/$.ddl),…
```

- `esta.sdt/<ip>:<port>` is the control endpoint.
- `cid` is the unit's ACN component identifier. **Mandatory:** an SDT JOIN
  addressed to any other CID is dropped with no reply, no JOIN_REFUSE,
  nothing. Shure derives it from the MAC (`00:0e:dd:2d:45:3e` →
  `DD2D453E-0000-11DD-A000-000EDDCCCCCC`); `cidFromMac` in `slp.js` is the
  last-resort derivation.
- `acn-fctn` is the model. `acn-uacn` is ACN's "user-assigned name", but on
  Shure hardware nobody assigns it: the unit fills it with its model, its
  band and sometimes a variant tag that Workbench shows nowhere. Heard on one
  segment (2026-10-07): `ADTQ G57 NACLOCK`, `ADTD K54 NACLOCK`,
  `ULXD4Q G50 REV5`, `ULXD4D G50 REV2`, `AD4Q A`, `AD4D B`, `P10T G10`,
  `AD600`. The plugin shows the model and band (`ADTQ G57`) and drops the
  variant tag; `describeUacn` in `slp.js` is the reading.
- Three traps: the service type is `esta.dmp`, not `esta.sdt`; the unit
  answers to **UDP/8427 on the requester's address**, not to the source port
  of the request, so the plugin binds 8427 (and an ephemeral socket as a
  fallback when Workbench owns it); and the unit **only answers a request
  sent to the multicast group** — the same request unicast to its own
  address is dropped. Looking up one unit therefore asks the group as well
  and takes the reply that names it (observed on "ADTQ G57 NACLOCK": six
  seconds of unicast requests went unanswered; the group request was
  answered in 100 ms). The Python tool always sent both, which is why it
  never saw this.
- With the group joined, adverts from every ACN device on the segment also
  arrive unasked, every few seconds. A lookup filters them by address.

The `$.ddl` the advert points at would name every property, but the unit runs
no TFTP server. The property map was enumerated instead.

## Session: ACN SDT

Every datagram is an ACN root layer (`00 10 00 00 "ASC-E1.17" 00 00 00`,
then a PDU with vector 1 = SDT and the sender's CID) carrying SDT PDUs.
`driver/acn/session.js` reproduces Workbench's session exactly, in this
order:

| Step | Who | What |
|---|---|---|
| 1 | plugin | SLP component advert, multicast, three pulses 120 ms apart — the unit builds its table of controllers from these |
| 2 | plugin | wait 3 s (Workbench's advert → JOIN gap) |
| 3 | plugin | **JOIN** (vec 4): member CID = the unit's CID, our channel `0x8000 \| rand<<4`, reliable sequence base = our channel |
| 4 | unit | **JOIN_ACCEPT** (vec 6), last two bytes = the unit's reciprocal channel |
| 5 | unit | reciprocal **JOIN** on its own channel; plugin answers **JOIN_ACCEPT** |
| 6 | plugin | both directions joined → session key derived (below); cumulative **ack** of the unit's reliable frontier; then a reliable wrapper declaring protocol `0x102` (`70 07 09 00 00 01 02`) |
| 7 | unit | its own declaration `70 07 09 00000102`; plugin reciprocates **ASSOC0a** `70 07 0a 00000102` in a reliable wrapper whose client block carries the *unit's* channel as its association |
| 8 | unit | **ASSOC0a** for our declaration → DMP may be sent |
| 9 | plugin | 0.8 s write gate; the unit drops a SET issued into a half-open association |

About 4.2 s in total; paid once, then held for the life of the device.

**Keeping it alive.** The plugin sends an unreliable wrapper with a
cumulative ack (`70 07 0e 0000<seq>`) on every reliable wrapper the unit
sends and every 1.4 s when idle, and re-sends the SLP advert every 4 s. A
session that stops doing either goes stale.

**Sequence lockstep.** Total and reliable sequence counters start at our
channel: the first reliable wrapper is chan+1, which is what a JOIN base of
chan tells the unit to expect. The first reliable wrapper's trailer is
`ffff 0000 0000`, every later one `ffff ffff 0000`; oldest-available stays
pinned at the first reliable sequence. A NAK (vec 8, missed sequence at
offset 22) is answered by retransmitting from the unacked map.

**Disconnect.** Reliable disassociate (`70 07 0c 00000102`) and LEAVING
(vec 7), twice; then a root-layer leave (vec 8 with the unit's CID and a
fixed tail), twice.

## The DMP channel

Protocol `0x102` client blocks carry encrypted DMP. Key material:

```
key = skUtil( ourCid ‖ unitCid ‖ LE16(ourChan) ‖ LE16(unitChan) )[0:16]
```

`skUtil` is SHA-256, then 10–16 rounds of a byte permutation (round count
from the last two hash bytes), then SHA-256 again — `driver/acn/crypto.js`.
One key, both directions.

Each block is `01 01 <len16> <nonce8> <ctr8> <ciphertext> <tag4>`:

- ciphertext is AES-128-CTR over one **continuous** stream per direction:
  counter block = nonce ‖ BE64(block index), keystream taken from byte
  position `pos` of the stream, `pos` advancing by the plaintext length. The
  on-wire `ctr8` is `ceil(pos/16)` while the keystream uses `floor` — that
  is what Workbench does and what the unit checks.
- the tag is SKIP32 (Shure's 12-round variant, key = first 10 key bytes) of
  the CRC32 of everything before it.

The receiving side tracks the unit's stream position the same way. When a
unit block goes missing (a lost datagram), the next one no longer decodes at
the expected position; `DmpDecoder` searches a window (64 back, 2048
forward) for a position that yields a well-formed DMP head and resynchronises
there. Retransmitted ciphertext decodes at its remembered position.

DMP PDUs inside a block: `[70|len] [vector] [02] [address BE32] [value…]`.

| Vector | Meaning |
|---|---|
| 1 | GET |
| 2 | SET (the unit echoes it) |
| 3 | GET_REPLY |
| 4 | EVENT — the unit pushes a changed value (after a SET, and when the panel or Workbench changes something) |
| 9 | GET_FAIL, reason `02` — the address does not exist |
| 10 | SET_FAIL |

Only 3, 9 and 10 settle a request; 2 and 4 on the same address are not the
answer to a GET and are never treated as one.

The unit answers **every** GET. Silence is a lost packet. Pushed too hard it
drops a lot of them (a flat 16-per-20 ms burst lost 41 % of an 8192-address
sweep), so reads run with a bounded number in flight and retry what stayed
silent.

## Addresses

`0x02 <ch> <obj>`: device class 2, channel index 0–3, then the object. The
plugin reads these per channel; `docs/adtq-properties.md` has the evidence.

| Object | Value | Meaning |
|---|---|---|
| `0x08fb` | string | channel name (`0x0001` mirrors it) |
| `0x0802` | string | `"group,channel"` |
| `0x0804` | u32 | frequency, kHz, 25 kHz raster |
| `0x080e` | u8 | RF mute: 1 muted, 0 not |
| `0x0811` | u8 | RF power: 0 Normal, 1 High, 2 Low — identifiers, not a scale |
| `0x0102` | i8 | gain, dB |
| `0x0613` | u8 | audio mode: 1 stereo, 0 mono (summed) |
| `0x081f` | u8 | RF status; not a mute mirror; unidentified |
| `0x2000` | u8 | encryption: 0 off, 3 on; device-wide; outside the `0x0000–0x1fff` range every early sweep covered |

Strings are a 2-byte big-endian **total** length (header included) then
ASCII. Integers are big-endian; gain is two's complement (`0xf8` = −8 dB).

## Silent failure modes, in the order to check them

1. **No SLP reply.** Wrong segment (the lookup is multicast; a routed hop
   away the unit never hears it), or UDP/8427 blocked, or the unit is off.
   A request unicast to the unit is ignored — a lookup that only unicasts
   fails exactly like this.
2. **SLP reply without a CID.** The session cannot proceed; the driver
   refuses rather than guessing.
3. **JOIN sent, nothing back.** Wrong CID, or wrong control port. Total
   silence is the unit's only response to either.
4. **JOIN_REFUSE.** The reason byte is the last byte of the PDU; the driver
   names it. `ALREADY_MEMBER` after a crash clears when the unit times the
   old session out.
5. **Joined, DECL sent, no ASSOC0a.** The reciprocal ASSOC0a carried the
   wrong association, or the sequence base was off by one (the unit NAKs a
   phantom gap forever).
6. **Associated, SETs "succeed", nothing changes.** Another controller
   (Workbench) holds the unit; or the SET went out before the write gate.
   The read-back reports NOT APPLIED rather than success.
7. **SET answered with SET_FAIL.** Not silent, but easy to lose: the reason
   byte is the PDU's only data (`0x04` = NOT_WRITABLE, seen on the channel
   name's read address `0x08fb`), and the GET_REPLY to the read-back
   follows a millisecond later on the same address. The driver keeps both
   and reports REFUSED with the reason and the value the unit still holds.
