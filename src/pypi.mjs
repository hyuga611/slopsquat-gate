import { posix } from 'node:path';
import { getJson, hostOf } from './registry.mjs';
import { parseToml } from './toml.mjs';

export const PYPI_HOST = 'pypi.org';
const PUBLIC_HOSTS = new Set([PYPI_HOST, 'pypi.python.org', 'files.pythonhosted.org']);

// https://packaging.python.org/en/latest/specifications/name-normalization/
export const normalizePypi = (name) => name.replace(/[-_.]+/g, '-').toLowerCase();

// https://packaging.python.org/en/latest/specifications/dependency-specifiers/
export function parseRequirement(text) {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/s.exec(text);
  if (!m || !/^(@|;|[<>=!~(]|$)/.test(m[2])) return null;
  return m[2].startsWith('@') ? { name: m[1], skip: 'url', reason: 'direct URL reference, not checked' } : { name: m[1] };
}

const PATH_OR_URL = /^((git|hg|svn|bzr)\+|https?:|file:|[.~/\\]|[A-Za-z]:[\\/])|\.(whl|zip|tar\.gz|tgz|tar\.bz2)$/i;

const eggName = (s) => /#(?:.*&)?egg=([^&\s]+)/.exec(s)?.[1];

function splitOption(line) {
  const long = /^(--[a-z][a-z-]*)(?:\s*=\s*|\s+|$)(.*)$/.exec(line);
  if (long) return [long[1], long[2].trim()];
  const short = /^(-[a-zA-Z])\s*(.*)$/.exec(line);
  return short ? [short[1], short[2].trim()] : [line, ''];
}

// Comments removed and backslash continuations joined, each line with its first line number.
function logicalLines(text) {
  const out = [];
  let buf = '';
  let start = 0;
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      if (!buf) start = i + 1;
      const line = raw.replace(/(^|\s)#.*$/, '');
      if (line.endsWith('\\')) {
        buf += line.slice(0, -1);
        return;
      }
      buf += line;
      if (buf.trim()) out.push([start, buf.trim()]);
      buf = '';
    });
  if (buf.trim()) out.push([start, buf.trim()]);
  return out;
}

// pip's requirements format: https://pip.pypa.io/en/stable/reference/requirements-file-format/
// `read` returns another file of the same commit, for -r.
export function parseRequirements(text, file, read, seen = new Set()) {
  seen.add(file);
  const deps = [];
  const problems = [];
  const mirrors = [];
  for (const [n, line] of logicalLines(text)) {
    const where = `${file}:${n}`;
    if (line.startsWith('-')) {
      const [flag, value] = splitOption(line);
      if (flag === '-r' || flag === '--requirement') {
        const target = posix.normalize(posix.join(posix.dirname(file), value));
        if (/^[a-z]+:\/\//i.test(value)) problems.push(`${where}: cannot follow the remote file ${value}`);
        else if (!seen.has(target)) {
          const included = read(target);
          if (included == null) {
            problems.push(`${where}: ${value} is not in the repository`);
            continue;
          }
          const sub = parseRequirements(included, target, read, seen);
          deps.push(...sub.deps);
          problems.push(...sub.problems);
          if (sub.mirror) mirrors.push(sub.mirror);
        }
      } else if (flag === '-e' || flag === '--editable') {
        deps.push({ name: eggName(value) ?? value, spec: value, file, skip: 'editable', reason: 'editable install, not checked' });
      } else if (['-i', '--index-url', '--extra-index-url'].includes(flag)) {
        if (!PUBLIC_HOSTS.has(hostOf(value))) mirrors.push(hostOf(value) ?? 'another index');
      } else if (['-f', '--find-links', '--no-index'].includes(flag)) {
        mirrors.push('local files (--find-links / --no-index)');
      }
      continue;
    }
    const requirement = line.split(/\s+--/)[0];
    if (PATH_OR_URL.test(requirement)) {
      deps.push({ name: eggName(requirement) ?? requirement, spec: requirement, file, skip: 'url', reason: 'URL or path, not checked' });
      continue;
    }
    const parsed = parseRequirement(requirement);
    if (parsed) deps.push({ ...parsed, spec: requirement, file });
    else problems.push(`${where}: cannot read "${line}"`);
  }
  return { deps, problems, mirror: mirrors.length ? [...new Set(mirrors)].join(' or ') : undefined };
}

// A Poetry or uv source entry that sends the package somewhere other than PyPI.
function sourceOf(entry) {
  for (const e of [entry].flat()) {
    if (!e || typeof e !== 'object') continue;
    if (e.git) return { skip: 'git', reason: 'git dependency, not checked' };
    if (e.path) return { skip: 'path', reason: 'local path, not checked' };
    if (e.url) return { skip: 'url', reason: 'direct URL, not checked' };
    if (e.workspace) return { skip: 'workspace', reason: 'a workspace member in this repository' };
    const index = e.index ?? e.source;
    if (typeof index === 'string' && index.toLowerCase() !== 'pypi') {
      return { skip: 'private', reason: `pinned to the "${index}" index, not checked` };
    }
  }
  return {};
}

// [project], [dependency-groups] (PEP 735), [build-system], [tool.poetry] and [tool.uv.sources].
export function parsePyproject(text) {
  const doc = parseToml(text);
  const deps = [];
  const problems = [];
  const fromSpecifiers = (list, where) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const parsed = parseRequirement(item);
      if (parsed) deps.push({ ...parsed, spec: item });
      else problems.push(`${where}: cannot read "${item}"`);
    }
  };
  const project = doc.project ?? {};
  fromSpecifiers(project.dependencies, '[project] dependencies');
  for (const [group, list] of Object.entries(project['optional-dependencies'] ?? {})) {
    fromSpecifiers(list, `[project.optional-dependencies] ${group}`);
  }
  for (const [group, list] of Object.entries(doc['dependency-groups'] ?? {})) {
    fromSpecifiers(list, `[dependency-groups] ${group}`);
  }
  fromSpecifiers(doc['build-system']?.requires, '[build-system] requires');

  const uv = doc.tool?.uv ?? {};
  const uvSources = new Map(Object.entries(uv.sources ?? {}).map(([name, entry]) => [normalizePypi(name), entry]));
  for (const dep of deps) {
    if (!dep.skip) Object.assign(dep, sourceOf(uvSources.get(normalizePypi(dep.name))));
  }

  const poetry = doc.tool?.poetry ?? {};
  const poetryTables = [poetry.dependencies, poetry['dev-dependencies'], ...Object.values(poetry.group ?? {}).map((g) => g?.dependencies)];
  for (const table of poetryTables) {
    for (const [name, spec] of Object.entries(table ?? {})) {
      if (name.toLowerCase() === 'python') continue;
      deps.push({ name, spec: typeof spec === 'string' ? spec : JSON.stringify(spec), ...sourceOf(spec) });
    }
  }

  const indexes = [poetry.source, uv.index].flat().filter((s) => s && typeof s === 'object' && !PUBLIC_HOSTS.has(hostOf(s.url)));
  const mirror = indexes.length ? [...new Set(indexes.map((s) => hostOf(s.url) ?? `the "${s.name}" index`))].join(' or ') : undefined;
  return { names: [project.name, poetry.name].filter((n) => typeof n === 'string'), deps, problems, mirror };
}

export async function lookupPypi(name, fetch) {
  const url = `https://${PYPI_HOST}/simple/${normalizePypi(name)}/`;
  const doc = await getJson(fetch, url, { accept: 'application/vnd.pypi.simple.v1+json' });
  if (!doc) return { found: false };
  const files = doc.files ?? [];
  const first = files.reduce((min, f) => {
    const t = Date.parse(f['upload-time']);
    return Number.isFinite(t) && t < min ? t : min;
  }, Infinity);
  // Project status markers: https://peps.python.org/pep-0792/
  const status = doc['project-status'] ?? {};
  return {
    found: true,
    created: Number.isFinite(first) ? new Date(first).toISOString() : undefined,
    quarantined: status.status === 'quarantined',
    empty: !files.length,
    deprecated: status.status === 'deprecated' ? status.reason || true : undefined,
  };
}
