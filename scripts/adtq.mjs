#!/usr/bin/env node
// Talk to an ADTQ from the command line, through this plugin's own driver and
// with SoundBase nowhere in the picture. This is the tool for the first hour
// with a real unit: does discovery see it, does the session come up, do the
// values read as expected, does a mute land.
//
//   npm run adtq -- discover [--addresses 10.10.1.175,10.10.1.176]
//   npm run adtq -- status  <ip>
//   npm run adtq -- watch   <ip>                 # print every change the unit pushes
//   npm run adtq -- mute    <ip> <ch> on|off
//   npm run adtq -- freq    <ip> <ch> <MHz>
//   npm run adtq -- power   <ip> <ch> normal|high|low
//   npm run adtq -- mode    <ip> <ch> stereo|mono
//   npm run adtq -- name    <ip> <ch> <name>
//
// Every write is followed by a read-back and reported as CONFIRMED or NOT
// APPLIED. A frequency change retunes a live transmitter, so it asks first.
//
// SB_ADTQ_SLP_PORT overrides the SLP port (for a simulator on loopback).

import { createInterface } from 'node:readline';
import { AdtqDevice } from '../driver/adtq/device.js';
import { ANALOG_SENSITIVITIES, INPUT_SOURCES, channelList, presetCode, presetMenu, presetName } from '../driver/adtq/properties.js';
import { SLP_PORT, slpDiscover } from '../driver/acn/slp.js';
import { isIpv4, parseAddressList } from '../driver/netutil.js';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--')); // flags never belong in a name
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const slpPort = Number(process.env.SB_ADTQ_SLP_PORT) || SLP_PORT;
const quiet = args.includes('--quiet');
const log = (level, message) => {
  if (level === 'debug' && quiet) return;
  process.stderr.write(`[${level}] ${message}\n`);
};
const out = (s = '') => process.stdout.write(`${s}\n`);
const usage = () => {
  out('usage: adtq.mjs discover [--addresses a,b] | status <ip> | watch <ip> | mute <ip> <ch> on|off');
  out('       tone <ip> <ch> off|-60..0 [hz] | devname <ip> <name> | fan <ip> auto|on | lock <ip> panel|power on|off');
  out('       preset <ip> list | preset <ip> <code|name>       # device-wide; the unit reboots to apply it');
  out('       input <ip> <ch> rear|dante | sens <ip> <ch> aux|line   # per channel');
  out('       encryption <ip> on|off                          # device-wide; every receiver re-syncs');
  out('       band <ip> <K54>                                 # EXPERIMENT: a band change resets the unit to DHCP and clears the preset');
  out('       adtq.mjs freq <ip> <ch> <MHz> | power <ip> <ch> normal|high|low | mode <ip> <ch> stereo|mono | name <ip> <ch> <name>');
  process.exit(2);
};
const fmtFreq = (mhz) => (mhz == null ? '—' : `${mhz.toFixed(3)} MHz`);

const ask = (question) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

async function discover() {
  const targets = parseAddressList(flag('--addresses') ?? '');
  const multicast = process.env.SB_ADTQ_NO_MULTICAST !== '1';
  log('info', `asking ${multicast ? 'the segment' : 'nobody by multicast'}${targets.length ? ` and ${targets.join(', ')}` : ''} for service:esta.dmp on UDP/${slpPort}`);
  const replies = await slpDiscover({ targets, multicast, port: slpPort, timeoutMs: 3000, log });
  if (!replies.length) {
    out('no ACN devices answered');
    return;
  }
  for (const r of replies) {
    out(`${r.ip.padEnd(16)} ${(r.fctn ?? '?').padEnd(8)} "${r.uacn ?? '?'}"  port ${r.port}  cid ${r.cidText ?? 'not advertised'}`);
  }
}

async function withUnit(host, fn) {
  if (!isIpv4(host)) usage();
  const unit = new AdtqDevice({ host, slpPort, log });
  const t0 = Date.now();
  await unit.connect();
  log('info', `session up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  try {
    await fn(unit);
  } finally {
    await unit.close();
  }
}

const channelArg = (s) => {
  const ch = Number(s);
  if (![1, 2, 3, 4].includes(ch)) usage();
  return ch;
};

const report = (what, ch, r, shown = (v) => v) => {
  if (r.refused) out(`  ✗ REFUSED — the unit rejected the write (SET_FAIL ${r.refused}); channel ${ch} ${what} ${r.value === null ? 'was not read back' : `still reads ${shown(r.value)}`}`);
  else if (r.value === null) out(`  ! no read-back from the unit — ${what} on channel ${ch} unconfirmed`);
  else if (r.ok) out(`  ✓ CONFIRMED — channel ${ch} ${what} is now ${shown(r.value)} (device read-back)`);
  else out(`  ✗ NOT APPLIED — channel ${ch} ${what} still reads ${shown(r.value)}`);
};

async function status(unit) {
  const all = await unit.readAll();
  out(`${unit.identity.model} "${unit.identity.name}" at ${unit.host}:${unit.identity.port}  cid ${unit.identity.cidText}`);
  out(`encryption (device-wide): ${all.device.encryption ?? '—'}`);
  const d = all.device;
  const flag = (v) => (v == null ? '—' : v ? 'on' : 'off');
  out(`device ID ${JSON.stringify(d.name ?? '—')}  band ${d.band ?? '—'}  serial ${d.serial ?? '—'}  up ${d.uptime ?? '—'}  fan ${d.fanAlwaysOn == null ? '—' : d.fanAlwaysOn ? 'always on' : 'auto'}  panel lock ${flag(d.panelLock)}  power lock ${flag(d.powerLock)}`);
  const preset = d.rfModeCode == null ? '—' : `${JSON.stringify(presetName(unit.identity.model, d.rfModeList, d.rfModeCode))} (mode code ${d.rfModeCode}, id ${d.opPreset ?? '—'})`;
  out(`operational preset ${preset}  RF power ${d.rfPowerTable?.[String(d.rfModeCode)] ?? '—'}`);
  out();
  const meters = await unit.readMeters();
  out('  CH  NAME      GRP,CH  FREQUENCY     RF POWER  GAIN    AUDIO    RF MUTE   TONE          AF L/R dB    DOTS L/R');
  out('  ' + '-'.repeat(110));
  for (const ch of channelList(unit.channels)) {
    const c = all.channels[ch];
    const m = meters.channels[ch];
    const af = `${m.afDb ?? '—'} / ${m.afRDb ?? '—'}`;
    const dot = (d) => (d ? `${'●'.repeat(d.bar)}${'○'.repeat(Math.max(0, 7 - d.bar))}${d.peak > d.bar ? `^${d.peak}` : ''}` : '—');
    const dots = `${dot(m.afDots)} ${dot(m.afRDots)}`;
    const gc = c.groupChannel ? `${c.groupChannel.group},${c.groupChannel.channel}` : '—';
    const gain = c.gainDb == null ? '—' : `${c.gainDb} dB`;
    out(
      `  ${String(ch).padEnd(4)}${(c.name ?? '—').padEnd(10)}${gc.padEnd(8)}${fmtFreq(c.frequencyMhz).padEnd(14)}` +
        `${(c.txPowerMode ?? '—').padEnd(10)}${gain.padEnd(8)}${(c.audioMode ?? '—').padEnd(9)}${(c.muted == null ? '—' : c.muted ? 'MUTED' : 'unmuted').padEnd(10)}${(c.toneLevelDb == null ? '—' : c.toneLevelDb === -128 ? 'Off' : `${c.toneLevelDb} dB @${c.toneFreqHz ?? '?'}`).padEnd(14)}${af.padEnd(13)}${dots}` +
        `   in ${c.inputSource ?? '—'} / ${c.analogSensitivity ? c.analogSensitivity.split(' ')[0] : '—'}` +
        (c.carrier != null && c.carrier !== ch ? `   (RF on carrier ${c.carrier})` : c.carrier === ch && c.carrierName && c.carrierName !== c.name ? `   (carrier ${JSON.stringify(c.carrierName)})` : '')
    );
  }
  if (all.unanswered) out(`\n  ${all.unanswered} of ${all.asked} reads went unanswered`);
}

try {
  switch (cmd) {
    case 'discover':
      await discover();
      break;
    case 'status':
      await withUnit(args[1], status);
      break;
    case 'watch':
      await withUnit(args[1], async (unit) => {
        await status(unit);
        out('\nwatching for changes (ctrl-c to stop)…');
        unit.on('change', (c) => out(`  ${new Date().toISOString()}  ch${c.channel ?? '-'} ${c.key} -> ${JSON.stringify(c.value)}`));
        await new Promise(() => {});
      });
      break;
    case 'mute': {
      const ch = channelArg(args[2]);
      const on = { on: true, off: false, '1': true, '0': false }[args[3]];
      if (on === undefined) usage();
      await withUnit(args[1], async (unit) => {
        const t0 = Date.now();
        const r = await unit.setMute(ch, on);
        report('RF mute', ch, r, (v) => (v ? 'MUTED' : 'UNMUTED'));
        out(`  [${((Date.now() - t0) / 1000).toFixed(3)} s]`);
      });
      break;
    }
    case 'freq': {
      const ch = channelArg(args[2]);
      const mhz = Number(args[3]);
      if (!Number.isFinite(mhz)) usage();
      await withUnit(args[1], async (unit) => {
        const before = (await unit.readChannel(ch)).frequencyMhz;
        out(`  channel ${ch} is on ${fmtFreq(before)}; this retunes it to ${fmtFreq(mhz)} and drops the RF link on the old frequency.`);
        if ((await ask('  Type YES to proceed: ')) !== 'YES') {
          out('  cancelled');
          return;
        }
        report('frequency', ch, await unit.setFrequencyMhz(ch, mhz), fmtFreq);
      });
      break;
    }
    case 'power': {
      const ch = channelArg(args[2]);
      await withUnit(args[1], async (unit) => report('TX power', ch, await unit.setTxPowerMode(ch, args[3] ?? '')));
      break;
    }
    case 'mode': {
      const ch = channelArg(args[2]);
      await withUnit(args[1], async (unit) => report('audio mode', ch, await unit.setAudioMode(ch, args[3] ?? '')));
      break;
    }
    case 'name': {
      const ch = channelArg(args[2]);
      if (!positional[3]) usage();
      await withUnit(args[1], async (unit) => report('name', ch, await unit.setChannelName(ch, positional.slice(3).join(' ')), JSON.stringify));
      break;
    }
    case 'tone': {
      const ch = channelArg(args[2]);
      if (args[3] === undefined) usage();
      await withUnit(args[1], async (unit) => {
        report('tone level', ch, await unit.setToneLevel(ch, args[3]), (v) => (v === 'Off' ? 'Off' : `${v} dB`));
        if (args[4] !== undefined) report('tone frequency', ch, await unit.setToneFrequencyHz(ch, Number(args[4])), (v) => `${v} Hz`);
      });
      break;
    }
    case 'devname': {
      if (!positional[2]) usage();
      await withUnit(args[1], async (unit) => report('device ID', '-', await unit.setDeviceName(positional.slice(2).join(' ')), JSON.stringify));
      break;
    }
    case 'preset': {
      const want = args[2];
      await withUnit(args[1], async (unit) => {
        const dev = await unit.readDevice();
        const menu = presetMenu(unit.identity.model, dev.rfModeList);
        if (!want || want === 'list') { for (const p of menu) out(`  ${String(p.code).padStart(3)}  ${p.name}${p.code === dev.rfModeCode ? '   <- current' : ''}`); return; }
        const code = /^\d+$/.test(want) ? Number(want) : presetCode(unit.identity.model, dev.rfModeList, want);
        if (code === null || !menu.some((p) => p.code === code)) { out(`no preset ${JSON.stringify(want)} on this unit; try "preset <ip> list"`); return; }
        const r = await unit.setOperationalPreset(code);
        const name = (c) => JSON.stringify(presetName(unit.identity.model, dev.rfModeList, c));
        if (r.refused) out(`  ✗ REFUSED (SET_FAIL ${r.refused}); the unit still reads ${r.value} ${name(r.value)}`);
        else if (r.restarting) out(`  ✓ taken: ${code} ${name(code)} — the unit is restarting to apply it`);
        else out(`  ${r.ok ? '✓' : '✗'} reads ${r.value} ${name(r.value)}`);
      });
      break;
    }
    case 'input': {
      const ch = channelArg(args[2]);
      const want = (args[3] ?? '').toLowerCase();
      const source = want.startsWith('rear') ? INPUT_SOURCES[0] : want === 'dante' ? INPUT_SOURCES[1] : null;
      if (!source) { out('input <ip> <ch> rear|dante'); break; }
      await withUnit(args[1], async (unit) => report('input', ch, await unit.setInputSource(ch, source)));
      break;
    }
    case 'sens': {
      const ch = channelArg(args[2]);
      const want = (args[3] ?? '').toLowerCase();
      const level = want === 'aux' ? ANALOG_SENSITIVITIES[0] : want === 'line' ? ANALOG_SENSITIVITIES[1] : null;
      if (!level) { out('sens <ip> <ch> aux|line'); break; }
      await withUnit(args[1], async (unit) => report('analog sensitivity', ch, await unit.setAnalogSensitivity(ch, level)));
      break;
    }
    case 'encryption': {
      const want = (args[2] ?? '').toLowerCase();
      if (!['on', 'off'].includes(want)) { out('encryption <ip> on|off'); break; }
      await withUnit(args[1], async (unit) => {
        const r = await unit.setEncryption(want === 'on');
        report('encryption', 1, r);
        out(`  every channel now reads: ${Object.entries(r.copies).map(([ch, v]) => `ch${ch} ${v ?? '—'}`).join(', ')}`);
      });
      break;
    }
    case 'band': {
      const want = args[2];
      if (!want) { out('band <ip> <band>'); break; }
      await withUnit(args[1], async (unit) => {
        const r = await unit.setBandExperimental(want);
        if (r.refused) out(`  ✗ REFUSED (SET_FAIL ${r.refused}); the unit still reads ${JSON.stringify(r.value)}`);
        else if (r.restarting) out(`  ✓ taken: ${JSON.stringify(r.value)} — the unit is restarting; expect it to come back on DHCP`);
        else out(`  ${r.ok ? '✓' : '✗'} reads ${JSON.stringify(r.value)}`);
      });
      break;
    }
    case 'fan': {
      const on = { auto: false, on: true }[args[2]];
      if (on === undefined) usage();
      await withUnit(args[1], async (unit) => report('fan mode', '-', await unit.setFanAlwaysOn(on), (v) => (v ? 'ALWAYS ON' : 'AUTO')));
      break;
    }
    case 'lock': {
      const which = args[2];
      const on = { on: true, off: false }[args[3]];
      if (!['panel', 'power'].includes(which) || on === undefined) usage();
      await withUnit(args[1], async (unit) => report(`${which} lock`, '-', which === 'panel' ? await unit.setPanelLock(on) : await unit.setPowerLock(on), (v) => (v ? 'LOCKED' : 'UNLOCKED')));
      break;
    }
    default:
      usage();
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}
