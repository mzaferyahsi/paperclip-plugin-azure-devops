// Gated actions (class G, spec D7/D8). Two phases with a durable ledger:
//   phase 1 (no actionId): validate everything, write an `action` row bound to a hash of the exact arguments, ask a human on the issue
//   phase 2 (actionId):    require the human's acceptance, re-validate against live ADO state, execute with bypassPolicy=false
// ADO branch policy stays the hard gate: the plugin never sets bypassPolicy and the bot identities should not hold that permission.
import { createHash } from 'node:crypto';
import { allowEnvironment, allowPipeline, allowSecureFile, requirePlatformAdmin, variableGroupOf } from '../platform-admin.ts';
import { APPROVAL_CHECK_TYPE } from '../ado/api.ts';
import { AdoError } from '../ado/client.ts';
import { VARIABLE_NAME, type ProjectConfig } from '../config.ts';
import { NS } from '../namespace.ts';
import { neutralize } from '../sanitize.ts';
import type { Service } from '../service.ts';
import { audit, identityId, requireRepo, toRef, ToolError, workProductStep, type RunCtx, type ToolOut } from './common.ts';
import { evaluateApproval, type ApprovalFacts } from './approval.ts';
import { prView } from './read.ts';

type A = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const TTL_MS = 24 * 3600_000;
const COOLDOWN_MS = 30 * 60_000;
const STRATEGIES = ['noFastForward', 'squash', 'rebase', 'rebaseMerge'];

const canonical = (v: unknown): string => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`);
export const hashArgs = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');

interface ActionRow { id: string; issue_id: string | null; agent_id: string; tool: string; args_hash: string; args_redacted: Record<string, unknown>; status: string; interaction_id: string | null; expires_at: Date; result: unknown; gate_mode: string; approved_by_agent_id: string | null; approval_deadline_at: Date | null; approval_issue_id: string | null }
const ACTION_COLS = 'id,issue_id,agent_id,tool,args_hash,args_redacted,status,interaction_id,expires_at,result,gate_mode,approved_by_agent_id,approval_deadline_at,approval_issue_id';

export function makeGatedTools(svc: Service, agentName: (companyId: string, agentId: string) => Promise<string> = async () => 'an agent') {
  const host = svc.host;
  const nowIso = () => new Date(host.now()).toISOString();

  async function load(run: RunCtx, id: string): Promise<ActionRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return (await host.db.query<ActionRow>(`SELECT ${ACTION_COLS} FROM ${NS}.action WHERE company_id=$1 AND id=$2`, [run.companyId, id]))[0] ?? null;
  }
  const setStatus = (run: RunCtx, id: string, status: string, extra: { result?: unknown; approvedBy?: string | null } = {}) =>
    host.db.execute(`UPDATE ${NS}.action SET status=$3, result=COALESCE($4::jsonb,result), approved_by_user_id=COALESCE($5::text,approved_by_user_id), approved_at=CASE WHEN $3 IN ('approved','applied') THEN COALESCE(approved_at,$6::timestamptz) ELSE approved_at END, applied_at=CASE WHEN $3='applied' THEN $6::timestamptz ELSE applied_at END WHERE company_id=$1 AND id=$2`,
      [run.companyId, id, status, extra.result === undefined ? null : JSON.stringify(extra.result), extra.approvedBy ?? null, nowIso()]);


  const lc = (x: string) => x.toLowerCase();

  /** Wake someone who can decide: a task assigned to the first eligible approver, or (without the issues.create capability) a comment on the issue. */
  async function askApprovers(run: RunCtx, cfg: Awaited<ReturnType<typeof svc.cfg>>, actionId: string, issueId: string, prompt: string, details: string, facts: ApprovalFacts | null): Promise<string> {
    const eligible = cfg.approval.approverAgentIds.filter((x) => lc(x) !== lc(run.agentId));
    const lines = [`Action \`${actionId}\`: ${prompt}`, '', details, '', facts ? `Verified by the plugin at commit \`${facts.commit.slice(0, 7)}\`: ${facts.verdicts.map((v) => `${v.fn} ${v.vote}`).join(', ') || 'no verdicts'}; staging gate ${facts.stagingGate}.` : '',
      '', `Decide with \`ado_pr_approval_post\` { actionId: "${actionId}", decision: "approve" | "reject"${facts ? `, headCommit: "${facts.commit}"` : ''}, reason }. Read the details first with \`ado_pr_approval_get\` { actionId }. ${facts ? 'You approve the facts; you do not re-review the code. ' : 'Check the run is what the reason says: this pipeline, this branch. '}The tool refuses unless every condition holds now.`].filter((x) => x !== undefined);
    const body = lines.join('\n');
    if (eligible[0]) {
      try {
        const t = await host.issues.createChild(run.companyId, issueId, { title: `Approve: ${prompt}`.slice(0, 190), description: body, assigneeAgentId: eligible[0] });
        await host.db.execute(`UPDATE ${NS}.action SET approval_issue_id=$3 WHERE company_id=$1 AND id=$2`, [run.companyId, actionId, t.id]);
        await host.issues.wake(run.companyId, t.id, 'approval_requested', `ado:approval-task:${actionId}`).catch(() => {});
        await host.issues.comment(run.companyId, issueId, `Merge approval requested: ${t.identifier} (approvers: ${cfg.approval.approverAgentIds.length}).`).catch(() => {});
        return `${t.identifier}, assigned to the first approver`;
      } catch (e) { host.log.warn('approval task could not be created, falling back to a comment', { error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    }
    await host.issues.comment(run.companyId, issueId, `**Merge approval needed** from one of the configured approvers.\n\n${body}`).catch(() => {});
    await host.issues.wake(run.companyId, issueId, 'approval_requested', `ado:approval:${actionId}`).catch(() => {});
    return 'the approvers (comment on the issue)';
  }

  async function humanCard(companyId: string, issueId: string, actionId: string, prompt: string, details: string, why: string): Promise<string> {
    return (await host.issues.requestConfirmation(companyId, issueId, { prompt, detailsMarkdown: `${why}\n\n${details}`, acceptLabel: 'Approve', rejectLabel: 'Reject', idempotencyKey: `ado:human:${actionId}`.slice(0, 250) })).id;
  }

  /** A run that was started is spent: asking again is a new attempt with its own approval. */
  const SPENT_WHEN_APPLIED = new Set(['ado_pipeline_run_create', 'ado_pr_policy_queue_apply']);
  const SHORT = /^[0-9a-f]{7,40}$/i;
  const sameCommit = (given: string, actual: string) => SHORT.test(given) && actual.toLowerCase().startsWith(given.toLowerCase());

  /** The tool approvers use. Everything is re-evaluated from ledger and live state at this moment. */
  async function approvalPost(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    const actionId = str(a.actionId); const decision = str(a.decision);
    if (!actionId || (decision !== 'approve' && decision !== 'reject')) throw new ToolError('bad_request', 'actionId and decision (approve or reject) are required');
    const row = await load(run, actionId);
    if (!row || !['ado_pr_complete_apply', 'ado_pr_abandon_apply', 'ado_pipeline_run_create', 'ado_pr_policy_queue_apply'].includes(row.tool)) throw new ToolError('action_not_found', 'Unknown action');
    if (row.gate_mode === 'board') throw new ToolError('not_an_approver_action', 'This action is decided by a person on the issue');
    if (!cfg.approval.approverAgentIds.some((x) => lc(x) === lc(run.agentId))) throw new ToolError('role_denied', 'Only a configured approver may decide');
    if (lc(row.agent_id) === lc(run.agentId)) throw new ToolError('self_approval', 'You proposed this action and cannot also decide it');
    if (row.approved_by_agent_id && decision === 'approve') return { content: 'Already approved.', data: { actionId, status: row.status } };
    if (row.status !== 'awaiting_approval') throw new ToolError('wrong_state', `This action is ${row.status.replace('_', ' ')}; it cannot be decided now`);
    if (new Date(row.expires_at).getTime() < host.now()) { await setStatus(run, actionId, 'expired'); throw new ToolError('action_expired', 'This action expired; the proposer must propose it again'); }
    const issueId = row.issue_id;
    if (decision === 'reject') {
      const reason = neutralize(String(a.reason ?? '').trim().slice(0, 500));
      if (!reason) throw new ToolError('bad_request', 'A reason is required when rejecting');
      const r = await host.db.execute(`UPDATE ${NS}.action SET status='rejected', rejected_by_agent_id=$3, reject_reason=$4 WHERE company_id=$1 AND id=$2 AND status='awaiting_approval'`, [run.companyId, actionId, run.agentId, reason]);
      if (!r.rowCount) throw new ToolError('wrong_state', 'The action changed while you were deciding');
      await audit(svc, host, run, row.tool, row.args_redacted, 'rejected', issueId, { reason });
      if (issueId) await host.issues.comment(run.companyId, issueId, `Approval of ${row.tool === 'ado_pipeline_run_create' ? 'the pipeline run' : row.tool === 'ado_pr_policy_queue_apply' ? 'the build policy queue' : 'the merge'} rejected by ${await agentName(run.companyId, run.agentId)}: ${reason}`).catch(() => {});
      return { content: 'Rejected. The proposer was told on the issue.', data: { actionId, status: 'rejected' } };
    }
    // approve: recompute everything now
    let facts: ApprovalFacts | null = null; let commitNow = '';
    if (row.tool === 'ado_pr_complete_apply') {
      const stored = row.args_redacted; const prId = num(stored.prId);
      const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(stored.repository), project: str(stored.project) });
      const { snap, links } = await svc.syncPr(run.companyId, cfg, project, repo, prId ?? 0, 'gate:ado_pr_approval_post');
      commitNow = snap.lastMergeSourceCommit;
      facts = await evaluateApproval(svc, run.companyId, cfg, project, snap, links, { approverId: run.agentId, proposerId: row.agent_id });
      const live = completionProblems(snap, cfg.review.publishStatus, cfg.review.statusGenre, cfg.review.statusName);
      if (live.length) facts.missing.push(...live);
      if (str(stored.commit) && stored.commit !== commitNow) throw new ToolError('commit_changed', 'The pull request has a new commit since it was proposed. The proposer must propose it again.');
    }
    if (commitNow) {
      if (!sameCommit(str(a.headCommit) ?? '', commitNow)) throw new ToolError('commit_mismatch', `headCommit does not match the pull request's current head (${commitNow.slice(0, 7)}). Read ado_pr_approval_get again.`);
    }
    if (facts && facts.missing.length) { await audit(svc, host, run, row.tool, row.args_redacted, 'refused:not_ready', issueId, { missing: facts.missing }); throw new ToolError('not_ready', `Not ready to approve: ${[...new Set(facts.missing)].join('; ')}.`); }
    const both = row.gate_mode === 'both';
    let interactionId: string | null = null;
    if (both) { if (!issueId) throw new ToolError('no_issue_for_confirmation', 'No issue to ask the person on'); interactionId = await humanCard(run.companyId, issueId, actionId, row.tool === 'ado_pipeline_run_create' ? `Confirm: run pipeline ${String(row.args_redacted.pipelineId ?? '')} on ${String(row.args_redacted.branch ?? '')}` : `Confirm: ${String(row.args_redacted.repository ?? '')} !${String(row.args_redacted.prId ?? '')}`, row.tool === 'ado_pipeline_run_create' ? 'An approver agent already approved. Confirm to run it.' : 'An approver agent already approved the facts. Confirm to merge.', `Approved by ${await agentName(run.companyId, run.agentId)}.`); }
    const r = await host.db.execute(`UPDATE ${NS}.action SET status=$3, approved_by_agent_id=$4, approved_commit=$5, approved_at=$6::timestamptz, interaction_id=COALESCE($7::uuid,interaction_id), precondition_snapshot=$8::jsonb WHERE company_id=$1 AND id=$2 AND status='awaiting_approval'`,
      [run.companyId, actionId, both ? 'awaiting_confirmation' : 'approved', run.agentId, commitNow || null, nowIso(), interactionId, JSON.stringify(facts ?? {})]);
    if (!r.rowCount) throw new ToolError('wrong_state', 'The action changed while you were deciding');
    const who = await agentName(run.companyId, run.agentId);
    await audit(svc, host, run, row.tool, row.args_redacted, 'approved', issueId, { by: who, commit: commitNow.slice(0, 7), verdicts: facts?.verdicts.map((v) => `${v.fn}:${v.vote}`) });
    if (issueId) await host.issues.comment(run.companyId, issueId, `Approved by ${who}${commitNow ? ` at ${commitNow.slice(0, 7)}` : ''}${facts ? `; verdicts: ${facts.verdicts.map((v) => `${v.fn} ${v.vote}`).join(', ') || 'none required'}; staging gate ${facts.stagingGate}` : ''}.${both ? ' A person still has to confirm.' : ' The plugin applies it within a minute.'}`).catch(() => {});
    return { content: both ? 'Approved. A person must still confirm on the issue (dual control).' : 'Approved. The plugin applies it within a minute and comments the result on the issue.', data: { actionId, status: both ? 'awaiting_confirmation' : 'approved' } };
  }

  /** The facts an approver decides on, straight from the plugin's ledger and live Azure DevOps state. No pull request text is returned. */
  async function approvalGet(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    let target = { prId: num(a.prId), repository: str(a.repository), project: str(a.project) }; let action: ActionRow | null = null;
    if (str(a.actionId)) { action = await load(run, str(a.actionId)!); if (!action) throw new ToolError('action_not_found', 'Unknown action'); target = { prId: num(action.args_redacted.prId), repository: str(action.args_redacted.repository), project: str(action.args_redacted.project) }; }
    if (action?.tool === 'ado_pr_policy_queue_apply') {
      const st = action.args_redacted; const mine = lc(action.agent_id) === lc(run.agentId);
      const problems = [...(mine ? ['you proposed this action and cannot also decide it'] : []), ...(action.status !== 'awaiting_approval' ? [`the action is ${action.status.replace('_', ' ')}`] : [])];
      return { content: problems.length ? `Not ready: ${problems.join('; ')}.` : 'Ready: you may decide this build policy queue.', data: { ready: problems.length === 0, missing: problems, mode: cfg.approval.mode, action: { id: action.id, status: action.status, tool: action.tool },
        queue: { project: neutralize(String(st.project ?? '').slice(0, 80)), repository: neutralize(String(st.repository ?? '').slice(0, 80)), prId: st.prId, commit: st.commit ?? null, buildPolicies: Array.isArray(st.evaluations) ? st.evaluations.length : 0, reason: neutralize(String(st.reason ?? '').slice(0, 500)), proposedBy: neutralize(await agentName(run.companyId, action.agent_id)).slice(0, 60) } } };
    }
    if (action?.tool === 'ado_pipeline_run_create') {
      const st = action.args_redacted; const mine = lc(action.agent_id) === lc(run.agentId);
      const problems = [...(mine ? ['you proposed this action and cannot also decide it'] : []), ...(action.status !== 'awaiting_approval' ? [`the action is ${action.status.replace('_', ' ')}`] : [])];
      return { content: problems.length ? `Not ready: ${problems.join('; ')}.` : 'Ready: you may decide this pipeline run.', data: { ready: problems.length === 0, missing: problems, mode: cfg.approval.mode, action: { id: action.id, status: action.status, tool: action.tool },
        run: { project: neutralize(String(st.project ?? '').slice(0, 80)), pipelineId: st.pipelineId, branch: neutralize(String(st.branch ?? '').slice(0, 120)), commit: st.commit ?? null, reason: neutralize(String(st.reason ?? '').slice(0, 500)), proposedBy: neutralize(await agentName(run.companyId, action.agent_id)).slice(0, 60) } } };
    }
    if (!target.prId || !target.repository) throw new ToolError('bad_request', 'Give actionId, or prId and repository');
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: target.repository, project: target.project });
    const { snap, links } = await svc.syncPr(run.companyId, cfg, project, repo, target.prId, 'gate:ado_pr_approval_get');
    const isApprover = cfg.approval.approverAgentIds.some((x) => lc(x) === lc(run.agentId));
    const facts = await evaluateApproval(svc, run.companyId, cfg, project, snap, links, { ...(isApprover ? { approverId: run.agentId } : {}), proposerId: action?.agent_id });
    const names = new Map<string, string>(); for (const v of facts.verdicts) if (!names.has(v.agentId)) names.set(v.agentId, await agentName(run.companyId, v.agentId));
    const problems = completionProblems(snap, cfg.review.publishStatus, cfg.review.statusGenre, cfg.review.statusName);
    const missing = [...new Set([...facts.missing, ...problems])];
    return { content: missing.length ? `Not ready: ${missing.join('; ')}.` : 'Ready: every condition holds on the current head commit.', data: {
      ready: missing.length === 0, missing, headCommit: snap.lastMergeSourceCommit, mode: cfg.approval.mode, action: action ? { id: action.id, status: action.status, tool: action.tool } : null,
      verdicts: facts.verdicts.map((v) => ({ function: v.fn, by: neutralize(names.get(v.agentId) ?? '').slice(0, 60), vote: v.vote, at: v.at })), stagingGate: facts.stagingGate,
      policies: snap.policies.map((p) => ({ policy: neutralize(p.name.slice(0, 60)), status: p.status, blocking: p.blocking })), activeThreads: facts.activeThreads, requiredFunctions: cfg.approval.requiredVerdictFunctions } };
  }

  /** A staging or deployment check on the exact commit, posted by the agent that ran it. */
  async function gatePost(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    if (!cfg.approval.stagingGateAgentIds.some((x) => lc(x) === lc(run.agentId))) throw new ToolError('role_denied', 'This agent may not post staging gate results. That tool is only for a deployment check on a repository with a staging gate. A QA or Security verdict goes through ado_pr_review_post.');
    const state = str(a.state); if (state !== 'succeeded' && state !== 'failed') throw new ToolError('bad_request', 'state must be succeeded or failed');
    const evidence = str(a.evidenceUrl); if (!evidence || !/^https:\/\/[^\s]{4,500}$/.test(evidence)) throw new ToolError('bad_request', 'evidenceUrl (https) is required');
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(a.repository), project: str(a.project) });
    if (!project.stagingGateRepositories.some((r) => lc(r) === lc(repo))) throw new ToolError('gate_not_required', 'No staging gate is configured for this repository');
    const prId = num(a.prId); if (!prId) throw new ToolError('bad_request', 'prId is required');
    const { snap, links } = await svc.syncPr(run.companyId, cfg, project, repo, prId, 'gate:ado_pr_gate_post');
    if (links.some((l) => l.authorAgentId && lc(l.authorAgentId) === lc(run.agentId))) throw new ToolError('self_review', 'You authored this pull request and cannot post its gate result');
    await svc.store.addGate({ id: host.uuid(), companyId: run.companyId, org: snap.org, projectId: snap.projectId, repoId: snap.repoId, prId: snap.prId, commit: snap.lastMergeSourceCommit, iteration: snap.iterationCount, state, agentId: run.agentId, runId: run.runId, evidenceUrl: evidence, at: nowIso() });
    await audit(svc, host, run, 'ado_pr_gate_post', { prId: snap.prId, repo: snap.repoName }, 'ok', links[0]?.issueId, { state, commit: snap.lastMergeSourceCommit.slice(0, 7) });
    return { content: `Staging gate ${state} recorded for !${snap.prId} at ${snap.lastMergeSourceCommit.slice(0, 7)}.`, data: { state, commit: snap.lastMergeSourceCommit } };
  }

  /** Shared phase machinery. describe() validates and says what the human must see; execute() runs only after acceptance. */
  async function twoPhase(run: RunCtx, tool: string, actionId: string | undefined, plan: {
    describe: () => Promise<{ issueId: string; hash: string; args: Record<string, unknown>; prompt: string; details: string }>;
    /** Live state again after approval: the hash must equal the approved one, and any problem refuses execution. */
    recheck: (row: ActionRow) => Promise<{ hash: string; problems?: string[] }>;
    execute: (row: ActionRow) => Promise<{ summary: string; data: Record<string, unknown> }>;
    /** Merge approval facts (verdicts, gate, policies) when approvers decide; completion only. */
    facts?: () => Promise<ApprovalFacts>;
    /** Decided by approver agents when the approval mode asks for them, although there are no pull request facts to verify (protected pipeline runs). */
    agentDecides?: boolean;
  }): Promise<ToolOut> {
    if (!actionId) {
      const d = await plan.describe();
      // The newest attempt for the same arguments decides: reuse a live one, wait out a recent rejection, otherwise start fresh.
      // A consumed (applied) pipeline run is spent: a new proposal is a new attempt with its own approval. Other tools keep "already applied".
      // On equal timestamps an applied row sorts last, so it never masks a pending attempt created in the same instant.
      const latest = (await host.db.query<ActionRow & { created_at: Date }>(`SELECT ${ACTION_COLS},created_at FROM ${NS}.action WHERE company_id=$1 AND tool=$2 AND args_hash=$3 ORDER BY created_at DESC, (status='applied') ASC LIMIT 1`, [run.companyId, tool, d.hash]))[0];
      const live = latest && new Date(latest.expires_at).getTime() > host.now();
      if (latest && live && ['proposed', 'awaiting_confirmation', 'awaiting_approval', 'escalated', 'approved'].includes(latest.status)) {
        return { content: `Already ${latest.status.replace('_', ' ')}.`, data: { actionId: latest.id, status: latest.status, interactionId: latest.interaction_id } };
      }
      if (latest && live && latest.status === 'applied' && !SPENT_WHEN_APPLIED.has(tool)) {
        return { content: 'Already applied.', data: { actionId: latest.id, status: latest.status, interactionId: latest.interaction_id } };
      }
      if (latest?.status === 'rejected' && host.now() - new Date(latest.created_at).getTime() < COOLDOWN_MS) {
        throw new ToolError('recently_rejected', 'A person rejected this exact action a moment ago. Do not propose it again unless something changed; ask on the issue first.');
      }
      const id = host.uuid();
      const key = latest ? `${tool}:${d.hash}:${id}` : `${tool}:${d.hash}`;
      const cfg = await svc.cfg(run.companyId);
      // Approvers decide completions of pull requests, where the plugin can verify the facts. Abandon and protected pipeline runs stay with a person.
      const mode = plan.facts || (plan.agentDecides && cfg.approval.pipelineRunsByApprovers) ? cfg.approval.mode : 'board';
      const facts = mode !== 'board' && plan.facts ? await plan.facts() : null;
      const eligible = facts ? facts.eligibleApprovers : cfg.approval.approverAgentIds.filter((x) => lc(x) !== lc(run.agentId));
      if (facts && !facts.ready) throw new ToolError('not_ready', `Not ready for approval: ${facts.missing.join('; ')}.`);
      // Ledger row first: a card or task can never exist without the row that gives it meaning.
      await host.db.execute(`INSERT INTO ${NS}.action (id,company_id,issue_id,agent_id,run_id,tool,args_hash,args_redacted,risk_class,status,created_at,expires_at,idempotency_key,gate_mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'G','proposed',$9,$10,$11,$12)`,
        [id, run.companyId, d.issueId, run.agentId, run.runId, tool, d.hash, JSON.stringify(d.args), nowIso(), new Date(host.now() + TTL_MS).toISOString(), key, mode]);
      if (mode !== 'board' && cfg.approval.boardWhenNoApprover && eligible.length === 0) {
        // Nobody independent can approve (for example the approver is the author): the board decides, on the issue, and the plugin applies it.
        let card: string;
        try { card = await humanCard(run.companyId, d.issueId, id, d.prompt, d.details, 'No approver agent may decide this pull request (each one authored it, proposed it or gave a verdict), so the decision comes to the board. ' + (facts ? 'The plugin has verified the QA and Security verdicts, the build policy and the staging gate on this exact commit. Approving here merges it.' : 'Approving here runs it.')); } catch (e) { await setStatus(run, id, 'failed', { result: { error: 'confirmation_failed' } }); throw e; }
        await host.db.execute(`UPDATE ${NS}.action SET status='escalated', escalated_at=$3::timestamptz, interaction_id=$4::uuid, precondition_snapshot=$5::jsonb WHERE company_id=$1 AND id=$2`, [run.companyId, id, nowIso(), card, JSON.stringify(facts ?? {})]);
        await audit(svc, host, run, tool, d.args, 'proposed', d.issueId, { mode, route: 'board_no_eligible_approver' });
        return { content: 'No approver agent can decide this pull request, so a confirmation card was put on the issue for the board. Once a person approves it there, the plugin applies it within a minute and comments the result. Do not ask anyone on the portal.', data: { actionId: id, status: 'escalated', interactionId: card } };
      }
      if (mode !== 'board') {
        const deadline = new Date(host.now() + cfg.approval.approvalTimeoutMinutes * 60_000).toISOString();
        await host.db.execute(`UPDATE ${NS}.action SET status='awaiting_approval', approval_deadline_at=$3, precondition_snapshot=$4::jsonb WHERE company_id=$1 AND id=$2`, [run.companyId, id, deadline, JSON.stringify(facts ?? {})]);
        const how = await askApprovers(run, cfg, id, d.issueId, d.prompt, d.details, facts);
        await audit(svc, host, run, tool, d.args, 'proposed', d.issueId, { mode });
        return { content: `Approval requested from ${how}. An approver decides with ado_pr_approval_post; the plugin then applies the action by itself within a minute. If nobody decides in ${cfg.approval.approvalTimeoutMinutes} minutes ${cfg.approval.escalateToBoardOnTimeout ? 'it goes to the board' : 'it expires'}.`, data: { actionId: id, status: 'awaiting_approval', mode } };
      }
      let interactionId: string;
      try {
        interactionId = (await host.issues.requestConfirmation(run.companyId, d.issueId, { prompt: d.prompt, detailsMarkdown: d.details, acceptLabel: 'Approve', rejectLabel: 'Reject', idempotencyKey: `ado:${tool}:${d.hash}:${id}`.slice(0, 250) })).id;
      } catch (e) { await setStatus(run, id, 'failed', { result: { error: 'confirmation_failed' } }); throw e; }
      await host.db.execute(`UPDATE ${NS}.action SET status='awaiting_confirmation', interaction_id=$3 WHERE company_id=$1 AND id=$2`, [run.companyId, id, interactionId]);
      await audit(svc, host, run, tool, d.args, 'proposed', d.issueId);
      return { content: 'A confirmation was requested on the issue. A person must approve it there; the plugin then applies it by itself within a minute.', data: { actionId: id, status: 'awaiting_confirmation', interactionId } };
    }
    const row = await load(run, actionId);
    if (!row || row.tool !== tool) throw new ToolError('action_not_found', 'Unknown action');
    if (row.agent_id.toLowerCase() !== run.agentId.toLowerCase()) throw new ToolError('action_not_yours', 'This action was proposed by another agent');
    if (row.status === 'applied') return { content: 'Already applied.', data: { actionId: row.id, status: 'applied', result: row.result } };
    if (['rejected', 'expired', 'failed'].includes(row.status)) throw new ToolError(`action_${row.status}`, `This action is ${row.status}; propose it again if it is still needed`);
    if (new Date(row.expires_at).getTime() < host.now()) { await setStatus(run, row.id, 'expired'); throw new ToolError('action_expired', 'The confirmation expired; propose the action again'); }
    // Who still has to decide? Approvers (agents) first when the mode asks for them; a person when the mode is board or both, or after escalation.
    const needsAgent = row.gate_mode !== 'board' && !row.approved_by_agent_id && row.status !== 'escalated';
    if (needsAgent) return { content: 'Still waiting for an approver. They decide with ado_pr_approval_post; the plugin applies the action once approved.', data: { actionId: row.id, status: row.status } };
    const needsHuman = row.gate_mode === 'board' || row.gate_mode === 'both' || row.status === 'escalated';
    if (needsHuman) {
      const inter = row.interaction_id && row.issue_id ? await host.issues.interaction(run.companyId, row.issue_id, row.interaction_id) : null;
      if (!inter) throw new ToolError('confirmation_missing', 'The confirmation card is gone; propose the action again');
      if (inter.outcome === 'rejected') { await setStatus(run, row.id, 'rejected'); throw new ToolError('action_rejected', 'A person rejected this action'); }
      if (inter.outcome !== 'accepted') {
        if (inter.status !== 'pending' && inter.outcome) { await setStatus(run, row.id, 'expired'); throw new ToolError('action_expired', `The confirmation ended (${inter.outcome}); propose the action again`); }
        return { content: 'Still waiting for a person to approve on the issue.', data: { actionId: row.id, status: 'awaiting_confirmation' } };
      }
      // A person approves these cards. The host would let any agent with a run resolve one, so an agent's acceptance counts for nothing.
      if (inter.resolvedByAgentId) { await setStatus(run, row.id, 'failed', { result: { error: 'action_resolved_by_agent' } }); await audit(svc, host, run, tool, row.args_redacted, 'refused:resolved_by_agent', row.issue_id); throw new ToolError('action_resolved_by_agent', 'An agent resolved the confirmation. Only a person may approve it here; propose the action again.'); }
      await setStatus(run, row.id, 'approved', { approvedBy: inter.resolvedByUserId });
    } else if (row.status !== 'approved') await setStatus(run, row.id, 'approved');
    const re = await plan.recheck(row);
    if (re.hash !== row.args_hash) { await setStatus(run, row.id, 'expired'); await audit(svc, host, run, tool, row.args_redacted, 'refused:state_changed', row.issue_id); throw new ToolError('state_changed', 'The pull request or pipeline changed after approval; propose the action again'); }
    if (re.problems?.length) { await audit(svc, host, run, tool, row.args_redacted, 'refused:not_ready', row.issue_id, { problems: re.problems }); throw new ToolError('not_ready', `Not ready any more: ${re.problems.join('; ')}.`); }
    // One apply per action: a second caller (the proposer and the settle job) gets an answer instead of a second pipeline run or merge.
    if (!(await svc.store.once(run.companyId, `apply:${row.id}`, nowIso()))) return { content: 'This action is already being applied.', data: { actionId: row.id, status: 'approved' } };
    try {
      const done = await plan.execute(row);
      await setStatus(run, row.id, 'applied', { result: done.data });
      await audit(svc, host, run, tool, row.args_redacted, 'applied', row.issue_id);
      return { content: done.summary, data: { actionId: row.id, status: 'applied', ...done.data } };
    } catch (e) {
      const msg = e instanceof AdoError ? e.message : 'failed';
      await setStatus(run, row.id, 'failed', { result: { error: e instanceof AdoError ? e.code : 'error', message: msg } });
      await audit(svc, host, run, tool, row.args_redacted, `failed:${e instanceof AdoError ? e.code : 'error'}`, row.issue_id);
      throw e;
    }
  }

  async function issueFor(run: RunCtx, links: Awaited<ReturnType<typeof svc.store.linksForObject>>): Promise<string> {
    const exact = links.find((l) => l.confidence === 'exact');
    if (exact) return exact.issueId;
    const mine = await svc.issueForRun(run.companyId, run.agentId, undefined, run.runId);
    if (mine) return mine.id;
    throw new ToolError('no_issue_for_confirmation', 'No issue is linked to this object; link one with ado_link_create so the confirmation has a place to appear');
  }

  /** Phase 2 identifies the target from the stored proposal and nothing else: every other argument the agent sends again is ignored. */
  async function storedArgs(run: RunCtx, a: A): Promise<{ stored: Record<string, unknown> | null; a: A }> {
    const id = str(a.actionId); if (!id) return { stored: null, a };
    const row = await load(run, id);
    if (!row) throw new ToolError('action_not_found', 'Unknown action');
    return { stored: row.args_redacted, a: { actionId: id } };
  }

  /** Everything that must still be true at the moment of completion, evaluated on the live snapshot (phase 1 and phase 2 alike). */
  function completionProblems(snap: Awaited<ReturnType<typeof svc.syncPr>>['snap'], publishStatus: boolean, genre: string, name: string): string[] {
    const problems: string[] = [];
    if (snap.status !== 'active') problems.push(`the pull request is ${snap.status}`);
    if (snap.isDraft) problems.push('it is a draft');
    if (snap.mergeStatus !== 'succeeded') problems.push(`merge status is ${snap.mergeStatus}`);
    const open = snap.policies.filter((p) => p.blocking && p.status !== 'approved');
    if (open.length) problems.push(`blocking policies not approved: ${open.map((p) => `${neutralize(p.name.slice(0, 40))} (${p.status})`).join(', ')}`);
    if (publishStatus && snap.reviewStatus !== 'succeeded') problems.push(`the ${genre}/${name} status is ${snap.reviewStatus}`);
    if (snap.reviewers.some((r) => r.vote <= -5)) problems.push('a reviewer has requested changes or rejected');
    return problems;
  }

  async function prComplete(a0: A, run: RunCtx): Promise<ToolOut> {
    const { stored, a } = await storedArgs(run, a0);
    const cfg = await svc.cfg(run.companyId);
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(stored?.repository ?? a.repository), project: str(stored?.project ?? a.project) });
    const prId = num(stored?.prId ?? a.prId); if (!prId) throw new ToolError('bad_request', 'prId is required');
    const strategy = str(stored?.strategy ?? a.mergeStrategy) ?? 'squash';
    if (!STRATEGIES.includes(strategy)) throw new ToolError('bad_request', `mergeStrategy must be one of ${STRATEGIES.join(', ')}`);
    const opts = { mergeStrategy: strategy, deleteSourceBranch: stored ? stored.deleteSourceBranch !== false : a.deleteSourceBranch !== false, transitionWorkItems: stored ? stored.transitionWorkItems === true : a.transitionWorkItems === true };
    const current = (id: number) => svc.syncPr(run.companyId, cfg, project, repo, id, 'gate:ado_pr_complete_apply');
    const approvedFields = (snap: Awaited<ReturnType<typeof current>>['snap']) => ({ prId: snap.prId, repository: snap.repoName, project: snap.projectName, strategy, deleteSourceBranch: opts.deleteSourceBranch, transitionWorkItems: opts.transitionWorkItems, target: snap.targetRef, commit: snap.lastMergeSourceCommit, protectedTarget: project.protectedBranches.includes(snap.targetRef) });
    return twoPhase(run, 'ado_pr_complete_apply', str(a.actionId), {
      facts: async () => { const { snap, links } = await current(prId); return evaluateApproval(svc, run.companyId, cfg, project, snap, links, { proposerId: run.agentId }); },
      describe: async () => {
        const { snap, links } = await current(prId);
        // An author-role agent may ask for approval of its own pull request only; operators may ask for any.
        const isOperator = cfg.roles.operatorAgentIds.some((x) => x.toLowerCase() === run.agentId.toLowerCase());
        if (!isOperator && !links.some((l) => l.authorAgentId && l.authorAgentId.toLowerCase() === run.agentId.toLowerCase())) throw new ToolError('role_denied', 'Only an operator, or the agent that authored this pull request, may propose completing it');
        const problems = completionProblems(snap, cfg.review.publishStatus, cfg.review.statusGenre, cfg.review.statusName);
        if (problems.length) throw new ToolError('not_ready', `Not ready to complete: ${problems.join('; ')}.`);
        const hashed = approvedFields(snap);
        const issueId = await issueFor(run, links);
        const reason = neutralize(String(a.reason ?? '').slice(0, 500));
        return { issueId, hash: hashArgs(hashed), args: { ...hashed, reason }, prompt: `Complete pull request !${snap.prId} into ${neutralize(snap.targetRef.replace('refs/heads/', '').slice(0, 120))}${hashed.protectedTarget ? ' (protected branch: a merge here can deploy)' : ''}?`,
          details: `**${neutralize(snap.repoName.slice(0, 80))} !${snap.prId}** ${snap.url}\n\n- Strategy: ${strategy}${opts.deleteSourceBranch ? ', delete source branch' : ''}\n- Target: ${neutralize(snap.targetRef.replace('refs/heads/', '').slice(0, 120))}\n- Commit: \`${snap.lastMergeSourceCommit.slice(0, 7)}\`\n- Policies: ${snap.policies.map((p) => `${neutralize(p.name.slice(0, 40))} ${p.status}`).join(', ') || 'none'}\n- Review status: ${snap.reviewStatus}\n- Reviewers: ${snap.reviewers.map((r) => `${neutralize(r.name.slice(0, 40))} (${r.vote})`).join(', ') || 'none'}\n- Reason: ${reason || 'not given'}\n\nBranch policies still apply. Check the verdicts on this issue before approving.` };
      },
      // Phase 2 rebuilds every approved attribute from the LIVE snapshot (target branch included) and re-runs the readiness checks.
      recheck: async (row) => {
        const { snap, links } = await current(prId);
        const problems = completionProblems(snap, cfg.review.publishStatus, cfg.review.statusGenre, cfg.review.statusName);
        // Verdicts and the gate are keyed by commit: a push after approval empties them, so approved code is exactly what gets merged.
        if (row.gate_mode !== 'board') problems.push(...(await evaluateApproval(svc, run.companyId, cfg, project, snap, links, { proposerId: row.agent_id })).missing);
        return { hash: hashArgs(approvedFields(snap)), problems };
      },
      execute: async (row) => {
        const { snap } = await current(prId);
        // The merge is of the commit that was approved. Azure DevOps refuses it if the branch moved; so do we, before asking.
        const approved = str(row.args_redacted.commit);
        if (!approved || approved !== snap.lastMergeSourceCommit) throw new ToolError('state_changed', 'The pull request has a new commit since it was approved; propose it again');
        const done = await svc.api(run.companyId, cfg, 'author').completePr(snap.projectId, snap.repoId, prId, approved, opts);
        const after = await current(prId);
        return { summary: `Pull request !${prId} ${done.status === 'completed' ? 'was completed' : 'completion was queued (' + done.status + ')'}.`, data: { prStatus: done.status, ...prView(after.snap, false) } };
      },
    });
  }

  async function prAbandon(a0: A, run: RunCtx): Promise<ToolOut> {
    const { stored, a } = await storedArgs(run, a0);
    const cfg = await svc.cfg(run.companyId);
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(stored?.repository ?? a.repository), project: str(stored?.project ?? a.project) });
    const prId = num(stored?.prId ?? a.prId); if (!prId) throw new ToolError('bad_request', 'prId is required');
    const fields = (s: { prId: number; repoId: string; projectId: string; status: string }) => ({ prId: s.prId, repo: s.repoId, project: s.projectId });
    return twoPhase(run, 'ado_pr_abandon_apply', str(a.actionId), {
      describe: async () => {
        const { snap, links } = await svc.syncPr(run.companyId, cfg, project, repo, prId, 'gate:ado_pr_abandon_apply');
        if (snap.status !== 'active') throw new ToolError('not_ready', `The pull request is ${snap.status}`);
        const reason = neutralize(String(a.reason ?? '').slice(0, 500));
        return { issueId: await issueFor(run, links), hash: hashArgs(fields(snap)), args: { prId: snap.prId, repository: snap.repoName, project: snap.projectName, reason }, prompt: `Abandon pull request !${snap.prId}?`, details: `**${snap.repoName} !${snap.prId}** ${snap.url}\n\nReason: ${reason || 'not given'}\n\nAbandoning closes the pull request without merging.` };
      },
      recheck: async () => { const { snap } = await svc.syncPr(run.companyId, cfg, project, repo, prId, 'gate'); return { hash: hashArgs(fields(snap)), problems: snap.status === 'active' ? [] : [`the pull request is ${snap.status}`] }; },
      execute: async () => { const s = await svc.loadPr(run.companyId, cfg, project, repo, prId); await svc.api(run.companyId, cfg, 'author').abandonPr(s.projectId, s.repoId, prId); await svc.syncPr(run.companyId, cfg, project, repo, prId, 'gate'); return { summary: `Pull request !${prId} was abandoned.`, data: { prStatus: 'abandoned' } }; },
    });
  }

  const isProtected = (project: ProjectConfig, pipelineId: number, branch: string): boolean => project.protectedPipelines.includes(pipelineId) || project.protectedBranches.includes(toRef(branch));

  async function pipelineRun(a0: A, run: RunCtx): Promise<ToolOut> {
    const { stored, a } = await storedArgs(run, a0);
    const cfg = await svc.cfg(run.companyId);
    // Phase 2 takes project, pipeline, branch and parameters from the approved proposal only.
    const project = svc.projectOf(cfg, str(stored?.projectId ?? a.project));
    const pipelineId = num(stored?.pipelineId ?? a.pipelineId); const branch = str(stored?.branch ?? a.branch) ?? 'main';
    const commit = str(stored?.commit ?? a.commit); if (commit && !/^[0-9a-f]{40}$/i.test(commit)) throw new ToolError('bad_request', 'commit must be the full 40 character hash (read it with ado_pipeline_run_find or ado_repo_branch_find)');
    if (!pipelineId) throw new ToolError('bad_request', 'pipelineId is required');
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..')) throw new ToolError('bad_branch', 'Invalid branch name');
    const rawParams = stored ? stored.parameters : a.parameters;
    const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams) ? (rawParams as Record<string, unknown>) : undefined;
    if (params && JSON.stringify(params).length > 2048) throw new ToolError('bad_request', 'parameters are limited to 2 KiB');
    const start = async () => {
      const r = await svc.api(run.companyId, cfg, 'author').queueRun(project.projectId, pipelineId, branch, params, commit);
      return { summary: `Pipeline run ${r.id} queued.`, data: { runId: r.id, url: r._links?.web?.href ?? null, state: r.state ?? 'queued' } };
    };
    if (!str(a.actionId) && !isProtected(project, pipelineId, branch)) {
      const done = await start();
      await audit(svc, host, run, 'ado_pipeline_run_create', { pipelineId, branch, projectId: project.projectId }, 'applied');
      return { content: done.summary, data: done.data };
    }
    const approved = { projectId: project.projectId, pipelineId, branch, parameters: params ?? null, commit: commit ?? null };
    return twoPhase(run, 'ado_pipeline_run_create', str(a.actionId), {
      describe: async () => {
        const given = str(a.issueId);
        if (given && !/^[0-9a-f-]{36}$/i.test(given)) throw new ToolError('bad_request', 'issueId must be a UUID');
        const issue = await svc.issueForRun(run.companyId, run.agentId, given, run.runId);
        if (!issue) throw new ToolError('no_issue_for_confirmation', 'A protected pipeline run needs an issue to ask on: this run has no single checked-out issue. Pass issueId (an issue assigned to you and in progress).');
        if (given && (issue.assigneeAgentId !== run.agentId || issue.status !== 'in_progress')) throw new ToolError('issue_not_yours', 'issueId must be an in-progress issue assigned to you');
        const reason = neutralize(String(a.reason ?? '').slice(0, 500));
        if (cfg.approval.mode !== 'board' && cfg.approval.pipelineRunsByApprovers && !reason.trim()) throw new ToolError('bad_request', 'A protected pipeline run needs a reason: the approver decides on it');
        return { issueId: issue.id, hash: hashArgs(approved), args: { ...approved, project: project.name, reason }, prompt: `Run pipeline ${pipelineId} in ${project.name} on ${branch}? (protected)`, details: `Project **${project.name}**, pipeline **${pipelineId}**, branch \`${branch}\`.\n\nReason: ${reason || 'not given'}\n\nA run on a protected pipeline or branch can deploy.` };
      },
      recheck: async () => ({ hash: hashArgs(approved) }),
      execute: start,
      agentDecides: true,
    });
  }


  /** Queue the Build policy of a pull request on its current head (the "Queue" button for manual-queue-only policies). Always approved first. */
  async function policyQueue(a0: A, run: RunCtx): Promise<ToolOut> {
    const { stored, a } = await storedArgs(run, a0);
    const cfg = await svc.cfg(run.companyId);
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(stored?.repository ?? a.repository), project: str(stored?.project ?? a.project) });
    const prId = num(stored?.prId ?? a.prId); if (!prId) throw new ToolError('bad_request', 'prId is required');
    const live = async () => {
      const { snap } = await svc.syncPr(run.companyId, cfg, project, repo, prId, 'gate:ado_pr_policy_queue_apply');
      const evals = await svc.api(run.companyId, cfg, 'author').policyEvaluations(project.name, project.projectId, prId);
      const builds = evals.filter((e) => e.evaluationId && e.configuration?.isEnabled !== false && e.configuration?.type?.displayName === 'Build');
      const problems: string[] = [];
      if (snap.status !== 'active') problems.push(`the pull request is ${snap.status}`);
      if (snap.isDraft) problems.push('it is a draft');
      if (!builds.length) problems.push('it has no enabled Build policy');
      const hash = hashArgs({ projectId: project.projectId, repository: snap.repoName, prId, commit: snap.lastMergeSourceCommit, evaluations: builds.map((e) => e.evaluationId).sort() });
      return { snap, builds, problems, hash };
    };
    return twoPhase(run, 'ado_pr_policy_queue_apply', str(a.actionId), {
      agentDecides: true,
      describe: async () => {
        const given = str(a.issueId);
        if (given && !/^[0-9a-f-]{36}$/i.test(given)) throw new ToolError('bad_request', 'issueId must be a UUID');
        const issue = await svc.issueForRun(run.companyId, run.agentId, given, run.runId);
        if (!issue) throw new ToolError('no_issue_for_confirmation', 'Queueing a build policy needs an issue to ask on: this run has no single checked-out issue. Pass issueId (an issue assigned to you and in progress).');
        if (given && (issue.assigneeAgentId !== run.agentId || issue.status !== 'in_progress')) throw new ToolError('issue_not_yours', 'issueId must be an in-progress issue assigned to you');
        const reason = neutralize(String(a.reason ?? '').slice(0, 500));
        if (cfg.approval.mode !== 'board' && cfg.approval.pipelineRunsByApprovers && !reason.trim()) throw new ToolError('bad_request', 'Queueing a build policy needs a reason: the approver decides on it');
        const l = await live();
        if (l.problems.length) throw new ToolError('not_ready', `Cannot queue the build policy: ${l.problems.join('; ')}.`);
        const names = l.builds.map((e) => neutralize(String((e.configuration?.settings as Record<string, unknown> | undefined)?.displayName ?? 'Build').slice(0, 80)));
        return { issueId: issue.id, hash: l.hash,
          args: { projectId: project.projectId, project: project.name, repository: l.snap.repoName, prId, commit: l.snap.lastMergeSourceCommit, evaluations: l.builds.map((e) => e.evaluationId), reason },
          prompt: `Queue the build policy on ${l.snap.repoName} !${prId}?`,
          details: `Pull request **${l.snap.repoName} !${prId}** at commit \`${l.snap.lastMergeSourceCommit.slice(0, 12)}\`. This starts the Build policy run(s): ${names.join(', ')}. It does not change a policy, vote or merge.\n\nReason: ${reason || 'not given'}` };
      },
      recheck: async () => { const l = await live(); return { hash: l.hash, problems: l.problems }; },
      execute: async () => {
        const l = await live(); const api = svc.api(run.companyId, cfg, 'author'); const out: Array<{ evaluationId: string; before: string | null; after: string | null }> = [];
        for (const e of l.builds) { const r = await api.requeuePolicyEvaluation(project.name, e.evaluationId!); out.push({ evaluationId: e.evaluationId!, before: e.status ?? null, after: r?.status ?? null }); }
        return { summary: `Build policy queued on ${l.snap.repoName} !${prId}.`, data: { prId, commit: l.snap.lastMergeSourceCommit, evaluations: out } };
      },
    });
  }

  // ---- Pipeline definitions and repositories. Always confirmed by a person; off unless the company switches them on.
  const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
  const issueOf = async (run: RunCtx): Promise<string> => {
    const issue = await svc.issueForRun(run.companyId, run.agentId, undefined, run.runId);
    if (!issue) throw new ToolError('no_issue_for_confirmation', 'This needs an in-progress issue assigned to you to ask the board on');
    return issue.id;
  };
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');

  async function pipelineCreate(a0: A, run: RunCtx): Promise<ToolOut> {
    const { stored, a } = await storedArgs(run, a0);
    const cfg = await svc.cfg(run.companyId);
    if (!cfg.pipelines.allowCreate) throw new ToolError('not_enabled', 'Creating pipelines is switched off. The board turns it on in the Azure DevOps settings (Pipelines).');
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(stored?.repository ?? a.repository), project: str(stored?.project ?? a.project) });
    const name = str(stored?.name ?? a.name); if (!name || !NAME_OK.test(name)) throw new ToolError('bad_request', 'name is required (letters, digits, space, . _ -)');
    const folder = str(stored?.folder ?? a.folder) ?? '\\'; if (!/^[\\A-Za-z0-9 ._-]{1,100}$/.test(folder)) throw new ToolError('bad_request', 'Invalid folder');
    const yamlPath = str(stored?.yamlPath ?? a.yamlPath); if (!yamlPath || yamlPath.length > 260 || yamlPath.includes('..') || yamlPath.includes('\0')) throw new ToolError('bad_request', 'yamlPath is required');
    const branch = (str(stored?.branch ?? a.branch) ?? 'main').replace(/^refs\/heads\//, ''); if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..')) throw new ToolError('bad_ref', 'Invalid branch');
    const queueId = num(stored?.queueId ?? a.queueId) ?? cfg.pipelines.allowedQueueIds[0];
    if (!queueId || !cfg.pipelines.allowedQueueIds.includes(queueId)) throw new ToolError('queue_not_allowed', `queueId must be one of the allowed queues: ${cfg.pipelines.allowedQueueIds.join(', ') || 'none configured'}`);
    const api = svc.api(run.companyId, cfg, 'author');
    const repos = await svc.read(run.companyId, cfg, (x) => x.listRepos(project.projectId)); const repoRow = repos.find((r) => r.name.toLowerCase() === repo.toLowerCase());
    if (!repoRow) throw new ToolError('not_found_or_forbidden', 'Repository not found');
    const yamlNow = async () => { try { return (await svc.read(run.companyId, cfg, (x) => x.repoItemText(project.projectId, repo, yamlPath.startsWith('/') ? yamlPath : `/${yamlPath}`, branch, 'branch', 65536))).text; } catch { throw new ToolError('yaml_missing', `${yamlPath} does not exist on ${branch}`); } };
    const approvedOf = async () => ({ projectId: project.projectId, repoId: repoRow.id, name, folder, yamlPath, branch, queueId, yamlSha: sha(await yamlNow()) });
    return twoPhase(run, 'ado_pipeline_create', str(a.actionId), {
      describe: async () => {
        const existing = await svc.read(run.companyId, cfg, (x) => x.buildDefinitions(project.projectId, { name, top: 20 }));
        if (existing.some((d) => (d.name ?? '').toLowerCase() === name.toLowerCase())) throw new ToolError('already_exists', 'A pipeline with that name already exists');
        const yaml = await yamlNow(); const approved = await approvedOf(); const reason = neutralize(String(a.reason ?? '').slice(0, 500));
        return { issueId: await issueOf(run), hash: hashArgs(approved), args: { ...approved, repository: repo, project: project.name, reason }, prompt: `Create pipeline "${neutralize(name)}" from ${neutralize(yamlPath.slice(0, 120))} in ${neutralize(repo)}? (created disabled)`,
          details: `Repository **${neutralize(repo)}**, branch \`${branch}\`, YAML \`${neutralize(yamlPath.slice(0, 200))}\`, queue ${queueId}, folder \`${neutralize(folder)}\`.\n\nIt is created **disabled**, without triggers, variables or variable groups. Enabling it and running it are separate confirmed steps.\n\nReason: ${reason || 'not given'}\n\nFirst lines of the YAML (untrusted):\n\n\`\`\`\n${neutralize(yaml.split('\n').slice(0, 40).join('\n'))}\n\`\`\`` };
      },
      recheck: async () => ({ hash: hashArgs(await approvedOf()) }),
      execute: async () => {
        const made = await api.createBuildDefinition(project.projectId, { name, folder, yamlPath: yamlPath.startsWith('/') ? yamlPath : `/${yamlPath}`, repositoryId: repoRow.id, repositoryName: repoRow.name, branch, queueId });
        return { summary: `Pipeline ${made.id} "${neutralize(name)}" was created, disabled.`, data: { pipelineId: made.id, queueStatus: 'disabled' } };
      },
    });
  }

  async function pipelineUpdate(a0: A, run: RunCtx): Promise<ToolOut> {
    const { stored, a } = await storedArgs(run, a0);
    const cfg = await svc.cfg(run.companyId);
    if (!cfg.pipelines.allowCreate) throw new ToolError('not_enabled', 'Changing pipelines is switched off. The board turns it on in the Azure DevOps settings (Pipelines).');
    const project = svc.projectOf(cfg, str(stored?.projectId ?? a.project));
    const id = num(stored?.pipelineId ?? a.pipelineId); if (!id) throw new ToolError('bad_request', 'pipelineId is required');
    const queueStatus = str(stored?.queueStatus ?? a.queueStatus); if (queueStatus && !['enabled', 'paused', 'disabled'].includes(queueStatus)) throw new ToolError('bad_request', 'queueStatus must be enabled, paused or disabled');
    const yamlPath = str(stored?.yamlPath ?? a.yamlPath); if (yamlPath && (yamlPath.length > 260 || yamlPath.includes('..') || yamlPath.includes('\0'))) throw new ToolError('bad_request', 'Invalid yamlPath');
    const queueId = num(stored?.queueId ?? a.queueId); if (queueId !== undefined && !cfg.pipelines.allowedQueueIds.includes(queueId)) throw new ToolError('queue_not_allowed', `queueId must be one of the allowed queues: ${cfg.pipelines.allowedQueueIds.join(', ') || 'none configured'}`);
    if (!queueStatus && !yamlPath && queueId === undefined) throw new ToolError('bad_request', 'Nothing to change');
    const api = svc.api(run.companyId, cfg, 'author');
    const apply = async (revisionMustBe?: number) => {
      const raw = await api.getBuildDefinitionRaw(project.projectId, id);
      if (revisionMustBe !== undefined && raw.revision !== revisionMustBe) throw new ToolError('state_changed', 'The pipeline changed since it was proposed; propose again');
      if (queueStatus) raw.queueStatus = queueStatus;
      if (yamlPath) raw.process = { ...(raw.process ?? {}), yamlFilename: yamlPath.startsWith('/') ? yamlPath.slice(1) : yamlPath };
      if (queueId !== undefined) raw.queue = { ...(raw.queue ?? {}), id: queueId };
      const done = await api.updateBuildDefinition(project.projectId, id, raw);
      return { summary: `Pipeline ${id} was updated.`, data: { pipelineId: id, revision: done.revision ?? null, ...(queueStatus ? { queueStatus } : {}) } };
    };
    // Switching a pipeline off or pausing it only reduces what it can do: applied at once and audited. Everything else is confirmed by a person.
    if (!str(a.actionId) && queueStatus && queueStatus !== 'enabled' && !yamlPath && queueId === undefined) {
      const done = await apply();
      await audit(svc, host, run, 'ado_pipeline_update', { pipelineId: id, queueStatus }, 'applied');
      return { content: done.summary, data: done.data };
    }
    const revisionNow = async () => (await api.getBuildDefinitionRaw(project.projectId, id)).revision as number;
    return twoPhase(run, 'ado_pipeline_update', str(a.actionId), {
      describe: async () => {
        const rev = await revisionNow(); const reason = neutralize(String(a.reason ?? '').slice(0, 500));
        const approved = { projectId: project.projectId, pipelineId: id, revision: rev, queueStatus: queueStatus ?? null, yamlPath: yamlPath ?? null, queueId: queueId ?? null };
        return { issueId: await issueOf(run), hash: hashArgs(approved), args: { ...approved, project: project.name, reason }, prompt: `Change pipeline ${id}${queueStatus ? `: ${queueStatus}` : ''}${yamlPath ? `, YAML ${neutralize(yamlPath.slice(0, 120))}` : ''}${queueId !== undefined ? `, queue ${queueId}` : ''}?`,
          details: `Pipeline **${id}** in ${neutralize(project.name)} (revision ${rev}). Enabling lets it run when something queues it; a changed YAML path or queue changes what runs and where.\n\nReason: ${reason || 'not given'}` };
      },
      recheck: async () => ({ hash: hashArgs({ projectId: project.projectId, pipelineId: id, revision: await revisionNow(), queueStatus: queueStatus ?? null, yamlPath: yamlPath ?? null, queueId: queueId ?? null }) }),
      execute: (row) => apply(num(row.args_redacted.revision)),
    });
  }

  async function repoCreate(a0: A, run: RunCtx): Promise<ToolOut> {
    const { stored, a } = await storedArgs(run, a0);
    const cfg = await svc.cfg(run.companyId);
    if (!cfg.repos.allowCreate) throw new ToolError('not_enabled', 'Creating repositories is switched off. The board turns it on in the Azure DevOps settings (Repositories).');
    const project = svc.projectOf(cfg, str(stored?.projectId ?? a.project));
    const name = str(stored?.name ?? a.name); if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.endsWith('.git')) throw new ToolError('bad_request', 'name is required (letters, digits, . _ -, not ending in .git)');
    if (project.repositories.length && !project.repositories.some((r) => r.toLowerCase() === name.toLowerCase())) throw new ToolError('repo_not_in_scope', 'The project has a repository allow-list; the board adds the name there first');
    const approved = { projectId: project.projectId, name };
    return twoPhase(run, 'ado_repo_create', str(a.actionId), {
      describe: async () => {
        const repos = await svc.read(run.companyId, cfg, (x) => x.listRepos(project.projectId));
        if (repos.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new ToolError('already_exists', 'A repository with that name already exists');
        const reason = neutralize(String(a.reason ?? '').slice(0, 500));
        return { issueId: await issueOf(run), hash: hashArgs(approved), args: { ...approved, project: project.name, reason }, prompt: `Create repository "${neutralize(name)}" in ${neutralize(project.name)}?`,
          details: `New empty repository **${neutralize(name)}**. The first push creates its default branch. Reason: ${reason || 'not given'}` };
      },
      recheck: async () => {
        const repos = await svc.read(run.companyId, cfg, (x) => x.listRepos(project.projectId));
        return { hash: hashArgs(approved), problems: repos.some((r) => r.name.toLowerCase() === name.toLowerCase()) ? ['a repository with that name now exists'] : [] };
      },
      execute: async () => { const made = await svc.api(run.companyId, cfg, 'author').createRepository(project.projectId, project.projectId, name); return { summary: `Repository "${neutralize(name)}" was created.`, data: { repositoryId: made.id } }; },
    });
  }

  /** Names that look like credentials may only be set as secret variables bound in the settings, never as plain text on an approval card. */
  const SENSITIVE_PLAIN = /secret|passw|pwd|token|key|credential|connection.?string|(^|[._-])pat($|[._-])/i;
  async function variableGroupUpdate(input: A, run: RunCtx): Promise<ToolOut> {
    const tool = 'ado_variable_group_update';
    let target: A = {}; let outcome = 'failed';
    try {
      const { stored, a } = await storedArgs(run, input);
      const params = stored ?? a;
      const group = str(params.group); const reason = str(params.reason)?.trim();
      if (!group || group.length > 100 || !reason || reason.length > 500) throw new ToolError('bad_request', 'group and reason (1..500 characters) are required');
      const description = params.description === undefined ? undefined : str(params.description);
      if (description !== undefined && description.length > 500) throw new ToolError('bad_request', 'description may hold at most 500 characters');
      const rawPlain = params.variables === undefined ? [] : params.variables;
      const rawSecret = params.secretVariables === undefined ? [] : params.secretVariables;
      if (!Array.isArray(rawPlain) || !Array.isArray(rawSecret)) throw new ToolError('bad_request', 'variables and secretVariables must be lists');
      if (rawPlain.length + rawSecret.length < 1 || rawPlain.length > 30 || rawSecret.length > 30) throw new ToolError('bad_request', 'give 1..30 plain and 0..30 secret variables');
      const plain: Array<{ name: string; value: string }> = [];
      for (const v of rawPlain as A[]) {
        const name = str(v?.name); const value = typeof v?.value === 'string' ? v.value : undefined;
        if (!name || !VARIABLE_NAME.test(name) || value === undefined || value.length > 1000) throw new ToolError('bad_request', 'each variable needs a valid name and a string value of at most 1000 characters');
        if (SENSITIVE_PLAIN.test(name)) throw new ToolError('sensitive_name_plain', `Variable ${neutralize(name)} looks like a credential. Set it with secretVariables, bound to a Paperclip secret in the plugin settings; never as plain text.`);
        plain.push({ name, value });
      }
      const secretNames = [...new Set((rawSecret as unknown[]).map((x) => { if (typeof x !== 'string' || !VARIABLE_NAME.test(x)) throw new ToolError('bad_request', 'secretVariables must be valid variable names'); return x; }))];
      const all = [...plain.map((p) => p.name), ...secretNames];
      if (new Set(all.map((n) => n.toLowerCase())).size !== all.length) throw new ToolError('bad_request', 'a variable may be listed only once');
      plain.sort((x, y) => x.name.localeCompare(y.name)); secretNames.sort();
      const resolve = async () => {
        const cfg = await svc.cfg(run.companyId); requirePlatformAdmin(cfg);
        const entry = variableGroupOf(cfg, group);
        if (!entry) throw new ToolError('resource_not_allowed', 'Variable group is not allowed by platformAdmin.variableGroups');
        for (const n of secretNames) if (!entry.secrets[n]) throw new ToolError('secret_not_bound', `Secret variable ${neutralize(n)} is not bound to a Paperclip secret for this group in the plugin settings`);
        for (const p of plain) if (entry.secrets[p.name]) throw new ToolError('bad_request', `Variable ${neutralize(p.name)} is bound to a secret and must be set through secretVariables`);
        const project = svc.projectOf(cfg, str(params.project));
        const api = svc.admin(run.companyId, cfg).api;
        const hits = (await api.variableGroups(project.projectId, group)).filter((g) => g.name === group);
        if (hits.length > 1) throw new ToolError('resource_not_allowed', 'Variable group name is ambiguous');
        const existing = hits[0]?.id !== undefined ? await api.variableGroup(project.projectId, hits[0].id) : null;
        if (existing && existing.name !== group) throw new ToolError('resource_not_allowed', 'Variable group does not match the allowed name');
        for (const p of plain) if (existing?.variables?.[p.name]?.isSecret === true) throw new ToolError('secret_downgrade', `Variable ${neutralize(p.name)} is secret in Azure DevOps and cannot be turned into a plain variable`);
        target = { project: project.projectId, group, groupId: existing?.id ?? null, create: !existing, plain: plain.map((p) => p.name), protectedVars: secretNames.map((n) => ({ name: n, ref: entry.secrets[n]!.secretId })) };
        const hash = hashArgs({ ...target, values: plain });
        return { api, project, entry, existing, hash };
      };
      let resolved: Awaited<ReturnType<typeof resolve>>;
      const unchanged = () => !!resolved.existing && secretNames.length === 0 && plain.every((p) => resolved.existing!.variables?.[p.name]?.value === p.value) && (description === undefined || resolved.existing.description === description);
      if (!stored) {
        resolved = await resolve();
        if (unchanged()) { outcome = 'already_applied'; return { content: 'The variable group already holds these values.', data: { status: outcome, ...target } }; }
      }
      const out = await twoPhase(run, tool, str(a.actionId), {
        agentDecides: false,
        describe: async () => ({
          issueId: await issueOf(run), hash: resolved.hash,
          args: { project: resolved.project.projectId, group, ...(description !== undefined ? { description: neutralize(description) } : {}), variables: plain.map((p) => ({ name: p.name, value: neutralize(p.value) })), secretVariables: secretNames, reason: neutralize(reason) },
          prompt: `${resolved.existing ? 'Change' : 'Create'} Library variable group ${neutralize(group)}?`,
          details: `Project ${neutralize(resolved.project.name)}. ${resolved.existing ? `Existing group ${resolved.existing.id}; variables not listed here are left as they are.` : 'The group does not exist yet and will be created.'}\n\nPlain variables:\n${plain.length ? plain.map((p) => `- ${neutralize(p.name)} = ${neutralize(p.value.slice(0, 200))}`).join('\n') : '- none'}\n\nSecret variables (stored as secret in Azure DevOps; the values come from the bound Paperclip secrets and are never shown):\n${secretNames.length ? secretNames.map((n) => `- ${neutralize(n)}`).join('\n') : '- none'}\n\nReason: ${neutralize(reason)}. Only a person can approve this.`,
        }),
        recheck: async () => {
          try { resolved = await resolve(); return { hash: resolved.hash }; }
          catch (e) { if (e instanceof ToolError && ['not_enabled', 'resource_not_allowed', 'secret_not_bound', 'secret_downgrade'].includes(e.code)) throw new ToolError('state_changed', 'Variable group scope changed after approval'); throw e; }
        },
        execute: async () => {
          const vars: Record<string, { value?: string | null; isSecret?: boolean }> = {};
          for (const [k, v] of Object.entries(resolved.existing?.variables ?? {})) vars[k] = v?.isSecret === true ? { isSecret: true, value: null } : { value: v?.value ?? '' };
          for (const p of plain) vars[p.name] = { value: p.value };
          for (const n of secretNames) {
            let value: string;
            try { value = await svc.host.resolveSecret(run.companyId, resolved.entry.secrets[n]!, `platformAdmin.variableGroups.${group}.${n}`); } catch { throw new ToolError('secret_unreadable', `The Paperclip secret bound to ${neutralize(n)} could not be read`); }
            if (!value) throw new ToolError('secret_unreadable', `The Paperclip secret bound to ${neutralize(n)} is empty`);
            vars[n] = { value, isSecret: true };
          }
          const body = { name: group, description: description ?? resolved.existing?.description ?? '', variables: vars };
          if (resolved.existing) await resolved.api.updateVariableGroup(resolved.project.projectId, resolved.project.name, resolved.existing.id!, body);
          else await resolved.api.createVariableGroup(resolved.project.projectId, resolved.project.name, body);
          const after = (await resolved.api.variableGroups(resolved.project.projectId, group)).filter((g) => g.name === group);
          const back = after.length === 1 && after[0]!.id !== undefined ? await resolved.api.variableGroup(resolved.project.projectId, after[0]!.id) : null;
          const bad = !back
            || plain.some((p) => back.variables?.[p.name]?.value !== p.value || back.variables?.[p.name]?.isSecret === true)
            || secretNames.some((n) => back.variables?.[n]?.isSecret !== true)
            || Object.keys(resolved.existing?.variables ?? {}).some((k) => !back.variables || !(k in back.variables));
          if (bad) throw new ToolError('postcondition_failed', 'Variable group readback did not match the approved change');
          return { summary: `${resolved.existing ? 'Variable group changed' : 'Variable group created'}; readback verified (secret values are not readable and were not compared).`, data: { ...target } };
        },
      });
      outcome = String(out.data && (out.data as A).status || 'ok'); return out;
    } catch (e) { outcome = e instanceof ToolError ? `refused:${e.code}` : 'failed'; throw e; }
    finally { await audit(svc, host, run, tool, target, outcome); }
  }

  async function secureFilePermissionUpdate(input: A, run: RunCtx): Promise<ToolOut> {
    const tool = 'ado_securefile_pipeline_permission_update';
    let target: A = {}; let outcome = 'failed';
    try {
      if ('allPipelines' in input) throw new ToolError('all_pipelines_refused', 'Only named pipelines may be authorized');
      const { stored, a } = await storedArgs(run, input);
      const params = stored ?? a;
      if (stored) target = { project: stored.project, secureFileId: stored.secureFileId, pipelineIds: stored.pipelineIds };
      const pipelineIds = params.pipelineIds;
      if (!Array.isArray(pipelineIds) || pipelineIds.length < 1 || pipelineIds.length > 10 || pipelineIds.some((id) => !Number.isInteger(id) || id <= 0)) throw new ToolError('bad_request', 'pipelineIds must contain 1..10 positive integers');
      const ids = [...new Set(pipelineIds as number[])].sort((a, b) => a - b);
      const secureFile = str(params.secureFile);
      const reason = str(params.reason)?.trim();
      if (!secureFile || secureFile.length > 100 || !reason || reason.length > 500) throw new ToolError('bad_request', 'secureFile and reason (1..500 characters) are required');
      const resolve = async () => {
        const cfg = await svc.cfg(run.companyId); requirePlatformAdmin(cfg);
        if (ids.some((id) => !allowPipeline(cfg, id))) throw new ToolError('pipeline_not_allowed', 'Pipeline is not allowed by platformAdmin.pipelineIds');
        if (!cfg.platformAdmin.secureFiles.length) throw new ToolError('resource_not_allowed', 'No secure files are allowed');
        const project = svc.projectOf(cfg, str(params.project)).projectId;
        const api = svc.admin(run.companyId, cfg).api;
        const rows = (await Promise.all(cfg.platformAdmin.secureFiles.map((name) => api.secureFiles(project, name)))).flat();
        const hits = rows.filter((r) => allowSecureFile(cfg, r.name) && (r.name === secureFile || r.id === secureFile));
        if (hits.length !== 1) throw new ToolError('resource_not_allowed', 'Secure file must resolve to one allowed name');
        const row = await api.secureFile(project, hits[0]!.id);
        if (row.id !== hits[0]!.id || row.name !== hits[0]!.name || !allowSecureFile(cfg, row.name)) throw new ToolError('resource_not_allowed', 'Secure file is not allowed');
        target = { project, secureFileId: row.id, pipelineIds: ids };
        return { api, project, row, hash: hashArgs(target) };
      };
      let resolved: Awaited<ReturnType<typeof resolve>>;
      const complete = (p: Awaited<ReturnType<Awaited<ReturnType<typeof resolve>>['api']['pipelinePermissions']>>) => p.allPipelines?.authorized !== true && ids.every((id) => p.pipelines?.some((p) => p.id === id && p.authorized === true));
      if (!stored) {
        resolved = await resolve();
        if (complete(await resolved.api.pipelinePermissions(resolved.project, 'securefile', resolved.row.id))) {
          outcome = 'already_applied'; return { content: 'Named pipelines are already authorized.', data: { status: outcome, ...target } };
        }
      }
      const out = await twoPhase(run, tool, str(a.actionId), {
        agentDecides: false,
        describe: async () => ({ issueId: await issueOf(run), hash: resolved.hash, args: { ...target, secureFile, reason: neutralize(reason) }, prompt: `Authorize named pipelines on ${neutralize(resolved.row.name)} (${neutralize(resolved.row.id)})?`, details: `Project ${neutralize(resolved.project)}. Pipelines: ${ids.join(', ')}.\n\nReason: ${neutralize(reason)}. Only a person can approve this permission change.` }),
        recheck: async () => {
          try { resolved = await resolve(); return { hash: resolved.hash }; }
          catch (e) { if (e instanceof ToolError && ['not_enabled', 'resource_not_allowed', 'pipeline_not_allowed'].includes(e.code)) throw new ToolError('state_changed', 'Platform scope changed after approval'); throw e; }
        },
        execute: async () => {
          const before = await resolved.api.pipelinePermissions(resolved.project, 'securefile', resolved.row.id);
          if (complete(before)) return { summary: 'Named pipelines are already authorized.', data: { outcome: 'already_applied', ...target } };
          const after = await resolved.api.authorizeSecureFilePipelines(resolved.project, resolved.row.id, ids);
          if (!complete(after)) throw new ToolError('postcondition_failed', 'Secure file authorization readback did not satisfy the approved scope');
          return { summary: 'Named pipelines authorized; readback verified.', data: { ...target, allPipelines: false } };
        },
      });
      outcome = String(out.data && (out.data as A).status || 'ok'); return out;
    } catch (e) { outcome = e instanceof ToolError ? `refused:${e.code}` : 'failed'; throw e; }
    finally { await audit(svc, host, run, tool, target, outcome); }
  }

  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /**
   * The approver must be one active ADO user, found through the org-level identities API. Groups, inactive accounts, ambiguous matches,
   * anything ADO does not know (such as a Paperclip agent id) and the plugin's own bot identities are refused.
   */
  async function resolveApprover(api: Service['admin'] extends (...a: never[]) => infer R ? R : never, run: RunCtx, cfg: Awaited<ReturnType<typeof svc.cfg>>, input: string) {
    const isGuid = GUID.test(input);
    if (!isGuid && !/^[^\s<>"'`,;]{3,200}$/.test(input)) throw new ToolError('not_an_ado_identity', 'approver must be an Azure DevOps identity GUID or a sign-in name');
    const found = await api.identities.identities(isGuid ? { id: input } : { signIn: input });
    const want = input.toLowerCase();
    const hits = found.filter((x) => typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 64 && (isGuid ? x.id.toLowerCase() === want : [x.account, x.mail, x.displayName?.replace(/^(\S+)\s(\S+)$/, '$1@$2')].some((v) => v?.toLowerCase() === want)));
    if (hits.length !== 1) throw new ToolError('not_an_ado_identity', `approver did not resolve to exactly one Azure DevOps identity (search returned ${found.length} candidate(s), ${hits.length} matched)`);
    const who = hits[0]!;
    if (who.isContainer !== false || who.isActive !== true) throw new ToolError('not_an_ado_identity', 'approver must be an active Azure DevOps user, not a group or an inactive account');
    const bots = [await identityId(svc, run.companyId, cfg, 'author'), await identityId(svc, run.companyId, cfg, 'reviewer'), (await api.api.connectionData()).authenticatedUser?.id ?? ''];
    if (bots.some((b) => !b)) throw new ToolError('identity_unknown', 'Could not determine the plugin identities, so the approver cannot be checked');
    if (bots.some((b) => b.toLowerCase() === who.id!.toLowerCase())) throw new ToolError('approver_refused', 'The approver may not be one of the plugin identities (author, reviewer or admin)');
    return { id: who.id!.toLowerCase(), displayName: who.displayName ?? '' };
  }

  async function environmentCheckCreate(input: A, run: RunCtx): Promise<ToolOut> {
    const tool = 'ado_environment_check_create';
    let target: A = {}; let outcome = 'failed';
    try {
      if ('requesterCannotBeApprover' in input) throw new ToolError('bad_request', 'requesterCannotBeApprover is fixed to true and cannot be set');
      const { stored, a } = await storedArgs(run, input);
      const params = stored ?? a;
      if (stored) target = { project: stored.project, environmentId: stored.environmentId, approverId: stored.approverId, timeoutMinutes: stored.timeoutMinutes };
      const environment = str(params.environment); const approver = str(params.approver)?.trim(); const reason = str(params.reason)?.trim();
      const timeout = params.timeoutMinutes === undefined ? 1440 : params.timeoutMinutes;
      const instructions = params.instructions === undefined ? '' : neutralize(String(params.instructions).replace(/\s+/g, ' ').trim());
      if (!environment || environment.length > 100 || !approver || approver.length > 200 || !reason || reason.length > 500) throw new ToolError('bad_request', 'environment, approver and reason (1..500 characters) are required');
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 43200) throw new ToolError('bad_request', 'timeoutMinutes must be an integer from 1 to 43200');
      if (params.instructions !== undefined && (typeof params.instructions !== 'string' || params.instructions.length > 500)) throw new ToolError('bad_request', 'instructions must be at most 500 characters');
      const resolve = async () => {
        const cfg = await svc.cfg(run.companyId); requirePlatformAdmin(cfg);
        if (!cfg.platformAdmin.environments.length) throw new ToolError('resource_not_allowed', 'No environments are allowed');
        const project = svc.projectOf(cfg, str(params.project)).projectId;
        const admin = svc.admin(run.companyId, cfg); const api = admin.api;
        const rows = (await Promise.all(cfg.platformAdmin.environments.map((name) => api.environments(project, name)))).flat();
        const hits = rows.filter((r) => allowEnvironment(cfg, r.name) && (r.name === environment || String(r.id) === environment));
        if (hits.length !== 1) throw new ToolError('resource_not_allowed', 'Environment must resolve to one allowed name');
        const env = await api.environment(project, hits[0]!.id);
        if (env.id !== hits[0]!.id || env.name !== hits[0]!.name || !allowEnvironment(cfg, env.name)) throw new ToolError('resource_not_allowed', 'Environment is not allowed');
        const who = await resolveApprover(admin, run, cfg, approver);
        target = { project, environmentId: env.id, approverId: who.id, timeoutMinutes: timeout };
        return { api, project, env, who, hash: hashArgs({ ...target, instructions }) };
      };
      let resolved: Awaited<ReturnType<typeof resolve>>;
      const equal = async () => (await resolved.api.pipelineChecks(resolved.project, 'environment', String(resolved.env.id))).some((c) => c.isDisabled !== true && (c.type.name === 'Approval' || c.type.id?.toLowerCase() === APPROVAL_CHECK_TYPE.toLowerCase())
        && c.settings && c.settings.requesterCannotBeApprover === true && c.settings.approvers.length === 1 && c.settings.approvers[0]!.id?.toLowerCase() === resolved.who.id);
      if (!stored) {
        resolved = await resolve();
        if (await equal()) { outcome = 'already_exists'; return { content: 'An equal Approval check already exists. Nothing was created.', data: { status: outcome, ...target } }; }
      }
      const out = await twoPhase(run, tool, str(a.actionId), {
        agentDecides: false,
        describe: async () => ({ issueId: await issueOf(run), hash: resolved.hash, args: { ...target, environment, approver, instructions, reason: neutralize(reason) },
          prompt: `Add an Approval check to environment ${neutralize(resolved.env.name)} (${resolved.env.id}), approver ${neutralize(resolved.who.displayName).slice(0, 80)} (${resolved.who.id})?`,
          details: `Project ${neutralize(resolved.project)}. Environment ${neutralize(resolved.env.name)} (id ${resolved.env.id}). Approver ${neutralize(resolved.who.displayName).slice(0, 80)} (${resolved.who.id}). One approver is enough; the requester can never approve. Timeout ${timeout} minutes.${instructions ? `\n\nInstructions for the approver: ${instructions}` : ''}\n\nReason: ${neutralize(reason)}. Only a person can approve this.` }),
        recheck: async () => {
          try { resolved = await resolve(); return { hash: resolved.hash }; }
          catch (e) { if (e instanceof ToolError && ['not_enabled', 'resource_not_allowed', 'not_an_ado_identity', 'approver_refused'].includes(e.code)) throw new ToolError('state_changed', 'Platform scope or approver changed after approval'); throw e; }
        },
        execute: async () => {
          if (await equal()) return { summary: 'An equal Approval check already exists. Nothing was created.', data: { outcome: 'already_exists', ...target } };
          const made = await resolved.api.createApprovalCheck(resolved.project, { environmentId: resolved.env.id, environmentName: resolved.env.name, approverId: resolved.who.id, timeoutMinutes: timeout, ...(instructions ? { instructions } : {}) });
          if (typeof made.id !== 'number') throw new ToolError('postcondition_failed', 'Azure DevOps did not return the new check id');
          const back = await resolved.api.pipelineCheck(resolved.project, made.id);
          const good = back.settings.requesterCannotBeApprover === true && back.isDisabled !== true && (back.type.name === 'Approval' || back.type.id?.toLowerCase() === APPROVAL_CHECK_TYPE.toLowerCase())
            && back.resource.type === 'environment' && back.resource.id === String(resolved.env.id) && back.settings.approvers.length === 1 && back.settings.approvers[0]!.id?.toLowerCase() === resolved.who.id;
          if (!good) throw new ToolError('postcondition_failed', `Approval check ${made.id} readback did not match the approved settings (requesterCannotBeApprover must be true). Review the check in Azure DevOps.`);
          return { summary: 'Approval check created; readback verified (requester cannot approve).', data: { ...target, checkId: made.id, requesterCannotBeApprover: true } };
        },
      });
      outcome = String(out.data && (out.data as A).status || 'ok'); return out;
    } catch (e) { outcome = e instanceof ToolError ? `refused:${e.code}` : 'failed'; throw e; }
    finally { await audit(svc, host, run, tool, target, outcome); }
  }

  return { ado_variable_group_update: variableGroupUpdate, ado_pr_policy_queue_apply: policyQueue, ado_environment_check_create: environmentCheckCreate, ado_securefile_pipeline_permission_update: secureFilePermissionUpdate, ado_pipeline_create: pipelineCreate, ado_pipeline_update: pipelineUpdate, ado_repo_create: repoCreate, ado_pr_complete_apply: prComplete, ado_pr_abandon_apply: prAbandon, ado_pipeline_run_create: pipelineRun, ado_pr_approval_get: approvalGet, ado_pr_approval_post: approvalPost, ado_pr_gate_post: gatePost, humanCard, workProductStep };
}
