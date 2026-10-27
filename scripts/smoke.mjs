#!/usr/bin/env node
// Boot the plugin the way SoundBase does and check it answers.
//
// Unit tests import the adapter. This does not: it spawns `main.js` as a
// child process, reads the stdout handshake, and talks HTTP — the same three
// things the host does. A plugin whose tests pass but whose handshake never
// arrives is invisible to SoundBase, and the symptom is "my plugin does not
// appear" with nothing in any log to explain it.
//
// The device path is exercised against the simulated ADTQ (the fake speaks
// the real wire protocol on loopback), so the check proves discovery, the
// session prologue, state on the event stream and a command round trip with
// nothing attached — which is what a CI runner has.
//
//   npm run smoke                          # simulated unit
//   SB_ADTQ_HOST=10.10.1.175 npm run smoke # also add a real unit and read it
//
// Against a real unit only reads are performed; nothing is muted or retuned.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HANDSHAKE = 'SB_PLUGIN_READY ';
const BOOT_TIMEOUT_MS = 20_000;
const OPEN_TIMEOUT_MS = 15_000;
const REAL_HOST = process.env.SB_ADTQ_HOST;

const main = fileURLToPath(new URL('../main.js', import.meta.url));
const ok = (msg) => process.stdout.write(`  ok    ${msg}\n`);
const skip = (msg) => process.stdout.write(`  skip  ${msg}\n`);

const child = spawn(process.execPath, [main], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, SB_ADTQ_SIMULATE: '1' },
});
let failed = false;
const finish = (code) => {
  child.kill();
  process.exit(code);
};

process.stdout.write('booting the plugin\n');

const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () =>
      reject(
        new Error(
          `no ${HANDSHAKE.trim()} line within ${BOOT_TIMEOUT_MS / 1000}s. ` +
            'The host waits for this and gives up the same way.'
        )
      ),
    BOOT_TIMEOUT_MS
  );
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    process.stdout.write(chunk);
    const line = buffered.split('\n').find((l) => l.startsWith(HANDSHAKE));
    if (!line) return;
    clearTimeout(timer);
    try {
      resolve(JSON.parse(line.slice(HANDSHAKE.length)).port);
    } catch {
      reject(new Error(`handshake line is not valid JSON: ${line}`));
    }
  });
  child.on('error', reject);
  child.on('exit', (code) =>
    reject(new Error(`the plugin exited before handshaking (code ${code})`))
  );
}).catch((err) => {
  process.stderr.write(`\nFAILED: ${err.message}\n`);
  finish(1);
});

const base = `http://127.0.0.1:${port}`;
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const deviceRow = async (id) => (await call('GET', '/devices')).devices.find((d) => d.id === id);
const waitForStatus = async (id, wanted, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await deviceRow(id);
    if (row?.status.status === wanted) return row;
    if (row?.status.status === 'failed') throw new Error(`${id} failed: ${row.status.message}`);
    if (Date.now() > deadline) throw new Error(`${id} did not reach status ${wanted} within ${timeoutMs / 1000}s (last: ${row?.status.status})`);
    await delay(100);
  }
};

// a minimal SSE reader: the latest value of every state key per device
async function watchState() {
  const controller = new AbortController();
  const res = await fetch(`${base}/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const latest = new Map(); // deviceId -> Map(key -> value)
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!/^event: device-state$/m.test(frame)) continue;
          const data = JSON.parse(/^data: (.*)$/m.exec(frame)[1]);
          const map = latest.get(data.deviceId) ?? new Map();
          for (const patch of data.patches) map.set(patch.key, patch.value);
          latest.set(data.deviceId, map);
        }
      }
    } catch {
      // aborted
    }
  })();
  return { latest, close: () => controller.abort() };
}

const state = await watchState();

try {
  ok(`handshake reported port ${port}`);

  const health = await call('GET', '/health');
  if (health.ok !== true) throw new Error('/health did not report ok');
  ok('/health');

  const info = await call('GET', '/info');
  ok(`/info — ${info.name} ${info.version}, core ${info.contract.core}, modules ${Object.keys(info.contract.modules ?? {}).join('+')}`);

  // discovery: the simulated unit appears on the first listing
  let sim = null;
  for (let i = 0; i < 30 && !sim; i += 1) {
    sim = (await call('GET', '/devices')).devices.find((d) => d.id === 'sim:adtq');
    if (!sim) await delay(100);
  }
  if (!sim) throw new Error('the simulated ADTQ was not discovered');
  ok(`/devices — simulated unit discovered as ${sim.product}`);

  await call('POST', '/devices', { id: sim.id, product: sim.product, config: {} });
  const opened = await waitForStatus(sim.id, 'ok', OPEN_TIMEOUT_MS);
  ok(`simulated unit opened — ${opened.channelCount} channels, ${opened.properties.length} properties, layout ${opened.layout ? 'present' : 'absent'}`);

  await delay(200);
  const simState = state.latest.get(sim.id);
  const freq = simState?.get('frequency')?.channels;
  if (!freq || Object.keys(freq).length !== 4) throw new Error(`no four-channel frequency state arrived (${JSON.stringify(freq)})`);
  ok(`device-state — frequencies ${Object.values(freq).join(' / ')} MHz`);

  const dev = encodeURIComponent(sim.id);
  await call('POST', `/devices/${dev}/commands`, { propertyId: 'mute', channelIndex: 1, value: true });
  for (let i = 0; i < 20 && state.latest.get(sim.id)?.get('mute')?.channels?.[1] !== true; i += 1) await delay(50);
  if (state.latest.get(sim.id)?.get('mute')?.channels?.[1] !== true) throw new Error('the mute command was accepted but no muted state came back');
  ok('command — channel 1 RF mute on, confirmed by read-back');
  await call('POST', `/devices/${dev}/commands`, { propertyId: 'mute', channelIndex: 1, value: false });
  for (let i = 0; i < 20 && state.latest.get(sim.id)?.get('mute')?.channels?.[1] !== false; i += 1) await delay(50);
  ok('command — channel 1 RF mute off, confirmed by read-back');

  if (REAL_HOST) {
    const id = `net:${REAL_HOST}`;
    await call('POST', '/devices', { id, product: sim.product, config: { host: REAL_HOST } });
    const row = await waitForStatus(id, 'ok', 30_000);
    await delay(300);
    const real = state.latest.get(id);
    const names = real?.get('channelName')?.channels ?? {};
    const freqs = real?.get('frequency')?.channels ?? {};
    const mutes = real?.get('mute')?.channels ?? {};
    ok(`real unit ${REAL_HOST} opened — "${real?.get('deviceName')}", ${row.channelCount} channels`);
    for (const ch of [1, 2, 3, 4]) {
      ok(`  ch${ch} ${names[ch] ?? '?'} ${freqs[ch] ?? '?'} MHz ${mutes[ch] ? 'MUTED' : 'unmuted'}`);
    }
    ok('read only: nothing on the real unit was changed');
  } else {
    skip('SB_ADTQ_HOST not set, so no real unit was contacted');
  }
} catch (err) {
  process.stderr.write(`\nFAILED: ${err.message}\n`);
  failed = true;
}

state.close();
process.stdout.write(failed ? '\nsmoke check failed\n' : '\nsmoke check passed\n');
finish(failed ? 1 : 0);
