import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupCrate, normalizeCrate, parseCargoToml } from '../src/cargo.mjs';
import { ECOSYSTEMS } from '../src/ecosystems.mjs';
import { pool, USER_AGENT } from '../src/registry.mjs';
import { crateDoc, fakeRegistry } from './helpers.mjs';

test('every dependency table, including target-specific ones and the workspace', () => {
  const r = parseCargoToml(`
[package]
name = "my_tool"
[dependencies]
serde = { version = "1", features = ["derive"] }
anyhow = "1"
json = { package = "serde_json", version = "1" }
[dev-dependencies]
proptest = "1"
[build-dependencies]
cc = "1"
[target.'cfg(windows)'.dependencies]
winapi = "0.3"
[workspace.dependencies]
tokio = "1"
`);
  assert.equal(r.name, 'my_tool');
  assert.deepEqual(
    r.deps.map((d) => [d.name, d.alias]),
    [['serde', undefined], ['anyhow', undefined], ['serde_json', 'json'], ['proptest', undefined], ['cc', undefined], ['winapi', undefined], ['tokio', undefined]],
  );
});

test('path, git, other registries and workspace inheritance are not checked', () => {
  const r = parseCargoToml(`
[dependencies]
local = { path = "../local", version = "0.1" }
forked = { git = "https://github.com/u/forked" }
internal = { version = "1", registry = "acme" }
tokio = { workspace = true }
`);
  assert.deepEqual(
    r.deps.map((d) => [d.name, d.skip]),
    [['local', 'path'], ['forked', 'git'], ['internal', 'private'], ['tokio', 'workspace']],
  );
});

test('- and _ name the same crate', () => {
  assert.equal(normalizeCrate('Serde_JSON'), 'serde-json');
});

test('lookup names the client, as crates.io requires', async () => {
  const fetch = fakeRegistry({ crates: { serde: crateDoc('2014-12-05T20:20:39.487502Z') } });
  const facts = await lookupCrate('serde', fetch);
  assert.deepEqual(facts, { found: true, created: '2014-12-05T20:20:39.487502Z' });
  assert.equal(fetch.calls[0].headers['user-agent'], USER_AGENT);
  assert.match(USER_AGENT, /^slopsquat-gate\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/hyuga611\/slopsquat-gate\)$/);
  assert.deepEqual(await lookupCrate('no-such-crate', fetch), { found: false });
});

test('crates.io is asked one crate at a time, a second apart', async () => {
  const run = pool(1, 50);
  const starts = [];
  const all = Promise.all([1, 2, 3].map(() => run(async () => starts.push(Date.now()))));
  const busyUntil = Date.now() + 20;
  while (Date.now() < busyUntil);
  await all;
  assert.ok(starts[1] - starts[0] >= 45 && starts[2] - starts[1] >= 45, starts.join(' '));
  assert.deepEqual([ECOSYSTEMS.crates.concurrency, ECOSYSTEMS.crates.spacingMs], [1, 1000]);
});
