// Shared plumbing for tool handlers: run context, role checks, target resolution, result shaping, audit.
import { AdoError } from '../ado/client.ts';
import { toPrSnapshot, type PrSnapshot } from '../ado/model.ts';
import { isAllowedAdoHost, parseAdoUrl } from '../ado/urls.ts';
import type { Config, ProjectConfig, Role } from '../config.ts';
import type { Host, IssueRef } from '../host.ts';
import { assertNoSecretShapedKeys, safeResult } from '../sanitize.ts';
import { ConfigError, ScopeError, Service } from '../service.ts';
import type { ToolRole } from './catalog.ts';

export interface RunCtx { agentId: string; runId: string; companyId: string; projectId?: string }
export interface ToolOut { content?: string; data?: unknown; error?: string }
export class ToolError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

export const MAX_RESULT_BYTES = 64 * 1024;
const CALLS_PER_RUN = 60;
const runCalls = new Map<string, { n: number; at: number }>();

export function checkRunQuota(run: RunCtx, now: number, limit = CALLS_PER_RUN): void {
  for (const [k, v] of runCalls) if (now - v.at > 15 * 60_000) runCalls.delete(k);
  const cur = runCalls.get(run.runId) ?? { n: 0, at: now };
  cur.n++; cur.at = now; runCalls.set(run.runId, cur);
  if (cur.n > limit) throw new ToolError('run_quota_exceeded', `at most ${limit} Azure DevOps tool calls per run (the operator can raise limits.maxToolCallsPerRun on the Webhooks and limits tab of the settings in the Azure DevOps settings)`);
}

/** Authors are the listed agents, or every agent that is not a reviewer when the board chose "everyone is an author" (covers future agents). */
export function isAuthorAgent(cfg: Config, agentId: string): boolean {
  const is = (list: string[]) => list.some((x) => x.toLowerCase() === agentId.toLowerCase());
  return is(cfg.roles.authorAgentIds) || (cfg.roles.everyoneIsAuthor && !is(cfg.roles.reviewerAgentIds));
}

export function roleAllowed(cfg: Config, agentId: string, need: ToolRole): boolean {
  const is = (list: string[]) => list.some((x) => x.toLowerCase() === agentId.toLowerCase());
  switch (need) {
    case 'any': return true;
    case 'author': return isAuthorAgent(cfg, agentId);
    case 'reviewer': return is(cfg.roles.reviewerAgentIds);
    case 'operator': return is(cfg.roles.operatorAgentIds);
    case 'author_or_operator': return isAuthorAgent(cfg, agentId) || is(cfg.roles.operatorAgentIds);
    case 'author_or_reviewer': return isAuthorAgent(cfg, agentId) || is(cfg.roles.reviewerAgentIds);
    // Operators propose completions; in approver mode the author of a pull request may also ask for approval of its own work.
    case 'proposer': return is(cfg.roles.operatorAgentIds) || (cfg.approval.mode !== 'board' && isAuthorAgent(cfg, agentId));
    case 'approver': return is(cfg.approval.approverAgentIds);
    case 'deploy_approver': return is(cfg.platformAdmin.deployApproval.approverAgentIds);
    case 'gate': return is(cfg.approval.stagingGateAgentIds);
    case 'bundle_proposer': return is(cfg.platformAdmin.deployApproval.releaseBundle.proposerAgentIds);
    case 'bundle_party': { const da = cfg.platformAdmin.deployApproval; return is(da.releaseBundle.proposerAgentIds) || is(cfg.roles.reviewerAgentIds) || is(da.approverAgentIds) || Object.values(da.releaseVerdictFunctions).some(is); }
  }
}

/** Shape a handler result for the gateway: stable error codes, no secret-shaped keys, host scanner proof, size capped. */
export function finish(out: ToolOut): ToolOut {
  if (out.error) return { error: out.error, content: out.content ? String(out.content).slice(0, 600) : undefined };
  if (out.data !== undefined) assertNoSecretShapedKeys(out.data);
  let safe = safeResult(out);
  let size = Buffer.byteLength(JSON.stringify(safe), 'utf8');
  if (size > MAX_RESULT_BYTES) {
    safe = { content: (safe.content ?? '').slice(0, 2000) + '\n[result truncated: too large, ask for less]', data: { truncated: true } };
    size = 0;
  }
  return safe;
}

export function fail(e: unknown): ToolOut {
  if (e instanceof ToolError) return { error: e.code, content: e.message };
  if (e instanceof ConfigError) return { error: 'not_configured', content: e.message };
  if (e instanceof ScopeError) return { error: 'repo_not_in_scope', content: e.message };
  if (e instanceof AdoError) {
    const extra = e.code === 'ado_rate_limited' && e.retryAfterSeconds ? ` Retry in ${e.retryAfterSeconds} seconds.` : '';
    const msg = e.code === 'not_found_or_forbidden' ? `${e.message} (the object may not exist, or the identity may lack access)` : e.message;
    return { error: e.code, content: `${msg}.${extra}`.replace(/\.\.$/, '.') };
  }
  return { error: 'tool_failed', content: 'The Azure DevOps tool failed unexpectedly. Check ado_health.' };
}

export interface Target { project: ProjectConfig; repo: string; prId: number }

/** A PR can be named by id + repository (+ project) or by its web URL. URLs from agents are never fetched: they are only parsed. */
export async function resolvePrTarget(svc: Service, companyId: string, cfg: Config, p: { prId?: number; url?: string; repository?: string; project?: string }): Promise<Target> {
  if (p.url) {
    const ref = parseAdoUrl(p.url);
    if (!ref || ref.kind !== 'pull_request') throw new ToolError('bad_url', 'Not an Azure DevOps pull request URL');
    if (!isAllowedAdoHost(new URL(p.url).hostname, cfg.organization.name) || ref.org.toLowerCase() !== cfg.organization.name.toLowerCase()) throw new ToolError('url_not_allowed', 'The URL is outside the configured organization');
    const project = svc.projectOf(cfg, ref.project);
    if (!svc.repoAllowed(project, ref.repo!)) throw new ToolError('repo_not_in_scope', 'Repository is not in the configured scope');
    return { project, repo: ref.repo!, prId: ref.id };
  }
  if (!p.prId || !p.repository) throw new ToolError('bad_request', 'Give prId and repository, or url');
  const project = await svc.projectForRepo(companyId, cfg, p.project, p.repository);
  if (!svc.repoAllowed(project, p.repository)) throw new ToolError('repo_not_in_scope', 'Repository is not in the configured scope');
  return { project, repo: p.repository, prId: Math.trunc(p.prId) };
}

export async function requireRepo(svc: Service, companyId: string, cfg: Config, p: { repository?: string; project?: string }): Promise<{ project: ProjectConfig; repo: string }> {
  if (!p.repository) throw new ToolError('bad_request', 'repository is required');
  const project = await svc.projectForRepo(companyId, cfg, p.project, p.repository);
  if (!svc.repoAllowed(project, p.repository)) throw new ToolError('repo_not_in_scope', 'Repository is not in the configured scope');
  return { project, repo: p.repository };
}

export const sourceBranchOk = (b: string): boolean => /^[A-Za-z0-9._/-]{1,200}$/.test(b) && !b.includes('..') && !b.startsWith('/') && !b.endsWith('/');
export const toRef = (b: string): string => (b.startsWith('refs/') ? b : `refs/heads/${b}`);

export const footer = (agentName: string, issue: IssueRef | null, runId: string): string =>
  `\n\n---\nPosted by Paperclip agent ${agentName}${issue ? ` for ${issue.identifier}` : ''} (run ${runId.slice(0, 8)}).`;

/** The ADO identity id of a role, learned once from connectionData and kept in connection_state. */
export async function identityId(svc: Service, companyId: string, cfg: Config, role: Role): Promise<string> {
  const rows = await svc.store.connections(companyId);
  const row = rows.find((r) => r.role === role);
  // A recorded error (for example after the credential was swapped) forces a fresh lookup.
  if (row?.identity_id && !row.last_error_code) return row.identity_id;
  const me = await svc.api(companyId, cfg, role).connectionData();
  const id = me.authenticatedUser?.id ?? '';
  if (!id) throw new ToolError('identity_unknown', `Could not determine the ${role} identity`);
  await svc.store.setConnection(companyId, role, { identityId: id, displayName: me.authenticatedUser?.providerDisplayName ?? null, authKind: cfg.identities[role].kind, ok: true }, new Date(svc.host.now()).toISOString());
  return id;
}

export async function audit(svc: Service, host: Host, run: RunCtx, action: string, target: unknown, outcome: string, issueId?: string | null, detail?: unknown): Promise<void> {
  await svc.store.audit({ id: host.uuid(), companyId: run.companyId, at: new Date(host.now()).toISOString(), agentId: run.agentId, runId: run.runId, issueId: issueId ?? null, action, target, outcome, detail }).catch(() => {});
}

export function workProductStatus(s: PrSnapshot): 'draft' | 'ready_for_review' | 'changes_requested' | 'merged' | 'closed' {
  if (s.status === 'completed') return 'merged';
  if (s.status === 'abandoned') return 'closed';
  if (s.isDraft) return 'draft';
  if (s.reviewers.some((r) => r.vote <= -5)) return 'changes_requested';
  return 'ready_for_review';
}
export function workProductStep(issueId: string, s: PrSnapshot) {
  return {
    kind: 'work_product', method: 'POST', path: `/api/issues/${issueId}/work-products`,
    note: 'Record this pull request as a work product on the issue. Skip if one with the same externalId already exists; then PATCH its status instead.',
    body: { type: 'pull_request', provider: 'azure-devops', externalId: `${s.org}/${s.projectId}/${s.repoId}/${s.prId}`, title: s.title.slice(0, 200), url: s.url, status: workProductStatus(s), metadata: { org: s.org, projectId: s.projectId, repoId: s.repoId, repo: `${s.org}/${s.repoName}`, number: s.prId, sourceRef: s.sourceRef, targetRef: s.targetRef } },
  };
}
export { toPrSnapshot };
