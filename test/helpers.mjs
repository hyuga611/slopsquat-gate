import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const NOW = new Date('2026-10-14T12:00:00Z');
export const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// A fresh repository on branch main. Git runs without the machine's own configuration, so
// signing, hooks or a different default branch cannot change what the tests see.
export async function withRepo(fn) {
  const base = mkdtempSync(join(tmpdir(), 'slopsquat-'));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  const gitconfig = join(base, 'gitconfig');
  writeFileSync(gitconfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  // Writes the files (null deletes one) and commits them; returns the commit.
  const commit = (files, message = 'change') => {
    for (const [name, body] of Object.entries(files)) {
      const file = join(dir, name);
      if (body === null) rmSync(file, { force: true });
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
      }
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  try {
    return await fn({ dir, git, commit });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export const npmDoc = (created, extra = {}) => ({
  time: { created, modified: created },
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': {} },
  ...extra,
});
export const pypiDoc = (...uploads) => ({
  meta: { 'api-version': '1.4' },
  'project-status': { status: 'active' },
  files: uploads.map((t, i) => ({ filename: `pkg-${i}.tar.gz`, 'upload-time': t })),
});
export const crateDoc = (created) => ({ crate: { created_at: created } });

// Answers the way the three registries do, from tables of packages by URL path. Anything not in
// the tables is a 404. A number answers with that status, an Error is thrown as a network failure.
export function fakeRegistry({ npm = {}, pypi = {}, crates = {} } = {}) {
  const routes = new Map([
    ...Object.entries(npm).map(([path, doc]) => [`https://registry.npmjs.org/${path}`, doc]),
    ...Object.entries(pypi).map(([path, doc]) => [`https://pypi.org/simple/${path}/`, doc]),
    ...Object.entries(crates).map(([path, doc]) => [`https://crates.io/api/v1/crates/${path}?include=default_version`, doc]),
  ]);
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const answer = routes.get(String(url));
    if (answer === undefined) return new Response('{"error":"Not found"}', { status: 404 });
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return new Response('unavailable', { status: answer });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fetch.calls = calls;
  fetch.urls = () => calls.map((c) => c.url);
  return fetch;
}
