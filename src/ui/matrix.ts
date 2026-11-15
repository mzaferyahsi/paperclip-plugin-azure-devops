/** Pure helpers behind the agents table: one row per agent, one column per duty. */
type Cfg = Record<string, any>;

export type Duty = 'author' | 'reviewer' | 'operator' | 'approver' | 'qa' | 'security' | 'staging';

const has = (xs: unknown, id: string): boolean => Array.isArray(xs) && xs.includes(id);
const toggle = (xs: unknown, id: string, on: boolean): string[] => {
  const cur: string[] = Array.isArray(xs) ? xs : [];
  return on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id);
};

export function dutyOn(cfg: Cfg, duty: Duty, id: string): boolean {
  const r = cfg.roles ?? {}, a = cfg.approval ?? {};
  switch (duty) {
    case 'author': return (r.everyoneIsAuthor === true && !has(r.reviewerAgentIds, id)) || has(r.authorAgentIds, id);
    case 'reviewer': return has(r.reviewerAgentIds, id);
    case 'operator': return has(r.operatorAgentIds, id);
    case 'approver': return has(a.approverAgentIds, id);
    case 'qa': return has(a.verdictFunctions?.qa, id);
    case 'security': return has(a.verdictFunctions?.security, id);
    case 'staging': return has(a.stagingGateAgentIds, id);
  }
}

/** Set one duty for one agent. An agent cannot be author and reviewer: turning one on turns the other off. Verdict agents must be reviewers, so a verdict turns reviewer on. */
export function setDuty(cfg: Cfg, duty: Duty, id: string, on: boolean): Cfg {
  const r = { ...(cfg.roles ?? {}) }, a = { ...(cfg.approval ?? {}) };
  const vf = { ...(a.verdictFunctions ?? {}) };
  const reqDefault = a.requiredVerdictFunctions ?? ['qa', 'security'];
  switch (duty) {
    case 'author':
      r.authorAgentIds = toggle(r.authorAgentIds, id, on);
      if (on) r.reviewerAgentIds = toggle(r.reviewerAgentIds, id, false);
      break;
    case 'reviewer':
      r.reviewerAgentIds = toggle(r.reviewerAgentIds, id, on);
      if (on) r.authorAgentIds = toggle(r.authorAgentIds, id, false);
      else { vf.qa = toggle(vf.qa, id, false); vf.security = toggle(vf.security, id, false); a.verdictFunctions = vf; }
      break;
    case 'operator': r.operatorAgentIds = toggle(r.operatorAgentIds, id, on); break;
    case 'approver': a.approverAgentIds = toggle(a.approverAgentIds, id, on); break;
    case 'qa': case 'security':
      vf[duty] = toggle(vf[duty], id, on); a.verdictFunctions = vf; a.requiredVerdictFunctions = reqDefault;
      if (on) { r.reviewerAgentIds = toggle(r.reviewerAgentIds, id, true); r.authorAgentIds = toggle(r.authorAgentIds, id, false); }
      break;
    case 'staging': a.stagingGateAgentIds = toggle(a.stagingGateAgentIds, id, on); break;
  }
  return { ...cfg, roles: r, approval: a };
}

/** Plain-language problems in the agents table, shown next to it. */
export function dutyWarnings(cfg: Cfg, names: Record<string, string>): string[] {
  const out: string[] = [];
  const r = cfg.roles ?? {}, a = cfg.approval ?? {};
  const n = (id: string) => names[id] ?? id.slice(0, 8);
  for (const id of r.authorAgentIds ?? []) if (has(r.reviewerAgentIds, id)) out.push(`${n(id)} is both author and reviewer.`);
  if ((a.mode ?? 'board') !== 'board') {
    if (!(a.approverAgentIds ?? []).length) out.push('Merge approval needs at least one approver.');
    if (!(a.verdictFunctions?.qa ?? []).length) out.push('Merge approval needs at least one QA verdict agent.');
    if ((a.requiredVerdictFunctions ?? ['qa', 'security']).includes('security') && !(a.verdictFunctions?.security ?? []).length) out.push('A Security verdict is required, but no Security verdict agent is chosen.');
    for (const id of a.approverAgentIds ?? []) if (has(a.verdictFunctions?.qa, id) || has(a.verdictFunctions?.security, id)) out.push(`${n(id)} is an approver and also gives a verdict. An approver cannot do both.`);
  }
  return out;
}
