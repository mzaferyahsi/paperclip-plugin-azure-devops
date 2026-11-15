// Merge approval inside the organisation. Everything the approver needs to decide is evaluated HERE, from the plugin's own ledger
// (verdicts and gate results written by its tools) and live Azure DevOps state. Pull request text and comments are never consulted:
// an approver cannot be talked into approving, and a missing precondition is a mechanical refusal with a plain reason.
import type { PrSnapshot } from '../ado/model.ts';
import type { ApprovalConfig, Config, ProjectConfig } from '../config.ts';
import type { LinkRow } from '../store.ts';
import type { Service } from '../service.ts';

export interface VerdictFact { fn: string; agentId: string; vote: number; at: string }
export interface ApprovalFacts {
  commit: string; ready: boolean; missing: string[];
  /** Configured approvers who may decide this pull request now: not its author, not the proposer, not a verdict giver on this commit. */
  eligibleApprovers: string[];
  verdicts: VerdictFact[]; stagingGate: 'not_required' | 'succeeded' | 'failed' | 'missing';
  policies: Array<{ name: string; status: string; blocking: boolean }>; activeThreads: number | null;
}

const lc = (x: string) => x.toLowerCase();
const inList = (list: string[], id: string) => list.some((x) => lc(x) === lc(id));

/** Latest verdict per agent on the commit; an agent's later vote replaces an earlier one. */
export function latestVerdicts(rows: Array<{ agentId: string; fn: string; vote: number; at: string }>): VerdictFact[] {
  const by = new Map<string, VerdictFact>();
  for (const r of rows) by.set(`${lc(r.agentId)}:${r.fn}`, r);
  return [...by.values()];
}

/** Does the function have a qualifying verdict? An agent that is still assigned to it, voted at least minVote, and has not since voted -5 or worse. */
export function functionSatisfied(fn: string, verdicts: VerdictFact[], ap: ApprovalConfig): boolean {
  return verdicts.some((v) => v.fn === fn && inList(ap.verdictFunctions[fn] ?? [], v.agentId) && v.vote >= ap.minVerdictVote)
    && !verdicts.some((v) => v.fn === fn && inList(ap.verdictFunctions[fn] ?? [], v.agentId) && v.vote <= -5);
}

export async function evaluateApproval(svc: Service, companyId: string, cfg: Config, project: ProjectConfig, snap: PrSnapshot, links: LinkRow[], who?: { approverId?: string; proposerId?: string }): Promise<ApprovalFacts> {
  const ap = cfg.approval; const missing: string[] = [];
  const commit = snap.lastMergeSourceCommit;
  const verdicts = latestVerdicts(await svc.store.verdictsFor(companyId, snap.projectId, snap.repoId, snap.prId, commit));
  for (const fn of ap.requiredVerdictFunctions) if (!functionSatisfied(fn, verdicts, ap)) missing.push(`no ${fn} verdict of ${ap.minVerdictVote === 10 ? 'approved' : 'approved or approved with suggestions'} on commit ${commit.slice(0, 7)}`);
  // A status policy (such as the review status) can be satisfied without any build running, so only a Build policy shows a passing pipeline.
  if (ap.requirePipelinePolicy && !ap.pipelineOptionalRepositories.some((r) => lc(r) === lc(snap.repoName)) && !snap.policies.some((p) => p.blocking && /build/i.test(p.name) && p.status === 'approved')) missing.push('no blocking Build policy is approved on the target branch, so a passing pipeline cannot be shown');
  let activeThreads: number | null = null;
  if (ap.requireNoActiveThreads) {
    try {
      const th = await svc.read(companyId, cfg, (api) => api.threads(snap.projectId, snap.repoId, snap.prId));
      activeThreads = th.filter((t) => (t.status === 'active' || t.status === 'pending') && (t.comments ?? []).some((c) => (c as { commentType?: string }).commentType !== 'system')).length;
      if (activeThreads > 0) missing.push(`${activeThreads} review thread(s) are still active`);
    } catch { missing.push('review threads could not be read'); }
  }
  let stagingGate: ApprovalFacts['stagingGate'] = 'not_required';
  let gateAgent: string | null = null;
  if (project.stagingGateRepositories.some((r) => lc(r) === lc(snap.repoName))) {
    const g = await svc.store.gateFor(companyId, snap.projectId, snap.repoId, snap.prId, commit);
    stagingGate = !g ? 'missing' : g.state;
    gateAgent = g?.agentId ?? null;
    if (stagingGate !== 'succeeded') missing.push(stagingGate === 'failed' ? 'the staging gate failed on this commit' : 'the staging gate has no result for this commit');
  }
  if (who?.approverId) {
    const a = who.approverId;
    if (!inList(ap.approverAgentIds, a)) missing.push('you are not a configured approver');
    if (verdicts.some((v) => lc(v.agentId) === lc(a))) missing.push('you gave a verdict on this commit and cannot also approve it');
    if (gateAgent && lc(gateAgent) === lc(a)) missing.push('you posted the staging gate result on this commit and cannot also approve it');
    if (who.proposerId && lc(who.proposerId) === lc(a)) missing.push('you proposed this action and cannot also approve it');
    if (links.some((l) => l.authorAgentId && lc(l.authorAgentId) === lc(a))) missing.push('you authored this pull request and cannot approve it');
  }
  const authorKnown = links.some((l) => l.authorAgentId);
  if (!authorKnown && !ap.allowUnknownAuthor) missing.push('the author agent of this pull request is not recorded, so independence cannot be shown');
  const authors = links.map((l) => l.authorAgentId).filter((x): x is string => !!x);
  const eligibleApprovers = ap.approverAgentIds.filter((a) => !authors.some((x) => lc(x) === lc(a)) && !(who?.proposerId && lc(who.proposerId) === lc(a)) && !verdicts.some((v) => lc(v.agentId) === lc(a)) && !(gateAgent && lc(gateAgent) === lc(a)));
  return { commit, ready: missing.length === 0, missing, eligibleApprovers, verdicts, stagingGate, policies: snap.policies, activeThreads };
}
