// Core behaviour: fetch and persist ADO objects, discover links, turn changes into issue effects. No SDK imports: everything host
// related goes through the Host port so the same code runs in the worker and in tests.
import { AdoApi } from './ado/api.ts';
import { AdoClient, AdoError, type ClientRole } from './ado/client.ts';
import { RateGate } from './ado/rate.ts';
import { currentStatusState, toPrSnapshot, toWiSnapshot, type PrSnapshot, type WiSnapshot } from './ado/model.ts';
import type { Config, ProjectConfig, Role } from './config.ts';
import { deltaEvents, prKey, snapshotChanged, type PrEvent } from './delta.ts';
import type { Host, IssueRef } from './host.ts';
import { issueKeyFromBranch, issueKeyFromTitle } from './links.ts';
import { neutralize } from './sanitize.ts';
import { prsForBuild, Store, type LinkRow, type PrRow } from './store.ts';

export class ConfigError extends Error { code = 'not_configured'; }
/** The object exists but lies outside the repositories or projects selected in the settings. Never persisted, never acted on. */
export class ScopeError extends Error { code = 'repo_not_in_scope'; }
interface ClientSet { sig: string; gates: Record<Role, RateGate>; clients: Record<Role, AdoClient>; apis: Record<Role, AdoApi> }

export class Service {
  readonly host: Host;
  readonly store: Store;
  private sets = new Map<string, ClientSet>();
  private adminSets = new Map<string, { sig: string; gate: RateGate; api: AdoApi; identities: AdoApi }>();
  constructor(host: Host) { this.host = host; this.store = new Store(host.db); }

  async cfg(companyId: string): Promise<Config> {
    const c = await this.host.config(companyId);
    if (!c) throw new ConfigError('Azure DevOps is not configured for this company');
    return c;
  }

  /** One client set per company; rebuilt when the identity configuration changes. Rate gates survive a rebuild. */
  api(companyId: string, cfg: Config, role: Role): AdoApi {
    const sig = JSON.stringify([cfg.organization, cfg.identities]);
    let set = this.sets.get(companyId);
    if (!set || set.sig !== sig) {
      const gates = set?.gates ?? { author: new RateGate(this.host.now), reviewer: new RateGate(this.host.now) };
      const deps = (r: Role) => ({ fetch: this.host.fetch, resolveSecret: (ref: Parameters<Host['resolveSecret']>[1], path: string) => this.host.resolveSecret(companyId, ref, path), now: this.host.now, ...this.host.clientDeps });
      const clients = { author: new AdoClient('author', cfg, deps('author'), gates.author), reviewer: new AdoClient('reviewer', cfg, deps('reviewer'), gates.reviewer) };
      set = { sig, gates, clients, apis: { author: new AdoApi(clients.author), reviewer: new AdoApi(clients.reviewer) } };
      this.sets.set(companyId, set);
    }
    return set.apis[role];
  }
  /**
   * The platform administration identity. Only the platform administration tools may call this; `read` and every fallback never do.
   * Returns the organization-level API and the org-level identities API (vssps host), both bound to identities.admin.
   */
  admin(companyId: string, cfg: Config): { api: AdoApi; identities: AdoApi } {
    if (!cfg.identities.admin) throw new ConfigError('The platform administration identity is not configured (set identities.admin in the plugin settings)');
    const sig = JSON.stringify([cfg.organization, cfg.identities.admin]);
    let set = this.adminSets.get(companyId);
    if (!set || set.sig !== sig) {
      const gate = set?.gate ?? new RateGate(this.host.now);
      const deps = { fetch: this.host.fetch, resolveSecret: (ref: Parameters<Host['resolveSecret']>[1], path: string) => this.host.resolveSecret(companyId, ref, path), now: this.host.now, ...this.host.clientDeps };
      set = { sig, gate, api: new AdoApi(new AdoClient('admin' as ClientRole, cfg, deps, gate)), identities: new AdoApi(new AdoClient('admin', cfg, deps, gate, 'identities')) };
      this.adminSets.set(companyId, set);
    }
    return { api: set.api, identities: set.identities };
  }
  clientFor(companyId: string, cfg: Config, role: Role): AdoClient { this.api(companyId, cfg, role); return this.sets.get(companyId)!.clients[role]; }
  gate(companyId: string, role: Role): RateGate | undefined { return this.sets.get(companyId)?.gates[role]; }

  projectOf(cfg: Config, nameOrId?: string | null): ProjectConfig {
    if (!nameOrId) {
      if (cfg.projects.length === 1) return cfg.projects[0]!;
      throw new AdoError('ado_bad_request', 0, 'project is required: several projects are configured');
    }
    const p = cfg.projects.find((x) => x.projectId.toLowerCase() === nameOrId.toLowerCase() || x.name.toLowerCase() === nameOrId.toLowerCase());
    if (!p) throw new AdoError('not_found_or_forbidden', 0, `project "${nameOrId.slice(0, 80)}" is not in the configured scope`);
    return p;
  }
  private repoNames = new Map<string, { at: number; names: Set<string> }>();
  /** The project to use: the named one, the only one, or the one project that has a repository of that name (several projects configured). */
  async projectForRepo(companyId: string, cfg: Config, nameOrId: string | undefined, repo: string | undefined): Promise<ProjectConfig> {
    if (nameOrId || cfg.projects.length === 1 || !repo) return this.projectOf(cfg, nameOrId);
    const hits: ProjectConfig[] = [];
    for (const p of cfg.projects) {
      const key = `${companyId}:${p.projectId}`; let c = this.repoNames.get(key);
      if (!c || this.host.now() - c.at > 600_000) {
        try { c = { at: this.host.now(), names: new Set((await this.read(companyId, cfg, (api) => api.listRepos(p.projectId))).map((r) => r.name.toLowerCase())) }; this.repoNames.set(key, c); } catch { continue; }
      }
      if (c.names.has(repo.toLowerCase())) hits.push(p);
    }
    if (hits.length === 1) return hits[0]!;
    throw new AdoError('ado_bad_request', 0, hits.length ? `project is required: repository "${repo.slice(0, 80)}" exists in ${hits.map((h) => h.name).join(', ')}` : `project is required: several projects are configured (${cfg.projects.map((x) => x.name).join(', ')})`);
  }
  repoAllowed(p: ProjectConfig, repo: string): boolean {
    return p.repositories.length === 0 || p.repositories.some((r) => r.toLowerCase() === repo.toLowerCase());
  }
  /** Name or id may be listed in the settings. */
  repoInScope(p: ProjectConfig, name: string, id: string): boolean {
    return p.repositories.length === 0 || this.repoAllowed(p, name) || this.repoAllowed(p, id);
  }

  private async note(companyId: string, role: Role, cfg: Config, err?: unknown): Promise<void> {
    const nowIso = new Date(this.host.now()).toISOString();
    if (err instanceof AdoError) await this.store.setConnection(companyId, role, { authKind: cfg.identities[role].kind, ok: false, errorCode: err.code }, nowIso).catch(() => {});
    else await this.store.setConnection(companyId, role, { authKind: cfg.identities[role].kind, ok: true }, nowIso).catch(() => {});
  }

  /** Read side: the reviewer identity carries reads (spreads load across two budgets); the author identity is the fallback. */
  async read<T>(companyId: string, cfg: Config, fn: (api: AdoApi) => Promise<T>): Promise<T> {
    try {
      const out = await fn(this.api(companyId, cfg, 'reviewer'));
      await this.note(companyId, 'reviewer', cfg);
      return out;
    } catch (e) {
      if (e instanceof AdoError && (e.code === 'ado_auth' || e.code === 'ado_rate_limited')) {
        await this.note(companyId, 'reviewer', cfg, e);
        try { const out = await fn(this.api(companyId, cfg, 'author')); await this.note(companyId, 'author', cfg); return out; }
        catch (e2) { await this.note(companyId, 'author', cfg, e2); throw e2; }
      }
      throw e;
    }
  }

  async loadPr(companyId: string, cfg: Config, project: ProjectConfig, repo: string, prId: number): Promise<PrSnapshot> {
    return this.read(companyId, cfg, async (api) => {
      const { data: pr } = await api.getPr(project.projectId, repo, prId);
      const repoName = pr.repository?.name ?? repo;
      const iter = await api.iterationCount(project.projectId, repo, prId);
      const evals = pr.status === 'active' ? await api.policyEvaluations(project.projectId, project.projectId, prId) : [];
      let reviewStatus: PrSnapshot['reviewStatus'] = 'none';
      if (cfg.review.publishStatus) {
        reviewStatus = currentStatusState(await api.prStatuses(project.projectId, repo, prId), cfg.review.statusGenre, cfg.review.statusName, iter);
      }
      const snap = toPrSnapshot(cfg.organization.name, cfg.organization.hostForm, { ...pr, repository: { ...pr.repository, name: repoName, project: { id: pr.repository?.project?.id ?? project.projectId, name: pr.repository?.project?.name ?? project.name } } }, iter, evals, reviewStatus);
      if (!snap.projectId) snap.projectId = project.projectId;
      return snap;
    });
  }

  /**
   * A Build policy can sit "queued" with no build on the head (its pipeline was disabled when the pull request opened, or the queue event was lost),
   * and then nothing merges. When the same head still shows that on the next look, at least 8 minutes later, ask Azure DevOps to evaluate it again.
   * That only queues the policy's own validation build on the unchanged head, so reviews stay valid. At most once per policy, head and hour.
   */
  private async healStuckBuildPolicies(companyId: string, cfg: Config, project: ProjectConfig, snap: PrSnapshot, prev: PrRow | null): Promise<void> {
    if (snap.status !== 'active' || snap.isDraft || !prev || prev.lastMergeSourceCommit !== snap.lastMergeSourceCommit) return;
    if (this.host.now() - new Date(prev.fetchedAt).getTime() < 8 * 60_000) return;
    for (const p of snap.policies) {
      if (!p.noBuild || !p.blocking || !p.evaluationId || !prev.policies.some((x) => x.evaluationId === p.evaluationId && x.noBuild)) continue;
      const key = `policyheal:${p.evaluationId}:${snap.lastMergeSourceCommit}:${Math.floor(this.host.now() / 3600_000)}`;
      if (!(await this.store.once(companyId, key, new Date(this.host.now()).toISOString()))) continue;
      try { await this.read(companyId, cfg, (api) => api.requeuePolicyEvaluation(project.projectId, p.evaluationId!)); this.host.log.info('requeued a build policy that had no build', { pr: snap.prId, repo: snap.repoName }); this.host.metric('ado.policy.requeued', 1, { company: companyId }); }
      catch (e) { this.host.log.warn('could not requeue a build policy', { pr: snap.prId, error: String((e as Error)?.message ?? e).slice(0, 160) }); }
    }
  }

  private nextReconcile(cfg: Config, snap: PrSnapshot, jitterSeed: number): string | null {
    if (snap.terminal) return null;
    const minutes = snap.isDraft ? cfg.reconcile.dormantIntervalMinutes : cfg.reconcile.activeIntervalMinutes;
    const jitter = 1 + ((jitterSeed % 21) - 10) / 100;
    return new Date(this.host.now() + minutes * 60_000 * jitter).toISOString();
  }

  /** Fetch, persist, discover links, apply effects. Safe to call from webhook drain, reconciler, tools and the chip resolver. */
  async syncPr(companyId: string, cfg: Config, project: ProjectConfig, repo: string, prId: number, why: string): Promise<{ snap: PrSnapshot; prev: PrRow | null; events: PrEvent[]; links: LinkRow[] }> {
    const snap = await this.loadPr(companyId, cfg, project, repo, prId);
    if (!this.repoInScope(project, snap.repoName, snap.repoId)) throw new ScopeError('Repository is not in the configured scope');
    const prev = await this.store.getPr(companyId, snap.projectId, snap.repoId, prId);
    const nowIso = new Date(this.host.now()).toISOString();
    await this.healStuckBuildPolicies(companyId, cfg, project, snap, prev);
    await this.store.upsertPr(companyId, snap, { nowIso, changed: snapshotChanged(prev, snap), nextReconcileAt: this.nextReconcile(cfg, snap, prId) });
    await this.discoverLinks(companyId, cfg, snap);
    const links = await this.store.linksForObject(companyId, 'pull_request', snap.org, snap.projectId, snap.repoId, String(prId));
    const events = deltaEvents(prev, snap);
    await this.applyEvents(companyId, cfg, snap, events, links, why);
    return { snap, prev, events, links };
  }

  async discoverLinks(companyId: string, cfg: Config, snap: PrSnapshot): Promise<void> {
    const nowIso = new Date(this.host.now()).toISOString();
    const add = async (key: string, source: 'branch' | 'title', confidence: 'exact' | 'likely') => {
      const issue = await this.host.issues.findByIdentifier(companyId, key);
      if (!issue) return;
      await this.store.addLink({ id: this.host.uuid(), companyId, issueId: issue.id, kind: 'pull_request', org: snap.org, projectId: snap.projectId, repoId: snap.repoId, externalId: String(snap.prId), source, confidence }, nowIso);
    };
    if (cfg.links.autoLinkFromBranch) { const b = issueKeyFromBranch(snap.sourceRef, cfg.links); if (b) await add(b.key, 'branch', 'exact'); }
    if (cfg.links.autoLinkFromTitle) { const t = issueKeyFromTitle(snap.title, cfg.links); if (t) await add(t, 'title', 'likely'); }
  }

  /** Writes that change issue state or wake an agent need an exact link; a title token alone only earns a comment. */
  async applyEvents(companyId: string, cfg: Config, snap: PrSnapshot, events: PrEvent[], links: LinkRow[], why: string): Promise<void> {
    const nowIso = new Date(this.host.now()).toISOString();
    const pk = prKey(snap);
    const label = `!${snap.prId} (${snap.repoName})`;
    const title = neutralize(snap.title.slice(0, 120));
    for (const ev of events) {
      if (ev.type === 'iteration') {
        // A pull request seen for the first time keeps a review status that already exists; a new push resets it.
        // Only pull requests tied to a Paperclip issue get a review status: unrelated pull requests in the same repositories are left alone.
        if (cfg.review.publishStatus && links.length > 0 && !snap.isDraft && !(ev.first && snap.reviewStatus !== 'none') && await this.store.once(companyId, `pr:${pk}:status-pending:${ev.iteration}:${snap.lastMergeSourceCommit}`, nowIso)) {
          try { await this.api(companyId, cfg, 'reviewer').postStatus(snap.projectId, snap.repoId, snap.prId, { state: 'pending', description: 'Awaiting Paperclip review', genre: cfg.review.statusGenre, name: cfg.review.statusName, iterationId: ev.iteration }); }
          catch (e) { await this.store.forget(companyId, `pr:${pk}:status-pending:${ev.iteration}:${snap.lastMergeSourceCommit}`); this.host.log.warn('could not publish pending review status', { code: (e as AdoError).code }); }
        }
        if (ev.iteration > 1) await this.tell(companyId, links, `pr:${pk}:iter:${ev.iteration}`, `Azure DevOps pull request ${label} has a new iteration (${ev.iteration}) and is ready for review: ${snap.url}`, null, nowIso);
        continue;
      }
      if (ev.type === 'build_failed') {
        await this.tell(companyId, links, `pr:${pk}:policy:${neutralize(ev.policy)}:${snap.lastMergeSourceCommit}`, `Check "${neutralize(ev.policy.slice(0, 80))}" failed on ${label}: ${snap.url}`, 'ado_build_failed', nowIso);
      } else if (ev.type === 'conflicts') {
        await this.tell(companyId, links, `pr:${pk}:conflicts:${snap.lastMergeSourceCommit}`, `${label} has merge conflicts with ${snap.targetRef.replace('refs/heads/', '')}: ${snap.url}`, 'ado_pr_conflicts', nowIso);
      } else if (ev.type === 'changes_requested') {
        await this.tell(companyId, links, `pr:${pk}:changes:${ev.reviewer}:${snap.lastMergeSourceCommit}`, `${neutralize(ev.reviewer.slice(0, 60))} requested changes on ${label}: ${snap.url}`, 'ado_pr_changes_requested', nowIso);
      } else if (ev.type === 'abandoned') {
        await this.tell(companyId, links, `pr:${pk}:abandoned`, `${label} was abandoned: ${snap.url}`, null, nowIso);
      } else if (ev.type === 'completed') {
        const sha = snap.lastMergeCommit.slice(0, 7);
        await this.tell(companyId, links, `pr:${pk}:completed`, `${label} "${title}" was completed into ${snap.targetRef.replace('refs/heads/', '')}${sha ? ` (commit ${sha})` : ''}: ${snap.url}`, 'ado_pr_completed', nowIso);
        await this.progressIssues(companyId, links, pk, nowIso);
      }
    }
    void why;
  }

  private async tell(companyId: string, links: LinkRow[], key: string, text: string, wakeReason: string | null, nowIso: string): Promise<void> {
    for (const l of links) {
      const k = `${key}:issue:${l.issueId}`;
      if (!(await this.store.once(companyId, k, nowIso))) continue;
      const issue = await this.host.issues.get(companyId, l.issueId);
      if (!issue || ['done', 'cancelled'].includes(issue.status)) continue;
      try { await this.host.issues.comment(companyId, l.issueId, text); }
      catch (e) { await this.store.forget(companyId, k); this.host.log.warn('issue comment failed', { error: String(e) }); continue; }
      if (wakeReason && l.confidence === 'exact' && issue.assigneeAgentId && !['done', 'cancelled', 'blocked', 'backlog'].includes(issue.status)) {
        await this.host.issues.wake(companyId, l.issueId, wakeReason, `ado:${k}`).catch((e: unknown) => this.host.log.warn('wake refused', { error: String(e) }));
      }
    }
  }

  /** A merge moves an in-progress issue to in_review, never to done: the acceptance flow decides done. Only the issue's first PR link counts. */
  private async progressIssues(companyId: string, links: LinkRow[], pk: string, nowIso: string): Promise<void> {
    for (const l of links) {
      if (l.confidence !== 'exact') continue;
      const issue = await this.host.issues.get(companyId, l.issueId);
      if (!issue || issue.status !== 'in_progress') continue;
      const prLinks = await this.store.linksForIssue(companyId, l.issueId);
      const primary = prLinks.find((x) => x.kind === 'pull_request');
      if (!primary || primary.id !== l.id) continue;
      if (!(await this.store.once(companyId, `pr:${pk}:progress:${l.issueId}`, nowIso))) continue;
      await this.host.issues.setStatus(companyId, l.issueId, 'in_review').catch((e: unknown) => this.host.log.warn('status change refused', { error: String(e) }));
    }
  }

  async loadWorkItem(companyId: string, cfg: Config, project: ProjectConfig, id: number): Promise<WiSnapshot> {
    return this.read(companyId, cfg, async (api) => {
      const wi = await api.getWorkItem(id);
      const type = String(wi.fields?.['System.WorkItemType'] ?? '');
      const state = String(wi.fields?.['System.State'] ?? '');
      const cat = type && state ? await api.workItemStateCategory(project.projectId, type, state).catch(() => 'Unknown') : 'Unknown';
      // The work item endpoint is organisation wide: stay inside the selected project.
      if (String(wi.fields?.['System.TeamProject'] ?? '').toLowerCase() !== project.name.toLowerCase()) throw new AdoError('not_found_or_forbidden', 404, 'Work item is not in the selected project');
      const snap = toWiSnapshot(cfg.organization.name, cfg.organization.hostForm, wi, cat);
      snap.projectId = project.projectId;
      return snap;
    });
  }
  async syncWorkItem(companyId: string, cfg: Config, project: ProjectConfig, id: number): Promise<WiSnapshot> {
    const snap = await this.loadWorkItem(companyId, cfg, project, id);
    const nowIso = new Date(this.host.now()).toISOString();
    await this.store.upsertWi(companyId, snap, nowIso, snap.terminal ? null : new Date(this.host.now() + 60 * 60_000).toISOString());
    return snap;
  }

  /** Build finished: store it and refresh the open PRs it belongs to, which turns a failed required build into the usual PR effects. */
  async syncBuild(companyId: string, cfg: Config, project: ProjectConfig, buildId: number, why: string): Promise<void> {
    const b = await this.read(companyId, cfg, (api) => api.getBuild(project.projectId, buildId));
    const nowIso = new Date(this.host.now()).toISOString();
    await this.store.upsertBuild(companyId, { org: cfg.organization.name, projectId: project.projectId, buildId, pipelineId: b.definition?.id, webUrl: b._links?.web?.href, status: b.status, result: b.result, sourceBranch: b.sourceBranch, sourceVersion: b.sourceVersion, reason: b.reason, finishedAt: b.finishTime ?? null }, nowIso);
    if (!b.sourceBranch) return;
    for (const pr of await prsForBuild(this.host.db, companyId, project.projectId, b.sourceBranch)) await this.syncPr(companyId, cfg, project, pr.repoId, pr.prId, why);
  }

  /** Resolve an issue the run is working on: explicit id, else the issue this run checked out, else the agent's single in-progress issue. */
  async issueForRun(companyId: string, agentId: string, issueId?: string, runId?: string): Promise<IssueRef | null> {
    if (issueId) return this.host.issues.get(companyId, issueId);
    if (runId) { const co = await this.host.issues.checkedOutBy(companyId, agentId, runId); if (co) return co; }
    const mine = await this.host.issues.inProgressFor(companyId, agentId);
    return mine.length === 1 ? mine[0]! : null;
  }
}
