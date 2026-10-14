import { getJson } from './registry.mjs';
import { parseToml } from './toml.mjs';

export const CRATES_HOST = 'crates.io';

// crates.io treats - and _ as the same name.
export const normalizeCrate = (name) => name.replace(/_/g, '-').toLowerCase();

const TABLES = ['dependencies', 'dev-dependencies', 'dev_dependencies', 'build-dependencies', 'build_dependencies'];

// https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html
function classify(key, spec) {
  if (!spec || typeof spec !== 'object') return { name: key };
  const name = typeof spec.package === 'string' ? spec.package : key;
  const alias = name === key ? undefined : key;
  if (spec.workspace === true) return { name, alias, skip: 'workspace', reason: 'inherited from [workspace.dependencies]' };
  if (spec.path) return { name, alias, skip: 'path', reason: 'local path, not checked' };
  if (spec.git) return { name, alias, skip: 'git', reason: 'git dependency, not checked' };
  const registry = spec.registry ?? spec['registry-index'];
  if (registry) return { name, alias, skip: 'private', reason: `from the "${registry}" registry, not checked` };
  return { name, alias };
}

export function parseCargoToml(text) {
  const doc = parseToml(text);
  const deps = [];
  const add = (table) => {
    for (const [key, spec] of Object.entries(table ?? {})) {
      deps.push({ spec: typeof spec === 'string' ? spec : JSON.stringify(spec), ...classify(key, spec) });
    }
  };
  for (const scope of [doc, ...Object.values(doc.target ?? {})]) {
    for (const t of TABLES) add(scope?.[t]);
  }
  add(doc.workspace?.dependencies);
  return { name: typeof doc.package?.name === 'string' ? doc.package.name : undefined, deps };
}

export async function lookupCrate(name, fetch) {
  // include= trims the response from every version's metadata to the crate itself.
  const url = `https://${CRATES_HOST}/api/v1/crates/${encodeURIComponent(name)}?include=default_version`;
  const doc = await getJson(fetch, url, { accept: 'application/json' });
  if (!doc) return { found: false };
  return { found: true, created: doc.crate?.created_at };
}
