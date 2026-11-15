// ADO payload shapes (only the fields the plugin uses), normalised snapshots, and the chip status mapping (spec §10).
export interface AdoIdentityRef { id?: string; displayName?: string; uniqueName?: string }
export interface AdoReviewer extends AdoIdentityRef { vote?: number; isRequired?: boolean }
export interface AdoPullRequest {
  pullRequestId: number; status: 'active' | 'abandoned' | 'completed' | string; isDraft?: boolean; title?: string; description?: string;
  sourceRefName?: string; targetRefName?: string; mergeStatus?: string; createdBy?: AdoIdentityRef; reviewers?: AdoReviewer[];
  lastMergeSourceCommit?: { commitId?: string }; lastMergeCommit?: { commitId?: string }; lastMergeTargetCommit?: { commitId?: string };
  repository?: { id?: string; name?: string; project?: { id?: string; name?: string } };
  completionOptions?: Record<string, unknown>; creationDate?: string; closedDate?: string;
}
export interface AdoPolicyEvaluation {
  evaluationId?: string; status?: string; context?: { buildId?: number };
  configuration?: { isBlocking?: boolean; isEnabled?: boolean; type?: { displayName?: string; id?: string }; settings?: Record<string, unknown> };
}
export interface AdoBuild { id: number; status?: string; result?: string; sourceBranch?: string; sourceVersion?: string; reason?: string; finishTime?: string; definition?: { id?: number; name?: string }; _links?: { web?: { href?: string } }; project?: { id?: string; name?: string } }
export interface AdoWorkItem { id: number; rev?: number; fields?: Record<string, unknown>; relations?: Array<{ rel?: string; url?: string; attributes?: Record<string, unknown> }>; url?: string }

export interface PolicyBrief { name: string; status: string; blocking: boolean; evaluationId?: string; /** A Build policy that is queued but has no build on this head. */ noBuild?: boolean }
export interface PrSnapshot {
  org: string; projectId: string; projectName: string; repoId: string; repoName: string; prId: number; url: string;
  title: string; status: string; mergeStatus: string; isDraft: boolean; sourceRef: string; targetRef: string;
  createdById: string; lastMergeSourceCommit: string; lastMergeCommit: string; iterationCount: number;
  reviewers: Array<{ id: string; name: string; vote: number; required: boolean }>;
  policies: PolicyBrief[]; reviewStatus: 'succeeded' | 'pending' | 'failed' | 'none';
  terminal: boolean;
  /** Not persisted. Free text from ADO: untrusted. */
  description?: string;
}

export interface StatusRow { id?: number; state?: string; context?: { name?: string; genre?: string }; iterationId?: number; creationDate?: string; updatedDate?: string }
/**
 * The state of one status context on the current iteration. Azure DevOps keeps every status that was posted (the pending one
 * at the start and the later verdict), in no promised order, so the NEWEST entry decides, never the first one found.
 */
export function currentStatusState(rows: StatusRow[], genre: string, name: string, iteration: number): PrSnapshot['reviewStatus'] {
  const mine = rows.filter((s) => s.context?.genre === genre && s.context?.name === name);
  const newest = (xs: StatusRow[]) => xs.reduce<StatusRow | undefined>((a, b) => {
    if (!a) return b;
    const ta = Date.parse(a.updatedDate ?? a.creationDate ?? ''), tb = Date.parse(b.updatedDate ?? b.creationDate ?? '');
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb > ta ? b : a;
    return (b.id ?? 0) >= (a.id ?? 0) ? b : a;
  }, undefined);
  const cur = newest(mine.filter((s) => s.iterationId === iteration)) ?? newest(mine.filter((s) => s.iterationId === undefined)) ?? newest(mine);
  return cur?.state === 'succeeded' ? 'succeeded' : cur?.state === 'failed' || cur?.state === 'error' ? 'failed' : cur ? 'pending' : 'none';
}

export function prWebUrl(org: string, hostForm: string, projectName: string, repoName: string, prId: number): string {
  const e = encodeURIComponent;
  const base = hostForm === 'visualstudio.com' ? `https://${org}.visualstudio.com` : `https://dev.azure.com/${org}`;
  return `${base}/${e(projectName)}/_git/${e(repoName)}/pullrequest/${prId}`;
}

export function toPrSnapshot(org: string, hostForm: string, pr: AdoPullRequest, iterationCount: number, evals: AdoPolicyEvaluation[], reviewStatus: PrSnapshot['reviewStatus'] = 'none'): PrSnapshot {
  const project = pr.repository?.project ?? {};
  const policies: PolicyBrief[] = evals
    .filter((e) => e.status !== 'notApplicable' && e.configuration?.isEnabled !== false)
    .map((e) => ({ name: e.configuration?.type?.displayName ?? 'policy', status: e.status ?? 'queued', blocking: e.configuration?.isBlocking !== false,
      ...(e.evaluationId ? { evaluationId: e.evaluationId } : {}), ...(e.configuration?.type?.displayName === 'Build' && (e.status ?? 'queued') === 'queued' && !e.context?.buildId ? { noBuild: true } : {}) }));
  return {
    org, projectId: project.id ?? '', projectName: project.name ?? '', repoId: pr.repository?.id ?? '', repoName: pr.repository?.name ?? '', prId: pr.pullRequestId,
    url: prWebUrl(org, hostForm, project.name ?? '', pr.repository?.name ?? '', pr.pullRequestId),
    title: pr.title ?? '', status: pr.status, mergeStatus: pr.mergeStatus ?? 'notSet', isDraft: pr.isDraft === true,
    sourceRef: pr.sourceRefName ?? '', targetRef: pr.targetRefName ?? '', createdById: pr.createdBy?.id ?? '',
    lastMergeSourceCommit: pr.lastMergeSourceCommit?.commitId ?? '', lastMergeCommit: pr.lastMergeCommit?.commitId ?? '', iterationCount,
    reviewers: (pr.reviewers ?? []).map((r) => ({ id: r.id ?? '', name: r.displayName ?? '', vote: r.vote ?? 0, required: r.isRequired === true })),
    policies, reviewStatus, terminal: pr.status === 'completed' || pr.status === 'abandoned', description: pr.description,
  };
}

export type StatusCategory = 'unknown' | 'open' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'closed' | 'archived';
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';
export interface ChipStatus { statusKey: string; statusLabel: string; statusIconKey: string; statusCategory: StatusCategory; statusTone: StatusTone; isTerminal: boolean }

export function prChipStatus(p: PrSnapshot, requireReviewStatus = false): ChipStatus {
  if (p.status === 'completed') return { statusKey: 'merged', statusLabel: 'Completed', statusIconKey: 'git-merge', statusCategory: 'succeeded', statusTone: 'success', isTerminal: true };
  if (p.status === 'abandoned') return { statusKey: 'abandoned', statusLabel: 'Abandoned', statusIconKey: 'x-circle', statusCategory: 'closed', statusTone: 'muted', isTerminal: true };
  if (p.isDraft) return { statusKey: 'draft', statusLabel: 'Draft', statusIconKey: 'clock', statusCategory: 'waiting', statusTone: 'warning', isTerminal: false };
  if (p.mergeStatus === 'conflicts') return { statusKey: 'conflicts', statusLabel: 'Merge conflicts', statusIconKey: 'x-circle', statusCategory: 'blocked', statusTone: 'danger', isTerminal: false };
  const blocking = p.policies.filter((x) => x.blocking);
  if (blocking.some((x) => x.status === 'rejected' || x.status === 'broken')) return { statusKey: 'checks_failed', statusLabel: 'Checks failed', statusIconKey: 'x-circle', statusCategory: 'failed', statusTone: 'danger', isTerminal: false };
  const allApproved = blocking.length > 0 && blocking.every((x) => x.status === 'approved');
  const noRejectedVote = !p.reviewers.some((r) => r.vote <= -5);
  if (allApproved && noRejectedVote && (!requireReviewStatus || p.reviewStatus === 'succeeded')) return { statusKey: 'ready', statusLabel: 'Ready to complete', statusIconKey: 'check-circle', statusCategory: 'open', statusTone: 'success', isTerminal: false };
  return { statusKey: 'open', statusLabel: 'Open', statusIconKey: 'git-pull-request', statusCategory: 'open', statusTone: 'info', isTerminal: false };
}

export interface WiSnapshot { org: string; projectId: string; projectName: string; id: number; type: string; title: string; state: string; stateCategory: string; assignedTo: string; rev: number; url: string; terminal: boolean }
export function toWiSnapshot(org: string, hostForm: string, wi: AdoWorkItem, stateCategory: string): WiSnapshot {
  const f = wi.fields ?? {};
  const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '');
  const assigned = f['System.AssignedTo'];
  const projectName = s('System.TeamProject');
  const base = hostForm === 'visualstudio.com' ? `https://${org}.visualstudio.com` : `https://dev.azure.com/${org}`;
  return {
    org, projectId: '', projectName, id: wi.id, type: s('System.WorkItemType'), title: s('System.Title'), state: s('System.State'), stateCategory,
    assignedTo: typeof assigned === 'object' && assigned ? String((assigned as AdoIdentityRef).displayName ?? '') : typeof assigned === 'string' ? assigned : '',
    rev: wi.rev ?? 0, url: `${base}/${encodeURIComponent(projectName)}/_workitems/edit/${wi.id}`, terminal: stateCategory === 'Completed' || stateCategory === 'Removed',
  };
}
export function wiChipStatus(w: WiSnapshot): ChipStatus {
  switch (w.stateCategory) {
    case 'Proposed': return { statusKey: 'proposed', statusLabel: w.state || 'Proposed', statusIconKey: 'circle', statusCategory: 'open', statusTone: 'info', isTerminal: false };
    case 'InProgress': return { statusKey: 'in_progress', statusLabel: w.state || 'In progress', statusIconKey: 'loader', statusCategory: 'running', statusTone: 'info', isTerminal: false };
    case 'Resolved': return { statusKey: 'resolved', statusLabel: w.state || 'Resolved', statusIconKey: 'clock', statusCategory: 'waiting', statusTone: 'warning', isTerminal: false };
    case 'Completed': return { statusKey: 'completed', statusLabel: w.state || 'Done', statusIconKey: 'check-circle', statusCategory: 'succeeded', statusTone: 'success', isTerminal: true };
    case 'Removed': return { statusKey: 'removed', statusLabel: w.state || 'Removed', statusIconKey: 'archive', statusCategory: 'archived', statusTone: 'muted', isTerminal: true };
    default: return { statusKey: 'unknown', statusLabel: w.state || 'Unknown', statusIconKey: 'circle-dot', statusCategory: 'unknown', statusTone: 'neutral', isTerminal: false };
  }
}
