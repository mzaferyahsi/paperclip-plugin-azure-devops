import type { Service } from '../service.ts';
import { TOOLS } from './catalog.ts';
import { audit, checkRunQuota, fail, finish, roleAllowed, ToolError, type RunCtx, type ToolOut } from './common.ts';
import { makeGatedTools } from './gate.ts';
import { makeExploreTools } from './explore.ts';
import { makePlatformTools } from './platform.ts';
import { makeReadTools } from './read.ts';
import { makeWriteTools } from './write.ts';
import { makeReleaseTools } from './release.ts';
import { makeDeployApprovalTools } from './deploy-approval.ts';
import { makeBundleTools } from './bundle.ts';

import { NS } from '../namespace.ts';

export type Handler = (args: Record<string, unknown>, run: RunCtx) => Promise<ToolOut>;

/** One entry point per tool: quota, company config, role check, handler, then result shaping. Errors become stable codes. */
export function makeToolRunner(svc: Service, agentName: (companyId: string, agentId: string) => Promise<string>) {
  const gated = makeGatedTools(svc, agentName);
  const handlers: Record<string, Handler> = {
    ...makeReadTools(svc), ...makeExploreTools(svc), ...makePlatformTools(svc), ...makeWriteTools(svc, agentName), ...makeReleaseTools(svc), ...makeDeployApprovalTools(svc, agentName), ...makeBundleTools(svc),
    ado_pr_complete_apply: gated.ado_pr_complete_apply, ado_pr_abandon_apply: gated.ado_pr_abandon_apply, ado_pipeline_run_create: gated.ado_pipeline_run_create, ado_pr_policy_queue_apply: gated.ado_pr_policy_queue_apply,
    ado_securefile_pipeline_permission_update: gated.ado_securefile_pipeline_permission_update, ado_variable_group_update: gated.ado_variable_group_update, ado_environment_check_create: gated.ado_environment_check_create,
    ado_pipeline_create: gated.ado_pipeline_create, ado_pipeline_update: gated.ado_pipeline_update, ado_repo_create: gated.ado_repo_create,
    ado_pr_approval_get: gated.ado_pr_approval_get, ado_pr_approval_post: gated.ado_pr_approval_post, ado_pr_gate_post: gated.ado_pr_gate_post,
  };
  for (const t of TOOLS) if (!handlers[t.name]) throw new Error(`no handler for tool ${t.name}`);
  return async function run(name: string, params: unknown, ctx: RunCtx): Promise<ToolOut> {
    const spec = TOOLS.find((t) => t.name === name);
    const h = handlers[name];
    if (!spec || !h) return { error: 'unknown_tool', content: `No such tool: ${name.slice(0, 60)}` };
    let enteredHandler = false;
    try {
      let limit: number | undefined;
      try { limit = (await svc.cfg(ctx.companyId)).limits.maxToolCallsPerRun; } catch { /* counted with the default; the real error is raised below */ }
      checkRunQuota(ctx, svc.host.now(), limit);
      const cfg = await svc.cfg(ctx.companyId);
      if (!roleAllowed(cfg, ctx.agentId, spec.role)) {
        const isApprover = cfg.approval.approverAgentIds.some((x) => x.toLowerCase() === ctx.agentId.toLowerCase());
        if (spec.role === 'proposer' && isApprover) throw new ToolError('role_denied', 'You are an approver: you decide, you do not propose. Ask an operator or the pull request\'s author agent to call ado_pr_complete_apply, then decide with ado_pr_approval_post. Do not ask the board.');
        throw new ToolError('role_denied', `This agent may not use ${name} (needs the ${spec.role.replace(/_/g, ' ')} role in the Azure DevOps settings)`);
      }
      const args = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
      enteredHandler = true;
      const out = await h(args, ctx);
      svc.host.metric('ado.tool.calls', 1, { tool: name, outcome: 'ok' });
      return finish(out);
    } catch (e) {
      if (!enteredHandler && (name === 'ado_securefile_pipeline_permission_update' || name === 'ado_variable_group_update' || name === 'ado_environment_check_create' || name === 'ado_environment_approval_post')) await audit(svc, svc.host, ctx, name, {}, e instanceof ToolError ? `refused:${e.code}` : 'failed');
      svc.host.metric('ado.tool.calls', 1, { tool: name, outcome: 'error' });
      if (!(e instanceof ToolError)) svc.host.log.error('tool failed', { tool: name, error: String((e as Error)?.message ?? e).slice(0, 300), stack: String((e as Error)?.stack ?? '').split('\n').slice(0, 4).join(' | ').slice(0, 500) });
      return finish(fail(e));
    }
  };
}

/**
 * After a person approves a gated action on the issue, apply it from the stored proposal without waiting for an agent: the card
 * wakes the issue assignee, who is usually not the operator that proposed it. Runs from the reconcile job, once a minute at most.
 */
export async function settleApprovedActions(svc: Service, run: ReturnType<typeof makeToolRunner>): Promise<number> {
  const host = svc.host;
  const gate = makeGatedTools(svc);
  type Row = { id: string; company_id: string; issue_id: string | null; agent_id: string; run_id: string | null; tool: string; interaction_id: string | null; status: string; gate_mode: string; approved_by_agent_id: string | null; args_redacted: Record<string, unknown> };
  // 1. Approvers who did not decide in time: hand the decision to a person (a human-only card) or let the request lapse.
  const late = await host.db.query<Row>(`SELECT id,company_id,issue_id,agent_id,run_id,tool,interaction_id,status,gate_mode,approved_by_agent_id,args_redacted FROM ${NS}.action WHERE status='awaiting_approval' AND approval_deadline_at<$1 AND expires_at>$1 ORDER BY created_at LIMIT 20`, [new Date(host.now()).toISOString()]);
  for (const row of late) {
    try {
      const cfg = await svc.cfg(row.company_id);
      if (!row.issue_id || !cfg.approval.escalateToBoardOnTimeout) {
        await host.db.execute(`UPDATE ${NS}.action SET status='expired' WHERE company_id=$1 AND id=$2 AND status='awaiting_approval'`, [row.company_id, row.id]);
        if (row.issue_id) await host.issues.comment(row.company_id, row.issue_id, `The merge approval request expired: no approver decided in ${cfg.approval.approvalTimeoutMinutes} minutes. Propose it again when an approver is available.`).catch(() => {});
        continue;
      }
      const card = await gate.humanCard(row.company_id, row.issue_id, row.id, row.tool === 'ado_pr_policy_queue_apply' ? `Queue the build policy on ${String(row.args_redacted.repository ?? '')} !${String(row.args_redacted.prId ?? '')}? (no approver decided in time)` : row.tool === 'ado_pipeline_run_create' ? `Run pipeline ${String(row.args_redacted.pipelineId ?? '')} on ${String(row.args_redacted.branch ?? '')}? (no approver decided in time)` : `Approve ${String(row.args_redacted.repository ?? '')} !${String(row.args_redacted.prId ?? '')}? (no approver decided in time)`, 'The approvers did not decide in time, so the decision comes to the board. Check the details on this issue before approving.', 'Escalated to the board.');
      const r = await host.db.execute(`UPDATE ${NS}.action SET status='escalated', escalated_at=$3::timestamptz, interaction_id=$4::uuid WHERE company_id=$1 AND id=$2 AND status='awaiting_approval'`, [row.company_id, row.id, new Date(host.now()).toISOString(), card]);
      if (r.rowCount) await host.issues.comment(row.company_id, row.issue_id, 'No approver decided in time. The decision was escalated to the board on this issue.').catch(() => {});
    } catch (e) { host.log.warn('escalation failed', { action: row.id, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
  }
  // 2. Decided actions: a person resolved the card, or an approver approved (nothing more is needed in approvers mode).
  const rows = await host.db.query<Row>(
    `SELECT id,company_id,issue_id,agent_id,run_id,tool,interaction_id,status,gate_mode,approved_by_agent_id,args_redacted FROM ${NS}.action WHERE expires_at>$1 AND (status IN ('awaiting_confirmation','escalated') OR (status='approved' AND approved_at>$2)) ORDER BY created_at LIMIT 20`, [new Date(host.now()).toISOString(), new Date(host.now() - 24 * 3600_000).toISOString()]);
  let settled = 0;
  for (const row of rows) {
    if (!row.issue_id) continue;
    const agentOnly = row.gate_mode === 'approvers' && row.status === 'approved' && !!row.approved_by_agent_id;
    if (!agentOnly) {
      if (!row.interaction_id) continue;
      const inter = await host.issues.interaction(row.company_id, row.issue_id, row.interaction_id).catch(() => null);
      // Only resolved cards are worth a call; a pending card costs nothing here.
      if (!inter || (inter.status === 'pending' && !inter.outcome)) continue;
    }
    // A fresh run id per attempt: the proposer's own run may be long over and its call quota used up.
    const out = await run(row.tool, { actionId: row.id }, { agentId: row.agent_id, runId: host.uuid(), companyId: row.company_id });
    // A transient failure (rate limit, outage) is retried on the next tick; anything else ends the attempt and is reported once.
    if (out.error && /rate_limited|unavailable|timeout|network|5\d\d/.test(out.error)) continue;
    const key = `action:${row.id}:settled`;
    if (!(await svc.store.once(row.company_id, key, new Date(host.now()).toISOString()))) continue;
    settled++;
    const text = out.error
      ? `The approved Azure DevOps action could not be applied: ${out.error}. ${String(out.content ?? '').slice(0, 300)}`
      : `The approved Azure DevOps action was applied: ${String(out.content ?? '').slice(0, 300)}`;
    await host.issues.comment(row.company_id, row.issue_id, text).catch(() => {});
  }
  // 3. Approval tasks ("Approve: ..."): the plugin creates them, so the plugin closes them once the action has left the approvers' hands.
  const decided = await host.db.query<{ id: string; company_id: string; approval_issue_id: string; status: string; approved_by_agent_id: string | null }>(
    `SELECT id,company_id,approval_issue_id,status,approved_by_agent_id FROM ${NS}.action WHERE approval_issue_id IS NOT NULL AND status<>'awaiting_approval' ORDER BY created_at DESC LIMIT 50`);
  for (const d of decided) {
    try {
      const t = await host.issues.get(d.company_id, d.approval_issue_id);
      if (!t || t.status === 'done' || t.status === 'cancelled') continue;
      await host.issues.setStatus(d.company_id, d.approval_issue_id, d.status === 'expired' && !d.approved_by_agent_id ? 'cancelled' : 'done');
    } catch (e) { host.log.warn('approval task could not be closed', { action: d.id, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
  }
  return settled;
}
