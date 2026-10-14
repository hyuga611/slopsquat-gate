import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../src/verdict.mjs';
import { daysAgo, NOW } from './helpers.mjs';

const npm = { ecosystem: 'npm', name: 'x' };
const at = (facts, dep = npm, minAgeDays = 30) => judge(dep, { found: true, ...facts }, { now: NOW, minAgeDays });

test('a package that does not exist fails, unless another registry may hold it', () => {
  assert.deepEqual(judge(npm, { found: false }, { now: NOW, minAgeDays: 30 }), {
    status: 'fail',
    reason: 'does not exist on registry.npmjs.org: a made-up name, and anyone can register it',
  });
  const mirrored = judge({ ...npm, mirror: 'npm.acme.example' }, { found: false }, { now: NOW, minAgeDays: 30 });
  assert.equal(mirrored.status, 'warn');
  assert.match(mirrored.reason, /may come from npm\.acme\.example/);
});

test('younger than the minimum age fails; exactly the minimum passes', () => {
  assert.equal(at({ created: daysAgo(29) }).status, 'fail');
  assert.match(at({ created: daysAgo(29) }).reason, /^first published 2026-09-15, 29 days ago: newer than 30 days$/);
  assert.equal(at({ created: daysAgo(30) }).status, 'ok');
  assert.equal(at({ created: daysAgo(0) }).reason, 'first published 2026-10-14, today: newer than 30 days');
  assert.equal(at({ created: daysAgo(0) }, npm, 0).status, 'ok');
});

test('taken down, quarantined, unpublished and empty packages fail even when old', () => {
  const old = daysAgo(2000);
  assert.match(at({ created: old, holding: '0.0.1-security' }).reason, /removed by npm as malicious.*0\.0\.1-security/);
  assert.match(at({ created: old, quarantined: true }, { ecosystem: 'pypi', name: 'x' }).reason, /quarantined by PyPI/);
  assert.equal(at({ created: old, unpublished: true }).status, 'fail');
  assert.match(at({ empty: true }, { ecosystem: 'pypi', name: 'x' }).reason, /no files to install/);
});

test('deprecated warns, and a missing date warns rather than passing silently', () => {
  const deprecated = at({ created: daysAgo(4000), deprecated: 'request has been\n deprecated, see https://github.com/request/request/issues/3142' });
  assert.equal(deprecated.status, 'warn');
  assert.equal(deprecated.reason, 'deprecated: request has been deprecated, see https://github.com/request/request/issues/3142');
  assert.equal(at({ created: daysAgo(4000), deprecated: true }, { ecosystem: 'pypi', name: 'x' }).reason, 'deprecated');
  assert.deepEqual(at({}), { status: 'warn', reason: 'registry.npmjs.org gives no first-publish date' });
});
