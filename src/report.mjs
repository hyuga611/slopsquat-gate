import { VERSION } from './registry.mjs';

const LABEL = { fail: 'FAIL', error: 'ERROR', warn: 'warn', ok: 'ok', allow: 'allow', skip: 'skip' };

const short = (sha) => sha.slice(0, 7);
const deps = (n) => `${n} new ${n === 1 ? 'dependency' : 'dependencies'}`;
const packageName = (r) => (r.alias ? `${r.name} (as ${r.alias})` : r.name);

function range(o) {
  const base = o.mergeBase === o.baseCommit ? `${o.base} (${short(o.baseCommit)})` : `${o.base} (merge base ${short(o.mergeBase)})`;
  return `${o.head} (${short(o.headCommit)}) against ${base}`;
}

export function verdictLine(o) {
  const n = o.results.length;
  const count = (s) => o.results.filter((r) => r.status === s).length;
  if (count('fail')) return `${count('fail')} of ${deps(n)} failed.`;
  if (count('error')) return `${count('error')} of ${deps(n)} could not be checked.`;
  if (o.problems.length) return 'Some manifests could not be read.';
  if (!n) return 'No new dependencies.';
  const warned = count('warn') ? `, ${count('warn')} with a warning` : '';
  return `${n === 1 ? 'The new dependency' : `All ${deps(n)}`} passed${warned}.`;
}

export function formatText(o) {
  const out = [`slopsquat-gate ${VERSION}: ${range(o)}`];
  if (o.results.length) {
    out.push(`Packages first published less than ${o.minAgeDays} days ago fail.`, '');
    const nameWidth = Math.max(...o.results.map((r) => packageName(r).length));
    const fileWidth = Math.max(...o.results.map((r) => r.files.join(', ').length));
    for (const r of o.results) {
      out.push(
        `  ${LABEL[r.status].padEnd(5)}  ${r.ecosystem.padEnd(6)} ${packageName(r).padEnd(nameWidth)}  ${r.files.join(', ').padEnd(fileWidth)}  ${r.reason}`,
      );
    }
  }
  out.push('', verdictLine(o));
  out.push(...o.notes.map((n) => `note: ${n}`));
  return out.join('\n');
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

// Markdown for the job summary of a GitHub Actions run.
export function formatSummary(o) {
  const out = [`### slopsquat-gate: ${verdictLine(o)}`, ''];
  if (o.results.length) {
    out.push('| Result | Package | Registry | Manifest | Why |', '| --- | --- | --- | --- | --- |');
    for (const r of o.results) {
      const label = r.status === 'fail' || r.status === 'error' ? `**${LABEL[r.status]}**` : LABEL[r.status];
      out.push(`| ${label} | ${cell(code(packageName(r)))} | ${r.ecosystem} | ${cell(r.files.map(code).join(', '))} | ${cell(r.reason)} |`);
    }
    out.push('');
  }
  for (const p of o.problems) out.push(`- could not read ${cell(p)}`);
  for (const n of o.notes) out.push(`- ${cell(n)}`);
  out.push('', `Compared ${cell(range(o))}. Packages first published less than ${o.minAgeDays} days ago fail.`, '');
  return out.join('\n');
}
