import { ECOSYSTEMS } from './ecosystems.mjs';

const DAY_MS = 86_400_000;

const days = (n) => (n === 0 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`);
const oneLine = (text, max = 120) => {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// What the registry's answer means for one new dependency: fail, warn or ok, and why.
export function judge(dep, facts, { now, minAgeDays }) {
  const where = ECOSYSTEMS[dep.ecosystem].host;
  const fail = (reason) => ({ status: 'fail', reason });
  if (!facts.found) {
    if (dep.mirror) return { status: 'warn', reason: `not on ${where}; may come from ${dep.mirror}, which was not asked` };
    return fail(`does not exist on ${where}: a made-up name, and anyone can register it`);
  }
  if (facts.holding) return fail(`removed by npm as malicious; only a security placeholder (${facts.holding}) is left`);
  if (facts.quarantined) return fail('quarantined by PyPI, which is done to projects reported as malware');
  if (facts.unpublished) return fail(`every version was unpublished from ${where}; there is nothing to install`);
  if (facts.empty) return fail(`registered on ${where} with no files to install`);

  const created = new Date(facts.created ?? NaN);
  if (Number.isNaN(created.getTime())) return { status: 'warn', reason: `${where} gives no first-publish date` };
  const ageDays = Math.max(0, Math.floor((now - created) / DAY_MS));
  const date = created.toISOString().slice(0, 10);
  const dated = { created: date, ageDays };
  if (ageDays < minAgeDays) {
    return { status: 'fail', ...dated, reason: `first published ${date}, ${days(ageDays)}: newer than ${minAgeDays} days` };
  }
  if (facts.deprecated) {
    const why = facts.deprecated === true ? '' : `: ${oneLine(facts.deprecated)}`;
    return { status: 'warn', ...dated, reason: `deprecated${why}` };
  }
  return { status: 'ok', ...dated, reason: `first published ${date}` };
}
