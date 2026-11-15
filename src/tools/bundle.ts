// Tools of the staging release bundle (design section 5). The agent chooses a commit and a reason; everything else is read live or comes from config.
import { randomUUID } from 'node:crypto';
import type { Service } from '../service.ts';
import { neutralize } from '../sanitize.ts';
import { audit, ToolError, type RunCtx, type ToolOut } from './common.ts';
import { BRANCH, argsHashOf, configHashOf, snapshotOf, SHA } from '../bundle/model.ts';
import { BundleStore, OPEN_STATUSES, type BundleRow } from '../bundle/store.ts';
import { auditBundle, revokeBundle } from '../bundle/engine.ts';
import { bundleDeps, readCommitFacts, strictlyAfter, type CommitFacts } from '../bundle/adapter.ts';

/** Seam for tests: the live Azure DevOps reads and the engine dependencies. */
export const hooks = { readCommitFacts, strictlyAfter, bundleDeps };

const KEY = /^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/;
const COOLDOWN_MS = 30_000;
const DAY_MS = 24 * 3600_000;

export function view(b: BundleRow, nowMs: number) {
  const left = Math.max(0, Math.floor((Date.parse(b.expiresAt) - nowMs) / 60_000));
  return {
    bundleId: b.id, status: b.status, commit: b.sourceCommit, buildPipelineId: b.buildPipelineId, deployPipelineId: b.deployPipelineId, expiresAt: b.expiresAt, minutesLeft: OPEN_STATUSES.includes(b.status) ? left : 0,
    approvedAt: b.approvedAt, buildAttempts: b.buildAttempts, buildId: b.buildId, imageDigest: b.imageDigest, deployRunId: b.deployRunId,
    pinnedTuple: b.imageDigest ? { commit: b.sourceCommit, imageReference: `${String(b.configSnapshot.imageRepository)}@${b.imageDigest}`, buildId: b.buildId } : null,
    result: b.result, revokedAt: b.revokedAt, revokeReason: b.revokeReason ? neutralize(b.revokeReason) : null,
  };
}

export function makeBundleTools(svc: Service) {
  const { host } = svc;
  const nowIso = () => new Date(host.now()).toISOString();
  const bundlesOf = () => new BundleStore(host.db);
  const strict = (a: Record<string, unknown>, keys: string[]) => { if (Object.keys(a).some((k) => !keys.includes(k))) throw new ToolError('bad_request', `Unknown argument. Allowed: ${keys.join(', ')}`); };

  async function create(a: Record<string, unknown>, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId); const rb = cfg.platformAdmin.deployApproval.releaseBundle;
    let issueId: string | null = null;
    try {
      if (!rb.enabled) throw new ToolError('not_enabled', 'Release bundles are switched off in the plugin settings');
      strict(a, ['releaseIssue', 'commit', 'reason']);
      if (typeof a.releaseIssue !== 'string' || !KEY.test(a.releaseIssue)) throw new ToolError('bad_request', 'releaseIssue must be an issue identifier such as ENG-12');
      if (typeof a.commit !== 'string' || !/^[0-9a-fA-F]{40}$/.test(a.commit)) throw new ToolError('bad_request', 'commit must be the full 40 character commit id');
      const reason = neutralize(String(a.reason ?? '').trim().slice(0, 500)); if (!reason) throw new ToolError('bad_request', 'reason is required');
      const commit = a.commit.toLowerCase();
      const issue = await host.issues.findByIdentifier(run.companyId, a.releaseIssue);
      if (!issue) throw new ToolError('release_not_found', 'The release issue was not found');
      issueId = issue.id;
      if (issue.status !== 'in_progress' || (issue.assigneeAgentId ?? '').toLowerCase() !== run.agentId.toLowerCase()) throw new ToolError('issue_not_yours', 'The release issue must be assigned to you and in progress');
      try { if ((await host.issues.blockers(run.companyId, issue.id)).some((b) => b.status !== 'done')) throw new ToolError('release_blocked', 'The release issue has unresolved blockers'); }
      catch (e) { if (e instanceof ToolError) throw e; throw new ToolError('release_blocked', 'The release issue blockers could not be read'); }
      const store = bundlesOf();
      const open = await store.openFor(run.companyId, rb.projectId.toLowerCase());
      if (open) {
        if (open.sourceCommit === commit && open.proposerAgentId.toLowerCase() === run.agentId.toLowerCase()) return { content: `This bundle is already open (${open.status}).`, data: view(open, host.now()) };
        throw new ToolError('bundle_open', `Another release bundle is open for this project (${open.status}). Wait for it to end or ask for it to be revoked.`);
      }
      if (await store.pendingFor(run.companyId, run.agentId)) throw new ToolError('bundle_pending', 'You already have a bundle waiting for a person');
      if (await store.proposalsSince(run.companyId, run.agentId, new Date(host.now() - DAY_MS).toISOString()) >= rb.maxProposalsPerAgentPerDay) throw new ToolError('daily_cap', 'The daily proposal limit is reached');
      const rej = await store.lastRejectedAt(run.companyId, run.agentId);
      if (rej && host.now() - Date.parse(rej) < COOLDOWN_MS) throw new ToolError('recently_rejected', 'A person rejected a bundle a moment ago. Do not propose again unless something changed; ask on the issue first.');
      if (await store.completedCommit(run.companyId, rb.projectId.toLowerCase(), commit)) throw new ToolError('already_released', 'This commit already has a completed bundle. Use the normal per-run cards to redeploy it.');
      const last = await store.lastCompleted(run.companyId, rb.projectId.toLowerCase());
      let facts: CommitFacts;
      try { facts = await hooks.readCommitFacts(svc, run.companyId, cfg, commit, last?.sourceCommit ?? null); }
      catch { throw new ToolError('commit_unreadable', 'The commit could not be read from Azure DevOps'); }
      if (!facts.inMain) throw new ToolError('commit_not_in_main', 'The commit is not part of main');
      if (!facts.tip) {
        if (!facts.pr) throw new ToolError('commit_not_allowed', 'The commit is neither the tip of main nor the merge commit of a completed pull request');
        if (facts.behind > rb.maxCommitsBehind) throw new ToolError('commit_too_old', `The commit is ${facts.behind} commits behind main; the limit is ${rb.maxCommitsBehind}`);
      }
      if (last && !(await hooks.strictlyAfter(svc, run.companyId, cfg, last.sourceCommit, commit).catch(() => false))) throw new ToolError('rollback_refused', 'The commit must come after the last completed bundle. Use the normal per-run cards to redeploy or roll back.');

      const snap = snapshotOf(cfg); const configHash = configHashOf(snap); const id = randomUUID(); const now = nowIso();
      const argsHash = argsHashOf({ companyId: run.companyId, projectId: rb.projectId.toLowerCase(), issueId: issue.id, proposerAgentId: run.agentId.toLowerCase(), sourceCommit: commit, branch: BRANCH, buildPipelineId: rb.buildPipelineId, deployPipelineId: rb.deployPipelineId, ttlMinutes: rb.ttlMinutes, configHash, reason });
      const ok = await store.insert({ id, companyId: run.companyId, issueId: issue.id, projectId: rb.projectId.toLowerCase(), proposerAgentId: run.agentId.toLowerCase(), sourceCommit: commit, buildPipelineId: rb.buildPipelineId, deployPipelineId: rb.deployPipelineId,
        configSnapshot: snap, configHash, argsHash, reason, commitFacts: { ...facts }, createdAt: now, expiresAt: new Date(host.now() + rb.proposalTtlMinutes * 60_000).toISOString() }).catch(() => false);
      if (!ok) throw new ToolError('bundle_open', 'Another release bundle was opened at the same time');
      const details = [
        `**Commit** \`${commit}\` on \`main\` only. Subject: ${facts.subject || 'unknown'}. Author: ${facts.author || 'unknown'}.`,
        `**Pull request:** ${facts.pr ? `!${facts.pr.id} ${facts.pr.url ?? ''}` : 'none linked (tip of main)'}. **Size:** ${facts.changedFiles === null ? 'unknown' : `${facts.changedFiles} changed files`} against ${facts.comparedTo ? `the commit last deployed by a bundle (\`${facts.comparedTo.slice(0, 7)}\`)` : 'unknown (no earlier bundle)'}. Lines: not available.`,
        `**What happens after you accept:** the plugin runs pipeline ${rb.buildPipelineId} (build) on this commit, at most ${rb.maxBuildAttempts} times, then pipeline ${rb.deployPipelineId} (deploy) once, with the image digest that the build published. Fixed parameters: imageReference, sourceCommit, buildId.`,
        `**Staging only, never production.** The deploy still waits for the staging environment approval and the three attestations.`,
        `**Time limit:** ${rb.ttlMinutes} minutes after you accept. A deploy run that is still waiting at the environment approval is cancelled when the time ends.`,
        `**Revoke:** any time, with ado_release_bundle_revoke_apply or from the plugin page.`,
        `Reason (from ${run.agentId.slice(0, 8)}, untrusted text): ${reason}`,
        `Bundle \`${id}\`, check code \`${argsHash.slice(0, 12)}\`.`,
      ].join('\n\n');
      let cardId: string;
      try { cardId = (await host.issues.requestConfirmation(run.companyId, issue.id, { prompt: `Run the staging release of ${commit.slice(0, 7)} (build ${rb.buildPipelineId}, deploy ${rb.deployPipelineId})?`, detailsMarkdown: details, acceptLabel: 'Approve staging release', rejectLabel: 'Reject', idempotencyKey: `bundle:${id}:${argsHash}`, humanOnly: true })).id; }
      catch (e) { await store.endProposal(run.companyId, id, 'expired', nowIso(), 'card_failed'); throw e; }
      await store.setInteraction(run.companyId, id, cardId);
      await audit(svc, host, run, 'ado_release_bundle_create', { bundleId: id, commit: commit.slice(0, 7) }, 'proposed', issue.id);
      const row = (await store.get(run.companyId, id))!;
      await auditBundle({ host, companyId: run.companyId, cfg, bundles: store, store: svc.store, port: null as never }, 'bundle_proposed', row, 'proposed', { proposer: run.agentId });
      return { content: `Bundle proposed. A person decides on the card on ${a.releaseIssue}; you will be woken on the issue. Do not run pipelines ${rb.buildPipelineId} or ${rb.deployPipelineId} yourself: the plugin does.`, data: view(row, host.now()) };
    } catch (e) {
      if (e instanceof ToolError) await audit(svc, host, run, 'ado_release_bundle_create', {}, `refused:${e.code}`, issueId);
      throw e;
    }
  }

  async function get(a: Record<string, unknown>, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId); if (!cfg.platformAdmin.deployApproval.releaseBundle.enabled) throw new ToolError('not_enabled', 'Release bundles are switched off in the plugin settings');
    strict(a, ['bundleId', 'releaseIssue']);
    const store = bundlesOf(); let b: BundleRow | null = null;
    if (typeof a.bundleId === 'string' && /^[0-9a-f-]{36}$/i.test(a.bundleId)) b = await store.get(run.companyId, a.bundleId.toLowerCase());
    else if (typeof a.releaseIssue === 'string' && KEY.test(a.releaseIssue)) { const i = await host.issues.findByIdentifier(run.companyId, a.releaseIssue); if (i) b = await store.latestForIssue(run.companyId, i.id); }
    else throw new ToolError('bad_request', 'Give bundleId or releaseIssue');
    if (!b) throw new ToolError('not_found', 'No such release bundle');
    return { content: `Bundle ${b.status}.`, data: view(b, host.now()) };
  }

  async function revoke(a: Record<string, unknown>, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId); if (!cfg.platformAdmin.deployApproval.releaseBundle.enabled) throw new ToolError('not_enabled', 'Release bundles are switched off in the plugin settings');
    strict(a, ['bundleId', 'reason']);
    if (typeof a.bundleId !== 'string' || !/^[0-9a-f-]{36}$/i.test(a.bundleId)) throw new ToolError('bad_request', 'bundleId is required');
    const reason = neutralize(String(a.reason ?? '').trim().slice(0, 300)); if (!reason) throw new ToolError('bad_request', 'reason is required');
    const store = bundlesOf(); const b = await store.get(run.companyId, a.bundleId.toLowerCase());
    if (!b) throw new ToolError('not_found', 'No such release bundle');
    const out = await revokeBundle(hooks.bundleDeps(svc, run.companyId, cfg), b, `agent:${run.agentId}`, reason);
    await audit(svc, host, run, 'ado_release_bundle_revoke_apply', { bundleId: b.id }, out.revoked ? 'revoked' : 'not_revoked', b.issueId, { note: out.note });
    return { content: out.note, data: { revoked: out.revoked, ...view((await store.get(run.companyId, b.id)) ?? b, host.now()) } };
  }

  return { ado_release_bundle_create: create, ado_release_bundle_get: get, ado_release_bundle_revoke_apply: revoke };
}
