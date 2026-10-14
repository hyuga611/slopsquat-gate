import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNpmSpec, lookupNpm, npmSource, parseNpmrc, parsePackageJson } from '../src/npm.mjs';
import { fakeRegistry, npmDoc } from './helpers.mjs';

test('specs that install from the registry, and those that do not', () => {
  for (const spec of ['^1.2.3', '1.x || 2.x', '>=1 <2', 'latest', 'next', '*', '', 'catalog:', 'catalog:react18']) {
    assert.deepEqual(classifyNpmSpec(spec), {}, spec);
  }
  const kind = (spec) => classifyNpmSpec(spec).skip;
  assert.equal(kind('workspace:*'), 'workspace');
  assert.equal(kind('workspace:^1.0.0'), 'workspace');
  for (const spec of ['file:../lib', 'link:../lib', 'portal:../lib', './lib', '../lib', '~/lib', '/opt/lib']) assert.equal(kind(spec), 'path', spec);
  for (const spec of ['github:user/repo', 'user/repo', 'user/repo#v1.0.0', 'git+https://github.com/u/r.git', 'git://github.com/u/r.git', 'git@github.com:u/r.git', 'gitlab:u/r', 'bitbucket:u/r']) {
    assert.equal(kind(spec), 'git', spec);
  }
  assert.equal(kind('https://example.com/pkg.tgz'), 'url');
  assert.equal(kind('patch:left-pad@npm%3A1.3.0#./patches/x.patch'), 'patch');
  assert.equal(kind('jsr:@std/path@^1'), 'jsr');
});

test('an npm: alias installs the package it names, scoped or not', () => {
  assert.deepEqual(classifyNpmSpec('npm:left-pad@^1.3.0'), { name: 'left-pad' });
  assert.deepEqual(classifyNpmSpec('npm:@types/node@20'), { name: '@types/node' });
  assert.deepEqual(classifyNpmSpec('npm:string-width'), { name: 'string-width' });
});

test('package.json: the four dependency fields, aliases, and a BOM', () => {
  const pkg = parsePackageJson(
    '﻿' +
      JSON.stringify({
        name: '@acme/app',
        dependencies: { react: '^18.0.0', 'old-name': 'npm:new-name@^2' },
        devDependencies: { '@types/node': '^20' },
        optionalDependencies: { fsevents: '^2' },
        peerDependencies: { 'react-dom': '*' },
        bundledDependencies: ['react'],
        overrides: { foo: '1.0.0' },
      }),
  );
  assert.equal(pkg.name, '@acme/app');
  assert.deepEqual(
    pkg.deps.map((d) => [d.name, d.alias]),
    [['react', undefined], ['new-name', 'old-name'], ['@types/node', undefined], ['fsevents', undefined], ['react-dom', undefined]],
  );
});

test('package.json that is not an object is an error', () => {
  assert.throws(() => parsePackageJson('[]'), /not a JSON object/);
  assert.throws(() => parsePackageJson('{ "dependencies": '));
});

test('.npmrc: only registry keys are kept, never auth lines', () => {
  const npmrc = parseNpmrc(
    [
      '; comment',
      'registry=https://npm.acme.example/',
      '@acme:registry = "https://npm.acme.example/acme/"',
      '@types:registry=https://registry.npmjs.org/',
      '//npm.acme.example/:_authToken=npm_SECRETSECRET',
      'always-auth=true',
    ].join('\r\n'),
  );
  assert.deepEqual(npmrc, {
    registry: 'https://npm.acme.example/',
    scopes: { '@acme': 'https://npm.acme.example/acme/', '@types': 'https://registry.npmjs.org/' },
  });
  assert.doesNotMatch(JSON.stringify(npmrc), /SECRET/);
});

test('a scope on a private registry is not checked, and its names are not sent anywhere', () => {
  const npmrc = parseNpmrc('@acme:registry=https://npm.acme.example/\n@types:registry=https://registry.npmjs.org/');
  assert.equal(npmSource('@acme/widget', npmrc).skip, 'private');
  assert.match(npmSource('@acme/widget', npmrc).reason, /@acme resolves from npm\.acme\.example/);
  assert.deepEqual(npmSource('@types/node', npmrc), {});
  assert.deepEqual(npmSource('left-pad', npmrc), {});
  assert.deepEqual(npmSource('left-pad', undefined), {});
});

test('a private default registry makes a missing package unverified, without showing credentials', () => {
  // A made-up credential, to show that only the host reaches the output. code-review: allow secret.basic-auth-url
  const npmrc = parseNpmrc('registry=https://ci:hunter2@artifactory.acme.example/api/npm/npm/');
  assert.deepEqual(npmSource('left-pad', npmrc), { mirror: 'artifactory.acme.example' });
  assert.deepEqual(npmSource('x', parseNpmrc('registry=${NPM_REGISTRY}')), { mirror: 'the registry in .npmrc' });
  assert.deepEqual(npmSource('x', parseNpmrc('registry=https://registry.yarnpkg.com')), {});
});

test('lookup: a scoped name is encoded as one path segment', async () => {
  const fetch = fakeRegistry({ npm: { '@acme%2Fwidget': npmDoc('2020-01-01T00:00:00.000Z') } });
  const facts = await lookupNpm('@acme/widget', fetch);
  assert.deepEqual(fetch.urls(), ['https://registry.npmjs.org/@acme%2Fwidget']);
  assert.equal(facts.found, true);
  assert.equal(facts.created, '2020-01-01T00:00:00.000Z');
});

test('lookup: missing, held by npm security, unpublished and deprecated packages', async () => {
  const fetch = fakeRegistry({
    npm: {
      electorn: npmDoc('2020-10-01T16:30:27.452Z', {
        description: 'security holding package',
        'dist-tags': { latest: '0.0.1-security' },
        versions: { '0.0.1-security': {} },
      }),
      gone: { time: { created: '2019-01-01T00:00:00.000Z', unpublished: { time: '2019-02-01T00:00:00.000Z', versions: ['1.0.0'] } } },
      request: npmDoc('2011-01-22T00:00:00.000Z', { versions: { '1.0.0': { deprecated: 'request has been deprecated' } } }),
    },
  });
  assert.deepEqual(await lookupNpm('reqeusts-helper', fetch), { found: false });
  assert.equal((await lookupNpm('electorn', fetch)).holding, '0.0.1-security');
  assert.equal((await lookupNpm('gone', fetch)).unpublished, true);
  assert.equal((await lookupNpm('request', fetch)).deprecated, 'request has been deprecated');
});
