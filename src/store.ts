// SQL for the plugin schema. Every statement is company scoped. The schema name is derived once (namespace.ts).
import type { Db } from './host.ts';
import { NS } from './namespace.ts';
import type { PrSnapshot, WiSnapshot } from './ado/model.ts';

export interface PrRow extends PrSnapshot { companyId: string; reviewRequestedAt: string | null; fetchedAt: string; changedAt: string; etag: string | null; nextReconcileAt: string | null }
export interface LinkRow { id: string; companyId: string; issueId: string; kind: 'pull_request' | 'work_item' | 'build'; org: string; projectId: string; repoId: string; externalId: string; source: string; confidence: 'exact' | 'likely'; authorAgentId: string | null; createdByRunId: string | null; releasedAt: string | null }

export interface ReleaseTuple { companyId: string; releaseIssueId: string; sourceCommit: string; imageDigest: string; buildId: number }
export interface ReleaseVerdictRow extends ReleaseTuple { id: string; fn: string; agentId: string; vote: number; summaryRedacted: string; runId: string | null; createdAt: string }

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

function prFromRow(r: Record<string, unknown>): PrRow {
  return {
    companyId: String(r.company_id), org: String(r.org), projectId: String(r.project_id), projectName: String(r.project_name ?? ''), repoId: String(r.repo_id), repoName: String(r.repo_name ?? ''),
    prId: Number(r.pr_id), url: String(r.url ?? ''), title: String(r.title ?? ''), status: String(r.status), mergeStatus: String(r.merge_status ?? 'notSet'), isDraft: r.is_draft === true,
    sourceRef: String(r.source_ref ?? ''), targetRef: String(r.target_ref ?? ''), createdById: String(r.created_by_id ?? ''),
    lastMergeSourceCommit: String(r.last_merge_source_commit ?? ''), lastMergeCommit: String(r.last_merge_commit ?? ''), iterationCount: Number(r.iteration_count ?? 0),
    reviewers: (r.reviewers as PrSnapshot['reviewers']) ?? [], policies: (r.policy_summary as PrSnapshot['policies']) ?? [],
    reviewStatus: ((r.review_status as { state?: PrSnapshot['reviewStatus'] } | null)?.state ?? 'none'), terminal: r.terminal === true,
    reviewRequestedAt: iso(r.review_requested_at), fetchedAt: iso(r.fetched_at) ?? '', changedAt: iso(r.changed_at) ?? '', etag: (r.etag as string | null) ?? null, nextReconcileAt: iso(r.next_reconcile_at),
  };
}
function linkFromRow(r: Record<string, unknown>): LinkRow {
  return { id: String(r.id), companyId: String(r.company_id), issueId: String(r.issue_id), kind: r.kind as LinkRow['kind'], org: String(r.org), projectId: String(r.project_id), repoId: String(r.repo_id ?? ''), externalId: String(r.external_id), source: String(r.source), confidence: r.confidence === 'likely' ? 'likely' : 'exact', authorAgentId: (r.author_agent_id as string | null) ?? null, createdByRunId: (r.created_by_run_id as string | null) ?? null, releasedAt: iso(r.released_at) };
}

export class Store {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async getPr(companyId: string, projectId: string, repoId: string, prId: number): Promise<PrRow | null> {
    const rows = await this.db.query(`SELECT * FROM ${NS}.pull_request WHERE company_id=$1 AND project_id=$2 AND repo_id=$3 AND pr_id=$4`, [companyId, projectId, repoId, prId]);
    return rows[0] ? prFromRow(rows[0]) : null;
  }
  async findPrById(companyId: string, projectId: string, repoId: string, prId: number): Promise<PrRow | null> { return this.getPr(companyId, projectId, repoId, prId); }
  async findPrByName(companyId: string, org: string, projectName: string, repoName: string, prId: number): Promise<PrRow | null> {
    const rows = await this.db.query(`SELECT * FROM ${NS}.pull_request WHERE company_id=$1 AND lower(org)=lower($2) AND lower(project_name)=lower($3) AND lower(repo_name)=lower($4) AND pr_id=$5`, [companyId, org, projectName, repoName, prId]);
    return rows[0] ? prFromRow(rows[0]) : null;
  }
  async upsertPr(companyId: string, s: PrSnapshot, o: { nowIso: string; changed: boolean; etag?: string | null; nextReconcileAt: string | null; reviewRequestedAt?: string | null }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${NS}.pull_request (company_id,org,project_id,repo_id,pr_id,repo_name,project_name,url,title,status,merge_status,is_draft,source_ref,target_ref,created_by_id,last_merge_source_commit,last_merge_commit,iteration_count,reviewers,policy_summary,review_status,review_requested_at,etag,fetched_at,changed_at,terminal,next_reconcile_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21::jsonb,$22,$23,$24,$24,$25,$26)
       ON CONFLICT (company_id,org,project_id,repo_id,pr_id) DO UPDATE SET
         repo_name=EXCLUDED.repo_name, project_name=EXCLUDED.project_name, url=EXCLUDED.url, title=EXCLUDED.title, status=EXCLUDED.status, merge_status=EXCLUDED.merge_status, is_draft=EXCLUDED.is_draft,
         source_ref=EXCLUDED.source_ref, target_ref=EXCLUDED.target_ref, created_by_id=EXCLUDED.created_by_id, last_merge_source_commit=EXCLUDED.last_merge_source_commit, last_merge_commit=EXCLUDED.last_merge_commit,
         iteration_count=EXCLUDED.iteration_count, reviewers=EXCLUDED.reviewers, policy_summary=EXCLUDED.policy_summary, review_status=EXCLUDED.review_status,
         review_requested_at=COALESCE(EXCLUDED.review_requested_at, ${NS}.pull_request.review_requested_at), etag=EXCLUDED.etag, fetched_at=EXCLUDED.fetched_at,
         changed_at=CASE WHEN $27::boolean THEN EXCLUDED.fetched_at ELSE ${NS}.pull_request.changed_at END, terminal=EXCLUDED.terminal, next_reconcile_at=EXCLUDED.next_reconcile_at`,
      [companyId, s.org, s.projectId, s.repoId, s.prId, s.repoName, s.projectName, s.url, s.title, s.status, s.mergeStatus, s.isDraft, s.sourceRef, s.targetRef, s.createdById, s.lastMergeSourceCommit, s.lastMergeCommit, s.iterationCount,
        JSON.stringify(s.reviewers), JSON.stringify(s.policies), JSON.stringify({ state: s.reviewStatus }), o.reviewRequestedAt ?? null, o.etag ?? null, o.nowIso, s.terminal, o.nextReconcileAt, o.changed]);
  }
  async duePrs(companyId: string, nowIso: string, limit: number): Promise<PrRow[]> {
    const rows = await this.db.query(`SELECT p.* FROM ${NS}.pull_request p WHERE p.company_id=$1 AND p.terminal=false AND (p.next_reconcile_at IS NULL OR p.next_reconcile_at<=$2) ORDER BY (EXISTS (SELECT 1 FROM ${NS}.link l WHERE l.company_id=p.company_id AND l.kind='pull_request' AND l.project_id=p.project_id AND l.repo_id=p.repo_id AND l.external_id=p.pr_id::text AND l.released_at IS NULL)) DESC, p.next_reconcile_at NULLS FIRST LIMIT $3`, [companyId, nowIso, limit]);
    return rows.map(prFromRow);
  }
  /** An object that fell out of scope stops being refreshed. */
  async retire(companyId: string, projectId: string, repoId: string, prId: number): Promise<void> {
    await this.db.execute(`UPDATE ${NS}.pull_request SET terminal=true, next_reconcile_at=NULL WHERE company_id=$1 AND project_id=$2 AND repo_id=$3 AND pr_id=$4`, [companyId, projectId, repoId, prId]);
  }
  async activePrs(companyId: string): Promise<PrRow[]> {
    return (await this.db.query(`SELECT * FROM ${NS}.pull_request WHERE company_id=$1 AND terminal=false ORDER BY changed_at DESC LIMIT 200`, [companyId])).map(prFromRow);
  }

  async upsertWi(companyId: string, w: WiSnapshot, nowIso: string, next: string | null): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${NS}.work_item (company_id,org,project_id,wi_id,url,wi_type,title,state,state_category,assigned_to,rev,fetched_at,terminal,next_reconcile_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (company_id,org,project_id,wi_id) DO UPDATE SET url=EXCLUDED.url,wi_type=EXCLUDED.wi_type,title=EXCLUDED.title,state=EXCLUDED.state,state_category=EXCLUDED.state_category,assigned_to=EXCLUDED.assigned_to,rev=EXCLUDED.rev,fetched_at=EXCLUDED.fetched_at,terminal=EXCLUDED.terminal,next_reconcile_at=EXCLUDED.next_reconcile_at`,
      [companyId, w.org, w.projectId || w.projectName, w.id, w.url, w.type, w.title, w.state, w.stateCategory, w.assignedTo, w.rev, nowIso, w.terminal, next]);
  }
  async getWi(companyId: string, org: string, project: string, id: number): Promise<{ state: string; stateCategory: string; rev: number } | null> {
    const r = await this.db.query<{ state: string; state_category: string; rev: number }>(`SELECT state,state_category,rev FROM ${NS}.work_item WHERE company_id=$1 AND lower(org)=lower($2) AND lower(project_id)=lower($3) AND wi_id=$4`, [companyId, org, project, id]);
    return r[0] ? { state: r[0].state, stateCategory: r[0].state_category, rev: r[0].rev } : null;
  }
  async upsertBuild(companyId: string, b: { org: string; projectId: string; buildId: number; pipelineId?: number; webUrl?: string; status?: string; result?: string; sourceBranch?: string; sourceVersion?: string; reason?: string; finishedAt?: string | null }, nowIso: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${NS}.build (company_id,org,project_id,build_id,pipeline_id,web_url,status,result,source_branch,source_version,reason,finished_at,fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (company_id,org,project_id,build_id) DO UPDATE SET status=EXCLUDED.status,result=EXCLUDED.result,web_url=EXCLUDED.web_url,finished_at=EXCLUDED.finished_at,fetched_at=EXCLUDED.fetched_at`,
      [companyId, b.org, b.projectId, b.buildId, b.pipelineId ?? null, b.webUrl ?? null, b.status ?? null, b.result ?? null, b.sourceBranch ?? null, b.sourceVersion ?? null, b.reason ?? null, b.finishedAt ?? null, nowIso]);
  }

  async addLink(l: { id: string; companyId: string; issueId: string; kind: LinkRow['kind']; org: string; projectId: string; repoId: string; externalId: string; source: string; confidence: 'exact' | 'likely'; authorAgentId?: string | null; runId?: string | null }, nowIso: string): Promise<boolean> {
    const r = await this.db.execute(
      `INSERT INTO ${NS}.link (id,company_id,issue_id,kind,org,project_id,repo_id,external_id,source,confidence,author_agent_id,created_by_run_id,created_at,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       ON CONFLICT (company_id,issue_id,kind,org,project_id,repo_id,external_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at, released_at=NULL,
         confidence=CASE WHEN ${NS}.link.confidence='exact' OR EXCLUDED.confidence='exact' THEN 'exact' ELSE 'likely' END`,
      [l.id, l.companyId, l.issueId, l.kind, l.org, l.projectId, l.repoId, l.externalId, l.source, l.confidence, l.authorAgentId ?? null, l.runId ?? null, nowIso]);
    return r.rowCount > 0;
  }
  /** Record who wrote a pull request that was opened by hand. Only sets an author where none is recorded for the whole pull request. */
  async claimAuthor(companyId: string, issueId: string, org: string, projectId: string, repoId: string, prId: string, agentId: string): Promise<'claimed' | 'already_recorded'> {
    const taken = await this.db.query<{ n: string }>(`SELECT count(*)::text n FROM ${NS}.link WHERE company_id=$1 AND kind='pull_request' AND lower(org)=lower($2) AND project_id=$3 AND repo_id=$4 AND external_id=$5 AND author_agent_id IS NOT NULL`, [companyId, org, projectId, repoId, prId]);
    if (Number(taken[0]?.n ?? 0) > 0) return 'already_recorded';
    const r = await this.db.execute(`UPDATE ${NS}.link SET author_agent_id=$7, source='adopted' WHERE company_id=$1 AND issue_id=$2 AND kind='pull_request' AND lower(org)=lower($3) AND project_id=$4 AND repo_id=$5 AND external_id=$6 AND author_agent_id IS NULL`, [companyId, issueId, org, projectId, repoId, prId, agentId]);
    return r.rowCount > 0 ? 'claimed' : 'already_recorded';
  }
  async linksForIssue(companyId: string, issueId: string): Promise<LinkRow[]> {
    return (await this.db.query(`SELECT * FROM ${NS}.link WHERE company_id=$1 AND issue_id=$2 AND released_at IS NULL ORDER BY created_at`, [companyId, issueId])).map(linkFromRow);
  }
  async linksForObject(companyId: string, kind: LinkRow['kind'], org: string, projectId: string, repoId: string, externalId: string): Promise<LinkRow[]> {
    return (await this.db.query(`SELECT * FROM ${NS}.link WHERE company_id=$1 AND kind=$2 AND lower(org)=lower($3) AND project_id=$4 AND repo_id=$5 AND external_id=$6 AND released_at IS NULL`, [companyId, kind, org, projectId, repoId, externalId])).map(linkFromRow);
  }

  /** The applied ado_pipeline_run_create action that queued this Azure DevOps run, if exactly one did. Reads the ledger only. */
  async appliedPipelineRunAction(companyId: string, adoRunId: number): Promise<{ id: string; issueId: string | null; agentId: string; args: Record<string, unknown> } | null> {
    const rows = await this.db.query(`SELECT id,issue_id,agent_id,args_redacted FROM ${NS}.action WHERE company_id=$1 AND tool='ado_pipeline_run_create' AND status='applied' AND result->>'runId'=$2 LIMIT 2`, [companyId, String(adoRunId)]);
    if (rows.length !== 1) return null;
    const r = rows[0]!; const args = r.args_redacted;
    return { id: String(r.id), issueId: r.issue_id == null ? null : String(r.issue_id), agentId: String(r.agent_id), args: args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {} };
  }
  /** One-decision ledger for deploy approvals (design control 8): rows of tool ado_environment_approval_post keyed envapproval:{approvalId}. */
  async envApprovalClaim(r: { id: string; companyId: string; issueId: string; agentId: string; runId: string; key: string; argsHash: string; args: Record<string, unknown>; result: Record<string, unknown>; nowIso: string }): Promise<boolean> {
    return (await this.db.execute(`INSERT INTO ${NS}.action (id,company_id,issue_id,agent_id,run_id,tool,args_hash,args_redacted,risk_class,status,created_at,expires_at,idempotency_key,result) VALUES ($1,$2,$3,$4,$5,'ado_environment_approval_post',$6,$7::jsonb,'W','applying',$8,$9,$10,$11::jsonb) ON CONFLICT (company_id, idempotency_key) DO NOTHING`,
      [r.id, r.companyId, r.issueId, r.agentId, r.runId, r.argsHash, JSON.stringify(r.args), r.nowIso, new Date(Date.parse(r.nowIso) + 365 * 86400_000).toISOString(), r.key, JSON.stringify(r.result)])).rowCount > 0;
  }
  async envApprovalRow(companyId: string, key: string): Promise<{ id: string; status: string; agentId: string; args: Record<string, unknown>; result: Record<string, unknown>; createdAt: string } | null> {
    const rows = await this.db.query(`SELECT id,status,agent_id,args_redacted,result,created_at FROM ${NS}.action WHERE company_id=$1 AND idempotency_key=$2 AND tool='ado_environment_approval_post'`, [companyId, key]);
    const r = rows[0]; if (!r) return null;
    const o = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
    return { id: String(r.id), status: String(r.status), agentId: String(r.agent_id), args: o(r.args_redacted), result: o(r.result), createdAt: iso(r.created_at) ?? '' };
  }
  /** Compare-and-set: moves the row only from one of `from`, and only while args.lease still equals `fence` (a random token that every successful claim or takeover replaces, so it never repeats even within one millisecond). Returns false when another caller got there first. */
  async envApprovalMove(companyId: string, id: string, from: string[], to: { status: string; args?: Record<string, unknown>; result: Record<string, unknown>; nowIso: string; applied?: boolean; agentId?: string; runId?: string }, fence?: string): Promise<boolean> {
    return (await this.db.execute(`UPDATE ${NS}.action SET status=$4, result=$5::jsonb, args_redacted=COALESCE($6::jsonb,args_redacted), created_at=CASE WHEN $4='applying' THEN $7::timestamptz ELSE created_at END, applied_at=CASE WHEN $8 THEN $7::timestamptz ELSE applied_at END, agent_id=COALESCE($9::uuid,agent_id), run_id=COALESCE($10::uuid,run_id) WHERE company_id=$1 AND id=$2 AND status=ANY($3::text[]) AND tool='ado_environment_approval_post' AND ($11::text IS NULL OR COALESCE(args_redacted->>'lease','')=$11::text)`,
      [companyId, id, from, to.status, JSON.stringify(to.result), to.args ? JSON.stringify(to.args) : null, to.nowIso, !!to.applied, to.agentId ?? null, to.runId ?? null, fence ?? null])).rowCount > 0;
  }

  async addReleaseVerdict(v: ReleaseVerdictRow): Promise<void> {
    await this.db.execute(`INSERT INTO ${NS}.release_verdict (id,company_id,release_issue_id,source_commit,image_digest,build_id,fn,agent_id,vote,summary_redacted,run_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [v.id, v.companyId, v.releaseIssueId, v.sourceCommit, v.imageDigest, v.buildId, v.fn, v.agentId, v.vote, v.summaryRedacted, v.runId, v.createdAt]);
  }
  async releaseVerdictsFor(t: ReleaseTuple): Promise<ReleaseVerdictRow[]> {
    const rows = await this.db.query(`SELECT * FROM ${NS}.release_verdict WHERE company_id=$1 AND release_issue_id=$2 AND source_commit=$3 AND image_digest=$4 AND build_id=$5 ORDER BY created_at, id`, [t.companyId, t.releaseIssueId, t.sourceCommit, t.imageDigest, t.buildId]);
    return rows.map(r => ({ id: String(r.id), companyId: String(r.company_id), releaseIssueId: String(r.release_issue_id), sourceCommit: String(r.source_commit), imageDigest: String(r.image_digest), buildId: Number(r.build_id), fn: String(r.fn), agentId: String(r.agent_id), vote: Number(r.vote), summaryRedacted: String(r.summary_redacted), runId: r.run_id == null ? null : String(r.run_id), createdAt: iso(r.created_at) ?? '' }));
  }

  async addVerdict(v: { id: string; companyId: string; org: string; projectId: string; repoId: string; prId: number; commit: string; iteration: number; agentId: string; fn: string; vote: number; runId: string | null; at: string }): Promise<void> {
    await this.db.execute(`INSERT INTO ${NS}.verdict (id,company_id,org,project_id,repo_id,pr_id,commit_id,iteration,agent_id,verdict_function,vote,run_id,at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [v.id, v.companyId, v.org, v.projectId, v.repoId, v.prId, v.commit, v.iteration, v.agentId, v.fn, v.vote, v.runId, v.at]);
  }
  /** Every verdict given on exactly this commit, oldest first. A later row by the same agent replaces an earlier one. */
  async verdictsFor(companyId: string, projectId: string, repoId: string, prId: number, commit: string): Promise<Array<{ agentId: string; fn: string; vote: number; at: string }>> {
    const rows = await this.db.query<{ agent_id: string; verdict_function: string; vote: number; at: Date | string }>(`SELECT agent_id,verdict_function,vote,at FROM ${NS}.verdict WHERE company_id=$1 AND project_id=$2 AND repo_id=$3 AND pr_id=$4 AND commit_id=$5 ORDER BY at, id`, [companyId, projectId, repoId, prId, commit]);
    return rows.map((r) => ({ agentId: r.agent_id, fn: r.verdict_function, vote: Number(r.vote), at: iso(r.at) ?? '' }));
  }
  async addGate(g: { id: string; companyId: string; org: string; projectId: string; repoId: string; prId: number; commit: string; iteration: number; state: 'succeeded' | 'failed'; agentId: string; runId: string | null; evidenceUrl: string; at: string }): Promise<void> {
    await this.db.execute(`INSERT INTO ${NS}.gate (id,company_id,org,project_id,repo_id,pr_id,commit_id,iteration,kind,state,agent_id,run_id,evidence_url,at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staging',$9,$10,$11,$12,$13)`,
      [g.id, g.companyId, g.org, g.projectId, g.repoId, g.prId, g.commit, g.iteration, g.state, g.agentId, g.runId, g.evidenceUrl, g.at]);
  }
  /** The newest staging gate result on exactly this commit, or null. */
  async gateFor(companyId: string, projectId: string, repoId: string, prId: number, commit: string): Promise<{ state: 'succeeded' | 'failed'; agentId: string | null; at: string } | null> {
    const r = (await this.db.query<{ state: 'succeeded' | 'failed'; agent_id: string | null; at: Date | string }>(`SELECT state,agent_id,at FROM ${NS}.gate WHERE company_id=$1 AND project_id=$2 AND repo_id=$3 AND pr_id=$4 AND commit_id=$5 AND kind='staging' ORDER BY at DESC, id DESC LIMIT 1`, [companyId, projectId, repoId, prId, commit]))[0];
    return r ? { state: r.state, agentId: r.agent_id, at: iso(r.at) ?? '' } : null;
  }

  /** True the first time a key is seen for the company. All idempotent side effects go through this. */
  async once(companyId: string, key: string, nowIso: string): Promise<boolean> {
    return (await this.db.execute(`INSERT INTO ${NS}.effect (company_id,effect_key,at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [companyId, key, nowIso])).rowCount > 0;
  }
  async forget(companyId: string, key: string): Promise<void> { await this.db.execute(`DELETE FROM ${NS}.effect WHERE company_id=$1 AND effect_key=$2`, [companyId, key]); }

  async audit(a: { id: string; companyId: string; at: string; agentId?: string | null; runId?: string | null; issueId?: string | null; action: string; target?: unknown; outcome: string; detail?: unknown }): Promise<void> {
    await this.db.execute(`INSERT INTO ${NS}.audit (id,company_id,at,actor_agent_id,run_id,issue_id,action,target,outcome,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)`,
      [a.id, a.companyId, a.at, a.agentId ?? null, a.runId ?? null, a.issueId ?? null, a.action, JSON.stringify(a.target ?? {}), a.outcome, JSON.stringify(a.detail ?? {})]);
  }
  async setConnection(companyId: string, role: string, s: { identityId?: string | null; displayName?: string | null; authKind?: string; ok: boolean; errorCode?: string | null }, nowIso: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${NS}.connection_state (company_id,role,identity_id,display_name,auth_kind,last_ok_at,last_error_code,last_error_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id,role) DO UPDATE SET identity_id=COALESCE(EXCLUDED.identity_id,${NS}.connection_state.identity_id), display_name=COALESCE(EXCLUDED.display_name,${NS}.connection_state.display_name), auth_kind=EXCLUDED.auth_kind,
         last_ok_at=COALESCE(EXCLUDED.last_ok_at,${NS}.connection_state.last_ok_at), last_error_code=EXCLUDED.last_error_code, last_error_at=COALESCE(EXCLUDED.last_error_at,${NS}.connection_state.last_error_at)`,
      [companyId, role, s.identityId ?? null, s.displayName ?? null, s.authKind ?? null, s.ok ? nowIso : null, s.ok ? null : (s.errorCode ?? 'error'), s.ok ? null : nowIso]);
  }
  async connections(companyId: string) {
    return this.db.query<{ role: string; identity_id: string | null; display_name: string | null; auth_kind: string | null; last_ok_at: Date | null; last_error_code: string | null; last_error_at: Date | null }>(`SELECT * FROM ${NS}.connection_state WHERE company_id=$1`, [companyId]);
  }
  async cursor(companyId: string, scope: string, ok: boolean, nowIso: string, error?: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${NS}.reconcile_cursor (company_id,scope,last_run_at,last_ok_at,last_error,consecutive_failures) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id,scope) DO UPDATE SET last_run_at=EXCLUDED.last_run_at, last_ok_at=COALESCE(EXCLUDED.last_ok_at,${NS}.reconcile_cursor.last_ok_at), last_error=EXCLUDED.last_error,
         consecutive_failures=CASE WHEN $7::boolean THEN 0 ELSE ${NS}.reconcile_cursor.consecutive_failures+1 END`,
      [companyId, scope, nowIso, ok ? nowIso : null, ok ? null : (error ?? 'error').slice(0, 300), ok ? 0 : 1, ok]);
  }
  async cursors(companyId: string) { return this.db.query<{ scope: string; last_run_at: Date | null; last_ok_at: Date | null; last_error: string | null; consecutive_failures: number }>(`SELECT scope,last_run_at,last_ok_at,last_error,consecutive_failures FROM ${NS}.reconcile_cursor WHERE company_id=$1`, [companyId]); }
}

export async function prsForBuild(db: Db, companyId: string, projectId: string, sourceBranch: string): Promise<Array<{ repoId: string; prId: number }>> {
  const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(sourceBranch);
  const rows = m
    ? await db.query<{ repo_id: string; pr_id: number }>(`SELECT repo_id, pr_id FROM ${NS}.pull_request WHERE company_id=$1 AND project_id=$2 AND pr_id=$3 AND terminal=false`, [companyId, projectId, Number(m[1])])
    : await db.query<{ repo_id: string; pr_id: number }>(`SELECT repo_id, pr_id FROM ${NS}.pull_request WHERE company_id=$1 AND project_id=$2 AND source_ref=$3 AND terminal=false`, [companyId, projectId, sourceBranch]);
  return rows.map((r) => ({ repoId: r.repo_id, prId: Number(r.pr_id) }));
}

