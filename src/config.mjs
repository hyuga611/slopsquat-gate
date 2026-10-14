import { ECOSYSTEMS } from './ecosystems.mjs';

export const CONFIG_FILE = '.slopsquat.json';
const KEYS = ['allow', 'ignore', 'minAgeDays'];

export function parseConfig(text, where) {
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`${where}: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: expected a JSON object`);
  const unknown = Object.keys(raw).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw new Error(`${where}: unknown key ${unknown.join(', ')} (known: ${KEYS.join(', ')})`);
  const strings = (key) => {
    const v = raw[key] ?? [];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw new Error(`${where}: "${key}" must be a list of strings`);
    return v;
  };
  const { minAgeDays } = raw;
  if (minAgeDays !== undefined && !(Number.isInteger(minAgeDays) && minAgeDays >= 0)) {
    throw new Error(`${where}: "minAgeDays" must be a whole number of days, 0 or more`);
  }
  return { allow: strings('allow'), ignore: strings('ignore'), minAgeDays, source: where };
}

// * stays within a path segment or a name, ** crosses segments, a trailing / means everything below.
export function globToRegExp(glob) {
  const g = glob.endsWith('/') ? `${glob}**` : glob;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function pathMatcher(globs) {
  const res = globs.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}

// "@acme/*" allows a name in every ecosystem; "pypi:acme-*" only on PyPI. Names compare the way
// the registry compares them, so "pypi:Acme_Tools" also allows acme-tools.
export function allowMatcher(patterns) {
  const rules = patterns.map((p) => {
    const m = /^(npm|pypi|crates):/.exec(p);
    return { ecosystem: m?.[1], name: m ? p.slice(m[0].length) : p };
  });
  return (dep) =>
    rules.some((r) => (!r.ecosystem || r.ecosystem === dep.ecosystem) && globToRegExp(ECOSYSTEMS[dep.ecosystem].key(r.name)).test(dep.key));
}
