import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBase, exitCode, gate } from '../src/gate.mjs';
import { crateDoc, daysAgo, fakeRegistry, npmDoc, NOW, pypiDoc, withRepo } from './helpers.mjs';

const OLD = daysAgo(3000);
const run = (dir, fetch, opts = {}) => gate({ cwd: dir, base: 'main', head: 'HEAD', env: {}, fetch, now: NOW, ...opts });
const byName = (outcome) => Object.fromEntries(outcome.results.map((r) => [r.name, r]));

// main with a package.json and a requirements.txt; a feature branch checked out on top.
async function withBranch(fn) {
  return withRepo(async (repo) => {
    repo.commit({
      'package.json': { name: 'app', dependencies: { express: '^4.19.0' } },
      'requirements.txt': 'requests==2.31.0\n',
    });
    repo.git('switch', '-q', '-c', 'feature');
    return fn(repo);
  });
}

test('only dependencies added on the branch are asked about', () =>
  withBranch(async ({ dir, commit }) => {
    commit({
      'package.json': { name: 'app', dependencies: { express: '^4.21.0', 'left-pad': '^1.3.0' } },
      'requirements.txt': 'requests==2.32.0\nflask\n',
    });
    const fetch = fakeRegistry({ npm: { 'left-pad': npmDoc(OLD) }, pypi: { flask: pypiDoc(OLD) } });
    const outcome = await run(dir, fetch);
    assert.deepEqual(outcome.results.map((r) => [r.status, r.ecosystem, r.name]), [['ok', 'npm', 'left-pad'], ['ok', 'pypi', 'flask']]);
    assert.deepEqual(fetch.urls().sort(), ['https://pypi.org/simple/flask/', 'https://registry.npmjs.org/left-pad']);
    assert.equal(exitCode(outcome), 0);
  }));

test('a made-up name fails with exit code 1, next to a real one that passes', () =>
  withBranch(async ({ dir, commit }) => {
    commit({
      'package.json': { name: 'app', dependencies: { express: '^4.19.0', 'react-hooks-form-validator-pro': '^1.0.0', zod: '^3.23.0' } },
      'requirements.txt': 'requests==2.31.0\nhuggingface-cli\n',
    });
    const fetch = fakeRegistry({ npm: { zod: npmDoc(OLD) } });
    const outcome = await run(dir, fetch);
    const r = byName(outcome);
    assert.equal(r['react-hooks-form-validator-pro'].status, 'fail');
    assert.match(r['react-hooks-form-validator-pro'].reason, /does not exist on registry\.npmjs\.org/);
    assert.deepEqual(r['react-hooks-form-validator-pro'].files, ['package.json']);
    assert.match(r['huggingface-cli'].reason, /does not exist on pypi\.org/);
    assert.equal(r.zod.status, 'ok');
    assert.equal(exitCode(outcome), 1);
  }));

test('a package registered last week fails; --min-age 0 lets it through', () =>
  withBranch(async ({ dir, commit }) => {
    commit({ 'package.json': { name: 'app', dependencies: { express: '^4.19.0', 'fresh-pkg': '^0.1.0' } } });
    const fetch = fakeRegistry({ npm: { 'fresh-pkg': npmDoc(daysAgo(6)) } });
    const strict = await run(dir, fetch);
    assert.equal(strict.results[0].status, 'fail');
    assert.equal(strict.results[0].reason, 'first published 2026-10-08, 6 days ago: newer than 30 days');
    assert.equal((await run(dir, fetch, { minAgeDays: 7 })).results[0].status, 'fail');
    assert.equal((await run(dir, fetch, { minAgeDays: 0 })).results[0].status, 'ok');
  }));

test('the comparison starts at the merge base, so changes on main do not count', () =>
  withBranch(async ({ dir, git, commit }) => {
    commit({ 'package.json': { name: 'app', dependencies: { express: '^4.19.0', zod: '^3' } } });
    git('switch', '-q', 'main');
    commit({ 'package.json': { name: 'app', dependencies: { express: '^4.19.0', 'main-only': '^1' } } });
    git('switch', '-q', 'feature');
    const fetch = fakeRegistry({ npm: { zod: npmDoc(OLD) } });
    const outcome = await run(dir, fetch);
    assert.deepEqual(outcome.results.map((r) => r.name), ['zod']);
    assert.notEqual(outcome.mergeBase, outcome.baseCommit);
  }));

test('moving a dependency to another manifest or field is not new; a new spelling of it is not either', () =>
  withBranch(async ({ dir, commit }) => {
    commit({
      'package.json': { name: 'app', devDependencies: { express: '^4.19.0' } },
      'requirements.txt': null,
      'requirements-dev.txt': 'Requests==2.31.0\n',
    });
    const outcome = await run(dir, fakeRegistry());
    assert.deepEqual(outcome.results, []);
    assert.equal(exitCode(outcome), 0);
  }));

test('switching a dependency from git to the registry is new', () =>
  withRepo(async ({ dir, git, commit }) => {
    commit({ 'package.json': { dependencies: { mylib: 'github:me/mylib' } } });
    git('switch', '-q', '-c', 'feature');
    commit({ 'package.json': { dependencies: { mylib: '^1.0.0' } } });
    const outcome = await run(dir, fakeRegistry());
    assert.equal(outcome.results[0].status, 'fail');
  }));

test('git, URL, path and workspace dependencies are listed as not checked, and never asked about', () =>
  withRepo(async ({ dir, git, commit }) => {
    commit({ 'package.json': { name: 'root' } });
    git('switch', '-q', '-c', 'feature');
    commit({
      'package.json': {
        name: 'root',
        dependencies: { a: 'github:me/a', b: 'file:../b', c: 'workspace:*', d: 'https://example.com/d.tgz', '@acme/lib': '^1' },
      },
      'packages/lib/package.json': { name: '@acme/lib', version: '1.0.0' },
      'requirements.txt': '-e .\ngit+https://github.com/me/e.git#egg=e\n',
    });
    const fetch = fakeRegistry();
    const outcome = await run(dir, fetch);
    assert.deepEqual(fetch.calls, []);
    assert.ok(outcome.results.every((r) => r.status === 'skip'));
    assert.match(byName(outcome)['@acme/lib'].reason, /a package in this repository/);
    assert.equal(exitCode(outcome), 0);
  }));

test('a scope on a private registry is skipped and not sent; a missing package behind a mirror only warns', () =>
  withRepo(async ({ dir, git, commit }) => {
    commit({ 'package.json': { name: 'web' }, 'tools/package.json': { name: 'tools' } });
    git('switch', '-q', '-c', 'feature');
    commit({
      '.npmrc': '@acme:registry=https://npm.acme.example/\n',
      'package.json': { name: 'web', dependencies: { '@acme/secret-project': '^1', 'left-pad': '^1' } },
      'tools/.npmrc': 'registry=https://artifactory.acme.example/api/npm/\n',
      'tools/package.json': { name: 'tools', dependencies: { 'acme-internal-cli': '^2' } },
    });
    const fetch = fakeRegistry({ npm: { 'left-pad': npmDoc(OLD) } });
    const outcome = await run(dir, fetch);
    const r = byName(outcome);
    assert.equal(r['@acme/secret-project'].status, 'skip');
    assert.equal(r['acme-internal-cli'].status, 'warn');
    assert.match(r['acme-internal-cli'].reason, /artifactory\.acme\.example, which was not asked/);
    assert.ok(!fetch.urls().some((u) => u.includes('secret-project')));
    assert.equal(exitCode(outcome), 0);
  }));

test('the allowlist comes from the base branch, not from the change itself', () =>
  withRepo(async ({ dir, git, commit }) => {
    commit({ '.slopsquat.json': { allow: ['@acme/*', 'pypi:acme_tools'] }, 'package.json': { name: 'app' } });
    git('switch', '-q', '-c', 'feature');
    commit({
      '.slopsquat.json': { allow: ['@acme/*', 'pypi:acme_tools', 'evil-pkg'] },
      'package.json': { name: 'app', dependencies: { '@acme/new-thing': '^0.1.0', 'evil-pkg': '^1' } },
      'requirements.txt': 'Acme.Tools>=1\n',
    });
    const fetch = fakeRegistry();
    const outcome = await run(dir, fetch);
    const r = byName(outcome);
    assert.equal(r['@acme/new-thing'].status, 'allow');
    assert.equal(r['@acme/new-thing'].reason, 'allowed by .slopsquat.json on main');
    assert.equal(r['Acme.Tools'].status, 'allow');
    assert.equal(r['evil-pkg'].status, 'fail');
    assert.deepEqual(fetch.urls(), ['https://registry.npmjs.org/evil-pkg']);
    assert.match(outcome.notes[0], /\.slopsquat\.json is changed here; the one on main is used/);
  }));

test('--config reads the policy from a file, and ignore leaves manifests out', () =>
  withRepo(async ({ dir, git, commit }) => {
    commit({ 'package.json': { name: 'app' } });
    git('switch', '-q', '-c', 'feature');
    commit({
      'package.json': { name: 'app', dependencies: { 'young-pkg': '^1' } },
      'test/fixtures/bad/package.json': { dependencies: { 'made-up-for-a-test': '^1' } },
    });
    const config = join(dir, '..', 'policy.json');
    writeFileSync(config, JSON.stringify({ ignore: ['test/fixtures/'], minAgeDays: 3 }));
    const outcome = await run(dir, fakeRegistry({ npm: { 'young-pkg': npmDoc(daysAgo(5)) } }), { configFile: config });
    assert.deepEqual(outcome.results.map((r) => [r.name, r.status]), [['young-pkg', 'ok']]);
    assert.equal(outcome.minAgeDays, 3);
  }));

test('pyproject.toml and Cargo.toml, with names compared the way each registry compares them', () =>
  withRepo(async ({ dir, git, commit }) => {
    commit({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["Django_Rest.Framework"]\n',
      'Cargo.toml': '[package]\nname = "cli"\n[dependencies]\nserde_json = "1"\n',
    });
    git('switch', '-q', '-c', 'feature');
    commit({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["django-rest-framework", "httpx"]\n',
      'Cargo.toml': '[package]\nname = "cli"\n[dependencies]\nserde-json = "1"\nclap = "4"\n',
    });
    const fetch = fakeRegistry({ pypi: { httpx: pypiDoc(OLD) }, crates: { clap: crateDoc(OLD) } });
    const outcome = await run(dir, fetch);
    assert.deepEqual(outcome.results.map((r) => [r.ecosystem, r.name, r.status]), [['crates', 'clap', 'ok'], ['pypi', 'httpx', 'ok']]);
  }));

test('a registry that cannot be reached is exit code 2, not a pass and not a fail', () =>
  withBranch(async ({ dir, commit }) => {
    commit({ 'package.json': { name: 'app', dependencies: { express: '^4.19.0', 'left-pad': '^1' } } });
    const down = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const outcome = await run(dir, fakeRegistry({ npm: { 'left-pad': down } }));
    assert.equal(outcome.results[0].status, 'error');
    assert.equal(outcome.results[0].reason, 'registry.npmjs.org could not be asked: ENOTFOUND');
    assert.equal(exitCode(outcome), 2);
  }));

test('a server error is retried, and a client error is not', () =>
  withBranch(async ({ dir, commit }) => {
    commit({ 'package.json': { name: 'app', dependencies: { express: '^4.19.0', flaky: '^1', forbidden: '^1' } } });
    const fetch = fakeRegistry({ npm: { flaky: 503, forbidden: 403 } });
    const outcome = await run(dir, fetch);
    const count = (name) => fetch.urls().filter((u) => u.endsWith(`/${name}`)).length;
    assert.equal(count('flaky'), 3);
    assert.equal(count('forbidden'), 1);
    assert.match(byName(outcome).flaky.reason, /HTTP 503/);
  }));

test('a manifest that cannot be read is exit code 2, and a failure still wins over it', () =>
  withBranch(async ({ dir, commit }) => {
    commit({ 'package.json': '{ "dependencies": ', 'requirements.txt': 'requests==2.31.0\nnot-on-pypi-zz\n' });
    const outcome = await run(dir, fakeRegistry());
    assert.match(outcome.problems[0], /^package\.json: /);
    assert.equal(exitCode(outcome), 1);
    assert.equal(exitCode({ ...outcome, results: [] }), 2);
  }));

test('unknown refs and directories that are not repositories are errors', () =>
  withRepo(async ({ dir }) => {
    await assert.rejects(run(dir, fakeRegistry(), { base: 'origin/main' }), /cannot find HEAD/);
  }).then(() =>
    withBranch(async ({ dir }) => {
      await assert.rejects(run(dir, fakeRegistry(), { base: 'origin/main' }), /cannot find origin\/main: fetch it, or pass --base/);
      await assert.rejects(run(dir, fakeRegistry(), { base: 'origin/main', env: { GITHUB_ACTIONS: 'true' } }), /fetch-depth: 0/);
      await assert.rejects(run(join(dir, '..'), fakeRegistry()), /is not a git repository/);
    }),
  ));

test('the default base follows the pull request on GitHub Actions', () => {
  assert.equal(defaultBase({ GITHUB_BASE_REF: 'develop' }), 'origin/develop');
  assert.equal(defaultBase({ GITHUB_BASE_REF: '' }), 'origin/main');
  assert.equal(defaultBase({}), 'origin/main');
});

test('run from a subdirectory, the whole repository is still read with paths from its root', () =>
  withRepo(async ({ dir, git, commit }) => {
    commit({ 'package.json': { name: 'root' }, 'web/package.json': { name: 'web' } });
    git('switch', '-q', '-c', 'feature');
    commit({ 'web/package.json': { name: 'web', dependencies: { 'web-made-up-zz': '^1' } } });
    const outcome = await run(join(dir, 'web'), fakeRegistry());
    assert.deepEqual(outcome.results.map((r) => [r.name, r.files]), [['web-made-up-zz', ['web/package.json']]]);
  }));
