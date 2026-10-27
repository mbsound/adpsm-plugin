// Small network helpers with no protocol knowledge.

import { networkInterfaces } from 'node:os';

export const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const isIpv4 = (s) =>
  typeof s === 'string' &&
  IPV4.test(s) &&
  s.split('.').every((o) => Number(o) <= 255);

export const ipToInt = (ip) =>
  ip.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);

const maskBits = (mask) => {
  const m = ipToInt(mask);
  let bits = 0;
  for (let i = 31; i >= 0 && (m >>> i) & 1; i -= 1) bits += 1;
  return bits;
};

export const sameSubnet = (a, b, mask) => {
  const bits = maskBits(mask);
  if (bits === 0) return false;
  const shift = 32 - bits;
  return ipToInt(a) >>> shift === ipToInt(b) >>> shift;
};

/**
 * The local IPv4 address that faces `target`: the interface whose subnet
 * contains it, else the first non-internal one, else loopback. This decides
 * which interface the SLP advert leaves by, and an advert that leaves via
 * Wi-Fi never reaches a device on a wired control network.
 */
export function localIpToward(target, interfaces = networkInterfaces()) {
  if (!isIpv4(target)) return null;
  if (target.startsWith('127.')) return '127.0.0.1';
  const candidates = [];
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' && iface.family !== 4) continue;
      if (iface.internal) continue;
      candidates.push(iface);
    }
  }
  const onSubnet = candidates.find(
    (iface) => iface.netmask && sameSubnet(iface.address, target, iface.netmask)
  );
  if (onSubnet) return onSubnet.address;
  return candidates[0]?.address ?? '127.0.0.1';
}

/** Every non-internal IPv4 address this machine has: the interfaces a browse must ask and listen on. */
export function localAddresses(interfaces = networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' && iface.family !== 4) continue;
      if (iface.internal) continue;
      out.push(iface.address);
    }
  }
  return out;
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Splits a comma / whitespace separated address list into IPv4 strings. */
export function parseAddressList(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const s = raw.trim();
    if (!s) continue;
    if (isIpv4(s) && !out.includes(s)) out.push(s);
  }
  return out;
}
