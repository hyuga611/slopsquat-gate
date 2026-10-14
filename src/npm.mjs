import { getJson, hostOf } from './registry.mjs';

export const NPM_HOST = 'registry.npmjs.org';
const PUBLIC_HOSTS = new Set([NPM_HOST, 'registry.npmjs.com', 'registry.yarnpkg.com']);

export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// Which specs install from the registry and which come from somewhere else:
// https://docs.npmjs.com/cli/configuring-npm/package-json#dependencies
export function classifyNpmSpec(spec) {
  const s = String(spec).trim();
  const alias = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@.*)?$/.exec(s);
  if (alias) return { name: alias[1] };
  if (s.startsWith('workspace:')) return { skip: 'workspace', reason: 'workspace: protocol, a package in this repository' };
  if (/^(file|link|portal):/.test(s) || /^(\.{1,2}|~)?\//.test(s)) return { skip: 'path', reason: 'local path, not checked' };
  if (s.startsWith('patch:')) return { skip: 'patch', reason: 'Yarn patch: protocol, not checked' };
  if (s.startsWith('jsr:')) return { skip: 'jsr', reason: 'a JSR package, not on npm; not checked' };
  if (/^(git(\+[a-z]+)?:|git@|github:|gitlab:|bitbucket:|gist:)/.test(s) || /^[^@\s:./][^\s:]*\/[^\s:]+$/.test(s)) {
    return { skip: 'git', reason: 'git dependency, not checked' };
  }
  if (/^https?:/.test(s)) return { skip: 'url', reason: 'tarball URL, not checked' };
  return {};
}

export function parsePackageJson(text) {
  const doc = JSON.parse(text.replace(/^﻿/, ''));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a JSON object');
  const deps = [];
  for (const field of DEPENDENCY_FIELDS) {
    const table = doc[field];
    if (!table || typeof table !== 'object') continue;
    for (const [key, spec] of Object.entries(table)) {
      const { name, ...how } = classifyNpmSpec(spec);
      deps.push({ name: name ?? key, alias: name ? key : undefined, spec: String(spec), ...how });
    }
  }
  return { name: typeof doc.name === 'string' ? doc.name : undefined, deps };
}

// Reads the registry keys only. Auth lines are passed over, never kept.
export function parseNpmrc(text) {
  const out = { registry: undefined, scopes: {} };
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(registry|@[^:\s=]+:registry)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, '$2');
    if (m[1] === 'registry') out.registry = value;
    else out.scopes[m[1].slice(0, -':registry'.length)] = value;
  }
  return out;
}

const registryLabel = (url) => hostOf(url) ?? 'the registry in .npmrc';

// Where a dependency resolves, given the nearest .npmrc. Names of packages that come from
// a private registry are never sent to the public one.
export function npmSource(name, npmrc) {
  const scope = name.startsWith('@') ? name.split('/')[0] : null;
  const scoped = scope && npmrc?.scopes[scope];
  if (scoped && !PUBLIC_HOSTS.has(hostOf(scoped))) {
    return { skip: 'private', reason: `${scope} resolves from ${registryLabel(scoped)} (.npmrc), not checked` };
  }
  if (!scoped && npmrc?.registry && !PUBLIC_HOSTS.has(hostOf(npmrc.registry))) {
    return { mirror: registryLabel(npmrc.registry) };
  }
  return {};
}

export const npmUrl = (name) => `https://${NPM_HOST}/${encodeURIComponent(name).replace(/^%40/, '@')}`;

export async function lookupNpm(name, fetch) {
  const doc = await getJson(fetch, npmUrl(name), { accept: 'application/json' });
  if (!doc) return { found: false };
  const latest = doc['dist-tags']?.latest;
  const holding = /-security$/.test(latest ?? '') || doc.description === 'security holding package';
  return {
    found: true,
    created: doc.time?.created,
    unpublished: Boolean(doc.time?.unpublished) && !Object.keys(doc.versions ?? {}).length,
    holding: holding ? (latest ?? 'security holding package') : undefined,
    deprecated: doc.versions?.[latest]?.deprecated || undefined,
  };
}
