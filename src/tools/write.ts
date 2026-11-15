// Write tools (class W). Every write: role checked in common.finish wrapper (worker), audited, carries a provenance footer, idempotent.
import { createHash } from 'node:crypto';
import { AdoError } from '../ado/client.ts';
import { prChipStatus } from '../ado/model.ts';
import { provenanceMarker } from '../links.ts';
import { issueKeyFromBranch } from '../links.ts';
import { NS } from '../namespace.ts';
import { neutralize } from '../sanitize.ts';
import type { Service } from '../service.ts';
import { audit, footer, identityId, isAuthorAgent, requireRepo, resolvePrTarget, roleAllowed, sourceBranchOk, toRef, ToolError, workProductStep, type RunCtx, type ToolOut } from './common.ts';
import { prView } from './read.ts';
import type { IssueRef } from '../host.ts';

type A = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED = ['done', 'cancelled'];

export function makeWriteTools(svc: Service, agentName: (companyId: string, agentId: string) => Promise<string>) {
  const host = svc.host;
  const nowIso = () => new Date(host.now()).toISOString();

  async function resolveIssue(run: RunCtx, issueId: string | undefined, branch?: string): Promise<IssueRef | null> {
    if (issueId) {
      if (!UUID.test(issueId)) throw new ToolError('bad_request', 'issueId must be a UUID');
      const i = await host.issues.get(run.companyId, issueId);
      if (!i) throw new ToolError('issue_not_found', 'Issue not found in this company');
      return i;
    }
    const mine = await svc.issueForRun(run.companyId, run.agentId, undefined, run.runId);
    if (mine) return mine;
    const key = branch ? issueKeyFromBranch(branch)?.key : undefined;
    return key ? host.issues.findByIdentifier(run.companyId, key) : null;
  }

  async function prCreate(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(a.repository), project: str(a.project) });
    const source = str(a.sourceBranch) ?? ''; const target = str(a.targetBranch) ?? 'main';
    if (!sourceBranchOk(source) || !sourceBranchOk(target)) throw new ToolError('bad_branch', 'Branch names may only contain letters, digits and . _ / -');
    if (source === target) throw new ToolError('bad_branch', 'Source and target branch are the same');
    const issue = await resolveIssue(run, str(a.issueId), source);
    if (issue && CLOSED.includes(issue.status)) throw new ToolError('issue_closed', `${issue.identifier} is ${issue.status}`);
    const api = svc.api(run.companyId, cfg, 'author');
    const me = await identityId(svc, run.companyId, cfg, 'author');
    let existing = (await api.listPrs(project.projectId, repo, { status: 'active', sourceRef: toRef(source), top: 5 })).find((p) => p.targetRefName === toRef(target));
    let created = false;
    if (!existing) {
      const name = await agentName(run.companyId, run.agentId);
      let title = String(a.title ?? '').trim().slice(0, 256);
      if (!title) throw new ToolError('bad_request', 'title is required');
      if (issue && !title.toUpperCase().includes(issue.identifier.toUpperCase())) title = `[${issue.identifier}] ${title}`.slice(0, 256);
      const description = (String(a.description ?? '').slice(0, 4000) + footer(name, issue, run.runId) + (issue ? `\n${provenanceMarker(issue.id, run.agentId, run.runId)}` : '')).slice(0, 4000 + 400);
      const wi = Array.isArray(a.workItemIds) ? a.workItemIds.filter((n): n is number => Number.isInteger(n)).slice(0, 10) : [];
      try { existing = await api.createPr(project.projectId, repo, { sourceRef: toRef(source), targetRef: toRef(target), title, description, isDraft: a.draft === true, workItemIds: wi }); created = true; }
      catch (e) {
        if (!(e instanceof AdoError && e.code === 'ado_conflict')) throw e;
        existing = (await api.listPrs(project.projectId, repo, { status: 'active', sourceRef: toRef(source), top: 5 }))[0];
        if (!existing) throw e;
      }
    }
    const prId = existing.pullRequestId;
    // Link first: the review status is only published for pull requests that have a linked issue.
    if (issue) await svc.store.addLink({ id: host.uuid(), companyId: run.companyId, issueId: issue.id, kind: 'pull_request', org: cfg.organization.name, projectId: project.projectId, repoId: existing.repository?.id ?? '', externalId: String(prId), source: created || existing.createdBy?.id === me ? 'created' : 'tool', confidence: 'exact', authorAgentId: created ? run.agentId : null, runId: run.runId }, nowIso());
    const { snap } = await svc.syncPr(run.companyId, cfg, project, repo, prId, 'tool:ado_pr_create');
    if (issue) {
      if (await svc.store.once(run.companyId, `pr:${snap.projectId}/${snap.repoId}/${prId}:opened:${issue.id}`, nowIso()))
        await host.issues.comment(run.companyId, issue.id, `Azure DevOps pull request !${prId} opened: ${snap.url}`).catch(() => {});
    }
    await audit(svc, host, run, 'ado_pr_create', { prId, repo }, created ? 'created' : 'existing', issue?.id);
    return {
      content: `${created ? 'Opened' : 'Found the open'} pull request !${prId}: ${snap.url}`,
      data: { ...prView(snap, false), created, linkedIssue: issue?.identifier ?? null, warning: issue ? undefined : 'no_issue_link', nextSteps: issue ? [workProductStep(issue.id, snap), { kind: 'comment', text: `PR opened: ${snap.url}`, note: 'Posting the URL yourself makes Paperclip render a live status chip.' }] : [] },
    };
  }

  async function ownPr(run: RunCtx, projectId: string, repoId: string, prId: number): Promise<boolean> {
    const rows = await host.db.query<{ n: string }>(`SELECT count(*)::text n FROM ${NS}.link WHERE company_id=$1 AND kind='pull_request' AND project_id=$2 AND repo_id=$3 AND external_id=$4 AND source IN ('created','adopted')`, [run.companyId, projectId, repoId, String(prId)]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async function prUpdate(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    const t = await resolvePrTarget(svc, run.companyId, cfg, { prId: num(a.prId), repository: str(a.repository), project: str(a.project) });
    const snap = await svc.loadPr(run.companyId, cfg, t.project, t.repo, t.prId);
    if (snap.terminal) throw new ToolError('pr_closed', 'The pull request is already completed or abandoned');
    const own = await ownPr(run, snap.projectId, snap.repoId, snap.prId);
    // Operators coordinate work and may publish or un-draft a pull request; the opener's text stays with the opener and the authors.
    const draftOnly = !isAuthorAgent(cfg, run.agentId);
    if (draftOnly && (Object.keys(a).some((k) => !['prId', 'repository', 'project', 'draft'].includes(k)) || typeof a.draft !== 'boolean')) throw new ToolError('role_denied', 'Operators may only change the draft state (draft true or false); title and description are for authors');
    if (!own) {
      // A pull request somebody opened by hand: the author agent or an operator who has it linked to an issue assigned to them may publish
      // it or take it back to draft (so it can be reviewed), and nothing else. Its title and text stay the opener's.
      const links = await svc.store.linksForObject(run.companyId, 'pull_request', snap.org, snap.projectId, snap.repoId, String(snap.prId));
      const mine = (await Promise.all(links.map((l) => host.issues.get(run.companyId, l.issueId)))).some((i) => i?.assigneeAgentId?.toLowerCase() === run.agentId.toLowerCase());
      const mayPublish = mine || roleAllowed(cfg, run.agentId, 'operator');
      if (!mayPublish || Object.keys(a).some((k) => !['prId', 'repository', 'project', 'draft'].includes(k)) || typeof a.draft !== 'boolean') throw new ToolError('not_plugin_pr', 'This pull request was opened by hand. Only its draft state can be changed, by an author agent or operator whose own issue it is linked to (set draft true or false)');
    }
    const patch: Record<string, unknown> = {};
    if (typeof a.title === 'string' && a.title.trim()) patch.title = a.title.trim().slice(0, 256);
    if (typeof a.description === 'string') patch.description = a.description.slice(0, 4000) + footer(await agentName(run.companyId, run.agentId), null, run.runId);
    if (typeof a.draft === 'boolean') patch.isDraft = a.draft;
    if (Object.keys(patch).length === 0) throw new ToolError('bad_request', 'Nothing to change');
    await svc.api(run.companyId, cfg, 'author').updatePr(snap.projectId, snap.repoId, snap.prId, patch);
    const { snap: next } = await svc.syncPr(run.companyId, cfg, t.project, t.repo, t.prId, 'tool:ado_pr_update');
    await audit(svc, host, run, 'ado_pr_update', { prId: snap.prId, fields: Object.keys(patch) }, 'ok');
    return { content: `Updated !${snap.prId}.`, data: prView(next, false) };
  }

  const isReviewer = (cfgReviewers: string[], id: string) => cfgReviewers.some((x) => x.toLowerCase() === id.toLowerCase());

  async function prComment(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    const t = await resolvePrTarget(svc, run.companyId, cfg, { prId: num(a.prId), repository: str(a.repository), project: str(a.project) });
    const content = String(a.content ?? '').trim().slice(0, 4000);
    if (!content) throw new ToolError('bad_request', 'content is required');
    const role = isReviewer(cfg.roles.reviewerAgentIds, run.agentId) ? 'reviewer' : 'author';
    const api = svc.api(run.companyId, cfg, role);
    const snap = await svc.loadPr(run.companyId, cfg, t.project, t.repo, t.prId);
    if (snap.terminal) throw new ToolError('pr_closed', 'The pull request is already completed or abandoned');
    const body = content + footer(await agentName(run.companyId, run.agentId), null, run.runId);
    const threadId = num(a.threadId);
    let out: { threadId: number; commentId?: number };
    if (threadId) { const c = await api.replyThread(snap.projectId, snap.repoId, snap.prId, threadId, body); out = { threadId, commentId: c.id }; if (a.status) await api.setThreadStatus(snap.projectId, snap.repoId, snap.prId, threadId, String(a.status)); }
    else {
      const th = await api.createThread(snap.projectId, snap.repoId, snap.prId, { content: body, filePath: str(a.filePath), line: num(a.line), side: a.side === 'target' ? 'target' : 'source', iteration: snap.iterationCount, status: str(a.status) });
      out = { threadId: th.id, commentId: th.comments?.[0]?.id };
    }
    await audit(svc, host, run, 'ado_pr_comment_post', { prId: snap.prId, thread: out.threadId }, 'ok');
    return { content: `Comment posted on !${snap.prId}.`, data: out };
  }

  async function prReview(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    const t = await resolvePrTarget(svc, run.companyId, cfg, { prId: num(a.prId), repository: str(a.repository), project: str(a.project) });
    const vote = num(a.vote);
    if (vote === undefined || ![10, 5, 0, -5, -10].includes(vote)) throw new ToolError('bad_request', 'vote must be 10, 5, 0, -5 or -10');
    const summary = String(a.summary ?? '').trim().slice(0, 4000);
    if (!summary) throw new ToolError('bad_request', 'summary is required');
    const api = svc.api(run.companyId, cfg, 'reviewer');
    const snap = await svc.loadPr(run.companyId, cfg, t.project, t.repo, t.prId);
    const target = { prId: snap.prId, repo: snap.repoName };
    const refuse = async (code: string, msg: string): Promise<never> => { await audit(svc, host, run, 'ado_pr_review_post', target, `refused:${code}`); throw new ToolError(code, msg); };
    if (snap.terminal) await refuse('pr_closed', 'The pull request is already completed or abandoned');
    if (snap.isDraft) await refuse('pr_draft', 'Reviewers cannot vote on a draft pull request');
    const iteration = num(a.iteration);
    if (iteration !== snap.iterationCount) await refuse('pr_changed', `The pull request is now at iteration ${snap.iterationCount}; read it again before reviewing`);
    if (cfg.review.requireIndependentReviewer) {
      const reviewerId = await identityId(svc, run.companyId, cfg, 'reviewer');
      if (snap.createdById && snap.createdById === reviewerId) await refuse('self_review', 'The reviewer identity opened this pull request');
      const links = await svc.store.linksForObject(run.companyId, 'pull_request', snap.org, snap.projectId, snap.repoId, String(snap.prId));
      if (links.some((l) => l.authorAgentId && l.authorAgentId.toLowerCase() === run.agentId.toLowerCase())) await refuse('self_review', 'You authored this pull request and cannot review it');
    }
    // Persist the current iteration first: the iteration effect (status pending) must happen BEFORE our verdict, never overwrite it.
    await svc.syncPr(run.companyId, cfg, t.project, t.repo, t.prId, 'tool:ado_pr_review_post:pre');
    const threads = Array.isArray(a.threads) ? (a.threads as A[]).slice(0, cfg.review.maxThreadsPerReview) : [];
    const reviewerId = await identityId(svc, run.companyId, cfg, 'reviewer');
    const name = await agentName(run.companyId, run.agentId);
    await api.putReviewer(snap.projectId, snap.repoId, snap.prId, reviewerId, vote);
    // The merge approval flow reads these rows, never comments: which agent (by function) voted what on exactly this commit.
    for (const fn of Object.keys(cfg.approval.verdictFunctions)) {
      if (!cfg.approval.verdictFunctions[fn]!.some((x) => x.toLowerCase() === run.agentId.toLowerCase())) continue;
      await svc.store.addVerdict({ id: host.uuid(), companyId: run.companyId, org: snap.org, projectId: snap.projectId, repoId: snap.repoId, prId: snap.prId, commit: snap.lastMergeSourceCommit, iteration: snap.iterationCount, agentId: run.agentId, fn, vote, runId: run.runId, at: nowIso() });
    }
    let posted = 0;
    for (const th of threads) {
      const file = str(th.filePath); const line = num(th.line); const content = String(th.content ?? '').trim().slice(0, 2000);
      if (!file || !line || !content) continue;
      await api.createThread(snap.projectId, snap.repoId, snap.prId, { content, filePath: file.startsWith('/') ? file : `/${file}`, line, side: th.side === 'target' ? 'target' : 'source', iteration: snap.iterationCount });
      posted++;
    }
    const label = ({ 10: 'approved', 5: 'approved with suggestions', 0: 'no vote', [-5]: 'waiting for author', [-10]: 'rejected' } as Record<number, string>)[vote];
    await api.createThread(snap.projectId, snap.repoId, snap.prId, { content: `Review (${label}):\n\n${summary}${footer(name, null, run.runId)}`, status: 'closed' });
    if (cfg.review.publishStatus && vote !== 0) {
      await api.postStatus(snap.projectId, snap.repoId, snap.prId, { state: vote >= 5 ? 'succeeded' : vote === -5 ? 'pending' : 'failed', description: vote >= 5 ? 'Approved by Paperclip review' : vote === -5 ? 'Waiting for the author' : 'Rejected by Paperclip review', genre: cfg.review.statusGenre, name: cfg.review.statusName, iterationId: snap.iterationCount });
    }
    const { snap: next, links } = await svc.syncPr(run.companyId, cfg, t.project, t.repo, t.prId, 'tool:ado_pr_review_post');
    for (const l of links) if (await svc.store.once(run.companyId, `review:${snap.projectId}/${snap.repoId}/${snap.prId}:${snap.iterationCount}:${vote}:${l.issueId}`, nowIso())) await host.issues.comment(run.companyId, l.issueId, `Review of !${snap.prId}: ${label} by ${neutralize(name.slice(0, 60))} (iteration ${snap.iterationCount}). ${snap.url}`).catch(() => {});
    await audit(svc, host, run, 'ado_pr_review_post', target, 'ok', links[0]?.issueId, { vote, threads: posted });
    return { content: `Review recorded on !${snap.prId}: ${label}.`, data: { vote, threadsPosted: posted, statusPublished: cfg.review.publishStatus && vote !== 0, state: prChipStatus(next, cfg.review.publishStatus).statusKey } };
  }

  async function workItemUpdate(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    const id = num(a.workItemId); if (!id) throw new ToolError('bad_request', 'workItemId is required');
    const project = svc.projectOf(cfg, str(a.project));
    const api = svc.api(run.companyId, cfg, 'author');
    const before = await api.getWorkItem(id);
    if (String(before.fields?.['System.TeamProject'] ?? '').toLowerCase() !== project.name.toLowerCase()) throw new ToolError('not_found_or_forbidden', 'Work item is not in the selected project');
    const ops: Array<{ op: 'add' | 'replace' | 'test'; path: string; value?: unknown }> = [{ op: 'test', path: '/rev', value: before.rev }];
    if (typeof a.state === 'string' && a.state) ops.push({ op: 'add', path: '/fields/System.State', value: a.state.slice(0, 100) });
    if (typeof a.comment === 'string' && a.comment) ops.push({ op: 'add', path: '/fields/System.History', value: neutralize(a.comment.slice(0, 4000)).replace(/</g, '&lt;') + footer(await agentName(run.companyId, run.agentId), null, run.runId).replace(/\n/g, '<br>') });
    const prId = num(a.linkPrId);
    if (prId) {
      const { repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(a.repository), project: str(a.project) });
      const snap = await svc.loadPr(run.companyId, cfg, project, repo, prId);
      if (!svc.repoInScope(project, snap.repoName, snap.repoId)) throw new ToolError('repo_not_in_scope', 'Repository is not in the configured scope');
      ops.push({ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${snap.projectId}%2F${snap.repoId}%2F${prId}`, attributes: { name: 'Pull Request' } } });
    }
    if (ops.length === 1) throw new ToolError('bad_request', 'Nothing to change');
    const after = await api.patchWorkItem(id, ops);
    await svc.syncWorkItem(run.companyId, cfg, project, id).catch(() => {});
    await audit(svc, host, run, 'ado_work_item_update', { workItemId: id }, 'ok');
    return { content: `Updated work item ${id}.`, data: { id, rev: after.rev ?? null, state: String(after.fields?.['System.State'] ?? '') } };
  }

  async function linkCreate(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await svc.cfg(run.companyId);
    const issue = await resolveIssue(run, str(a.issueId));
    if (!issue) throw new ToolError('no_issue', 'Give issueId: this run has no single in-progress issue');
    // Linking can move an issue forward later (merge) and wake its assignee: only the assignee or an operator may bind it by id.
    if (str(a.issueId) && issue.assigneeAgentId?.toLowerCase() !== run.agentId.toLowerCase() && !roleAllowed(cfg, run.agentId, 'operator')) throw new ToolError('not_your_issue', 'You can only link issues assigned to you');
    const id = num(a.externalId); if (!id) throw new ToolError('bad_request', 'externalId is required');
    const project = svc.projectOf(cfg, str(a.project));
    if (a.kind === 'pull_request') {
      const repo = str(a.repository); if (!repo) throw new ToolError('bad_request', 'repository is required for a pull request');
      if (!svc.repoAllowed(project, repo)) throw new ToolError('repo_not_in_scope', 'Repository is not in the configured scope');
      const { snap } = await svc.syncPr(run.companyId, cfg, project, repo, id, 'tool:ado_link_create');
      await svc.store.addLink({ id: host.uuid(), companyId: run.companyId, issueId: issue.id, kind: 'pull_request', org: snap.org, projectId: snap.projectId, repoId: snap.repoId, externalId: String(id), source: 'tool', confidence: 'exact', runId: run.runId }, nowIso());
      let claimed = false;
      if (a.author === true) {
        // A pull request somebody opened by hand has no recorded author, so it can be neither approved nor updated. The agent that wrote the work
        // may say so, once, for its own assigned issue; reviewers and approvers are not authors and cannot.
        if (!isAuthorAgent(cfg, run.agentId)) throw new ToolError('role_denied', 'Only an author agent can record itself as the author of a pull request');
        if (issue.assigneeAgentId?.toLowerCase() !== run.agentId.toLowerCase()) throw new ToolError('not_your_issue', 'You can only record yourself as author on an issue assigned to you');
        if (snap.terminal) throw new ToolError('pr_closed', 'The pull request is already completed or abandoned');
        const res = await svc.store.claimAuthor(run.companyId, issue.id, snap.org, snap.projectId, snap.repoId, String(id), run.agentId);
        if (res !== 'claimed') throw new ToolError('author_already_recorded', 'An author is already recorded for this pull request');
        claimed = true;
      }
      await audit(svc, host, run, 'ado_link_create', { kind: 'pull_request', id }, claimed ? 'ok:author_recorded' : 'ok', issue.id);
      return { content: `Linked !${id} to ${issue.identifier}${claimed ? ' and recorded you as its author' : ''}.`, data: { authorRecorded: claimed, nextSteps: [workProductStep(issue.id, snap)] } };
    }
    if (a.kind === 'work_item') {
      const w = await svc.syncWorkItem(run.companyId, cfg, project, id);
      await svc.store.addLink({ id: host.uuid(), companyId: run.companyId, issueId: issue.id, kind: 'work_item', org: w.org, projectId: project.projectId, repoId: '', externalId: String(id), source: 'tool', confidence: 'exact', runId: run.runId }, nowIso());
      await audit(svc, host, run, 'ado_link_create', { kind: 'work_item', id }, 'ok', issue.id);
      return { content: `Linked work item ${id} to ${issue.identifier}.`, data: { state: w.state } };
    }
    if (a.kind === 'build') {
      await svc.syncBuild(run.companyId, cfg, project, id, 'tool:ado_link_create');
      await svc.store.addLink({ id: host.uuid(), companyId: run.companyId, issueId: issue.id, kind: 'build', org: cfg.organization.name, projectId: project.projectId, repoId: '', externalId: String(id), source: 'tool', confidence: 'exact', runId: run.runId }, nowIso());
      await audit(svc, host, run, 'ado_link_create', { kind: 'build', id }, 'ok', issue.id);
      return { content: `Linked build ${id} to ${issue.identifier}.`, data: {} };
    }
    throw new ToolError('bad_request', 'kind must be pull_request, work_item or build');
  }

  /**
   * A client that loses a tool result (or an agent that retries after an error it could not read) must not post twice. The same run
   * sending the same call within the retention window gets the first outcome's acknowledgement instead of a duplicate write.
   * The key is released when the first attempt fails, so a real retry still works.
   */
  const noReplay = (name: string, fn: (a: A, run: RunCtx) => Promise<ToolOut>) => async (a: A, run: RunCtx): Promise<ToolOut> => {
    const key = `replay:${run.runId}:${name}:${createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0, 32)}`;
    if (!(await svc.store.once(run.companyId, key, nowIso()))) return { content: 'This exact call was already made in this run and went through; it was not repeated. Check the pull request instead of retrying.', data: { duplicate: true } };
    try { return await fn(a, run); } catch (e) { await svc.store.forget(run.companyId, key).catch(() => {}); throw e; }
  };

  return { ado_pr_create: prCreate, ado_pr_update: prUpdate, ado_pr_comment_post: noReplay('ado_pr_comment_post', prComment), ado_pr_review_post: noReplay('ado_pr_review_post', prReview), ado_work_item_update: workItemUpdate, ado_link_create: linkCreate };
}

