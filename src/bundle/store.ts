// SQL for release_bundle rows. Every statement is company scoped. The host allows one statement per call and no transactions, so every
// state change is ONE compare-and-set UPDATE, and the two-table write of a queued run is ordered (bundle first, ledger second, both idempotent).
// The UPDATE statements below never name the frozen columns (company_id, issue_id, project_id, proposer_agent_id, source_commit, branch,
// build_pipeline_id, deploy_pipeline_id, config_snapshot, config_hash, args_hash, reason, commit_facts, created_at): tests scan this file for them.
import type { Db } from '../host.ts';
import { NS } from '../namespace.ts';

export type BundleStatus = 'awaiting_confirmation' | 'active' | 'building' | 'built' | 'deploying' | 'completed' | 'failed' | 'rejected' | 'expired' | 'revoked';
export const OPEN_STATUSES: BundleStatus[] = ['awaiting_confirmation', 'active', 'building', 'built', 'deploying'];
export const TERMINAL_STATUSES: BundleStatus[] = ['completed', 'failed', 'rejected', 'expired', 'revoked'];

export interface BundleRow {
  id: string; companyId: string; issueId: string; projectId: string; proposerAgentId: string; sourceCommit: string; branch: string;
  buildPipelineId: number; deployPipelineId: number; configSnapshot: Record<string, unknown>; configHash: string; argsHash: string; reason: string; commitFacts: Record<string, unknown>;
  status: BundleStatus; interactionId: string | null; approvedByUserId: string | null; approvedAt: string | null; expiresAt: string; buildAttempts: number; buildId: number | null;
  imageDigest: string | null; digestPinnedAt: string | null; deployRunId: number | null; lease: string | null; leaseExpiresAt: string | null; stepStartedAt: string | null;
  revokedBy: string | null; revokedAt: string | null; revokeReason: string | null; result: Record<string, unknown>; createdAt: string;
}
export type NewBundle = Pick<BundleRow, 'id' | 'companyId' | 'issueId' | 'projectId' | 'proposerAgentId' | 'sourceCommit' | 'buildPipelineId' | 'deployPipelineId' | 'configSnapshot' | 'configHash' | 'argsHash' | 'reason' | 'commitFacts' | 'expiresAt' | 'createdAt'>;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export function bundleFromRow(r: Record<string, unknown>): BundleRow {
  return {
    id: String(r.id), companyId: String(r.company_id), issueId: String(r.issue_id), projectId: String(r.project_id), proposerAgentId: String(r.proposer_agent_id), sourceCommit: String(r.source_commit), branch: String(r.branch),
    buildPipelineId: Number(r.build_pipeline_id), deployPipelineId: Number(r.deploy_pipeline_id), configSnapshot: obj(r.config_snapshot), configHash: String(r.config_hash), argsHash: String(r.args_hash),
    reason: String(r.reason), commitFacts: obj(r.commit_facts), status: r.status as BundleStatus, interactionId: r.interaction_id == null ? null : String(r.interaction_id),
    approvedByUserId: r.approved_by_user_id == null ? null : String(r.approved_by_user_id), approvedAt: iso(r.approved_at), expiresAt: iso(r.expires_at) ?? '', buildAttempts: Number(r.build_attempts ?? 0),
    buildId: num(r.build_id), imageDigest: r.image_digest == null ? null : String(r.image_digest), digestPinnedAt: iso(r.digest_pinned_at), deployRunId: num(r.deploy_run_id),
    lease: r.lease == null ? null : String(r.lease), leaseExpiresAt: iso(r.lease_expires_at), stepStartedAt: iso(r.step_started_at),
    revokedBy: r.revoked_by == null ? null : String(r.revoked_by), revokedAt: iso(r.revoked_at), revokeReason: r.revoke_reason == null ? null : String(r.revoke_reason), result: obj(r.result), createdAt: iso(r.created_at) ?? '',
  };
}

/** Which build a writer saw: its attempt, and its run id (null = no run recorded yet, undefined = not checked). A writer whose view is stale writes nothing. */
export interface BuildFence { attempt: number; buildId?: number | null }
const fenceSql = (f: BuildFence, at: number): { sql: string; params: unknown[] } => ({
  sql: ` AND build_attempts=$${at}::integer` + (f.buildId === undefined ? '' : f.buildId === null ? ' AND build_id IS NULL' : ` AND build_id=$${at + 1}::bigint`),
  params: f.buildId === undefined || f.buildId === null ? [f.attempt] : [f.attempt, f.buildId],
});

export class BundleStore {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async insert(b: NewBundle): Promise<boolean> {
    return (await this.db.execute(
      `INSERT INTO ${NS}.release_bundle (id,company_id,issue_id,project_id,proposer_agent_id,source_commit,branch,build_pipeline_id,deploy_pipeline_id,config_snapshot,config_hash,args_hash,reason,commit_facts,status,expires_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'refs/heads/main',$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb,'awaiting_confirmation',$14,$15)`,
      [b.id, b.companyId, b.issueId, b.projectId, b.proposerAgentId, b.sourceCommit, b.buildPipelineId, b.deployPipelineId, JSON.stringify(b.configSnapshot), b.configHash, b.argsHash, b.reason, JSON.stringify(b.commitFacts), b.expiresAt, b.createdAt])).rowCount > 0;
  }
  async get(companyId: string, id: string): Promise<BundleRow | null> {
    const r = await this.db.query(`SELECT * FROM ${NS}.release_bundle WHERE company_id=$1 AND id=$2`, [companyId, id]);
    return r[0] ? bundleFromRow(r[0]) : null;
  }
  async openFor(companyId: string, projectId: string): Promise<BundleRow | null> {
    const r = await this.db.query(`SELECT * FROM ${NS}.release_bundle WHERE company_id=$1 AND project_id=$2 AND status = ANY($3::text[]) LIMIT 1`, [companyId, projectId, OPEN_STATUSES]);
    return r[0] ? bundleFromRow(r[0]) : null;
  }
  async open(companyId: string): Promise<BundleRow[]> {
    return (await this.db.query(`SELECT * FROM ${NS}.release_bundle WHERE company_id=$1 AND status = ANY($2::text[]) ORDER BY created_at LIMIT 50`, [companyId, OPEN_STATUSES])).map(bundleFromRow);
  }
  async latestForIssue(companyId: string, issueId: string): Promise<BundleRow | null> {
    const r = await this.db.query(`SELECT * FROM ${NS}.release_bundle WHERE company_id=$1 AND issue_id=$2 ORDER BY created_at DESC LIMIT 1`, [companyId, issueId]);
    return r[0] ? bundleFromRow(r[0]) : null;
  }
  async lastCompleted(companyId: string, projectId: string): Promise<BundleRow | null> {
    const r = await this.db.query(`SELECT * FROM ${NS}.release_bundle WHERE company_id=$1 AND project_id=$2 AND status='completed' ORDER BY created_at DESC LIMIT 1`, [companyId, projectId]);
    return r[0] ? bundleFromRow(r[0]) : null;
  }
  async completedCommit(companyId: string, projectId: string, commit: string): Promise<boolean> {
    return (await this.db.query(`SELECT 1 AS x FROM ${NS}.release_bundle WHERE company_id=$1 AND project_id=$2 AND source_commit=$3 AND status='completed' LIMIT 1`, [companyId, projectId, commit])).length > 0;
  }
  async proposalsSince(companyId: string, agentId: string, sinceIso: string): Promise<number> {
    return Number((await this.db.query<{ n: string }>(`SELECT count(*)::text n FROM ${NS}.release_bundle WHERE company_id=$1 AND proposer_agent_id=$2 AND created_at >= $3::timestamptz`, [companyId, agentId, sinceIso]))[0]?.n ?? 0);
  }
  async pendingFor(companyId: string, agentId: string): Promise<number> {
    return Number((await this.db.query<{ n: string }>(`SELECT count(*)::text n FROM ${NS}.release_bundle WHERE company_id=$1 AND proposer_agent_id=$2 AND status='awaiting_confirmation'`, [companyId, agentId]))[0]?.n ?? 0);
  }
  async lastRejectedAt(companyId: string, agentId: string): Promise<string | null> {
    const r = await this.db.query(`SELECT revoked_at FROM ${NS}.release_bundle WHERE company_id=$1 AND proposer_agent_id=$2 AND status='rejected' ORDER BY revoked_at DESC NULLS LAST LIMIT 1`, [companyId, agentId]);
    return iso(r[0]?.revoked_at);
  }
  async setInteraction(companyId: string, id: string, interactionId: string): Promise<boolean> {
    return (await this.db.execute(`UPDATE ${NS}.release_bundle SET interaction_id=$3::uuid WHERE company_id=$1 AND id=$2 AND interaction_id IS NULL`, [companyId, id, interactionId])).rowCount > 0;
  }

  /** Proposal ended without approval (rejected card, timeout, closed issue). */
  async endProposal(companyId: string, id: string, to: 'rejected' | 'expired', nowIso: string, reason: string): Promise<boolean> {
    return (await this.db.execute(`UPDATE ${NS}.release_bundle SET status=$3, revoked_at=$4::timestamptz, revoke_reason=$5 WHERE company_id=$1 AND id=$2 AND status='awaiting_confirmation'`, [companyId, id, to, nowIso, reason.slice(0, 300)])).rowCount > 0;
  }
  /** The accept CAS (design section 6): one statement; zero rows means a late or tampered accept. */
  async approve(companyId: string, id: string, userId: string, nowIso: string, ttlMinutes: number, argsHash: string): Promise<boolean> {
    return (await this.db.execute(
      `UPDATE ${NS}.release_bundle SET status='active', approved_by_user_id=$3, approved_at=$4::timestamptz, expires_at=$4::timestamptz + ($5::integer * interval '1 minute')
       WHERE company_id=$1 AND id=$2 AND status='awaiting_confirmation' AND expires_at > $4::timestamptz AND args_hash=$6`, [companyId, id, userId, nowIso, ttlMinutes, argsHash])).rowCount > 0;
  }
  /**
   * Claim a step. Checks in the same statement: status, window, argument hash and config hash. A claim also needs the lease free or expired.
   * Intent is written here (step_started_at, build_attempts) BEFORE any Azure DevOps call.
   */
  async claim(c: { companyId: string; id: string; from: BundleStatus; to: BundleStatus; lease: string; leaseExpiresIso: string; nowIso: string; argsHash: string; configHash: string; buildAttempt: boolean; maxAttempts?: number }): Promise<boolean> {
    return (await this.db.execute(
      `UPDATE ${NS}.release_bundle SET status=$4, lease=$5, lease_expires_at=$6::timestamptz, step_started_at=$7::timestamptz, build_attempts=build_attempts + $10::integer
       WHERE company_id=$1 AND id=$2 AND status=$3 AND expires_at > $7::timestamptz AND args_hash=$8 AND config_hash=$9 AND (lease_expires_at IS NULL OR lease_expires_at <= $7::timestamptz) AND ($11::integer IS NULL OR build_attempts < $11::integer)`,
      [c.companyId, c.id, c.from, c.to, c.lease, c.leaseExpiresIso, c.nowIso, c.argsHash, c.configHash, c.buildAttempt ? 1 : 0, c.buildAttempt && c.maxAttempts != null ? c.maxAttempts : null])).rowCount > 0;
  }
  /**
   * Record the run a step queued. Bundle first (the ledger row follows and is idempotent).
   * Fenced: the build must still be unrecorded, in the attempt the caller claimed, and the caller must still hold the lease (a recovery adoption passes no lease; it needs the null run id and the same attempt).
   * A stale worker whose lease or attempt moved on writes nothing.
   */
  async recordBuildRun(companyId: string, id: string, runId: number, fence: { attempt: number; lease?: string | null }): Promise<boolean> {
    return (await this.db.execute(`UPDATE ${NS}.release_bundle SET build_id=$3::bigint, lease=NULL, lease_expires_at=NULL WHERE company_id=$1 AND id=$2 AND status='building' AND image_digest IS NULL AND build_id IS NULL AND build_attempts=$4::integer AND ($5::text IS NULL OR lease=$5::text)`, [companyId, id, runId, fence.attempt, fence.lease ?? null])).rowCount > 0;
  }
  async recordDeployRun(companyId: string, id: string, runId: number, fence: { lease?: string | null } = {}): Promise<boolean> {
    return (await this.db.execute(`UPDATE ${NS}.release_bundle SET deploy_run_id=$3::bigint, lease=NULL, lease_expires_at=NULL WHERE company_id=$1 AND id=$2 AND status='deploying' AND deploy_run_id IS NULL AND ($4::text IS NULL OR lease=$4::text)`, [companyId, id, runId, fence.lease ?? null])).rowCount > 0;
  }
  /** Last check before the external POST: same lease, same status, window still open, hashes unchanged. */
  async stillOwned(companyId: string, id: string, status: BundleStatus, lease: string, argsHash: string, nowIso: string): Promise<boolean> {
    return (await this.db.query(`SELECT 1 AS x FROM ${NS}.release_bundle WHERE company_id=$1 AND id=$2 AND status=$3 AND lease=$4 AND lease_expires_at > $6::timestamptz AND expires_at > $6::timestamptz AND args_hash=$5`, [companyId, id, status, lease, argsHash, nowIso])).length > 0;
  }
  /**
   * Durable cancellation intent for a deploy run that waits at the environment approval. Takes the lease (so overlapping callers do not both cancel).
   * The first intent wins; later callers only retry the cancel under the lease.
   */
  async beginCancel(companyId: string, id: string, runId: number, intent: Record<string, unknown>, lease: string, leaseExpiresIso: string, nowIso: string): Promise<boolean> {
    return (await this.db.execute(
      `UPDATE ${NS}.release_bundle SET result = CASE WHEN result->'cancel' IS NULL THEN jsonb_set(COALESCE(result,'{}'::jsonb), '{cancel}', $4::jsonb) ELSE result END, lease=$5, lease_expires_at=$6::timestamptz
       WHERE company_id=$1 AND id=$2 AND status='deploying' AND deploy_run_id=$3::bigint AND (lease_expires_at IS NULL OR lease_expires_at <= $7::timestamptz)`,
      [companyId, id, runId, JSON.stringify(intent), lease, leaseExpiresIso, nowIso])).rowCount > 0;
  }
  async dropCancel(companyId: string, id: string): Promise<boolean> {
    return (await this.db.execute(`UPDATE ${NS}.release_bundle SET result = result - 'cancel', lease=NULL, lease_expires_at=NULL WHERE company_id=$1 AND id=$2 AND status='deploying' AND result->'cancel' IS NOT NULL`, [companyId, id])).rowCount > 0;
  }
  /** Back to the earlier state when the build ended without a usable digest. build_id is cleared so a retry can store its own. */
  async retryBuild(companyId: string, id: string, result: Record<string, unknown>, fence: BuildFence): Promise<boolean> {
    const f = fenceSql(fence, 4);
    return (await this.db.execute(`UPDATE ${NS}.release_bundle SET status='active', build_id=NULL, lease=NULL, lease_expires_at=NULL, step_started_at=NULL, result=$3::jsonb WHERE company_id=$1 AND id=$2 AND status='building' AND image_digest IS NULL${f.sql}`, [companyId, id, JSON.stringify(result), ...f.params])).rowCount > 0;
  }
  async setResult(companyId: string, id: string, result: Record<string, unknown>): Promise<void> {
    await this.db.execute(`UPDATE ${NS}.release_bundle SET result=$3::jsonb WHERE company_id=$1 AND id=$2`, [companyId, id, JSON.stringify(result)]);
  }
  /** First pin is immutable: WHERE image_digest IS NULL. */
  async pinDigest(companyId: string, id: string, digest: string, nowIso: string, result: Record<string, unknown>, fence: BuildFence): Promise<boolean> {
    const f = fenceSql(fence, 6);
    return (await this.db.execute(`UPDATE ${NS}.release_bundle SET image_digest=$3, digest_pinned_at=$4::timestamptz, status='built', result=$5::jsonb WHERE company_id=$1 AND id=$2 AND status='building' AND image_digest IS NULL AND build_id IS NOT NULL${f.sql}`, [companyId, id, digest, nowIso, JSON.stringify(result), ...f.params])).rowCount > 0;
  }
  /** Any open state to a terminal one. `from` guards against racing writers. */
  async finish(companyId: string, id: string, from: BundleStatus[], to: 'completed' | 'failed' | 'expired' | 'revoked', nowIso: string, o: { by?: string; reason?: string; result?: Record<string, unknown>; fence?: BuildFence; deployUnrecorded?: boolean } = {}): Promise<boolean> {
    const f = o.fence ? fenceSql(o.fence, 9) : { sql: '', params: [] as unknown[] };
    if (o.deployUnrecorded) f.sql += ' AND deploy_run_id IS NULL';
    return (await this.db.execute(
      `UPDATE ${NS}.release_bundle SET status=$4, revoked_by=COALESCE($5, revoked_by), revoked_at=$6::timestamptz, revoke_reason=COALESCE($7, revoke_reason), result=COALESCE($8::jsonb, result), lease=NULL, lease_expires_at=NULL WHERE company_id=$1 AND id=$2 AND status = ANY($3::text[])${f.sql}`,
      [companyId, id, from, to, o.by ?? null, nowIso, o.reason ? o.reason.slice(0, 300) : null, o.result ? JSON.stringify(o.result) : null, ...f.params])).rowCount > 0;
  }
  /** Lease takeover for recovery: only when the lease has expired. */
  async renewLease(companyId: string, id: string, status: BundleStatus, lease: string, leaseExpiresIso: string, nowIso: string): Promise<boolean> {
    return (await this.db.execute(`UPDATE ${NS}.release_bundle SET lease=$4, lease_expires_at=$5::timestamptz WHERE company_id=$1 AND id=$2 AND status=$3 AND (lease_expires_at IS NULL OR lease_expires_at <= $6::timestamptz)`, [companyId, id, status, lease, leaseExpiresIso, nowIso])).rowCount > 0;
  }

  // ---- ledger rows (action table) for the runs the worker queued
  /** Idempotent: the unique (company_id, idempotency_key) makes a repeat a no-op. */
  async ledgerRun(r: { id: string; companyId: string; issueId: string; agentId: string; key: string; argsHash: string; args: Record<string, unknown>; runId: number; nowIso: string; expiresIso: string }): Promise<boolean> {
    return (await this.db.execute(
      `INSERT INTO ${NS}.action (id,company_id,issue_id,agent_id,run_id,tool,args_hash,args_redacted,risk_class,status,created_at,expires_at,applied_at,result,idempotency_key)
       VALUES ($1,$2,$3,$4,NULL,'ado_pipeline_run_create',$5,$6::jsonb,'G','applied',$7::timestamptz,$8::timestamptz,$7::timestamptz,$9::jsonb,$10) ON CONFLICT DO NOTHING`,
      [r.id, r.companyId, r.issueId, r.agentId, r.argsHash, JSON.stringify(r.args), r.nowIso, r.expiresIso, JSON.stringify({ runId: r.runId }), r.key])).rowCount > 0;
  }
  async ledgerExists(companyId: string, key: string): Promise<boolean> {
    return (await this.db.query(`SELECT 1 AS x FROM ${NS}.action WHERE company_id=$1 AND idempotency_key=$2`, [companyId, key])).length > 0;
  }
  /** A bundle row that backs a deploy run, for control 6. */
  async bundleForDeployRun(companyId: string, bundleId: string): Promise<BundleRow | null> { return this.get(companyId, bundleId); }
}
