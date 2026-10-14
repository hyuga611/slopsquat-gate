import { posix } from 'node:path';
import { normalizeCrate, parseCargoToml } from './cargo.mjs';
import { ECOSYSTEMS } from './ecosystems.mjs';
import { listFiles, readFiles } from './git.mjs';
import { npmSource, parseNpmrc, parsePackageJson } from './npm.mjs';
import { normalizePypi, parsePyproject, parseRequirements } from './pypi.mjs';

export function manifestKind(path) {
  const parts = path.split('/');
  if (parts.includes('node_modules')) return null;
  const name = parts.at(-1);
  if (name === 'package.json') return 'npm';
  if (name === '.npmrc') return 'npmrc';
  if (name === 'pyproject.toml') return 'pyproject';
  if (/^requirements.*\.txt$/i.test(name) || (parts.at(-2) === 'requirements' && name.endsWith('.txt'))) return 'requirements';
  if (name === 'Cargo.toml') return 'cargo';
  return null;
}

function nearest(byDir, file) {
  for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
    if (byDir.has(dir)) return byDir.get(dir);
    if (dir === '.') return undefined;
  }
}

// Every dependency declared in the manifests of one commit, with where each one resolves.
export function collectAt(cwd, commit, isIgnored = () => false) {
  const paths = listFiles(cwd, commit).filter((p) => manifestKind(p) && !isIgnored(p));
  const files = readFiles(cwd, commit, paths);
  const read = (p) => (files.has(p) ? files.get(p) : readFiles(cwd, commit, [p]).get(p));
  const npmrcs = new Map(paths.filter((p) => manifestKind(p) === 'npmrc').map((p) => [posix.dirname(p), parseNpmrc(files.get(p) ?? '')]));

  const deps = [];
  const problems = [];
  const local = { npm: new Set(), pypi: new Set(), crates: new Set() };
  const add = (ecosystem, file, list, mirror) => {
    for (const d of list) {
      deps.push({ ecosystem, file, ...d, key: ECOSYSTEMS[ecosystem].key(d.name), ...(mirror && !d.skip ? { mirror } : {}) });
    }
  };

  for (const file of paths) {
    const text = files.get(file);
    if (text == null) continue;
    try {
      switch (manifestKind(file)) {
        case 'npm': {
          const pkg = parsePackageJson(text);
          if (pkg.name) local.npm.add(pkg.name);
          const npmrc = nearest(npmrcs, file);
          add('npm', file, pkg.deps.map((d) => (d.skip ? d : { ...d, ...npmSource(d.name, npmrc) })));
          break;
        }
        case 'requirements': {
          const r = parseRequirements(text, file, read);
          problems.push(...r.problems);
          add('pypi', file, r.deps, r.mirror);
          break;
        }
        case 'pyproject': {
          const r = parsePyproject(text);
          for (const name of r.names) local.pypi.add(normalizePypi(name));
          problems.push(...r.problems.map((p) => `${file}: ${p}`));
          add('pypi', file, r.deps, r.mirror);
          break;
        }
        case 'cargo': {
          const r = parseCargoToml(text);
          if (r.name) local.crates.add(normalizeCrate(r.name));
          add('crates', file, r.deps);
          break;
        }
      }
    } catch (e) {
      problems.push(`${file}: ${e.message}`);
    }
  }

  for (const d of deps) {
    if (!d.skip && local[d.ecosystem].has(d.key)) Object.assign(d, { skip: 'local', reason: 'a package in this repository' });
  }
  return { deps, problems };
}

// A dependency is new when the same package was not resolved the same way anywhere before:
// moving it between manifests or changing its version is not new, switching it from a git
// URL to the registry is.
export function newDependencies(before, after) {
  const signature = (d) => `${d.ecosystem}\0${d.key}\0${d.skip ?? 'registry'}`;
  const old = new Set(before.map(signature));
  const added = new Map();
  for (const d of after) {
    const s = signature(d);
    if (old.has(s)) continue;
    const seen = added.get(s);
    if (!seen) added.set(s, { ...d, files: [d.file] });
    else {
      if (!seen.files.includes(d.file)) seen.files.push(d.file);
      seen.mirror ??= d.mirror;
    }
  }
  return [...added.values()];
}
