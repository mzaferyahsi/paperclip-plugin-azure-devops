// Live evaluator for a staging deploy approval (design ALRAA-1280, controls 1-7 and the first evaluation of 12) and the read tool on top.
// Facts come only from Azure DevOps ids and parameters (strictly parsed), the plugin ledger and Paperclip issue status. No ADO free text is returned.
import { BundleStore } from '../bundle/store.ts';
import type { parsePipelineApproval } from '../ado/api.ts';
import { AdoError } from '../ado/client.ts';
import type { Config, ProjectConfig } from '../config.ts';
import { allowDeployEnvironment, allowDeployPipeline, allowBuildPipeline, requireDeployApproval } from '../platform-admin.ts';
import { neutralize } from '../sanitize.ts';
import type { Service } from '../service.ts';
import { hashArgs } from './gate.ts';
import { releaseAttestation } from './release.ts';
import { audit, ToolError, type RunCtx, type ToolOut } from './common.ts';

export const DEPLOY_ERROR_CODES = ['not_enabled', 'role_denied', 'resource_not_allowed', 'approval_not_pending', 'pipeline_not_allowed', 'binding_mismatch', 'attestation_missing', 'requester_forbidden', 'requester_unknown', 'release_blocked', 'already_decided', 'state_changed', 'postcondition_failed'] as const;
const COOLDOWN_MS = 30_000, STUCK_MS = 120_000;
const SCOPE_CODES: DeployErrorCode[] = ['approval_not_pending', 'resource_not_allowed', 'pipeline_not_allowed'];
const ORDER: DeployErrorCode[] = ['approval_not_pending', 'resource_not_allowed', 'pipeline_not_allowed', 'binding_mismatch', 'requester_forbidden', 'requester_unknown', 'release_blocked', 'attestation_missing'];
export type DeployErrorCode = typeof DEPLOY_ERROR_CODES[number];
export interface Missing { code: DeployErrorCode; reason: string }
type Fn = 'techlead' | 'qa' | 'security';
export interface DeployFacts {
  approvalId: string; environmentId: number | null; environmentName: string | null; runId: number | null; pipelineId: number | null; runCommit: string | null;
  commit: string | null; digest: string | null; buildId: number | null; requesterIds: string[]; requesterAgentId: string | null;
  attestations: Record<Fn, { satisfied: boolean; verdictIds: string[] }>;
  releaseIssue: { id: string; identifier: string; status: string; blockers: Array<{ identifier: string; status: string }> } | null;
}
export interface DeployEvaluation { ready: boolean; missing: Missing[]; facts: DeployFacts; factsHash: string }
export interface EvalInput { project: ProjectConfig; approvalId: string; releaseIssue?: string }

const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/;
const APPROVAL_CHECK_TYPE = '8c6f20a7-a545-4486-9777-f762fafe0d4d';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const emptyAttestations = (): DeployFacts['attestations'] => ({ techlead: { satisfied: false, verdictIds: [] }, qa: { satisfied: false, verdictIds: [] }, security: { satisfied: false, verdictIds: [] } });

/** Per-call lookups shared by a list evaluation so each check configuration and environment is read once. */
export interface EvalMemo { adminId?: string; checks: Map<number, Promise<unknown>>; envs: Map<number, Promise<unknown>> }
export const newMemo = (): EvalMemo => ({ checks: new Map(), envs: new Map() });
const once = <T>(m: Map<number, Promise<unknown>>, k: number, f: () => Promise<T>): Promise<T> => { let p = m.get(k); if (!p) { p = f(); m.set(k, p); } return p as Promise<T>; };

export async function evaluateDeployApproval(svc: Service, run: RunCtx, cfg: Config, input: EvalInput, memo: EvalMemo = newMemo()): Promise<DeployEvaluation> {
  requireDeployApproval(cfg);
  if (!GUID.test(input.approvalId)) throw new ToolError('bad_request', 'approvalId must be an Azure DevOps approval id (GUID)');
  const api = svc.admin(run.companyId, cfg).api;
  const adminId = memo.adminId ??= String((await api.connectionData()).authenticatedUser?.id ?? '');
  if (!GUID.test(adminId)) throw new ToolError('identity_unknown', 'Could not determine the platform administration identity');
  const found = await api.pipelineApprovals(input.project.name, { approvalIds: [input.approvalId] });
  const approval = found.length === 1 && same(found[0]!.id, input.approvalId) ? found[0]! : null;
  return evaluateApproval(svc, run, cfg, input, memo, adminId, approval);
}

export async function evaluateApproval(svc: Service, run: RunCtx, cfg: Config, input: EvalInput, memo: EvalMemo, adminId: string, approval: ReturnType<typeof parsePipelineApproval> | null): Promise<DeployEvaluation> {
  const da = cfg.platformAdmin.deployApproval;
  const api = svc.admin(run.companyId, cfg).api;
  const project = input.project.name;
  const missing: Missing[] = [];
  const miss = (code: DeployErrorCode, reason: string) => { if (!missing.some(m => m.code === code && m.reason === reason)) missing.push({ code, reason }); };
  const facts: DeployFacts = { approvalId: input.approvalId.toLowerCase(), environmentId: null, environmentName: null, runId: null, pipelineId: null, runCommit: null, commit: null, digest: null, buildId: null, requesterIds: [], requesterAgentId: null, attestations: emptyAttestations(), releaseIssue: null };
  const done = (): DeployEvaluation => ({ ready: missing.length === 0, missing, facts, factsHash: hashArgs(facts) });
  const notFound = (e: unknown) => e instanceof AdoError && e.code === 'not_found_or_forbidden';

  if (!approval) { miss('approval_not_pending', 'The approval was not found'); return done(); }
  facts.runId = approval.owner.id; facts.pipelineId = approval.pipeline.id;

  // Control 2: pending, one step, assigned to the platform administration identity.
  if (approval.status !== 'pending') miss('approval_not_pending', `The approval is ${approval.status}`);
  if (approval.steps.length !== 1) miss('approval_not_pending', 'The approval must have exactly one step');
  else {
    if (approval.steps[0]!.status !== 'pending') miss('approval_not_pending', `The approval step is ${approval.steps[0]!.status}`);
    if (!same(approval.steps[0]!.assignedApprover.id, adminId)) miss('approval_not_pending', 'The approval step is not assigned to the platform administration identity');
  }

  // Control 1: prove the environment through the approval check configuration. Anything unproven is refused and nothing else is read.
  let environmentOk = false;
  try {
    const cc = approval.checkConfiguration;
    if (!cc) miss('resource_not_allowed', 'The approval does not name its check configuration, so its environment cannot be proven');
    else {
      const check = await once(memo.checks, cc.id, () => api.checkConfiguration(project, cc.id));
      if (!same(check.type.id, APPROVAL_CHECK_TYPE)) miss('resource_not_allowed', 'The check is not an Approval check');
      else if (check.resource.type !== 'environment') miss('resource_not_allowed', 'The check does not belong to an environment');
      else if ((cc.resource && (cc.resource.type !== check.resource.type || cc.resource.id !== check.resource.id)) || (approval.resource && (approval.resource.type !== check.resource.type || approval.resource.id !== check.resource.id))) miss('resource_not_allowed', 'The approval and its check name different resources');
      else {
        const envId = Number(check.resource.id);
        const env = await once(memo.envs, envId, () => api.environment(project, envId));
        facts.environmentId = env.id;
        if (env.id !== envId) miss('resource_not_allowed', 'The environment could not be proven');
        else if (!allowDeployEnvironment(cfg, env.name)) miss('resource_not_allowed', 'The environment is not on the deploy approval allowlist');
        else { facts.environmentName = env.name; environmentOk = true; }
      }
    }
  } catch (e) { if (!notFound(e)) throw e; miss('resource_not_allowed', 'The approval check or environment could not be read'); }
  if (!environmentOk) return done();

  // Control 3: the owning run is an allowlisted, running, manual deploy of the allowed branch. Out-of-scope runs are not read further.
  let deploy: Awaited<ReturnType<typeof api.buildFacts>>;
  try { deploy = await api.buildFacts(project, approval.owner.id); } catch (e) { if (!notFound(e)) throw e; miss('pipeline_not_allowed', 'The approval run could not be read'); return done(); }
  facts.runCommit = deploy.sourceVersion.toLowerCase();
  if (!allowDeployPipeline(cfg, deploy.definition.id) || deploy.definition.id !== approval.pipeline.id) miss('pipeline_not_allowed', 'The run is not of an allowlisted deploy pipeline');
  if (deploy.status !== 'inProgress') miss('pipeline_not_allowed', `The deploy run is ${deploy.status}, not in progress`);
  if (deploy.sourceBranch !== da.sourceBranch) miss('pipeline_not_allowed', 'The deploy run is not on the allowed branch');
  if (deploy.reason !== 'manual') miss('pipeline_not_allowed', 'The deploy run was not started manually');
  if (missing.some(m => m.code === 'pipeline_not_allowed')) return done();

  // Control 4: the run's claimed image, commit and build must match the independent build record.
  const p = deploy.parameters;
  const image = typeof p.imageReference === 'string' && p.imageReference.startsWith(`${da.imageRepository}@`) && /^sha256:[0-9a-f]{64}$/.test(p.imageReference.slice(da.imageRepository.length + 1)) ? p.imageReference.slice(da.imageRepository.length + 1) : null;
  const commit = typeof p.sourceCommit === 'string' && /^[0-9a-f]{40}$/.test(p.sourceCommit) ? p.sourceCommit : null;
  const buildId = typeof p.buildId === 'string' && /^[1-9][0-9]{0,14}$/.test(p.buildId) ? Number(p.buildId) : typeof p.buildId === 'number' && Number.isSafeInteger(p.buildId) && p.buildId > 0 ? p.buildId : null;
  if (!image) miss('binding_mismatch', 'The run image is not a digest of the allowed image repository');
  if (!commit) miss('binding_mismatch', 'The run source commit is not a full commit id');
  if (buildId === null) miss('binding_mismatch', 'The run build id is not a positive number');
  facts.digest = image; facts.commit = commit; facts.buildId = buildId;
  if (commit && buildId !== null) {
    try {
      const built = await api.buildFacts(project, buildId);
      if (!allowBuildPipeline(cfg, built.definition.id)) miss('binding_mismatch', 'The image build is not from an allowlisted build pipeline');
      if (built.status !== 'completed' || built.result !== 'succeeded') miss('binding_mismatch', 'The image build did not succeed');
      if (built.sourceBranch !== da.sourceBranch) miss('binding_mismatch', 'The image build is not on the allowed branch');
      if (built.sourceVersion.toLowerCase() !== commit) miss('binding_mismatch', 'The image build commit differs from the run source commit');
    } catch (e) { if (!notFound(e)) throw e; miss('binding_mismatch', 'The image build could not be read'); }
  }

  // Control 6: who asked for the run. (a) the Azure DevOps requester is not the approver identity; (b) the ledger shows who proposed it.
  facts.requesterIds = [...new Set([deploy.requestedFor.id, deploy.requestedBy.id].map(x => x.toLowerCase()))].sort();
  if (facts.requesterIds.includes(adminId.toLowerCase())) miss('requester_forbidden', 'The run was requested by the approver identity');
  const action = await svc.store.appliedPipelineRunAction(run.companyId, approval.owner.id);
  const a = action?.args ?? {};
  const actionCommit = typeof a.commit === 'string' ? a.commit : a.parameters && typeof a.parameters === 'object' && typeof (a.parameters as Record<string, unknown>).sourceCommit === 'string' ? String((a.parameters as Record<string, unknown>).sourceCommit) : null;
  if (action && a.source === 'release_bundle') {
    // A ledger row written by the release bundle worker counts only while an approved bundle row backs this exact run (design section 4, control 6).
    const b = typeof a.bundleId === 'string' ? await new BundleStore(svc.host.db).get(run.companyId, a.bundleId) : null;
    const image = typeof deploy.parameters.imageReference === 'string' ? deploy.parameters.imageReference : '';
    const backed = !!b && ['deploying', 'completed'].includes(b.status) && !!b.approvedByUserId && b.deployRunId === approval.owner.id && b.sourceCommit === deploy.sourceVersion.toLowerCase() && b.deployPipelineId === deploy.definition.id
      && !!b.imageDigest && image === `${String(b.configSnapshot.imageRepository)}@${b.imageDigest}` && b.proposerAgentId.toLowerCase() === action.agentId.toLowerCase();
    if (!backed) { miss('requester_unknown', 'The run was queued by a release bundle that is not approved for this exact run'); }
  }
  if (!action) miss('requester_unknown', 'The run cannot be traced to an applied pipeline run action in the plugin ledger');
  else if (a.pipelineId !== deploy.definition.id || (typeof a.projectId === 'string' && !same(a.projectId, input.project.projectId)) || !actionCommit || actionCommit.toLowerCase() !== deploy.sourceVersion.toLowerCase()) miss('requester_unknown', 'The ledger action does not match the run pipeline, project or commit');
  else {
    facts.requesterAgentId = action.agentId.toLowerCase();
    if (da.approverAgentIds.some(id => same(id, action.agentId)) || same(action.agentId, run.agentId)) miss('requester_forbidden', 'The run was proposed by the deploy approver');
  }

  // Control 7 and the issue half of control 5.
  let issue: Awaited<ReturnType<Service['host']['issues']['findByIdentifier']>> = null;
  if (!input.releaseIssue || !ISSUE_KEY.test(input.releaseIssue)) miss('release_blocked', 'A release issue identifier is required');
  else {
    issue = await svc.host.issues.findByIdentifier(run.companyId, input.releaseIssue);
    if (!issue) miss('release_blocked', 'The release issue was not found');
  }
  if (issue) {
    let blockers: Array<{ id: string; identifier: string; status: string }> | null = null;
    try { blockers = await svc.host.issues.blockers(run.companyId, issue.id); } catch { miss('release_blocked', 'The release issue blockers could not be read'); }
    facts.releaseIssue = { id: issue.id, identifier: neutralize(issue.identifier).slice(0, 40), status: issue.status, blockers: (blockers ?? []).slice(0, 50).map(b => ({ identifier: neutralize(b.identifier).slice(0, 40), status: b.status })) };
    if (issue.status === 'blocked' || issue.status === 'cancelled') miss('release_blocked', `The release issue is ${issue.status}`);
    const open = (blockers ?? []).filter(b => b.status !== 'done');
    if (open.length) miss('release_blocked', `The release issue has ${open.length} unresolved blocker${open.length === 1 ? '' : 's'}`);
  }

  // Control 5: attestations on exactly this tuple.
  if (issue && image && commit && buildId !== null) {
    const rows = await svc.store.releaseVerdictsFor({ companyId: run.companyId, releaseIssueId: issue.id, sourceCommit: commit, imageDigest: image, buildId });
    facts.attestations = releaseAttestation(rows, { companyId: run.companyId, releaseIssueId: issue.id, sourceCommit: commit, imageDigest: image, buildId, releaseVerdictFunctions: da.releaseVerdictFunctions, approverAgentIds: da.approverAgentIds, ...(facts.requesterAgentId ? { requesterAgentId: facts.requesterAgentId } : {}) });
  }
  for (const fn of ['techlead', 'qa', 'security'] as const) if (!facts.attestations[fn].satisfied) miss('attestation_missing', `No valid ${fn} attestation on this exact commit, image and build`);
  return done();
}

export function makeDeployApprovalTools(svc: Service, agentName: (companyId: string, agentId: string) => Promise<string> = async () => 'agent') {
  async function approvalGet(a: Record<string, unknown>, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    requireDeployApproval(cfg);
    if (Object.keys(a).some(k => !['approvalId', 'releaseIssue', 'project'].includes(k)) || (a.approvalId !== undefined && typeof a.approvalId !== 'string') || (a.releaseIssue !== undefined && typeof a.releaseIssue !== 'string') || (a.project !== undefined && typeof a.project !== 'string')) throw new ToolError('bad_request', 'Give approvalId (optional), releaseIssue (optional) and project (optional)');
    const project = svc.projectOf(cfg, a.project as string | undefined);
    const releaseIssue = a.releaseIssue as string | undefined;
    if (typeof a.approvalId === 'string') {
      const e = await evaluateDeployApproval(svc, run, cfg, { project, approvalId: a.approvalId, ...(releaseIssue ? { releaseIssue } : {}) });
      return { content: e.ready ? 'Ready: every condition holds right now.' : `Not ready: ${e.missing.map(m => m.code).join(', ')}.`, data: e };
    }
    const memo = newMemo();
    const api = svc.admin(run.companyId, cfg).api;
    const adminId = memo.adminId = String((await api.connectionData()).authenticatedUser?.id ?? '');
    if (!GUID.test(adminId)) throw new ToolError('identity_unknown', 'Could not determine the platform administration identity');
    const pending = (await api.pipelineApprovals(project.name, { state: 'pending' })).slice(0, 50);
    const out: Array<{ approvalId: string; environmentName: string; runId: number | null; pipelineId: number | null; ready: boolean; missing: Missing[] }> = [];
    for (const ap of pending) {
      if (out.length >= 20) break;
      const e = await evaluateApproval(svc, run, cfg, { project, approvalId: ap.id, ...(releaseIssue ? { releaseIssue } : {}) }, memo, adminId, ap).catch(() => null);
      // Approvals outside the allowlisted environments (or that cannot be evaluated) are not listed at all.
      if (!e || !e.facts.environmentName) continue;
      out.push({ approvalId: e.facts.approvalId, environmentName: e.facts.environmentName, runId: e.facts.runId, pipelineId: e.facts.pipelineId, ready: e.ready, missing: e.missing });
    }
    return { content: `${out.length} pending approval${out.length === 1 ? '' : 's'} on allowlisted environments.`, data: { approvals: out, scanned: pending.length } };
  }

  // ---- ado_environment_approval_post (design controls 8-12) ----
  const cooldown = new Map<string, number>();
  const short = (f: DeployFacts) => ({ approvalId: f.approvalId, environmentId: f.environmentId, environmentName: f.environmentName, pipelineId: f.pipelineId, pipelineRunId: f.runId, commit: f.commit?.slice(0, 7) ?? null, digest: f.digest?.slice(0, 19) ?? null, buildId: f.buildId, verdictIds: { techlead: f.attestations.techlead.verdictIds, qa: f.attestations.qa.verdictIds, security: f.attestations.security.verdictIds }, requesterIds: f.requesterIds });
  async function approvalPost(a: Record<string, unknown>, run: RunCtx): Promise<ToolOut> {
    const { host, store } = svc;
    const nowMs = () => host.now(); const nowIso = () => new Date(host.now()).toISOString();
    const cfg = await svc.cfg(run.companyId);
    requireDeployApproval(cfg);
    // Who decided is the calling agent and its run, never the Azure DevOps identity that applies the decision.
    const decider = { decidedByAgentId: run.agentId.toLowerCase(), paperclipRunId: run.runId };
    let issueId: string | null = null; let detail: Record<string, unknown> = {}; let approvalId = typeof a.approvalId === 'string' ? a.approvalId.toLowerCase() : '';
    const refuse = async (code: DeployErrorCode | 'bad_request' | 'refusal_cooldown', message: string, cool = true): Promise<never> => {
      if (cool && approvalId) cooldown.set(`${run.companyId}:${approvalId}`, nowMs());
      await audit(svc, host, run, 'ado_environment_approval_post', { approvalId }, `refused:${code}`, issueId, { ...decider, ...detail, outcome: `refused:${code}`, reason: message.slice(0, 300) });
      throw new ToolError(code, message);
    };
    if (Object.keys(a).some(k => !['project', 'approvalId', 'decision', 'releaseIssue', 'reason'].includes(k)) || typeof a.approvalId !== 'string' || !GUID.test(a.approvalId) || (a.decision !== 'approve' && a.decision !== 'reject') ||
        typeof a.releaseIssue !== 'string' || !ISSUE_KEY.test(a.releaseIssue) || typeof a.reason !== 'string' || a.reason.trim().length < 1 || a.reason.length > 500 || a.reason.includes('\u0000') || (a.project !== undefined && typeof a.project !== 'string')) {
      return refuse('bad_request', 'Give approvalId (GUID), decision approve|reject, releaseIssue and a reason of 1..500 characters; no other keys are accepted', false);
    }
    const decision = a.decision; const want = decision === 'approve' ? 'approved' : 'rejected';
    const reason = neutralize(a.reason.trim()).slice(0, 500);
    const project = svc.projectOf(cfg, a.project as string | undefined);
    const key = `envapproval:${approvalId}`;
    const api = svc.admin(run.companyId, cfg).api;
    const issue = await host.issues.findByIdentifier(run.companyId, a.releaseIssue);
    issueId = issue?.id ?? null;
    const name = (await agentName(run.companyId, run.agentId).catch(() => 'agent')).replace(/[^\w .-]/g, '').slice(0, 60) || 'agent';
    const adminComment = (outcomeText: string, f: DeployFacts) => `Decision ${outcomeText} by Paperclip agent ${name} (${run.agentId}), run ${run.runId}, release ${neutralize(a.releaseIssue as string)}; commit ${f.commit?.slice(0, 7) ?? '-'} digest ${f.digest?.slice(0, 19) ?? '-'} build ${f.buildId ?? '-'}. Applied through the plugin with the platform administration identity. Reason: ${reason}`.slice(0, 1000);
    const readBack = async () => { const r = await api.pipelineApprovals(project.name, { approvalIds: [approvalId] }); return r.length === 1 && r[0]!.id.toLowerCase() === approvalId ? r[0]! : null; };
    const adminId = async () => { const id = String((await api.connectionData()).authenticatedUser?.id ?? ''); if (!GUID.test(id)) throw new ToolError('identity_unknown', 'Could not determine the platform administration identity'); return id; };
    const decidedOk = (ap: Awaited<ReturnType<typeof readBack>>, admin: string) => !!ap && ap.status === want && ap.steps.length === 1 && ap.steps[0]!.status === want && same(ap.steps[0]!.assignedApprover.id, admin);
    const done = async (row: { id: string; args: Record<string, unknown> }, f: DeployFacts, how: 'applied' | 'recovered'): Promise<ToolOut> => {
      const outcome = { outcome: want, how, ...short(f), ...decider };
      const moved = await store.envApprovalMove(run.companyId, row.id, ['applying', 'failed'], { status: 'applied', result: { phase: 'decided', ...outcome }, nowIso: nowIso(), applied: true }, (row.args.lease === undefined ? '' : String(row.args.lease)));
      if (!moved && how === 'recovered') return refuse('state_changed', 'Another call recorded this decision first', false);
      await audit(svc, host, run, 'ado_environment_approval_post', { approvalId }, `${want}`, issueId, { ...decider, ...short(f), decision, outcome: want, how, releaseIssue: a.releaseIssue, releaseIssueId: issueId });
      if (issue && await store.once(run.companyId, `${key}:comment`, nowIso())) await host.issues.comment(run.companyId, issue.id, `Deploy approval ${want} by ${name} (agent ${run.agentId}, run ${run.runId}). Approval ${approvalId}; environment ${f.environmentName} (${f.environmentId}); pipeline ${f.pipelineId} run ${f.runId}; commit ${f.commit?.slice(0, 7)}; digest ${f.digest?.slice(0, 19)}; build ${f.buildId}; verdicts techlead ${f.attestations.techlead.verdictIds.join(',') || '-'} qa ${f.attestations.qa.verdictIds.join(',') || '-'} security ${f.attestations.security.verdictIds.join(',') || '-'}; requesters ${f.requesterIds.join(',')}. Reason: ${reason}. Azure DevOps shows the administration account because the plugin applies the decision with it.`).catch(() => {});
      return { content: `Approval ${want}.`, data: { ...outcome, replayed: false } };
    };
    const replay = (row: NonNullable<Awaited<ReturnType<typeof store.envApprovalRow>>>): ToolOut => ({ content: `Approval already ${String(row.result.outcome)}: first outcome returned.`, data: { ...row.result, replayed: true } });

    // Control 8: an existing row for this approval id decides what happens, before anything else.
    let row = await store.envApprovalRow(run.companyId, key);
    let takeover = false;
    if (row) {
      detail = { priorStatus: row.status };
      const sameDecision = row.args.decision === decision;
      const phase = String(row.result.phase ?? '');
      if (row.status === 'applied') { if (!sameDecision) return refuse('already_decided', `This approval was already ${String(row.result.outcome)}`, false); await audit(svc, host, run, 'ado_environment_approval_post', { approvalId }, 'replayed', issueId, { ...decider, outcome: row.result.outcome }); return replay(row); }
      if (row.status === 'failed' && phase === 'postcondition') return refuse('postcondition_failed', 'The first attempt to decide this approval ended with a failed read-back check; an operator must look at it', false);
      if (row.status === 'failed' && phase === 'pre_patch') takeover = true; // no Azure DevOps write happened; the claim is free again
      else {
        if (!sameDecision) return refuse('already_decided', 'A different decision was already started for this approval', false);
        const admin = await adminId(); const ap = await readBack();
        if (!ap) return refuse('approval_not_pending', 'The approval was not found');
        if (ap.status !== 'pending') {
          if (decidedOk(ap, admin)) { const f = (row.result.facts ?? {}) as DeployFacts; return done(row, { ...f, approvalId, attestations: f.attestations ?? emptyAttestations(), requesterIds: f.requesterIds ?? [] } as DeployFacts, 'recovered'); }
          await store.envApprovalMove(run.companyId, row.id, ['applying', 'failed'], { status: 'failed', result: { ...row.result, phase: 'postcondition' }, nowIso: nowIso() }, (row.args.lease === undefined ? '' : String(row.args.lease)));
          return refuse('already_decided', 'The approval was decided in a different way', false);
        }
        const attempts = Number(row.args.attempts ?? 1);
        if (row.status === 'applying' && nowMs() - Date.parse(row.createdAt) < STUCK_MS) return refuse('state_changed', 'This decision is still being applied; try again in 2 minutes', false);
        if (attempts >= 2) return refuse('postcondition_failed', 'The decision was attempted twice and the approval is still pending; an operator must look at it', false);
        takeover = true;
      }
    }
    const last = cooldown.get(`${run.companyId}:${approvalId}`);
    if (last !== undefined && nowMs() - last < COOLDOWN_MS) return refuse('refusal_cooldown', `This approval was refused a moment ago; retry in ${Math.ceil((COOLDOWN_MS - (nowMs() - last)) / 1000)} seconds`, false);

    const admin = await adminId(); // resolved before the claim, so a failure here leaves no row behind
    // Evaluation 1.
    const e1 = await evaluateDeployApproval(svc, run, cfg, { project, approvalId, releaseIssue: a.releaseIssue });
    detail = { ...detail, ...short(e1.facts), missing: e1.missing.map(m => m.code), decision };
    const rank = (c: DeployErrorCode) => ORDER.indexOf(c);
    const first = [...e1.missing].sort((x, y) => rank(x.code) - rank(y.code))[0];
    if (decision === 'approve' && first) return refuse(first.code, `Not approved: ${first.reason}`);
    if (decision === 'reject') {
      const scope = [...e1.missing].find(m => SCOPE_CODES.includes(m.code)) ?? (!e1.facts.environmentName ? { code: 'resource_not_allowed' as const, reason: 'The environment is not proven to be allowlisted' } : null);
      if (scope) return refuse(scope.code, `Not touched: ${scope.reason}`);
      if (!issue) return refuse('release_blocked', 'The release issue was not found');
    }
    const facts1 = e1.facts;
    const summary = { facts: { ...facts1, releaseIssue: undefined }, phase: 'claimed', decision, ...decider };
    const nowI = nowIso();
    const args = { lease: host.uuid(), approvalId, decision, releaseIssue: a.releaseIssue, attempts: row ? Number(row.args.attempts ?? 1) + (row.status === 'failed' && String(row.result.phase) === 'patch_error' || row.status === 'applying' ? 1 : 0) : 1 };
    let claimed = false;
    if (!row) claimed = await store.envApprovalClaim({ id: host.uuid(), companyId: run.companyId, issueId: issue?.id ?? run.companyId, agentId: run.agentId, runId: run.runId, key, argsHash: hashArgs({ approvalId, decision, releaseIssue: a.releaseIssue }), args, result: summary, nowIso: nowI });
    else if (takeover) claimed = await store.envApprovalMove(run.companyId, row.id, [row.status], { status: 'applying', args, result: summary, nowIso: nowI, agentId: run.agentId, runId: run.runId }, (row.args.lease === undefined ? '' : String(row.args.lease)));
    if (!claimed) return refuse('state_changed', 'Another call is deciding this approval', false);
    row = await store.envApprovalRow(run.companyId, key);
    if (!row) return refuse('state_changed', 'The decision record is missing', false);
    const claim = row;
    const release = async (phase: string, extra: Record<string, unknown> = {}) => { await store.envApprovalMove(run.companyId, claim.id, ['applying'], { status: 'failed', result: { ...summary, phase, ...extra }, nowIso: nowIso() }, String(claim.args.lease ?? '')); };

    // Evaluation 2, immediately before the write: every fact must be unchanged.
    let e2: DeployEvaluation;
    try { e2 = await evaluateDeployApproval(svc, run, cfg, { project, approvalId, releaseIssue: a.releaseIssue }); }
    catch (e) { await release('pre_patch'); throw e; }
    if (e2.factsHash !== e1.factsHash || (decision === 'approve' && !e2.ready)) { await release('pre_patch'); return refuse('state_changed', 'The facts changed while the decision was being prepared; nothing was decided'); }

    // The only write: exactly [{approvalId, status, comment}] through the administration identity.
    try { await api.decidePipelineApproval(project.name, approvalId, want, adminComment(want, facts1)); }
    catch (e) {
      await release('patch_error', { error: e instanceof AdoError ? e.code : 'error' });
      await audit(svc, host, run, 'ado_environment_approval_post', { approvalId }, 'failed:patch_error', issueId, { ...decider, ...short(facts1), decision, code: e instanceof AdoError ? e.code : 'error' });
      throw e;
    }
    let back: Awaited<ReturnType<typeof readBack>> = null;
    try { back = await readBack(); } catch { back = null; }
    if (!decidedOk(back, admin)) {
      await release('postcondition');
      await audit(svc, host, run, 'ado_environment_approval_post', { approvalId }, 'failed:postcondition_failed', issueId, { ...decider, ...short(facts1), decision });
      throw new ToolError('postcondition_failed', 'Azure DevOps did not show the expected decision after the write; an operator must look at it');
    }
    return done(claim, facts1, 'applied');
  }
  return { ado_environment_approval_get: approvalGet, ado_environment_approval_post: approvalPost };
}
