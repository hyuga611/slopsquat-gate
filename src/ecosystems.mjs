import { CRATES_HOST, lookupCrate, normalizeCrate } from './cargo.mjs';
import { NPM_HOST, lookupNpm } from './npm.mjs';
import { PYPI_HOST, lookupPypi, normalizePypi } from './pypi.mjs';

// `key` turns a name into the form under which the registry knows it, so that two spellings
// of one package count as one.
export const ECOSYSTEMS = {
  npm: { host: NPM_HOST, key: (name) => name, lookup: lookupNpm, concurrency: 8 },
  pypi: { host: PYPI_HOST, key: normalizePypi, lookup: lookupPypi, concurrency: 8 },
  // crates.io asks API clients for at most one request a second.
  crates: { host: CRATES_HOST, key: normalizeCrate, lookup: lookupCrate, concurrency: 1, spacingMs: 1000 },
};
