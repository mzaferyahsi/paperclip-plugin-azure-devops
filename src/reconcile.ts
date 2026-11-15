// Inbox drain and reconciler (spec 6.5, 7.3). Webhooks only schedule fetches; the reconciler is the source of truth.
import { AdoError } from './ado/client.ts';
import type { Config } from './config.ts';
import type { Host } from './host.ts';
import { NS } from './namespace.ts';
import { ScopeError, Service } from './service.ts';
import type { ResourceRef } from './webhook.ts';

const MAX_ATTEMPTS = 5;

export async function drainInbox(svc: Service, host: Host, limit = 25): Promise<{ done: number; failed: number; skipped: number }> {
  const nowIso = new Date(host.now()).toISOString();
  const rows = await host.db.query<{ id: string; company_id: string; project_id: string; resource_ref: ResourceRef; attempts: number; event_type: string }>(
    `SELECT id,company_id,project_id,resource_ref,attempts,event_type FROM ${NS}.webhook_inbox WHERE status='pending' AND attempts<$3 AND next_attempt_at<=$1 ORDER BY received_at LIMIT $2`, [nowIso, limit, MAX_ATTEMPTS]);
  const out = { done: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    // Optimistic claim: only one drainer wins a row.
    const claim = await host.db.execute(`UPDATE ${NS}.webhook_inbox SET status='processing', attempts=attempts+1, next_attempt_at=$2 WHERE id=$1 AND status='pending'`, [row.id, nowIso]);
    if (claim.rowCount === 0) continue;
    const finish = (status: string, error?: string, next?: Date) =>
      host.db.execute(`UPDATE ${NS}.webhook_inbox SET status=$2, error=$3, next_attempt_at=COALESCE($4, next_attempt_at) WHERE id=$1`, [row.id, status, error ?? null, next?.toISOString() ?? null]);
    try {
      const cfg = await host.config(row.company_id);
      const project = cfg?.projects.find((p) => p.projectId.toLowerCase() === row.project_id);
      if (!cfg || !project || cfg.reconcile.paused) { await finish('skipped', 'company_or_project_not_in_scope'); out.skipped++; continue; }
      const ref = row.resource_ref;
      if (ref.kind === 'pull_request' && ref.prId && ref.repoId) await svc.syncPr(row.company_id, cfg, project, ref.repoId, ref.prId, `webhook:${row.event_type}`);
      else if (ref.kind === 'build' && ref.buildId) await svc.syncBuild(row.company_id, cfg, project, ref.buildId, `webhook:${row.event_type}`);
      else if (ref.kind === 'work_item' && ref.workItemId) {
        // Only items we already track are refreshed; the rest would cost a call for nothing.
        const known = await svc.store.getWi(row.company_id, cfg.organization.name, project.projectId, ref.workItemId);
        if (known) await svc.syncWorkItem(row.company_id, cfg, project, ref.workItemId); else { await finish('skipped', 'untracked_work_item'); out.skipped++; continue; }
      } else { await finish('skipped', 'unsupported_event'); out.skipped++; continue; }
      await finish('done'); out.done++;
    } catch (e) {
      if (e instanceof ScopeError) { await finish('skipped', 'repo_not_in_scope'); out.skipped++; continue; }
      const code = e instanceof AdoError ? e.code : 'error';
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS || code === 'ado_config') { await finish('failed', code); out.failed++; }
      else {
        const wait = e instanceof AdoError && e.retryAfterSeconds ? e.retryAfterSeconds : Math.min(600, 30 * 2 ** attempts);
        await host.db.execute(`UPDATE ${NS}.webhook_inbox SET status='pending', error=$2, next_attempt_at=$3 WHERE id=$1`, [row.id, code, new Date(host.now() + wait * 1000).toISOString()]);
      }
    }
  }
  return out;
}

export interface ReconcileReport { company: string; prs: number; workItems: number; discovered: number; stoppedEarly: string | null; errors: string[] }

/** One company, one tick. Never exceeds maxCallsPerTickPerIdentity on the reviewer identity, stops when the identity is parked. */
export async function reconcileCompany(svc: Service, host: Host, companyId: string, cfg: Config): Promise<ReconcileReport> {
  const report: ReconcileReport = { company: companyId, prs: 0, workItems: 0, discovered: 0, stoppedEarly: null, errors: [] };
  if (cfg.reconcile.paused) { report.stoppedEarly = 'paused'; return report; }
  const nowIso = new Date(host.now()).toISOString();
  const gate = () => svc.gate(companyId, 'reviewer');
  // One tick may spend at most maxCallsPerTickPerIdentity calls: a pull request sync is charged at its real cost up front.
  const cap = cfg.reconcile.maxCallsPerTickPerIdentity;
  let spent = 0;
  const COST = { sync: 4, workItem: 2, list: 1 };
  const afford = (n: number) => { const g = gate(); if ((g && g.lowBudget()) || spent + n > cap) return false; spent += n; return true; };
  const guard = async (scope: string, fn: () => Promise<void>) => {
    try { await fn(); await svc.store.cursor(companyId, scope, true, nowIso); }
    catch (e) { const m = e instanceof AdoError ? e.code : String(e).slice(0, 200); report.errors.push(`${scope}:${m}`); await svc.store.cursor(companyId, scope, false, nowIso, m); }
  };

  await guard('prs_active', async () => {
    for (const pr of await svc.store.duePrs(companyId, nowIso, 25)) {
      if (!afford(COST.sync)) { report.stoppedEarly = 'budget'; return; }
      const project = cfg.projects.find((p) => p.projectId.toLowerCase() === pr.projectId.toLowerCase());
      if (!project) { await svc.store.retire(companyId, pr.projectId, pr.repoId, pr.prId); continue; }
      try { await svc.syncPr(companyId, cfg, project, pr.repoId, pr.prId, 'reconcile'); report.prs++; }
      catch (e) { if (e instanceof ScopeError) await svc.store.retire(companyId, pr.projectId, pr.repoId, pr.prId); else throw e; }
    }
  });

  await guard('work_items', async () => {
    const rows = await host.db.query<{ project_id: string; wi_id: number }>(`SELECT project_id, wi_id FROM ${NS}.work_item WHERE company_id=$1 AND terminal=false AND (next_reconcile_at IS NULL OR next_reconcile_at<=$2) ORDER BY next_reconcile_at NULLS FIRST LIMIT 10`, [companyId, nowIso]);
    for (const r of rows) {
      if (!afford(COST.workItem)) { report.stoppedEarly = 'budget'; return; }
      const project = cfg.projects.find((p) => p.projectId.toLowerCase() === r.project_id.toLowerCase());
      if (project) { await svc.syncWorkItem(companyId, cfg, project, Number(r.wi_id)); report.workItems++; }
    }
  });

  // Discovery: once per 30 minutes list active PRs per repository and pick up those we do not know yet (links by branch / title).
  const last = (await host.db.query<{ last_run_at: Date | null }>(`SELECT last_run_at FROM ${NS}.reconcile_cursor WHERE company_id=$1 AND scope='prs_discover'`, [companyId]))[0]?.last_run_at;
  if (!report.stoppedEarly && (!last || host.now() - new Date(last).getTime() > 30 * 60_000)) {
    await guard('prs_discover', async () => {
      for (const project of cfg.projects) {
        if (!afford(COST.list)) { report.stoppedEarly = 'budget'; return; }
        const repos = await svc.read(companyId, cfg, (api) => api.listRepos(project.projectId));
        for (const repo of repos.filter((r) => !r.isDisabled && svc.repoInScope(project, r.name, r.id))) {
          if (!afford(COST.list)) { report.stoppedEarly = 'budget'; return; }
          const prs = await svc.read(companyId, cfg, (api) => api.listPrs(project.projectId, repo.id, { status: 'active', top: 100 }));
          let fresh = 0;
          for (const pr of prs) {
            if (fresh >= 10 || !afford(COST.sync)) break;
            if (await svc.store.getPr(companyId, project.projectId, repo.id, pr.pullRequestId)) { spent -= COST.sync; continue; }
            try { await svc.syncPr(companyId, cfg, project, repo.id, pr.pullRequestId, 'discover'); fresh++; report.discovered++; } catch (e) { if (!(e instanceof ScopeError)) throw e; }
          }
        }
      }
    });
  }
  return report;
}

export async function housekeeping(host: Host): Promise<void> {
  const cut14 = new Date(host.now() - 14 * 86400_000).toISOString();
  const cut180 = new Date(host.now() - 180 * 86400_000).toISOString();
  await host.db.execute(`DELETE FROM ${NS}.webhook_inbox WHERE received_at<$1 AND status IN ('done','skipped','failed','rejected')`, [cut14]);
  await host.db.execute(`DELETE FROM ${NS}.audit WHERE at<$1`, [cut180]);
  await host.db.execute(`DELETE FROM ${NS}.effect WHERE at<$1`, [cut180]);
  // A row stuck in 'processing' (worker died mid-drain) goes back to pending after ten minutes.
  await host.db.execute(`UPDATE ${NS}.webhook_inbox SET status=CASE WHEN attempts>=${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END WHERE status='processing' AND next_attempt_at<$1`, [new Date(host.now() - 600_000).toISOString()]);
}
