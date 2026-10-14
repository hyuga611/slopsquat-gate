#!/usr/bin/env node
import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILE } from './config.mjs';
import { DEFAULT_MIN_AGE_DAYS, exitCode, gate } from './gate.mjs';
import { VERSION } from './registry.mjs';
import { formatSummary, formatText } from './report.mjs';

const HELP = `slopsquat-gate ${VERSION}: does every dependency this change adds really exist, and is it old enough to trust?

Usage: slopsquat-gate [dir] [options]

Compares the manifests of two commits (package.json, requirements*.txt, pyproject.toml,
Cargo.toml) and asks the public registry about each dependency that is new: does it exist,
when was it first published, and has it been taken down as malware. Only package names are
sent, and only to registry.npmjs.org, pypi.org and crates.io.

Options:
  --base <ref>       what the change is compared with (default: origin/$GITHUB_BASE_REF in a
                     GitHub Actions pull request, otherwise origin/main). The comparison starts
                     from the merge base, as in base...head.
  --head <ref>       the change to check (default: HEAD)
  --min-age <days>   fail packages first published fewer days ago than this (default:
                     minAgeDays in ${CONFIG_FILE}, otherwise ${DEFAULT_MIN_AGE_DAYS}; 0 turns the check off)
  --config <file>    read the policy from this file instead of ${CONFIG_FILE} on the base branch
  --json             print the result as JSON
  -h, --help         show this help
  -v, --version      show the version

With GITHUB_STEP_SUMMARY set, as in GitHub Actions, the result is also added to the job summary.

Exit codes: 0 pass, 1 a new dependency failed, 2 usage error, unreadable manifest or
unreachable registry.`;

export function parseArgs(argv) {
  const opts = { dir: '.', base: undefined, head: 'HEAD', minAge: undefined, config: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--base') opts.base = value();
    else if (a === '--head') opts.head = value();
    else if (a === '--config') opts.config = value();
    else if (a === '--min-age') {
      const v = value();
      if (!/^\d+$/.test(v)) throw new Error(`--min-age must be a whole number of days (got "${v}")`);
      opts.minAge = Number(v);
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.dir = a;
  }
  return opts;
}

export async function main(argv, io = { log: console.log, error: console.error }, { env = process.env, fetch, now } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    io.error(`slopsquat-gate: ${e.message}\nRun slopsquat-gate --help for usage.`);
    return 2;
  }
  if (opts.help) return io.log(HELP), 0;
  if (opts.version) return io.log(VERSION), 0;

  let outcome;
  try {
    outcome = await gate({
      cwd: opts.dir,
      base: opts.base,
      head: opts.head,
      minAgeDays: opts.minAge,
      configFile: opts.config,
      env,
      fetch,
      now,
    });
  } catch (e) {
    io.error(`slopsquat-gate: ${e.message}`);
    return 2;
  }

  const code = exitCode(outcome);
  if (opts.json) io.log(JSON.stringify({ version: VERSION, failed: code === 1, ...outcome }, null, 2));
  else io.log(formatText(outcome));
  for (const p of outcome.problems) io.error(`slopsquat-gate: could not read ${p}`);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, formatSummary(outcome));
    } catch (e) {
      io.error(`slopsquat-gate: could not write the job summary: ${e.message}`);
    }
  }
  return code;
}

// npm i -g and npx call the bin through a symlink, so compare resolved paths.
function runDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (runDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
