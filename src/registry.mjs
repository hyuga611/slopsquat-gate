import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// crates.io refuses clients that do not name themselves: https://crates.io/data-access
export const USER_AGENT = `slopsquat-gate/${VERSION} (+https://github.com/hyuga611/slopsquat-gate)`;

const TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;

export class RegistryError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The parsed body, or null when the registry says there is no such package.
export async function getJson(fetch, url, headers = {}) {
  const host = new URL(url).host;
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(500 * (attempt - 1));
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      last = e.cause?.code ?? e.message;
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new RegistryError(`${host} answered with something that is not JSON`);
      }
    }
    await res.body?.cancel();
    last = `HTTP ${res.status}`;
    if (res.status < 500 && res.status !== 429) break;
  }
  throw new RegistryError(`${host} could not be asked: ${last}`);
}

// Runs at most `limit` of the queued tasks at a time, starting each at least `spacingMs` after the last.
export function pool(limit, spacingMs = 0) {
  let active = 0;
  let nextStart = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    const wait = Math.max(0, nextStart - Date.now());
    nextStart = Math.max(nextStart, Date.now()) + spacingMs;
    sleep(wait)
      .then(() => {
        nextStart = Math.max(nextStart, Date.now() + spacingMs);
        return task();
      })
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

export function hostOf(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
