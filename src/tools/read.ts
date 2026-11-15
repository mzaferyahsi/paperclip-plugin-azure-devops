// Read tools (class R). Free text is omitted unless asked for and always fenced as untrusted data.
import { prChipStatus, wiChipStatus, type PrSnapshot } from '../ado/model.ts';
import { neutralize, untrusted } from '../sanitize.ts';
import { NS } from '../namespace.ts';
import type { Service } from '../service.ts';
import { resolvePrTarget, ToolError, workProductStep, type RunCtx, type ToolOut } from './common.ts';

type A = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const bool = (v: unknown): boolean => v === true;
const short = (s: string, n = 120): string => neutralize(s.replace(/\s+/g, ' ').slice(0, n));

export function prView(s: PrSnapshot, requireReview: boolean) {
  const chip = prChipStatus(s, requireReview);
  return {
    prId: s.prId, repository: s.repoName, project: s.projectName, url: s.url, state: chip.statusKey, stateLabel: chip.statusLabel, status: s.status, mergeStatus: s.mergeStatus, isDraft: s.isDraft, headCommit: s.lastMergeSourceCommit,
    sourceBranch: s.sourceRef.replace('refs/heads/', ''), targetBranch: s.targetRef.replace('refs/heads/', ''), iteration: s.iterationCount,
    reviewers: s.reviewers.map((r) => ({ name: short(r.name, 60), vote: r.vote, required: r.required })),
    policies: s.policies.map((p) => ({ policy: short(p.name, 60), status: p.status, blocking: p.blocking })), reviewStatus: s.reviewStatus, title: short(s.title, 200),
  };
}

export function makeReadTools(svc: Service) {
  const host = svc.host;
  const cfgOf = (run: RunCtx) => svc.cfg(run.companyId);

  async function health(_a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const conns = await svc.store.connections(run.companyId);
    const cur = await svc.store.cursors(run.companyId);
    const inbox = await host.db.query<{ status: string; n: string }>(`SELECT status, count(*)::text n FROM ${NS}.webhook_inbox WHERE company_id=$1 GROUP BY status`, [run.companyId]);
    const roles = (['author', 'reviewer'] as const).map((role) => {
      const c = conns.find((x) => x.role === role); const g = svc.gate(run.companyId, role);
      return { role, authKind: cfg.identities[role].kind, identity: c?.display_name ?? null, lastOk: c?.last_ok_at ? new Date(c.last_ok_at).toISOString() : null, lastErrorCode: c?.last_error_code ?? null, parkedSeconds: g?.parkedSeconds() ?? 0, remainingHint: g?.remainingHint ?? null };
    });
    const data = { organization: cfg.organization.name, projects: cfg.projects.map((p) => p.name), identities: roles, reconcile: cur.map((c) => ({ scope: c.scope, lastOk: c.last_ok_at ? new Date(c.last_ok_at).toISOString() : null, failures: c.consecutive_failures, lastError: c.last_error })), inbox: Object.fromEntries(inbox.map((r) => [r.status, Number(r.n)])), webhookConfigured: !!cfg.webhook.hookTokenRef };
    const bad = roles.filter((r) => r.lastErrorCode).map((r) => `${r.role}: ${r.lastErrorCode}`);
    return { content: bad.length ? `Azure DevOps degraded (${bad.join(', ')}).` : 'Azure DevOps connection looks healthy.', data };
  }

  async function linkList(a: A, run: RunCtx): Promise<ToolOut> {
    const issue = await svc.issueForRun(run.companyId, run.agentId, str(a.issueId), run.runId);
    if (!issue) throw new ToolError('no_issue', 'Give issueId: this run has no single in-progress issue');
    const links = await svc.store.linksForIssue(run.companyId, issue.id);
    const out: unknown[] = []; const steps: unknown[] = [];
    for (const l of links) {
      if (l.kind === 'pull_request') {
        const snap = await svc.store.findPrById(run.companyId, l.projectId, l.repoId, Number(l.externalId));
        if (!snap) { out.push({ kind: l.kind, id: Number(l.externalId), confidence: l.confidence, source: l.source, state: 'not_synced' }); continue; }
        out.push({ ...prView(snap, false), kind: l.kind, confidence: l.confidence, source: l.source });
        steps.push(workProductStep(issue.id, snap));
      } else if (l.kind === 'work_item') {
        const w = await svc.store.getWi(run.companyId, l.org, l.projectId, Number(l.externalId));
        out.push({ kind: l.kind, id: Number(l.externalId), state: w?.state ?? 'not_synced', stateCategory: w?.stateCategory ?? null, confidence: l.confidence });
      } else out.push({ kind: l.kind, id: Number(l.externalId) });
    }
    return { content: `${links.length} Azure DevOps object(s) linked to ${issue.identifier}.`, data: { issue: issue.identifier, links: out, nextSteps: steps } };
  }

  async function prGet(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const t = await resolvePrTarget(svc, run.companyId, cfg, { prId: num(a.prId), url: str(a.url), repository: str(a.repository), project: str(a.project) });
    const { snap, links } = await svc.syncPr(run.companyId, cfg, t.project, t.repo, t.prId, 'tool:ado_pr_get');
    const issues: string[] = [];
    for (const l of links) { const i = await host.issues.get(run.companyId, l.issueId); if (i) issues.push(i.identifier); }
    const builds = await host.db.query<{ build_id: number; status: string; result: string | null; web_url: string | null }>(`SELECT build_id,status,result,web_url FROM ${NS}.build WHERE company_id=$1 AND project_id=$2 AND (source_branch=$3 OR source_branch=$4) ORDER BY build_id DESC LIMIT 5`, [run.companyId, snap.projectId, snap.sourceRef, `refs/pull/${snap.prId}/merge`]);
    const data: Record<string, unknown> = { ...prView(snap, cfg.review.publishStatus), linkedIssues: issues, builds: builds.map((b) => ({ buildId: Number(b.build_id), status: b.status, result: b.result, url: b.web_url })) };
    if (bool(a.includeDescription)) data.description = untrusted(snap.description, 4000);
    if (bool(a.includeThreads)) data.threads = await threadsOf(run, cfg, t, undefined);
    return { content: `Pull request !${snap.prId} is ${prView(snap, false).stateLabel.toLowerCase()} (${snap.sourceRef.replace('refs/heads/', '')} into ${snap.targetRef.replace('refs/heads/', '')}).`, data };
  }

  async function threadsOf(run: RunCtx, cfg: Awaited<ReturnType<typeof cfgOf>>, t: { project: { projectId: string }; repo: string; prId: number }, status?: string) {
    const threads = await svc.read(run.companyId, cfg, (api) => api.threads(t.project.projectId, t.repo, t.prId));
    return threads.filter((th) => !status || th.status === status).slice(0, 30).map((th) => ({
      threadId: th.id, status: th.status ?? 'unknown', filePath: th.threadContext?.filePath ?? null, line: th.threadContext?.rightFileStart?.line ?? null,
      comments: (th.comments ?? []).filter((c) => !c.isDeleted && c.commentType !== 'system').slice(0, 10).map((c) => ({ commentId: c.id, author: short(c.author?.displayName ?? '', 60), authorId: c.author?.id ?? null, text: untrusted(c.content, 1500) })),
    }));
  }

  async function prThreads(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const t = await resolvePrTarget(svc, run.companyId, cfg, { prId: num(a.prId), repository: str(a.repository), project: str(a.project) });
    const th = await threadsOf(run, cfg, t, str(a.status));
    return { content: `${th.length} thread(s) on !${t.prId}.`, data: { threads: th } };
  }

  async function prFind(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const repo = str(a.repository); if (!repo) throw new ToolError('bad_request', 'repository is required');
    const project = svc.projectOf(cfg, str(a.project));
    if (!svc.repoAllowed(project, repo)) throw new ToolError('repo_not_in_scope', 'Repository is not in the configured scope');
    const src = str(a.sourceBranch);
    const prs = await svc.read(run.companyId, cfg, (api) => api.listPrs(project.projectId, repo, { status: str(a.status) ?? 'active', sourceRef: src ? (src.startsWith('refs/') ? src : `refs/heads/${src}`) : undefined, top: Math.min(50, num(a.top) ?? 20) }));
    return { content: `${prs.length} pull request(s).`, data: { pullRequests: prs.map((p) => ({ prId: p.pullRequestId, title: short(p.title ?? '', 160), status: p.status, isDraft: p.isDraft === true, sourceBranch: (p.sourceRefName ?? '').replace('refs/heads/', ''), targetBranch: (p.targetRefName ?? '').replace('refs/heads/', ''), mergeStatus: p.mergeStatus ?? 'notSet' })) } };
  }

  async function prFiles(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const t = await resolvePrTarget(svc, run.companyId, cfg, { prId: num(a.prId), repository: str(a.repository), project: str(a.project) });
    const iteration = num(a.iteration) ?? await svc.read(run.companyId, cfg, (api) => api.iterationCount(t.project.projectId, t.repo, t.prId));
    const ch = await svc.read(run.companyId, cfg, (api) => api.prChanges(t.project.projectId, t.repo, t.prId, iteration));
    const files = ch.filter((c) => c.item && !c.item.isFolder).slice(0, 300).map((c) => ({ path: c.item!.path ?? '', changeType: c.changeType ?? 'edit' }));
    return { content: `${files.length} changed file(s) in iteration ${iteration}.`, data: { iteration, files, truncated: ch.length > 300 } };
  }

  async function prFileRead(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const t = await resolvePrTarget(svc, run.companyId, cfg, { prId: num(a.prId), repository: str(a.repository), project: str(a.project) });
    const path = str(a.path) ?? '';
    if (!path || path.length > 1024 || path.includes('\0') || path.split('/').some((s) => s === '..')) throw new ToolError('bad_path', 'Invalid file path');
    const snap = await svc.loadPr(run.companyId, cfg, t.project, t.repo, t.prId);
    const maxBytes = Math.min(65536, num(a.maxBytes) ?? 32768);
    const side = a.side === 'target' ? 'target' : 'source';
    const file = await svc.read(run.companyId, cfg, (api) => side === 'source'
      ? api.fileText(t.project.projectId, t.repo, path.startsWith('/') ? path : `/${path}`, snap.lastMergeSourceCommit, maxBytes * 2)
      : api.fileText(t.project.projectId, t.repo, path.startsWith('/') ? path : `/${path}`, snap.targetRef.replace('refs/heads/', ''), maxBytes * 2, 'branch'));
    if (file.text.includes('\u0000')) throw new ToolError('binary_file', 'Binary files are not returned');
    let text = file.text;
    const start = num(a.startLine);
    if (start && start > 1) text = text.split('\n').slice(start - 1).join('\n');
    const truncated = file.truncated || text.length > maxBytes;
    return { content: `File ${path} (${side} side of !${t.prId})${truncated ? ', truncated' : ''}.`, data: { path, side, truncated, text: untrusted(text.slice(0, maxBytes), maxBytes) } };
  }

  const SCRUB = [/(?:authorization|bearer)\s*[:=]?\s*\S{12,}/gi, /\b(?:pat|token|secret|password|passwd|apikey|api_key)\s*[:=]\s*\S+/gi, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g];
  const scrub = (s: string): string => SCRUB.reduce((t, re) => t.replace(re, '[scrubbed]'), s);

  async function pipelineRunGet(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const project = svc.projectOf(cfg, str(a.project));
    const buildId = num(a.buildId); if (!buildId) throw new ToolError('bad_request', 'buildId is required');
    const b = await svc.read(run.companyId, cfg, (api) => api.getBuild(project.projectId, buildId));
    const data: Record<string, unknown> = { buildId, pipelineId: b.definition?.id ?? null, pipeline: short(b.definition?.name ?? '', 80), status: b.status ?? null, result: b.result ?? null, branch: (b.sourceBranch ?? '').replace('refs/heads/', ''), reason: b.reason ?? null, url: b._links?.web?.href ?? null };
    if (b.result === 'failed' || b.result === 'partiallySucceeded' || bool(a.includeLogTail)) {
      const tl = await svc.read(run.companyId, cfg, (api) => api.buildTimeline(project.projectId, buildId)).catch(() => []);
      const failed = tl.filter((r) => r.result === 'failed' && r.type === 'Task');
      data.failedTasks = failed.slice(0, 10).map((r) => ({ name: short(r.name ?? '', 80), result: r.result }));
      if (bool(a.includeLogTail) && failed[0]?.log?.id) {
        const tail = await svc.read(run.companyId, cfg, (api) => api.buildLog(project.projectId, buildId, failed[0]!.log!.id!, 16 * 1024)).catch(() => '');
        data.logTail = untrusted(scrub(tail), 16 * 1024);
      }
    }
    const taskName = str(a.taskName); const logId = num(a.logId);
    if (taskName || logId) {
      let id = logId;
      if (!id && taskName) {
        const tl = await svc.read(run.companyId, cfg, (api) => api.buildTimeline(project.projectId, buildId)).catch(() => []);
        id = tl.find((r) => (r.name ?? '').toLowerCase() === taskName.toLowerCase() && r.log?.id)?.log?.id;
        if (!id) throw new ToolError('not_found_or_forbidden', 'No task with that name and a log in this run');
      }
      const maxChars = Math.min(32768, num(a.maxChars) ?? 16384);
      const text = await svc.read(run.companyId, cfg, (api) => api.buildLog(project.projectId, buildId, id!, maxChars));
      data.log = { id, tail: untrusted(scrub(text), maxChars) };
    }
    return { content: `Build ${buildId}: ${b.status ?? 'unknown'}${b.result ? ` / ${b.result}` : ''}.`, data };
  }

  async function workItemGet(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const id = num(a.workItemId); if (!id) throw new ToolError('bad_request', 'workItemId is required');
    const project = svc.projectOf(cfg, str(a.project));
    const wi = await svc.read(run.companyId, cfg, (api) => api.getWorkItem(id, true));
    const team = String(wi.fields?.['System.TeamProject'] ?? '');
    if (team.toLowerCase() !== project.name.toLowerCase()) throw new ToolError('not_found_or_forbidden', 'Work item is not in the selected project');
    const snap = await svc.syncWorkItem(run.companyId, cfg, project, id);
    const prs = (wi.relations ?? []).filter((r) => r.rel === 'ArtifactLink' && /PullRequestId/i.test(r.url ?? '')).map((r) => Number(decodeURIComponent(r.url ?? '').split('/').pop())).filter((n) => Number.isInteger(n));
    const data: Record<string, unknown> = { id, type: snap.type, title: short(snap.title, 200), state: snap.state, stateCategory: snap.stateCategory, chip: wiChipStatus(snap).statusKey, assignedTo: short(snap.assignedTo, 80), rev: snap.rev, url: snap.url, pullRequests: prs };
    if (bool(a.includeDescription)) data.description = untrusted(String(wi.fields?.['System.Description'] ?? ''), 4000);
    return { content: `Work item ${id} (${snap.type}) is ${snap.state}.`, data };
  }

  return { ado_health: health, ado_link_list: linkList, ado_pr_get: prGet, ado_pr_find: prFind, ado_pr_files: prFiles, ado_pr_file_read: prFileRead, ado_pr_threads_get: prThreads, ado_pipeline_run_get: pipelineRunGet, ado_work_item_get: workItemGet };
}
