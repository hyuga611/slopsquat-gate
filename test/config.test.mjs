import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowMatcher, parseConfig, pathMatcher } from '../src/config.mjs';

test('a config with every key', () => {
  assert.deepEqual(parseConfig('{"allow": ["@acme/*"], "ignore": ["test/fixtures/"], "minAgeDays": 14}', 'c'), {
    allow: ['@acme/*'],
    ignore: ['test/fixtures/'],
    minAgeDays: 14,
    source: 'c',
  });
  assert.deepEqual(parseConfig('{}', 'c'), { allow: [], ignore: [], minAgeDays: undefined, source: 'c' });
});

test('a typo or a wrong type is an error, not a silently ignored setting', () => {
  assert.throws(() => parseConfig('{"allowed": []}', 'c'), /unknown key allowed/);
  assert.throws(() => parseConfig('{"allow": "x"}', 'c'), /"allow" must be a list of strings/);
  assert.throws(() => parseConfig('{"minAgeDays": -1}', 'c'), /minAgeDays/);
  assert.throws(() => parseConfig('{"minAgeDays": "30"}', 'c'), /minAgeDays/);
  assert.throws(() => parseConfig('[]', 'c'), /expected a JSON object/);
  assert.throws(() => parseConfig('{', '.slopsquat.json on origin/main'), /^Error: \.slopsquat\.json on origin\/main: /);
});

test('allow entries: ecosystem prefixes, globs, and names compared as the registry does', () => {
  const allowed = allowMatcher(['@acme/*', 'pypi:Acme_Tools', 'crates:acme-*', 'internal-cli']);
  const dep = (ecosystem, key) => ({ ecosystem, key });
  assert.equal(allowed(dep('npm', '@acme/widget')), true);
  assert.equal(allowed(dep('npm', '@acme-evil/widget')), false);
  assert.equal(allowed(dep('pypi', 'acme-tools')), true);
  assert.equal(allowed(dep('npm', 'acme-tools')), false);
  assert.equal(allowed(dep('crates', 'acme-core')), true);
  assert.equal(allowed(dep('npm', 'acme-core')), false);
  assert.equal(allowed(dep('npm', 'internal-cli')), true);
  assert.equal(allowed(dep('pypi', 'internal-cli')), true);
  assert.equal(allowed(dep('npm', 'internal-cli-2')), false);
});

test('ignore globs over repository paths', () => {
  const ignored = pathMatcher(['test/fixtures/', '**/examples/*/package.json', 'docs/*.txt']);
  assert.equal(ignored('test/fixtures/a/package.json'), true);
  assert.equal(ignored('packages/x/examples/demo/package.json'), true);
  assert.equal(ignored('examples/demo/package.json'), true);
  assert.equal(ignored('examples/demo/nested/package.json'), false);
  assert.equal(ignored('docs/requirements.txt'), true);
  assert.equal(ignored('docs/sub/requirements.txt'), false);
  assert.equal(ignored('package.json'), false);
});
