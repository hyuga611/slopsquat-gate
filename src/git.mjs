import { spawnSync } from 'node:child_process';

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`could not run git: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

const tryGit = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

export const isRepository = (cwd) => tryGit(cwd, ['rev-parse', '--git-dir']) !== null;

export const resolveCommit = (cwd, ref) => tryGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);

export const mergeBase = (cwd, a, b) => tryGit(cwd, ['merge-base', a, b]);

export function listFiles(cwd, commit) {
  return git(cwd, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', commit]).toString('utf8').split('\0').filter(Boolean);
}

// Reads many files of one commit through a single `git cat-file --batch`. Missing files map to null.
export function readFiles(cwd, commit, paths) {
  const files = new Map();
  if (!paths.length) return files;
  const out = git(cwd, ['cat-file', '--batch'], paths.map((p) => `${commit}:${p}\n`).join(''));
  let pos = 0;
  for (const path of paths) {
    const eol = out.indexOf(10, pos);
    const header = out.toString('utf8', pos, eol).split(' ');
    pos = eol + 1;
    if (header[1] !== 'blob') {
      files.set(path, null);
      continue;
    }
    const size = Number(header[2]);
    files.set(path, out.toString('utf8', pos, pos + size));
    pos += size + 1;
  }
  return files;
}
