// The release bundle state machine (design sections 6 and 7). Pure logic over ports: the database (BundleStore), Azure DevOps (BundlePort)
// and the host. Correctness rests on single-statement compare-and-set updates and leases, never on the schedule: two ticks may overlap.
import type { Config } from '../config.ts';
import { validateConfig } from '../config.ts';
import type { Host } from '../host.ts';
import type { Store } from '../store.ts';
import { hashArgs } from '../tools/gate.ts';
import { NS } from '../namespace.ts';
import { BundleStore, OPEN_STATUSES, type BundleRow, type BuildFence } from './store.ts';
import { argsHashOf, configHashOf, expectedParams, parseProvenance, runMismatch, snapshotOf, type ArgsInput, type Kind, type RunFacts } from './model.ts';

/** Everything the engine needs from Azure DevOps. The worker adapter implements it over AdoApi; tests implement it with a scriptable fake. */
export interface BundlePort {
  /** Azure DevOps id of the author identity (the only identity that queues or cancels). */
  authorId(): Promise<string>;
  /** Is the commit still reachable from main, and how many commits is main ahead of it. Throws when unknown (callers fail closed). */
  mainState(commit: string): Promise<{ contains: boolean; behind: number }>;
  /** Queue a run with the author identity on refs/heads/main at the commit. May throw AFTER the run was created. */
  queue(pipelineId: number, commit: string, params: Record<string, string>): Promise<{ id: number }>;
  run(runId: number): Promise<RunFacts | null>;
  listRuns(pipelineId: number, minTimeIso: string): Promise<RunFacts[]>;
  /** Text files of the build artifact `image-provenance`, read with the admin identity. Null when the build published none. */
  provenance(buildId: number): Promise<Record<string, string> | null>;
  /** True only while the run waits at the environment Approval check with no stage started. */
  pendingAtApproval(runId: number): Promise<boolean>;
  cancel(runId: number): Promise<void>;
}

export interface Deps { host: Host; companyId: string; cfg: Config; bundles: BundleStore; store: Store; port: BundlePort }

export const LEASE_MS = 2 * 60_000;
export const LISTING_LAG_MS = 5 * 60_000;
const SKEW_MS = 2 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const short = (c: string | null) => (c ?? '').slice(0, 7);
const same = (a: unknown, b: unknown) => hashArgs(a) === hashArgs(b);

export async function auditBundle(d: Deps, action: string, row: BundleRow, outcome: string, detail: Record<string, unknown> = {}): Promise<void> {
  const write = (a: string, o: string, x: Record<string, unknown>) => d.store.audit({ id: d.host.uuid(), companyId: d.companyId, at: iso(d.host.now()), agentId: null, runId: null, issueId: row.issueId, action: a, target: { bundleId: row.id, projectId: row.projectId, commit: short(row.sourceCommit) }, outcome: o, detail: x }).catch(() => {});
  await write(action, outcome, detail);
  // Repeated refusals for one proposer in a day are an alert for the board (design S13).
  if (action === 'bundle_refused') {
    try {
      const n = Number((await d.store.db.query<{ n: string }>(`SELECT count(*)::text n FROM ${NS}.audit WHERE company_id=$1 AND action='bundle_refused' AND at >= $2::timestamptz`, [d.companyId, iso(d.host.now() - 24 * 3600_000)]))[0]?.n ?? 0);
      if (n >= 3 && await d.store.once(d.companyId, `bundle:abuse:${new Date(d.host.now()).toISOString().slice(0, 13)}`, iso(d.host.now()))) await write('bundle_abuse_alert', 'repeated_refusals', { refusals24h: n });
    } catch { /* an alert never blocks */ }
  }
}
async function say(d: Deps, row: BundleRow, event: string, text: string): Promise<void> {
  try { if (await d.store.once(d.companyId, `bundle:${row.id}:say:${event}`, iso(d.host.now()))) await d.host.issues.comment(d.companyId, row.issueId, text); } catch { /* a comment never blocks a step */ }
}

export const argsInputOf = (row: BundleRow): ArgsInput => ({ companyId: row.companyId, projectId: row.projectId, issueId: row.issueId, proposerAgentId: row.proposerAgentId, sourceCommit: row.sourceCommit, branch: row.branch, buildPipelineId: row.buildPipelineId, deployPipelineId: row.deployPipelineId, ttlMinutes: Number(row.configSnapshot.ttlMinutes), configHash: row.configHash, reason: row.reason });

/** One tick for one company: every open bundle, each in its own try/catch. */
export async function tickCompany(d: Deps): Promise<number> {
  let n = 0;
  for (const row of await d.bundles.open(d.companyId)) {
    try { await processRow(d, row); n++; }
    catch (e) { d.host.log.warn('release bundle step failed', { bundle: row.id, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
  }
  return n;
}

export async function processRow(d: Deps, row: BundleRow): Promise<void> {
  if (row.status === 'awaiting_confirmation') return awaiting(d, row);
  const rb = d.cfg.platformAdmin.deployApproval.releaseBundle;
  const nowMs = d.host.now();
  let stop: { to: 'expired'; reason: string; refused: boolean } | null = null;
  if (!rb.enabled || !validateConfig(d.cfg).ok) stop = { to: 'expired', reason: 'flag_off', refused: false };
  else {
    const snap = snapshotOf(d.cfg);
    if (configHashOf(snap) !== row.configHash || !same(snap, row.configSnapshot)) stop = { to: 'expired', reason: 'config_changed', refused: true };
    else if (argsHashOf(argsInputOf(row)) !== row.argsHash) stop = { to: 'expired', reason: 'args_hash_mismatch', refused: true };
    else if (Date.parse(row.expiresAt) <= nowMs) stop = { to: 'expired', reason: 'window_ended', refused: false };
  }
  if (row.status === 'deploying') return deploying(d, row, stop);
  if (stop) {
    if (await d.bundles.finish(d.companyId, row.id, ['active', 'building', 'built'], stop.to, iso(nowMs), { reason: stop.reason })) {
      await auditBundle(d, stop.refused ? 'bundle_refused' : 'bundle_expired', row, stop.reason);
      await say(d, row, 'ended', `The release bundle for ${short(row.sourceCommit)} ended without finishing: ${stop.reason.replace(/_/g, ' ')}. Nothing further will start from it.`);
    }
    return;
  }
  if (row.status === 'active') return buildStep(d, row);
  if (row.status === 'building') return row.buildId == null ? recoverBuild(d, row) : pollBuild(d, row);
  if (row.status === 'built') return deployStep(d, row);
}

// ---------------------------------------------------------------- proposal and accept
async function awaiting(d: Deps, row: BundleRow): Promise<void> {
  const rb = d.cfg.platformAdmin.deployApproval.releaseBundle; const nowMs = d.host.now();
  const end = async (to: 'rejected' | 'expired', why: string) => { if (await d.bundles.endProposal(d.companyId, row.id, to, iso(nowMs), why)) await auditBundle(d, to === 'rejected' ? 'bundle_rejected' : 'bundle_expired', row, why); };
  const issue = await d.host.issues.get(d.companyId, row.issueId);
  if (!issue || issue.status === 'done' || issue.status === 'cancelled') return end('expired', 'issue_closed');
  const inter = row.interactionId ? await d.host.issues.interaction(d.companyId, row.issueId, row.interactionId) : null;
  if (inter?.outcome === 'rejected') return end('rejected', 'card_rejected');
  if (inter?.outcome !== 'accepted') {
    if (inter && inter.status !== 'pending' && inter.outcome) return end('expired', `card_${inter.outcome}`);
    if (Date.parse(row.expiresAt) <= nowMs) return end('expired', 'proposal_ttl');
    return;
  }
  // Accepted: a user principal in approverUserIds, an unchanged row, and one compare-and-set.
  const bad = async (why: string) => { if (await d.bundles.endProposal(d.companyId, row.id, 'rejected', iso(nowMs), why)) await auditBundle(d, 'bundle_refused', row, why); };
  if (!inter.resolvedByUserId || inter.resolvedByAgentId) return bad('accepted_by_agent');
  if (!rb.approverUserIds.some((u) => u.toLowerCase() === inter.resolvedByUserId!.toLowerCase())) return bad('approver_not_listed');
  const snap = snapshotOf(d.cfg);
  if (configHashOf(snap) !== row.configHash || !same(snap, row.configSnapshot)) return bad('config_changed');
  const h = argsHashOf(argsInputOf(row));
  if (h !== row.argsHash) return bad('args_hash_mismatch');
  if (!rb.enabled) return bad('flag_off');
  if (await d.bundles.approve(d.companyId, row.id, inter.resolvedByUserId, iso(nowMs), Number(row.configSnapshot.ttlMinutes), h)) {
    await auditBundle(d, 'bundle_approved', row, 'approved', { by: inter.resolvedByUserId, ttlMinutes: row.configSnapshot.ttlMinutes });
    await say(d, row, 'approved', `The release bundle for ${short(row.sourceCommit)} was approved. The plugin now builds with pipeline ${row.buildPipelineId} and then deploys with pipeline ${row.deployPipelineId}. The window ends ${rb.ttlMinutes} minutes after approval.`);
  } else { await auditBundle(d, 'bundle_refused', row, 'late_or_tampered_accept'); await end('expired', 'late_accept'); }
}

// ---------------------------------------------------------------- queueing helpers
async function ensureLedger(d: Deps, row: BundleRow, kind: Kind, runId: number, params: Record<string, string>): Promise<void> {
  const key = kind === 'build' ? `bundle:${row.id}:build:${row.buildAttempts}` : `bundle:${row.id}:deploy`;
  if (await d.bundles.ledgerExists(d.companyId, key)) return;
  const pipelineId = kind === 'build' ? row.buildPipelineId : row.deployPipelineId;
  const args = { source: 'release_bundle', bundleId: row.id, pipelineId, projectId: row.projectId, commit: row.sourceCommit, parameters: params };
  await d.bundles.ledgerRun({ id: d.host.uuid(), companyId: d.companyId, issueId: row.issueId, agentId: row.proposerAgentId, key, argsHash: hashArgs(args), args, runId, nowIso: iso(d.host.now()), expiresIso: row.expiresAt });
}
const paramsFor = (d: Deps, row: BundleRow, kind: Kind): Record<string, string> => expectedParams(kind, { imageRepository: String(row.configSnapshot.imageRepository), digest: row.imageDigest, commit: row.sourceCommit, buildId: row.buildId });

async function claimStep(d: Deps, row: BundleRow, from: 'active' | 'built', to: 'building' | 'deploying'): Promise<BundleRow | null> {
  const nowMs = d.host.now();
  const ok = await d.bundles.claim({ companyId: d.companyId, id: row.id, from, to, lease: d.host.uuid(), leaseExpiresIso: iso(nowMs + LEASE_MS), nowIso: iso(nowMs), argsHash: row.argsHash, configHash: configHashOf(snapshotOf(d.cfg)), buildAttempt: to === 'building', maxAttempts: to === 'building' ? Number(row.configSnapshot.maxBuildAttempts) : undefined });
  return ok ? d.bundles.get(d.companyId, row.id) : null;
}
async function refuse(d: Deps, row: BundleRow, from: Array<BundleRow['status']>, why: string, detail: Record<string, unknown> = {}, fence?: BuildFence, deployUnrecorded = false): Promise<void> {
  if (await d.bundles.finish(d.companyId, row.id, from, 'failed', iso(d.host.now()), { reason: why, result: { ...row.result, failure: why, ...detail }, fence, deployUnrecorded })) {
    await auditBundle(d, 'bundle_step_failed', row, why, detail);
    await say(d, row, 'failed', `The release bundle for ${short(row.sourceCommit)} failed: ${why.replace(/_/g, ' ')}. A person has to decide what happens next.`);
  }
}
async function commitStillInMain(d: Deps, row: BundleRow): Promise<boolean> {
  try { return (await d.port.mainState(row.sourceCommit)).contains; } catch { return false; }
}

/** Queue, then read back. A thrown queue call leaves the row claimed: recovery decides after the lease. */
async function queueAndVerify(d: Deps, row: BundleRow, kind: Kind): Promise<RunFacts | null> {
  const pipelineId = kind === 'build' ? row.buildPipelineId : row.deployPipelineId;
  const params = paramsFor(d, row, kind);
  const authorId = await d.port.authorId();
  await auditBundle(d, 'bundle_step_started', row, kind, { pipelineId, attempt: row.buildAttempts });
  // Last guard before the external side effect: the awaits above may have outlived the lease or the approval window.
  const holding = kind === 'build' ? 'building' : 'deploying';
  if (!row.lease || !(await d.bundles.stillOwned(d.companyId, row.id, holding, row.lease, row.argsHash, iso(d.host.now())))) {
    if (Date.parse(row.expiresAt) <= d.host.now() && await d.bundles.finish(d.companyId, row.id, [holding], 'expired', iso(d.host.now()), { reason: 'window_ended_before_queue' })) {
      await auditBundle(d, 'bundle_expired', row, 'window_ended_before_queue', { kind });
    }
    return null;
  }
  let queued: { id: number };
  try { queued = await d.port.queue(pipelineId, row.sourceCommit, params); }
  catch (e) { await auditBundle(d, 'bundle_step_failed', row, `${kind}_queue_unconfirmed`, { error: String((e as Error)?.message ?? e).slice(0, 160) }); return null; }
  const run = await d.port.run(queued.id).catch(() => null);
  const bad = run ? runMismatch(run, { pipelineId, commit: row.sourceCommit, authorId, params }) : 'unreadable';
  const record = kind === 'build' ? d.bundles.recordBuildRun(d.companyId, row.id, queued.id, { attempt: row.buildAttempts, lease: row.lease }) : d.bundles.recordDeployRun(d.companyId, row.id, queued.id, { lease: row.lease });
  if (!(await record)) return null;
  const fresh = { ...((await d.bundles.get(d.companyId, row.id)) ?? row), buildAttempts: row.buildAttempts };
  await ensureLedger(d, fresh, kind, queued.id, params);
  if (bad) { await refuse(d, fresh, [kind === 'build' ? 'building' : 'deploying'], `readback_${bad}`, { runId: queued.id }, kind === 'build' ? { attempt: row.buildAttempts, buildId: queued.id } : undefined); return null; }
  return run;
}

// ---------------------------------------------------------------- step 1: build
async function buildStep(d: Deps, row: BundleRow): Promise<void> {
  if (!(await commitStillInMain(d, row))) return refuse(d, row, ['active'], 'commit_not_in_main');
  const claimed = await claimStep(d, row, 'active', 'building'); if (!claimed) return;
  const run = await queueAndVerify(d, claimed, 'build');
  if (run) await say(d, claimed, `build:${claimed.buildAttempts}`, `Build run ${run.id} of pipeline ${claimed.buildPipelineId} was queued for ${short(claimed.sourceCommit)} (attempt ${claimed.buildAttempts}).`);
}

async function recoverBuild(d: Deps, row: BundleRow): Promise<void> {
  const nowMs = d.host.now();
  if (row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) > nowMs) return; // another worker is inside the call
  const found = await matching(d, row, 'build');
  if (found.length === 1) {
    if (await d.bundles.recordBuildRun(d.companyId, row.id, found[0]!.id, { attempt: row.buildAttempts })) { await ensureLedger(d, row, 'build', found[0]!.id, paramsFor(d, row, 'build')); await auditBundle(d, 'bundle_step_started', row, 'build_adopted', { runId: found[0]!.id }); }
    return;
  }
  if (found.length > 1) return refuse(d, row, ['building'], 'ambiguous_build_runs', { candidates: found.map((r) => r.id).slice(0, 5) }, { attempt: row.buildAttempts, buildId: null });
  if (nowMs < Date.parse(row.stepStartedAt ?? row.createdAt) + LISTING_LAG_MS) return; // listing lag: do not decide yet
  if (row.buildAttempts >= Number(row.configSnapshot.maxBuildAttempts)) return refuse(d, row, ['building'], 'build_never_started', {}, { attempt: row.buildAttempts, buildId: null });
  await d.bundles.retryBuild(d.companyId, row.id, { ...row.result, lastAttempt: 'no_run_found' }, { attempt: row.buildAttempts, buildId: null }); // back to active; the normal step queues again and counts the attempt
}

async function matching(d: Deps, row: BundleRow, kind: Kind): Promise<RunFacts[]> {
  const pipelineId = kind === 'build' ? row.buildPipelineId : row.deployPipelineId;
  const authorId = await d.port.authorId();
  const since = iso(Date.parse(row.stepStartedAt ?? row.createdAt) - SKEW_MS);
  const params = paramsFor(d, row, kind);
  return (await d.port.listRuns(pipelineId, since)).filter((r) => runMismatch(r, { pipelineId, commit: row.sourceCommit, authorId, params }) === null);
}

async function pollBuild(d: Deps, row: BundleRow): Promise<void> {
  const fence: BuildFence = { attempt: row.buildAttempts, buildId: row.buildId };
  await ensureLedger(d, row, 'build', row.buildId!, paramsFor(d, row, 'build')); // repairs a crash between the bundle update and the ledger row
  const run = await d.port.run(row.buildId!).catch(() => null);
  if (!run || run.status !== 'completed') return;
  const attempts = Array.isArray(row.result.attempts) ? [...row.result.attempts as unknown[]] : [];
  if (run.result !== 'succeeded') {
    attempts.push({ buildId: row.buildId, result: run.result, requestedFor: run.requestedForId });
    const res = { ...row.result, attempts };
    await auditBundle(d, 'bundle_step_failed', row, `build_${run.result}`, { buildId: row.buildId });
    if (row.buildAttempts < Number(row.configSnapshot.maxBuildAttempts) && Date.parse(row.expiresAt) > d.host.now()) await d.bundles.retryBuild(d.companyId, row.id, res, fence);
    else await refuse(d, row, ['building'], 'build_failed', { attempts }, fence);
    return;
  }
  if (run.definitionId !== row.buildPipelineId || run.sourceVersion !== row.sourceCommit || run.sourceBranch !== 'refs/heads/main') return refuse(d, row, ['building'], 'build_facts_mismatch', {}, fence);
  const files = await d.port.provenance(row.buildId!).catch(() => null);
  if (!files) return refuse(d, row, ['building'], 'artifact_missing', {}, fence);
  const p = parseProvenance(files, { imageRepository: String(row.configSnapshot.imageRepository), commit: row.sourceCommit, buildId: row.buildId! });
  if (!p.ok) return refuse(d, row, ['building'], `artifact_${p.reason}`, {}, fence);
  attempts.push({ buildId: row.buildId, result: 'succeeded', requestedFor: run.requestedForId });
  if (await d.bundles.pinDigest(d.companyId, row.id, p.digest, iso(d.host.now()), { ...row.result, attempts }, fence)) {
    await auditBundle(d, 'bundle_digest_pinned', row, 'pinned', { digest: p.digest.slice(0, 19), buildId: row.buildId });
    await say(d, row, 'pinned', `Build ${row.buildId} succeeded. Pinned tuple: commit ${row.sourceCommit}, image ${p.imageReference}, build ${row.buildId}. Deploy follows next.`);
  }
}

// ---------------------------------------------------------------- step 2: deploy
async function deployStep(d: Deps, row: BundleRow): Promise<void> {
  if (!row.imageDigest || row.buildId == null) return refuse(d, row, ['built'], 'no_pinned_digest');
  if (!(await commitStillInMain(d, row))) return refuse(d, row, ['built'], 'commit_not_in_main');
  const claimed = await claimStep(d, row, 'built', 'deploying'); if (!claimed) return;
  const run = await queueAndVerify(d, claimed, 'deploy');
  if (run) await say(d, claimed, 'deploy', `Deploy run ${run.id} of pipeline ${claimed.deployPipelineId} was queued with the pinned tuple: commit ${claimed.sourceCommit}, image ${String(claimed.configSnapshot.imageRepository)}@${claimed.imageDigest}, build ${claimed.buildId}. It now waits for the staging environment approval. TechLead, QA and Security: attest this exact tuple (verify the digest in Harbor).`);
}

async function deploying(d: Deps, row: BundleRow, stop: { to: 'expired'; reason: string; refused: boolean } | null): Promise<void> {
  const nowMs = d.host.now();
  if (row.deployRunId == null) {
    if (row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) > nowMs) return;
    const found = await matching(d, row, 'deploy');
    if (found.length === 1) { if (await d.bundles.recordDeployRun(d.companyId, row.id, found[0]!.id)) { await ensureLedger(d, row, 'deploy', found[0]!.id, paramsFor(d, row, 'deploy')); await auditBundle(d, 'bundle_step_started', row, 'deploy_adopted', { runId: found[0]!.id }); } return; }
    // Zero or many matches: one deploy attempt, never queued again.
    return refuse(d, row, ['deploying'], found.length ? 'ambiguous_deploy_runs' : 'deploy_run_not_found', { candidates: found.map((r) => r.id).slice(0, 5) }, undefined, true);
  }
  await ensureLedger(d, row, 'deploy', row.deployRunId, paramsFor(d, row, 'deploy'));
  const run = await d.port.run(row.deployRunId).catch(() => null);
  if (!run) return;
  if (row.result.cancel && run.status === 'completed') { await settleCancel(d, row.id); return; }
  if (row.result.cancel && !(row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) > nowMs)) {
    // Cancellation was requested earlier but the run is not completed. Retry while it still waits at the approval; drop the intent once it is approved and running.
    const c = row.result.cancel as { to?: string; reason?: string; by?: string };
    if (await d.port.pendingAtApproval(run.id).catch(() => false)) await cancelIfPending(d, row, run.id, c.to === 'revoked' ? 'revoked' : 'expired', c.reason ?? 'cancel_retry', c.by);
    else if (await d.bundles.dropCancel(d.companyId, row.id)) await auditBundle(d, 'bundle_cancel_requested', row, 'dropped_run_started', { runId: run.id });
    return;
  }
  if (run.status === 'completed') {
    const ok = run.result === 'succeeded';
    if (await d.bundles.finish(d.companyId, row.id, ['deploying'], ok ? 'completed' : 'failed', iso(nowMs), { result: { ...row.result, deploy: { runId: run.id, result: run.result } } })) {
      await auditBundle(d, ok ? 'bundle_step_started' : 'bundle_step_failed', row, ok ? 'deploy_completed' : `deploy_${run.result}`, { runId: run.id });
      await say(d, row, 'done', `Deploy run ${run.id} ended: ${run.result}. The release bundle for ${short(row.sourceCommit)} is ${ok ? 'completed' : 'failed'}.`);
    }
    return;
  }
  if (stop) await cancelIfPending(d, row, run.id, stop.to, stop.reason);
}

/**
 * Cancel a deploy run that still waits at the environment approval. The bundle stays `deploying` (one-open-bundle protection holds) until the
 * run is READ BACK as completed. The intent is durable (result.cancel) and the cancel call runs under the lease, so overlapping callers do not both cancel
 * and a later tick retries. Returns true only when the bundle was closed.
 */
async function cancelIfPending(d: Deps, row: BundleRow, runId: number, to: 'expired' | 'revoked', reason: string, by?: string): Promise<boolean> {
  if (!(await d.port.pendingAtApproval(runId).catch(() => false))) return false; // already approved and running: the plugin never cancels a running deployment
  const nowMs = d.host.now();
  if (!(await d.bundles.beginCancel(d.companyId, row.id, runId, { to, reason: reason.slice(0, 200), ...(by ? { by } : {}), at: iso(nowMs) }, d.host.uuid(), iso(nowMs + LEASE_MS), iso(nowMs)))) return false;
  await auditBundle(d, 'bundle_cancel_requested', row, reason, { runId });
  await d.port.cancel(runId).catch(() => {});
  return settleCancel(d, row.id);
}

/** Read the run back; close the bundle only when it is really completed. Uses the stored intent, so a retry by a later tick ends the same way. */
async function settleCancel(d: Deps, id: string): Promise<boolean> {
  const row = await d.bundles.get(d.companyId, id);
  const intent = row?.result.cancel as { to?: string; reason?: string; by?: string } | undefined;
  if (!row || row.status !== 'deploying' || row.deployRunId == null || !intent) return false;
  const run = await d.port.run(row.deployRunId).catch(() => null);
  if (!run || run.status !== 'completed') return false;
  const to = intent.to === 'revoked' ? 'revoked' : 'expired';
  const cancelled = /^cancel/.test(run.result ?? '');
  const ok = await d.bundles.finish(d.companyId, row.id, ['deploying'], cancelled ? to : (run.result === 'succeeded' ? 'completed' : 'failed'), iso(d.host.now()), { reason: intent.reason, ...(intent.by ? { by: intent.by } : {}), result: { ...row.result, deploy: { runId: run.id, result: run.result } } });
  if (ok) {
    if (cancelled && to === 'revoked') await auditBundle(d, 'bundle_revoked', row, 'revoked', { by: intent.by, reason: intent.reason, runId: run.id });
    await say(d, row, 'ended', `The release bundle for ${short(row.sourceCommit)} ended (${String(intent.reason ?? '').replace(/_/g, ' ')}). Deploy run ${run.id} ${cancelled ? 'was still waiting for the environment approval and was cancelled' : `ended on its own: ${run.result}`}.`);
  }
  return ok && cancelled;
}

/** Revoke from any open state. Narrowing only: from `deploying` it cancels a run that still waits at the approval, and leaves a running one alone. */
export async function revokeBundle(d: Deps, row: BundleRow, by: string, reason: string): Promise<{ revoked: boolean; note: string }> {
  if (!OPEN_STATUSES.includes(row.status)) return { revoked: false, note: `The bundle is already ${row.status}.` };
  if (row.status !== 'deploying') {
    const ok = await d.bundles.finish(d.companyId, row.id, ['awaiting_confirmation', 'active', 'building', 'built'], 'revoked', iso(d.host.now()), { by, reason });
    if (ok) await auditBundle(d, 'bundle_revoked', row, 'revoked', { by, reason: reason.slice(0, 200) });
    return ok ? { revoked: true, note: 'Revoked. No further step starts. A step claimed in the same second may still start.' } : { revoked: false, note: 'The state changed; read the bundle and try again.' };
  }
  if (row.deployRunId == null) return { revoked: false, note: 'The deploy run is being queued; try again in a few minutes.' };
  const run = await d.port.run(row.deployRunId).catch(() => null);
  if (run?.status === 'completed') return { revoked: false, note: 'The deploy run already ended.' };
  const done = await cancelIfPending(d, row, row.deployRunId, 'revoked', reason, by);
  if (!done && (await d.bundles.get(d.companyId, row.id))?.result.cancel) return { revoked: false, note: 'Cancellation was requested. The bundle stays open until the run is confirmed cancelled; the job retries it.' };
  return done ? { revoked: true, note: 'Revoked. The deploy run was waiting for the environment approval and was cancelled.' } : { revoked: false, note: 'The deploy run is already approved and running. The plugin never cancels a running deployment; it will finish.' };
}
