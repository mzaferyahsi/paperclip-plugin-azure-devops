import { definePlugin, runWorker, type PluginContext } from '@paperclipai/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { AdoApi } from './ado/api.ts';
import { AdoClient, AdoError } from './ado/client.ts';
import { parseAdoUrl } from './ado/urls.ts';
import { detectOrg, parseOrgInput } from './orgdetect.ts';
import { probeGitAuth, probePush } from './spike.ts';
import { parseConfig, validateConfig, type Config } from './config.ts';
import type { Host } from './host.ts';
import { NS } from './namespace.ts';
import { detect, resolve } from './provider.ts';
import { drainInbox, housekeeping, reconcileCompany } from './reconcile.ts';
import { ConfigError, Service } from './service.ts';
import { TOOLS } from './tools/catalog.ts';
import { makeToolRunner, settleApprovedActions } from './tools/index.ts';
import { wireOpencodeAgents } from './opencode.ts';
import { WebhookIngress } from './webhook.ts';
import { GitBroker } from './gitbroker.ts';
import { gitAccessStatus } from './gitaccess.ts';
import { fileURLToPath } from 'node:url';
import { prChipStatus } from './ado/model.ts';
import { BundleStore } from './bundle/store.ts';
import { revokeBundle } from './bundle/engine.ts';
import { bundleDeps, releaseBundleJob } from './bundle/adapter.ts';
import manifest from '../manifest.json' with { type: 'json' };

interface Actor { type?: string; userId?: string | null; companyId?: string | null }
const isBoard = (a: Actor | null | undefined): a is Actor & { userId: string } => !!a && a.type === 'user' && typeof a.userId === 'string' && a.userId.length > 0;
class Forbidden extends Error {}
class BadRequest extends Error {}
const requireBoard = (a: Actor | null | undefined, what: string): string => { if (!isBoard(a)) throw new Forbidden(`Only board members can ${what}`); return a.userId; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireCompany = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) throw new BadRequest('companyId is required'); return v; };

function createHost(ctx: PluginContext): Host {
  const toRef = (i: { id: string; identifier?: string | null; status: string; assigneeAgentId?: string | null; title?: string }) =>
    ({ id: i.id, identifier: i.identifier ?? '', status: i.status, assigneeAgentId: i.assigneeAgentId ?? null, title: i.title });
  return {
    db: ctx.db, now: () => Date.now(), uuid: () => randomUUID(),
    log: { info: (m, x) => ctx.logger.info(m, x), warn: (m, x) => ctx.logger.warn(m, x), error: (m, x) => ctx.logger.error(m, x) },
    fetch: (u, i) => ctx.http.fetch(u, i),
    async config(companyId) {
      try {
        const raw = await ctx.config.get(companyId);
        const cfg = parseConfig(raw);
        return cfg.organization.name ? cfg : null;
      } catch { return null; }
    },
    async configuredCompanies() {
      const out: string[] = [];
      for (const c of await ctx.companies.list({ limit: 200 })) {
        try { if (parseConfig(await ctx.config.get(c.id)).organization.name) out.push(c.id); } catch { /* no config for this company */ }
      }
      return out;
    },
    resolveSecret: (companyId, ref, configPath) => ctx.secrets.resolve({ type: 'secret_ref', secretId: ref.secretId, ...(ref.version !== undefined ? { version: ref.version as string | number } : {}) } as never, { companyId, configPath }),
    issues: {
      async findByIdentifier(companyId, key) {
        const r = await ctx.db.query<{ id: string; identifier: string; status: string; assignee_agent_id: string | null; title: string }>(`SELECT id, identifier, status, assignee_agent_id, title FROM public.issues WHERE company_id=$1 AND upper(identifier)=upper($2) LIMIT 1`, [companyId, key]);
        return r[0] ? { id: r[0].id, identifier: r[0].identifier, status: r[0].status, assigneeAgentId: r[0].assignee_agent_id, title: r[0].title } : null;
      },
      // A private or unreadable issue is reported as missing: the plugin must not fail a whole sync because one issue is off limits.
      async get(companyId, issueId) { try { const i = await ctx.issues.get(issueId, companyId); return i ? toRef(i as never) : null; } catch { return null; } },
      async blockers(companyId, issueId) { const r = await ctx.issues.relations.get(issueId, companyId); return r.blockedBy.map((b) => ({ id: b.id, identifier: b.identifier ?? '', status: b.status })); },
      async checkedOutBy(companyId, agentId, runId) {
        try {
          const r = await ctx.db.query<{ id: string; identifier: string; status: string; assignee_agent_id: string | null; title: string }>(`SELECT i.id, i.identifier, i.status, i.assignee_agent_id, i.title FROM public.issues i WHERE i.company_id=$1 AND i.assignee_agent_id=$2 AND i.status='in_progress' AND (i.checkout_run_id=$3::uuid OR i.execution_run_id=$3::uuid) LIMIT 2`, [companyId, agentId, runId]);
          return r.length === 1 ? { id: r[0]!.id, identifier: r[0]!.identifier, status: r[0]!.status, assigneeAgentId: r[0]!.assignee_agent_id, title: r[0]!.title } : null;
        } catch { return null; }
      },
      async inProgressFor(companyId, agentId) { try { return (await ctx.issues.list({ companyId, assigneeAgentId: agentId, status: 'in_progress', limit: 5 })).map((i) => toRef(i as never)); } catch { return []; } },
      async comment(companyId, issueId, body) { await ctx.issues.createComment(issueId, body, companyId); },
      async setStatus(companyId, issueId, status) { await ctx.issues.update(issueId, { status: status as never }, companyId); },
      async wake(companyId, issueId, reason, idempotencyKey) { await ctx.issues.requestWakeup(issueId, companyId, { reason, contextSource: 'azure-devops', idempotencyKey }); },
      async requestConfirmation(companyId, issueId, c) {
        const r = await ctx.issues.requestConfirmation(issueId, { idempotencyKey: c.idempotencyKey.slice(0, 250), title: 'Azure DevOps action', continuationPolicy: 'wake_assignee', ...(c.humanOnly === false ? {} : { resolverPolicy: 'human_only' }), payload: { version: 1, prompt: c.prompt.slice(0, 990), acceptLabel: c.acceptLabel, rejectLabel: c.rejectLabel, detailsMarkdown: c.detailsMarkdown.slice(0, 19000), supersedeOnUserComment: false } } as never, companyId);
        return { id: r.id };
      },
      async createChild(companyId, parentId, c) {
        const parent = await ctx.issues.get(parentId, companyId);
        const r = await ctx.issues.create({ companyId, parentId, ...(parent?.projectId ? { projectId: parent.projectId } : {}), title: c.title.slice(0, 200), description: c.description.slice(0, 19000), assigneeAgentId: c.assigneeAgentId, status: 'todo', originKind: 'plugin:mzaferyahsi.azure-devops:approval' } as never);
        return toRef(r as never);
      },
      async interaction(companyId, issueId, interactionId) {
        const list = await ctx.issues.listInteractions(issueId, companyId);
        const i = list.find((x) => x.id === interactionId) as ({ status: string; result?: { outcome?: string } | null; resolvedByUserId?: string | null; resolvedByAgentId?: string | null; id: string } | undefined);
        return i ? { id: i.id, status: i.status, outcome: i.result?.outcome ?? null, resolvedByUserId: i.resolvedByUserId ?? null, resolvedByAgentId: i.resolvedByAgentId ?? null } : null;
      },
    },
    metric: (name, value, tags) => { ctx.metrics.write(name, value, tags).catch(() => {}); },
  };
}

interface Runtime { broker: GitBroker; ingress: WebhookIngress; svc: Service; host: Host; log: PluginContext['logger']; health: () => Promise<{ status: 'ok' | 'degraded' | 'error'; message?: string; details?: Record<string, unknown> }> }
// Set in setup(); the definePlugin hooks below are declared outside it.
let rt: Runtime | null = null;
const need = (): Runtime => { if (!rt) throw new Error('plugin not ready'); return rt; };

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx: PluginContext) {
    const host = createHost(ctx);
    const svc = new Service(host);
    const ingress = new WebhookIngress(host);
    if (ctx.db.namespace !== NS) ctx.logger.error('plugin schema differs from the derived namespace; SQL will fail', { host: ctx.db.namespace, derived: NS });
    const agentName = async (companyId: string, agentId: string): Promise<string> => {
      try { return (await ctx.agents.get(agentId, companyId))?.name ?? 'agent'; } catch { return 'agent'; }
    };
    const runTool = makeToolRunner(svc, agentName);
    for (const t of TOOLS) {
      ctx.tools.register(t.name, { displayName: t.displayName, description: t.description, parametersSchema: t.parametersSchema as never }, async (params, run) => runTool(t.name, params, run));
    }

    ctx.jobs.register('inbox-drain', async () => {
      await drainInbox(svc, host, 25);
      try {
        for (const companyId of await host.configuredCompanies()) {
          const cfg = await host.config(companyId); if (!cfg) continue;
          for (const r of await wireOpencodeAgents(ctx.db, companyId, cfg)) if (r.changed) ctx.logger.info('opencode tools wiring changed', { agent: r.agent, enabled: cfg.agentTools.opencodeNative });
        }
      } catch (e) { ctx.logger.warn('opencode tools wiring failed', { error: String(e).slice(0, 200) }); }
      try { await settleApprovedActions(svc, runTool); } catch (e) { ctx.logger.error('settling approved actions failed', { error: String(e).slice(0, 200) }); }
    });
    ctx.jobs.register('reconcile', async () => {
      for (const companyId of await host.configuredCompanies()) {
        const cfg = await host.config(companyId);
        if (!cfg) continue;
        try { const r = await reconcileCompany(svc, host, companyId, cfg); host.metric('ado.reconcile.prs', r.prs, { company: companyId }); }
        catch (e) { ctx.logger.error('reconcile failed', { company: companyId, error: String(e).slice(0, 300) }); }
      }
    });
    // One company failing never stops another (design F7). Polling needs no lease; queueing and cancelling are guarded by CAS and leases inside the engine.
    ctx.jobs.register('release-bundle', async () => { await releaseBundleJob(svc); });
    ctx.jobs.register('housekeeping', async () => { await housekeeping(host); });

    // ---- data and actions for the UI -------------------------------------------------------------------------------------
    const webhookRecipe = (cfg: Config | null) => {
      const base = (cfg?.webhook.publicBaseUrl ?? 'https://<your-paperclip-host>').replace(/\/+$/, '');
      return { url: `${base}/api/plugins/${manifest.id}/webhooks/ado`, header: 'X-Paperclip-Hook-Token', basicAuthUser: cfg?.webhook.basicAuthUser ?? 'paperclip', events: ['git.pullrequest.created', 'git.pullrequest.updated', 'git.pullrequest.merged', 'build.complete', 'ms.vss-pipelines.run-state-changed-event'], resourceDetailsToSend: 'Minimal' };
    };

    ctx.data.register('overview', async (p) => {
      const companyId = requireCompany(p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) return { configured: false, webhook: webhookRecipe(null), tools: TOOLS.map((t) => ({ name: t.name, cls: t.cls, role: t.role })) };
      const [conns, cursors, inbox] = await Promise.all([
        svc.store.connections(companyId), svc.store.cursors(companyId),
        ctx.db.query<{ status: string; n: string }>(`SELECT status, count(*)::text n FROM ${NS}.webhook_inbox WHERE company_id=$1 GROUP BY status`, [companyId]),
      ]);
      const v = validateConfig(cfg);
      return {
        configured: true, organization: cfg.organization.name, projects: cfg.projects.map((x) => ({ projectId: x.projectId, name: x.name, repositories: x.repositories, protectedBranches: x.protectedBranches })),
        identities: (['author', 'reviewer'] as const).map((role) => {
          const c = conns.find((x) => x.role === role); const g = svc.gate(companyId, role);
          return { role, kind: cfg.identities[role].kind, displayName: c?.display_name ?? null, lastOkAt: c?.last_ok_at ?? null, lastErrorCode: c?.last_error_code ?? null, parkedSeconds: g?.parkedSeconds() ?? 0 };
        }),
        reconcile: cursors, inbox: Object.fromEntries(inbox.map((r) => [r.status, Number(r.n)])), rejected10m: ingress.rejected10m.length,
        validation: v, webhook: webhookRecipe(cfg), roles: cfg.roles, pausedReconcile: cfg.reconcile.paused,
        tools: TOOLS.map((t) => ({ name: t.name, cls: t.cls, role: t.role })),
      };
    });

    ctx.data.register('issue-links', async (p) => {
      const companyId = requireCompany(p.companyId);
      const issueId = typeof p.issueId === 'string' && UUID.test(p.issueId) ? p.issueId : null;
      if (!issueId) return { links: [] };
      const cfg = await host.config(companyId);
      const links = await svc.store.linksForIssue(companyId, issueId);
      const out: unknown[] = [];
      for (const l of links) {
        if (l.kind === 'pull_request') {
          const pr = await svc.store.findPrById(companyId, l.projectId, l.repoId, Number(l.externalId));
          out.push(pr ? { kind: l.kind, confidence: l.confidence, source: l.source, prId: pr.prId, repository: pr.repoName, title: pr.title.slice(0, 200), url: pr.url, state: prChipStatus(pr, !!cfg?.review.publishStatus), sourceBranch: pr.sourceRef.replace('refs/heads/', ''), targetBranch: pr.targetRef.replace('refs/heads/', ''), reviewers: pr.reviewers, policies: pr.policies, reviewStatus: pr.reviewStatus, fetchedAt: pr.fetchedAt }
            : { kind: l.kind, confidence: l.confidence, source: l.source, prId: Number(l.externalId), state: null });
          const builds = pr ? await ctx.db.query(`SELECT build_id, status, result, web_url FROM ${NS}.build WHERE company_id=$1 AND project_id=$2 AND (source_branch=$3 OR source_branch=$4) ORDER BY build_id DESC LIMIT 3`, [companyId, pr.projectId, pr.sourceRef, `refs/pull/${pr.prId}/merge`]) : [];
          for (const b of builds) out.push({ kind: 'build', ...b });
        } else if (l.kind === 'work_item') {
          const w = await svc.store.getWi(companyId, l.org, l.projectId, Number(l.externalId));
          out.push({ kind: l.kind, confidence: l.confidence, source: l.source, id: Number(l.externalId), state: w?.state ?? null, stateCategory: w?.stateCategory ?? null });
        }
      }
      return { links: out, canLink: !!cfg };
    });

    ctx.data.register('pending-prs', async (p) => {
      const companyId = requireCompany(p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) return { prs: [] };
      const prs = await svc.store.activePrs(companyId);
      return { prs: prs.filter((x) => !x.isDraft).slice(0, 25).map((x) => ({ prId: x.prId, repository: x.repoName, title: x.title.slice(0, 160), url: x.url, state: prChipStatus(x, cfg.review.publishStatus), reviewStatus: x.reviewStatus, changedAt: x.changedAt })) };
    });

    ctx.actions.register('test-connection', async (p, a) => {
      requireBoard(a.actor, 'test the Azure DevOps connection');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Save the organization and identities first');
      const results: unknown[] = [];
      for (const role of ['author', 'reviewer'] as const) {
        const api = svc.api(companyId, cfg, role);
        try {
          const me = await api.connectionData();
          const id = me.authenticatedUser?.id ?? null;
          await svc.store.setConnection(companyId, role, { identityId: id, displayName: me.authenticatedUser?.providerDisplayName ?? null, authKind: cfg.identities[role].kind, ok: true }, new Date().toISOString());
          const projects: unknown[] = [];
          for (const pr of cfg.projects) {
            try {
              const repos = await api.listRepos(pr.projectId);
              const perms = await api.gitPermissions(pr.projectId);
              const warnings: string[] = [];
              if (perms.contributeToPullRequests === false) warnings.push('missing "Contribute to pull requests" on the repositories');
              if (perms.bypassPullRequestPolicy === true) warnings.push('has "Bypass policies when completing pull requests": remove it');
              if (perms.editPolicies === true || perms.managePermissions === true) warnings.push('can edit policies or permissions: remove it');
              if (role === 'reviewer' && perms.push === true) warnings.push('can push: a reviewer should not');
              projects.push({ project: pr.name, ok: true, repositories: repos.length, permissions: perms, warnings });
            }
            catch (e) { projects.push({ project: pr.name, ok: false, code: e instanceof AdoError ? e.code : 'error' }); }
          }
          const expected = cfg.identities[role].expectedDisplayName;
          results.push({ role, ok: true, identity: me.authenticatedUser?.providerDisplayName ?? null, matchesExpected: expected ? expected === me.authenticatedUser?.providerDisplayName : null, projects });
        } catch (e) {
          const code = e instanceof AdoError ? e.code : 'error';
          await svc.store.setConnection(companyId, role, { authKind: cfg.identities[role].kind, ok: false, errorCode: code }, new Date().toISOString());
          results.push({ role, ok: false, code, message: e instanceof AdoError ? e.message : 'failed' });
        }
      }
      const ids = new Set((await svc.store.connections(companyId)).map((c) => c.identity_id).filter(Boolean));
      return { results, distinctIdentities: ids.size >= 2 || results.some((r) => (r as { ok: boolean }).ok === false) };
    });

    // Setup wizard: turn a pasted URL or name into organization, URL form and Entra tenant, so nothing is looked up by hand.
    ctx.actions.register('detect-org', async (p, a) => {
      requireBoard(a.actor, 'detect the Azure DevOps organization');
      const guess = typeof p.input === 'string' ? parseOrgInput(p.input) : null;
      if (!guess) throw new BadRequest('Paste the organization URL, for example https://dev.azure.com/yourorg');
      return detectOrg((u, i) => ctx.http.fetch(u, i), guess);
    });

    ctx.actions.register('git-access-status', async (p, a) => {
      requireBoard(a.actor, 'read the git access status');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId); if (!cfg) throw new ConfigError('Not configured');
      return gitAccessStatus(ctx.db, companyId, cfg, fileURLToPath(new URL('../host/install-git-access.sh', import.meta.url)));
    });
    // Proves the broker chain without an agent run: scope, role, token, and a real git ls-remote with that token. The token never leaves the worker.
    ctx.actions.register('git-access-test', async (p, a) => {
      requireBoard(a.actor, 'test git access');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId); if (!cfg) throw new ConfigError('Not configured');
      const project = cfg.projects[0]; if (!project) throw new BadRequest('Select a project first');
      const repoName = typeof p.repository === 'string' && p.repository ? p.repository : (await svc.read(companyId, cfg, (api) => api.listRepos(project.projectId))).find((r) => !r.isDisabled && svc.repoInScope(project, r.name, r.id))?.name;
      if (!repoName) throw new BadRequest('No repository found in scope');
      const base = cfg.organization.hostForm === 'visualstudio.com' ? `https://${cfg.organization.name}.visualstudio.com` : `https://dev.azure.com/${cfg.organization.name}`;
      const out: Record<string, unknown> = { repository: repoName };
      for (const role of ['reviewer', 'author'] as const) {
        try { const t = await svc.clientFor(companyId, cfg, role).accessToken(); const r = await probeGitAuth(t.token, `${base}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(repoName)}`); out[role] = { ok: r.basicPassword.ok, detail: r.basicPassword.ok ? 'git reached the repository' : r.basicPassword.head }; }
        catch (e) { out[role] = { ok: false, detail: e instanceof AdoError ? e.message : 'failed' }; }
      }
      // Optional write proof on a repository the board names: one throwaway branch pushed with the author bot token, then deleted.
      if (p.push === true) {
        try { const t = await svc.clientFor(companyId, cfg, 'author').accessToken(); out.push = await probePush(t.token, `${base}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(repoName)}`); }
        catch (e) { out.push = { error: e instanceof AdoError ? e.message : 'failed' }; }
      }
      return out;
    });

    ctx.actions.register('discover', async (p, a) => {
      requireBoard(a.actor, 'list Azure DevOps projects');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Save the organization and identities first');
      const projects = await svc.read(companyId, cfg, (api) => api.listProjects());
      return { projects: projects.map((x) => ({ projectId: x.id, name: x.name })) };
    });
    // Read-only diagnosis for the board: why a pull request's policy is not passing (evaluation detail and the pipeline's queue state).
    ctx.actions.register('inspect-pr-policy', async (p, a) => {
      requireBoard(a.actor, 'inspect pull request policies');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Save the organization and identities first');
      const project = typeof p.projectId === 'string' ? p.projectId : '';
      const prId = Number(p.prId);
      if (!UUID.test(project) || !Number.isInteger(prId) || prId < 1) throw new BadRequest('projectId and prId are required');
      const name = cfg.projects.find((x) => x.projectId === project)?.name ?? project;
      const evals = await svc.read(companyId, cfg, (api) => api.policyEvaluations(name, project, prId));
      const out = [];
      for (const e of evals) {
        const st = (e.configuration?.settings ?? {}) as Record<string, unknown>;
        const defId = Number(st.buildDefinitionId);
        const def = Number.isInteger(defId) && defId > 0 ? await svc.read(companyId, cfg, (api) => api.getBuildDefinitionRaw(name, defId)).catch(() => null) : null;
        // Optional (pass commit): the pool lines of the pipeline's YAML at that commit, so board can see where the run would really go.
        let yamlPool: string[] | undefined; let yamlText: string | undefined;
        if (def && typeof p.commit === 'string' && /^[0-9a-f]{40}$/i.test(p.commit) && def.process?.yamlFilename && def.repository?.name) {
          const f = await svc.read(companyId, cfg, (api) => api.fileText(name, String(def.repository.name), '/' + String(def.process.yamlFilename).replace(/^\/+/, ''), p.commit as string, 200_000)).catch((err) => ({ text: '', truncated: false, error: String((err as Error)?.message ?? err).slice(0, 120) }));
          const lines = String(f.text ?? '').split('\n');
          if (p.yamlFull === true && !(f as { error?: string }).error) yamlText = String(f.text ?? '').slice(0, 20_000);
          yamlPool = (f as { error?: string }).error ? [`unreadable: ${(f as { error?: string }).error}`] : lines.map((l, i) => ({ l, i })).filter((x) => /^\s*(pool|vmImage|demands|name)\s*:/.test(x.l) || /^\s*-\s*(pool|vmImage)\s*:/.test(x.l)).slice(0, 12).map((x) => `${x.i + 1}: ${x.l.trimEnd().slice(0, 120)}`);
        }
        out.push({
          yamlPool, yamlText,
          policy: e.configuration?.type?.displayName ?? 'policy', status: e.status, blocking: e.configuration?.isBlocking, enabled: e.configuration?.isEnabled,
          settings: { displayName: st.displayName, manualQueueOnly: st.manualQueueOnly, queueOnSourceUpdateOnly: st.queueOnSourceUpdateOnly, validDuration: st.validDuration, buildDefinitionId: st.buildDefinitionId, minimumApproverCount: st.minimumApproverCount, creatorVoteCounts: st.creatorVoteCounts, blockLastPusherVote: st.blockLastPusherVote, resetOnSourcePush: st.resetOnSourcePush, resetRejectionsOnSourcePush: st.resetRejectionsOnSourcePush, allowDownvotes: st.allowDownvotes, scope: st.scope },
          context: (e as any).context ?? null,
          pipeline: def ? { id: defId, name: def.name, queueStatus: def.queueStatus, queue: def.queue?.name ?? def.process?.type, pool: def.queue?.pool?.name, path: def.process?.yamlFilename, repository: def.repository?.name } : null,
        });
      }
      // Optional: the latest pushes to a branch, so "last pusher" rules can be checked (pass repositoryId and refName).
      let pushes: unknown = undefined;
      if (typeof p.repositoryId === 'string' && UUID.test(p.repositoryId) && typeof p.refName === 'string') {
        const r = await svc.read(companyId, cfg, (api) => api.c.get<any>(`git/repositories/${p.repositoryId}/pushes`, { 'searchCriteria.refName': p.refName as string, $top: 5 }, project)).catch(() => null);
        pushes = (r?.value ?? []).map((x: any) => ({ pushId: x.pushId, date: x.date, by: x.pushedBy?.displayName, byId: x.pushedBy?.id, commit: x.commits?.[0]?.commitId }));
      }
      return { evaluations: out, pushes };
    });
    // Board-only, read only: the steps of one build with their results, and the log tail of the steps that failed.
    ctx.actions.register('inspect-build', async (p, a) => {
      requireBoard(a.actor, 'inspect a build');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Save the organization and identities first');
      const project = typeof p.projectId === 'string' ? p.projectId : ''; const buildId = Number(p.buildId);
      if (!UUID.test(project) || !Number.isInteger(buildId) || buildId < 1) throw new BadRequest('projectId and buildId are required');
      const name = cfg.projects.find((x) => x.projectId === project)?.name ?? project;
      const records = await svc.read(companyId, cfg, (api) => api.buildTimeline(name, buildId));
      const steps = records.filter((r) => r.type === 'Task' || r.type === 'Job').map((r) => ({ type: r.type, name: r.name, state: r.state, result: r.result, logId: r.log?.id ?? null }));
      const failed = records.filter((r) => r.type === 'Task' && r.result === 'failed' && r.log?.id).slice(0, 3);
      const tails: Array<{ step?: string; tail: string }> = [];
      for (const f of failed) tails.push({ step: f.name, tail: await svc.read(companyId, cfg, (api) => api.buildLog(name, buildId, f.log!.id!, 3000)).catch((e) => `unreadable: ${String((e as Error)?.message ?? e).slice(0, 100)}`) });
      return { steps, failedLogTails: tails };
    });
    // Board-only: ask Azure DevOps to evaluate the build policies of a pull request again (for example after its pipeline was re-enabled).
    ctx.actions.register('requeue-pr-policy', async (p, a) => {
      requireBoard(a.actor, 'requeue pull request policies');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Save the organization and identities first');
      const project = typeof p.projectId === 'string' ? p.projectId : '';
      const prId = Number(p.prId);
      if (!UUID.test(project) || !Number.isInteger(prId) || prId < 1) throw new BadRequest('projectId and prId are required');
      const name = cfg.projects.find((x) => x.projectId === project)?.name ?? project;
      const evals = await svc.read(companyId, cfg, (api) => api.policyEvaluations(name, project, prId));
      const out = [];
      const only = typeof p.evaluationId === 'string' ? p.evaluationId : '';
      for (const e of evals) {
        if (!e.evaluationId || e.configuration?.isEnabled === false) continue;
        if (only ? e.evaluationId !== only : e.configuration?.type?.displayName !== 'Build') continue;
        const r = await svc.read(companyId, cfg, (api) => api.requeuePolicyEvaluation(name, e.evaluationId!)).catch((err) => ({ status: `error: ${String((err as Error)?.message ?? err).slice(0, 160)}` }));
        out.push({ evaluationId: e.evaluationId, before: e.status, after: r?.status ?? null });
      }
      return { requeued: out };
    });
    // Board-only: set the reviewer bot's vote to 0 and back, so Azure DevOps evaluates a stale reviewer policy again. Needs a changed vote; the same vote twice does not raise an event.
    ctx.actions.register('refresh-reviewer-vote', async (p, a) => {
      requireBoard(a.actor, 'refresh a reviewer vote');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Save the organization and identities first');
      const project = typeof p.projectId === 'string' ? p.projectId : '';
      const repo = typeof p.repositoryId === 'string' ? p.repositoryId : '';
      const reviewerId = typeof p.reviewerId === 'string' ? p.reviewerId : '';
      const prId = Number(p.prId); const vote = Number(p.vote);
      if (!UUID.test(project) || !UUID.test(repo) || !reviewerId || !Number.isInteger(prId) || prId < 1 || ![-10, -5, 5, 10].includes(vote)) throw new BadRequest('projectId, repositoryId, reviewerId, prId and vote (-10, -5, 5 or 10) are required');
      const name = cfg.projects.find((x) => x.projectId === project)?.name ?? project;
      const api = svc.api(companyId, cfg, 'reviewer');
      await api.putReviewer(name, repo, prId, reviewerId, 0);
      await new Promise((r) => setTimeout(r, 2000));
      const back = await api.putReviewer(name, repo, prId, reviewerId, vote);
      return { vote: back?.vote ?? null };
    });
    // Board-only: what each bot may do on one repository (read, push, branch, pull requests), so a missing right is found without guessing.
    ctx.actions.register('check-repo-access', async (p, a) => {
      requireBoard(a.actor, 'check repository access');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Save the organization and identities first');
      const project = typeof p.projectId === 'string' ? p.projectId : '';
      const repoName = typeof p.repository === 'string' ? p.repository.slice(0, 128) : '';
      if (!UUID.test(project) || !repoName) throw new BadRequest('projectId and repository are required');
      const repos = await svc.read(companyId, cfg, (api) => api.listRepos(project));
      const repo = repos.find((r) => r.name.toLowerCase() === repoName.toLowerCase());
      if (!repo) return { found: false, repositories: repos.length };
      const out: Record<string, unknown> = { found: true, repository: repo.name };
      for (const role of ['author', 'reviewer'] as const) out[role] = await svc.api(companyId, cfg, role).gitPermissions(project, repo.id);
      return out;
    });
    ctx.actions.register('discover-repos', async (p, a) => {
      requireBoard(a.actor, 'list Azure DevOps repositories');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Save the organization and identities first');
      const project = typeof p.projectId === 'string' ? p.projectId : '';
      if (!UUID.test(project)) throw new BadRequest('projectId is required');
      return { repositories: (await svc.read(companyId, cfg, (api) => api.listRepos(project))).map((r) => ({ id: r.id, name: r.name })) };
    });
    // Agent queues the configured projects may use, so the settings page offers a list instead of asking for numbers.
    ctx.actions.register('discover-queues', async (p, a) => {
      requireBoard(a.actor, 'list Azure DevOps agent queues');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Save the organization and identities first');
      const seen = new Map<number, { id: number; name: string; pool: string; hosted: boolean; project: string }>();
      for (const project of cfg.projects) {
        for (const q of await svc.read(companyId, cfg, (api) => api.agentQueues(project.projectId)).catch(() => [])) if (q.id && !seen.has(q.id)) seen.set(q.id, { id: q.id, name: String(q.name ?? '').slice(0, 80), pool: String(q.pool?.name ?? '').slice(0, 80), hosted: q.pool?.isHosted === true, project: project.name });
      }
      // Organization pools, so the page can tell a pool that exists but is not attached to a project from one the bot cannot see.
      const attached = new Set([...seen.values()].map((q) => q.pool));
      const pools = (await svc.read(companyId, cfg, (api) => api.orgPools()).catch(() => null))?.map((x) => ({ id: x.id ?? 0, name: String(x.name ?? '').slice(0, 80), hosted: x.isHosted === true, attached: attached.has(String(x.name ?? '')) }));
      return { queues: [...seen.values()], pools: pools ?? null };
    });
    // Board UI revoke: narrowing only, so any board member may do it (design section 5).
    ctx.actions.register('revoke-release-bundle', async (p, a) => {
      const by = requireBoard(a.actor, 'revoke a release bundle');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId); if (!cfg) throw new ConfigError('Not configured');
      const id = typeof p.bundleId === 'string' && UUID.test(p.bundleId) ? p.bundleId.toLowerCase() : null;
      const reason = typeof p.reason === 'string' ? p.reason.trim().slice(0, 300) : '';
      if (!id || !reason) throw new BadRequest('bundleId and reason are required');
      const d = bundleDeps(svc, companyId, cfg); const b = await d.bundles.get(companyId, id);
      if (!b) throw new BadRequest('No such release bundle');
      return revokeBundle(d, b, `user:${by}`, reason);
    });
    ctx.data.register('release-bundles', async (p) => {
      const companyId = requireCompany(p.companyId);
      const rows = await ctx.db.query(`SELECT id,issue_id,source_commit,status,expires_at,build_id,image_digest,deploy_run_id,approved_by_user_id,revoke_reason,created_at FROM ${NS}.release_bundle WHERE company_id=$1 ORDER BY created_at DESC LIMIT 10`, [companyId]);
      return { bundles: rows };
    });
    ctx.actions.register('sync-now', async (p, a) => {
      requireBoard(a.actor, 'run a sync');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Not configured');
      await drainInbox(svc, host, 50);
      return reconcileCompany(svc, host, companyId, cfg);
    });
    ctx.actions.register('link-url', async (p, a) => {
      requireBoard(a.actor, 'link an Azure DevOps object');
      const companyId = requireCompany(a.companyId ?? p.companyId);
      const cfg = await host.config(companyId);
      if (!cfg) throw new ConfigError('Not configured');
      const issueId = typeof p.issueId === 'string' && UUID.test(p.issueId) ? p.issueId : null;
      const ref = typeof p.url === 'string' ? parseAdoUrl(p.url) : null;
      if (!issueId || !ref || ref.org.toLowerCase() !== cfg.organization.name.toLowerCase()) throw new BadRequest('Give an issue and an Azure DevOps pull request or work item URL of the configured organization');
      const project = svc.projectOf(cfg, ref.project);
      if (ref.kind === 'pull_request') {
        if (!svc.repoAllowed(project, ref.repo!)) throw new BadRequest('Repository is not in the configured scope');
        const { snap } = await svc.syncPr(companyId, cfg, project, ref.repo!, ref.id, 'ui:link');
        await svc.store.addLink({ id: randomUUID(), companyId, issueId, kind: 'pull_request', org: snap.org, projectId: snap.projectId, repoId: snap.repoId, externalId: String(ref.id), source: 'tool', confidence: 'exact' }, new Date().toISOString());
      } else {
        await svc.syncWorkItem(companyId, cfg, project, ref.id);
        await svc.store.addLink({ id: randomUUID(), companyId, issueId, kind: 'work_item', org: cfg.organization.name, projectId: project.projectId, repoId: '', externalId: String(ref.id), source: 'tool', confidence: 'exact' }, new Date().toISOString());
      }
      return { ok: true };
    });

    const health: Runtime['health'] = async () => {
      const companies = await host.configuredCompanies();
      if (companies.length === 0) return { status: 'ok', message: 'No company is configured yet', details: {} };
      const details: Record<string, unknown> = {}; let worst: 'ok' | 'degraded' | 'error' = 'ok';
      for (const c of companies) {
        const conns = await svc.store.connections(c).catch(() => []);
        const cur = await svc.store.cursors(c).catch(() => []);
        const authBad = conns.filter((x) => x.last_error_code === 'ado_auth' || x.last_error_code === 'ado_config').map((x) => x.role);
        const failing = cur.filter((x) => x.consecutive_failures >= 3).map((x) => x.scope);
        if (authBad.length) worst = 'error'; else if ((conns.some((x) => x.last_error_code) || failing.length || ingress.rejected10m.length > 100) && worst === 'ok') worst = 'degraded';
        details[c] = { authFailed: authBad, failingScopes: failing, recentRejectedWebhooks: ingress.rejected10m.length };
      }
      return { status: worst, message: worst === 'ok' ? 'Azure DevOps connection is healthy' : worst === 'error' ? 'A bot identity is rejected by Azure DevOps' : 'Azure DevOps sync is degraded', details };
    };
    rt = { broker: new GitBroker(svc), ingress, svc, host, log: ctx.logger, health };
  },

  async onWebhook(input) {
    // Never throw for a bad delivery: a throw becomes HTTP 502 and Azure DevOps retries the same request.
    const r = rt;
    if (!r) return;
    try {
      const outcome = await r.ingress.handle(input);
      if (outcome.result === 'rejected') r.log.warn('webhook rejected', { reason: outcome.reason });
    } catch (e) { r.log.error('webhook handling failed', { error: String(e).slice(0, 200) }); }
  },

  async onValidateConfig(config) {
    const cfg = parseConfig(config);
    if (!cfg.organization.name && cfg.projects.length === 0) return { ok: true, warnings: ['Azure DevOps is not configured for this company yet.'] };
    const v = validateConfig(cfg);
    return { ok: v.ok, errors: v.errors, warnings: v.warnings };
  },

  async onApiRequest(input) {
    const r = need();
    if (input.routeKey === 'git-credentials') {
      const out = await r.broker.handle({ companyId: input.companyId, agentId: input.actor.agentId ?? null, runId: input.actor.runId ?? null, body: input.body });
      return { status: out.status, headers: { 'cache-control': 'no-store' }, body: out.body };
    }
    return { status: 404, body: { error: 'not_found' } };
  },

  async onConfigChanged() { rt?.ingress.invalidate(); },

  async onHealth() { return rt ? rt.health() : { status: 'ok' as const, message: 'starting' }; },

  async onDetectExternalObjects(params) { return detect(need().svc, params.companyId, params.urls as never) as never; },
  async onResolveExternalObject(params) { return resolve(need().svc, params.companyId, params.externalId) as never; },
});

export default plugin;
runWorker(plugin, import.meta.url);
