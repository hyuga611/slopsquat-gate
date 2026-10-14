import { existsSync, readFileSync } from 'node:fs';
import { collectAt, newDependencies } from './collect.mjs';
import { allowMatcher, CONFIG_FILE, parseConfig, pathMatcher } from './config.mjs';
import { ECOSYSTEMS } from './ecosystems.mjs';
import { isRepository, mergeBase, readFiles, resolveCommit } from './git.mjs';
import { pool } from './registry.mjs';
import { judge } from './verdict.mjs';

export const DEFAULT_MIN_AGE_DAYS = 30;

// In a pull request on GitHub Actions the base branch is known; elsewhere main is the best guess.
export const defaultBase = (env) => (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : 'origin/main');

const ORDER = ['fail', 'error', 'warn', 'ok', 'allow', 'skip'];

// The allowlist is the gate's own policy, so it comes from the base branch: a change cannot
// wave its own new dependency through by adding it to the list.
function loadConfig(cwd, { configFile, base, baseCommit, headCommit, notes }) {
  if (configFile) return parseConfig(readFileSync(configFile, 'utf8'), configFile);
  const [atBase, atHead] = [baseCommit, headCommit].map((c) => readFiles(cwd, c, [CONFIG_FILE]).get(CONFIG_FILE));
  if (atHead != null && atHead !== atBase) {
    notes.push(`${CONFIG_FILE} is changed here; the one on ${base} is used, so the change applies once it is merged.`);
  }
  return atBase == null ? parseConfig('{}', CONFIG_FILE) : parseConfig(atBase, `${CONFIG_FILE} on ${base}`);
}

async function check(deps, { fetch, now, minAgeDays, allowed, allowSource }) {
  const queues = Object.fromEntries(Object.entries(ECOSYSTEMS).map(([name, e]) => [name, pool(e.concurrency, e.spacingMs)]));
  return Promise.all(
    deps.map(async (dep) => {
      if (dep.skip) return { ...dep, status: 'skip' };
      if (allowed(dep)) return { ...dep, status: 'allow', reason: `allowed by ${allowSource}` };
      try {
        const facts = await queues[dep.ecosystem](() => ECOSYSTEMS[dep.ecosystem].lookup(dep.name, fetch));
        return { ...dep, ...judge(dep, facts, { now, minAgeDays }) };
      } catch (e) {
        return { ...dep, status: 'error', reason: e.message };
      }
    }),
  );
}

const publicView = ({ ecosystem, name, alias, files, spec, status, reason, created, ageDays }) => ({
  status,
  ecosystem,
  name,
  ...(alias && { alias }),
  spec,
  files,
  reason,
  ...(created && { created, ageDays }),
});

export async function gate({
  cwd = '.',
  base,
  head = 'HEAD',
  minAgeDays,
  configFile,
  env = process.env,
  fetch = globalThis.fetch,
  now = new Date(),
} = {}) {
  base ??= defaultBase(env);
  if (!existsSync(cwd) || !isRepository(cwd)) throw new Error(`${cwd} is not a git repository`);
  const headCommit = resolveCommit(cwd, head);
  if (!headCommit) throw new Error(`cannot find ${head}`);
  const baseCommit = resolveCommit(cwd, base);
  if (!baseCommit) {
    const hint = env.GITHUB_ACTIONS ? 'check out with fetch-depth: 0 so that the base branch is there' : 'fetch it, or pass --base';
    throw new Error(`cannot find ${base}: ${hint}`);
  }

  const notes = [];
  let from = mergeBase(cwd, baseCommit, headCommit);
  if (!from) {
    from = baseCommit;
    notes.push(`${base} and ${head} share no history in this clone, so ${head} is compared with ${base} itself.`);
  }
  const config = loadConfig(cwd, { configFile, base, baseCommit, headCommit, notes });
  const ignored = pathMatcher(config.ignore);
  // Problems on the base side are passed over: a dependency it fails to show is only checked again.
  const before = collectAt(cwd, from, ignored);
  const after = collectAt(cwd, headCommit, ignored);
  const days = minAgeDays ?? config.minAgeDays ?? DEFAULT_MIN_AGE_DAYS;

  const results = await check(newDependencies(before.deps, after.deps), {
    fetch,
    now,
    minAgeDays: days,
    allowed: allowMatcher(config.allow),
    allowSource: config.source,
  });
  results.sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name),
  );
  return {
    base,
    head,
    baseCommit,
    mergeBase: from,
    headCommit,
    minAgeDays: days,
    results: results.map(publicView),
    problems: [...new Set(after.problems)],
    notes,
  };
}

export function exitCode(outcome) {
  if (outcome.results.some((r) => r.status === 'fail')) return 1;
  if (outcome.problems.length || outcome.results.some((r) => r.status === 'error')) return 2;
  return 0;
}
