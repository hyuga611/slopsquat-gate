import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseArgs } from '../src/check.mjs';
import { daysAgo, fakeRegistry, npmDoc, NOW, withRepo } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'src', 'check.mjs');
const VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;

function capture() {
  const out = [];
  const err = [];
  return { io: { log: (s) => out.push(s), error: (s) => err.push(s) }, out: () => out.join('\n'), err: () => err.join('\n') };
}

async function withChange(fn) {
  return withRepo(async (repo) => {
    repo.commit({ 'package.json': { name: 'app', dependencies: { express: '^4' } } });
    repo.git('switch', '-q', '-c', 'feature');
    repo.commit({ 'package.json': { name: 'app', dependencies: { express: '^4', zod: '^3', 'zod-schema-guard-pro': '^1', 'new-kid': '^0.1.0' } } });
    return fn(repo);
  });
}

const registry = () => fakeRegistry({ npm: { zod: npmDoc(daysAgo(2000)), 'new-kid': npmDoc(daysAgo(3)) } });

test('the text report: one line per new dependency, failures first, then the verdict', () =>
  withChange(async ({ dir }) => {
    const c = capture();
    const code = await main([dir, '--base', 'main'], c.io, { env: {}, fetch: registry(), now: NOW });
    assert.equal(code, 1);
    const lines = c.out().split('\n');
    assert.match(lines[0], new RegExp(`^slopsquat-gate ${VERSION}: HEAD \\([0-9a-f]{7}\\) against main \\([0-9a-f]{7}\\)$`));
    assert.equal(lines[1], 'Packages first published less than 30 days ago fail.');
    assert.deepEqual(lines.slice(3, 6), [
      '  FAIL   npm    new-kid               package.json  first published 2026-10-11, 3 days ago: newer than 30 days',
      '  FAIL   npm    zod-schema-guard-pro  package.json  does not exist on registry.npmjs.org: a made-up name, and anyone can register it',
      '  ok     npm    zod                   package.json  first published 2021-04-23',
    ]);
    assert.equal(lines.at(-1), '2 of 3 new dependencies failed.');
  }));

test('--json carries the same result, and the exit code', () =>
  withChange(async ({ dir }) => {
    const c = capture();
    const code = await main([dir, '--base', 'main', '--json', '--min-age', '1'], c.io, { env: {}, fetch: registry(), now: NOW });
    const j = JSON.parse(c.out());
    assert.equal(code, 1);
    assert.equal(j.failed, true);
    assert.equal(j.minAgeDays, 1);
    assert.deepEqual(j.results.map((r) => [r.status, r.name]), [['fail', 'zod-schema-guard-pro'], ['ok', 'new-kid'], ['ok', 'zod']]);
    assert.deepEqual(j.results[2], { status: 'ok', ecosystem: 'npm', name: 'zod', spec: '^3', files: ['package.json'], reason: 'first published 2021-04-23', created: '2021-04-23', ageDays: 2000 });
  }));

test('the job summary is written when GITHUB_STEP_SUMMARY is set', () =>
  withChange(async ({ dir }) => {
    const summary = join(dir, '..', 'summary.md');
    await main([dir, '--base', 'main'], capture().io, { env: { GITHUB_STEP_SUMMARY: summary }, fetch: registry(), now: NOW });
    const md = readFileSync(summary, 'utf8');
    assert.match(md, /^### slopsquat-gate: 2 of 3 new dependencies failed\.$/m);
    assert.match(md, /^\| \*\*FAIL\*\* \| `zod-schema-guard-pro` \| npm \| `package\.json` \| does not exist on registry\.npmjs\.org: a made-up name, and anyone can register it \|$/m);
  }));

test('no new dependencies passes quietly', () =>
  withRepo(async ({ dir, git, commit }) => {
    commit({ 'package.json': { name: 'app', dependencies: { express: '^4' } } });
    git('switch', '-q', '-c', 'feature');
    commit({ 'README.md': 'docs only' });
    const c = capture();
    const fetch = fakeRegistry();
    assert.equal(await main([dir, '--base', 'main'], c.io, { env: {}, fetch, now: NOW }), 0);
    assert.equal(c.out().split('\n').at(-1), 'No new dependencies.');
    assert.deepEqual(fetch.calls, []);
  }));

test('argument errors', () => {
  assert.throws(() => parseArgs(['--min-age', 'ten']), /--min-age must be a whole number/);
  assert.throws(() => parseArgs(['--base']), /--base needs a value/);
  assert.deepEqual(parseArgs(['repo', '--base', 'origin/dev', '--head', 'pr']), {
    dir: 'repo',
    base: 'origin/dev',
    head: 'pr',
    minAge: undefined,
    config: undefined,
    json: false,
  });
});

test('as a process: --version, --help and an unknown flag', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  assert.equal(run('--version').stdout.trim(), VERSION);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Exit codes: 0 pass, 1 a new dependency failed, 2 /);
  const bad = run('--zzz');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option --zzz/);
});

test('as a process: a directory that is not a repository is exit code 2', () => {
  const r = spawnSync(process.execPath, [CLI, join(HERE, 'no-such-dir')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not a git repository/);
});
