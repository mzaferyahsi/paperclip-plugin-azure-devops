// Typed wrappers over the REST calls the plugin makes. One place for URLs and bodies; no business rules here.
import { AdoClient, AdoError } from './client.ts';
import type { AdoBuild, AdoPolicyEvaluation, AdoPullRequest, AdoWorkItem } from './model.ts';

export const APPROVAL_CHECK_TYPE = '8C6F20A7-A545-4486-9777-F762FAFE0D4D';
const enc = encodeURIComponent;
export interface VariableGroupBody { id?: number; name?: string; description?: string; type?: string; variables?: Record<string, { value?: string | null; isSecret?: boolean }> }
const git = (repo: string) => `git/repositories/${enc(repo)}`;
const list = <T>(r: unknown): T[] => (r && typeof r === 'object' && Array.isArray((r as { value?: unknown }).value) ? ((r as { value: T[] }).value) : []);

export class AdoShapeError extends AdoError {
  constructor() { super('ado_bad_request', 0, 'Unexpected Azure DevOps approval or build facts shape'); }
}
const shape = (): never => { throw new AdoShapeError(); };
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : shape();
const positive = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : shape();
const text = (v: unknown): string => typeof v === 'string' && v.length > 0 && v.length <= 1000 ? v : shape();
const guid = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v) ? v : shape();
const statusOf = (v: unknown, allowed: string[]): string => typeof v === 'string' && allowed.includes(v) ? v : shape();
const approvalStatuses = ['undefined', 'uninitiated', 'pending', 'approved', 'rejected', 'skipped', 'canceled', 'timedOut', 'failed'];
const resourceLink = (v: unknown) => {
  const r = record(v);
  const id = text(r.id);
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) shape();
  return { type: text(r.type), id };
};
export function parsePipelineApproval(v: unknown) {
  const a = record(v);
  if (!Array.isArray(a.steps) || !a.steps.length || a.steps.length > 100) shape();
  const check = a.checkConfiguration === undefined ? undefined : record(a.checkConfiguration);
  return {
    id: guid(a.id), status: statusOf(a.status, approvalStatuses),
    steps: (a.steps as unknown[]).map(v => { const s = record(v); return { assignedApprover: { id: guid(record(s.assignedApprover).id) }, status: statusOf(s.status, approvalStatuses) }; }),
    // Require explicit run/pipeline links because guessing an undocumented association could authorize the wrong run.
    owner: { id: positive(record(a.owner).id) }, pipeline: { id: positive(record(a.pipeline).id) },
    ...(check ? { checkConfiguration: { id: positive(check.id), ...(check.resource === undefined ? {} : { resource: resourceLink(check.resource) }) } } : {}),
    ...(a.resource === undefined ? {} : { resource: resourceLink(a.resource) }),
  };
}
export function parseBuildFacts(v: unknown) {
  const b = record(v);
  let parameters: Record<string, unknown> = {};
  if (b.parameters !== undefined) {
    if (typeof b.parameters !== 'string') shape();
    try { parameters = record(JSON.parse(b.parameters as string)); } catch { shape(); }
  }
  const templateParameters = b.templateParameters === undefined ? {} : record(b.templateParameters);
  for (const [key, value] of Object.entries(templateParameters)) {
    if (Object.hasOwn(parameters, key) && JSON.stringify(parameters[key]) !== JSON.stringify(value)) shape();
    parameters[key] = value;
  }
  const sourceVersion = text(b.sourceVersion);
  if (!/^[0-9a-f]{40}$/i.test(sourceVersion)) shape();
  return {
    id: positive(b.id), definition: { id: positive(record(b.definition).id) },
    status: statusOf(b.status, ['none', 'inProgress', 'completed', 'cancelling', 'postponed', 'notStarted', 'all']),
    result: b.result === undefined || b.result === null ? undefined : statusOf(b.result, ['none', 'succeeded', 'partiallySucceeded', 'failed', 'canceled']),
    sourceBranch: text(b.sourceBranch), sourceVersion, reason: statusOf(b.reason, ['none', 'manual', 'individualCI', 'batchedCI', 'schedule', 'scheduleForced', 'userCreated', 'validateShelveset', 'checkInShelveset', 'pullRequest', 'buildCompletion', 'resourceTrigger']),
    requestedFor: { id: guid(record(b.requestedFor).id) }, requestedBy: { id: guid(record(b.requestedBy).id) }, parameters,
  };
}

export class AdoApi {
  readonly c: AdoClient;
  constructor(client: AdoClient) { this.c = client; }

  private requireAdmin(): void { if (this.c.role !== 'admin') throw new AdoError('ado_config', 0, 'This API requires identities.admin'); }
  async pipelineApprovals(project: string, q: { approvalIds?: string[]; state?: string }) {
    this.requireAdmin();
    if (q.approvalIds !== undefined) { if (!Array.isArray(q.approvalIds) || !q.approvalIds.length || q.approvalIds.length > 100) shape(); q.approvalIds.forEach(guid); }
    if (q.state !== undefined) statusOf(q.state, approvalStatuses);
    const r = record(await this.c.get('pipelines/approvals', { approvalIds: q.approvalIds?.join(','), state: q.state, $expand: 'steps' }, project, { apiVersion: '7.1-preview' }));
    if (!Array.isArray(r.value)) shape();
    return (r.value as unknown[]).map(parsePipelineApproval);
  }
  async decidePipelineApproval(project: string, approvalId: string, status: 'approved' | 'rejected', comment: string) {
    this.requireAdmin(); guid(approvalId); statusOf(status, ['approved', 'rejected']); text(comment);
    const r = record((await this.c.request('PATCH', 'pipelines/approvals', { project, apiVersion: '7.1-preview', body: [{ approvalId, status, comment }] })).data);
    if (!Array.isArray(r.value)) shape();
    return (r.value as unknown[]).map(parsePipelineApproval);
  }
  async checkConfiguration(project: string, id: number) {
    this.requireAdmin(); positive(id);
    const r = record(await this.c.get(`pipelines/checks/configurations/${id}`, { $expand: 'settings' }, project, { apiVersion: '7.1-preview.1' }));
    if (positive(r.id) !== id) shape();
    return { id, type: { id: guid(record(r.type).id), name: text(record(r.type).name) }, resource: resourceLink(r.resource) };
  }
  async buildFacts(project: string, id: number) {
    this.requireAdmin(); positive(id);
    const facts = parseBuildFacts(await this.getBuild(project, id));
    if (facts.id !== id) shape();
    return facts;
  }

  connectionData() { return this.c.get<{ authenticatedUser?: { id?: string; providerDisplayName?: string; customDisplayName?: string } }>('connectionData', undefined, undefined, { apiVersion: '7.1-preview.1' }); }
  async listProjects() { return list<{ id: string; name: string; state?: string }>(await this.c.get('projects', { $top: 200 })); }
  async listRepos(project: string) { return list<{ id: string; name: string; isDisabled?: boolean; defaultBranch?: string }>(await this.c.get('git/repositories', undefined, project)); }

  getPr(project: string, repo: string, prId: number, etag?: string) {
    return this.c.request<AdoPullRequest>('GET', `${git(repo)}/pullrequests/${prId}`, { project, etag, allowNotModified: !!etag });
  }
  async listPrs(project: string, repo: string, q: { status?: string; sourceRef?: string; top?: number }) {
    return list<AdoPullRequest>(await this.c.get(`${git(repo)}/pullrequests`, { 'searchCriteria.status': q.status ?? 'active', 'searchCriteria.sourceRefName': q.sourceRef, $top: q.top ?? 50 }, project));
  }
  async iterationCount(project: string, repo: string, prId: number): Promise<number> {
    return list<unknown>(await this.c.get(`${git(repo)}/pullrequests/${prId}/iterations`, undefined, project)).length;
  }
  async policyEvaluations(project: string, projectId: string, prId: number): Promise<AdoPolicyEvaluation[]> {
    return list<AdoPolicyEvaluation>(await this.c.get('policy/evaluations', { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}` }, project, { apiVersion: '7.1-preview.1' }));
  }
  /** Asks Azure DevOps to evaluate a policy again (for a build policy: queue its pipeline on the current head). */
  async requeuePolicyEvaluation(project: string, evaluationId: string) {
    return (await this.c.request<{ status?: string; evaluationId?: string }>('PATCH', `policy/evaluations/${encodeURIComponent(evaluationId)}`, { project, apiVersion: '7.1-preview.1' })).data;
  }
  async prStatuses(project: string, repo: string, prId: number) {
    return list<{ id?: number; state?: string; description?: string; context?: { name?: string; genre?: string }; iterationId?: number; creationDate?: string; updatedDate?: string }>(await this.c.get(`${git(repo)}/pullrequests/${prId}/statuses`, undefined, project));
  }
  async prChanges(project: string, repo: string, prId: number, iteration: number) {
    const r = await this.c.get<{ changeEntries?: Array<{ changeType?: string; item?: { path?: string; isFolder?: boolean } }> }>(`${git(repo)}/pullrequests/${prId}/iterations/${iteration}/changes`, undefined, project);
    return r.changeEntries ?? [];
  }
  async fileText(project: string, repo: string, path: string, version: string, maxBytes: number, versionType: 'commit' | 'branch' = 'commit') {
    const res = await this.c.request<string>('GET', `${git(repo)}/items`, { project, raw: true, accept: 'text/plain', query: { path, 'versionDescriptor.version': version, 'versionDescriptor.versionType': versionType, includeContent: true, $format: 'text' } });
    const text = String(res.data ?? '');
    return text.length > maxBytes ? { text: text.slice(0, maxBytes), truncated: true } : { text, truncated: false };
  }
  async threads(project: string, repo: string, prId: number) {
    return list<{ id: number; status?: string; threadContext?: { filePath?: string; rightFileStart?: { line?: number } }; comments?: Array<{ id: number; content?: string; author?: { id?: string; displayName?: string }; commentType?: string; isDeleted?: boolean }> }>(await this.c.get(`${git(repo)}/pullrequests/${prId}/threads`, undefined, project));
  }
  async createThread(project: string, repo: string, prId: number, body: { content: string; filePath?: string; line?: number; side?: 'source' | 'target'; iteration?: number; status?: string }) {
    const ctx = body.filePath ? (body.side === 'target'
      ? { filePath: body.filePath, leftFileStart: { line: body.line ?? 1, offset: 1 }, leftFileEnd: { line: body.line ?? 1, offset: 1 } }
      : { filePath: body.filePath, rightFileStart: { line: body.line ?? 1, offset: 1 }, rightFileEnd: { line: body.line ?? 1, offset: 1 } }) : undefined;
    const payload: Record<string, unknown> = { comments: [{ parentCommentId: 0, content: body.content, commentType: 'text' }], status: body.status ?? 'active' };
    if (ctx) payload.threadContext = ctx;
    if (ctx && body.iteration) payload.pullRequestThreadContext = { iterationContext: { firstComparingIteration: body.iteration, secondComparingIteration: body.iteration } };
    return (await this.c.request<{ id: number; comments?: Array<{ id: number }> }>('POST', `${git(repo)}/pullrequests/${prId}/threads`, { project, body: payload })).data;
  }
  async replyThread(project: string, repo: string, prId: number, threadId: number, content: string) {
    return (await this.c.request<{ id: number }>('POST', `${git(repo)}/pullrequests/${prId}/threads/${threadId}/comments`, { project, body: { content, parentCommentId: 1, commentType: 'text' } })).data;
  }
  async setThreadStatus(project: string, repo: string, prId: number, threadId: number, status: string) {
    await this.c.request('PATCH', `${git(repo)}/pullrequests/${prId}/threads/${threadId}`, { project, body: { status } });
  }
  async putReviewer(project: string, repo: string, prId: number, reviewerId: string, vote: number) {
    return (await this.c.request<{ vote?: number }>('PUT', `${git(repo)}/pullrequests/${prId}/reviewers/${enc(reviewerId)}`, { project, body: { vote } })).data;
  }
  async postStatus(project: string, repo: string, prId: number, s: { state: 'pending' | 'succeeded' | 'failed' | 'error' | 'notApplicable'; description: string; genre: string; name: string; targetUrl?: string; iterationId?: number }) {
    const body: Record<string, unknown> = { state: s.state, description: s.description.slice(0, 400), context: { name: s.name, genre: s.genre } };
    if (s.targetUrl) body.targetUrl = s.targetUrl;
    if (s.iterationId) body.iterationId = s.iterationId;
    return (await this.c.request('POST', `${git(repo)}/pullrequests/${prId}/statuses`, { project, body })).data;
  }
  async createPr(project: string, repo: string, b: { sourceRef: string; targetRef: string; title: string; description: string; isDraft: boolean; workItemIds?: number[] }) {
    const body: Record<string, unknown> = { sourceRefName: b.sourceRef, targetRefName: b.targetRef, title: b.title, description: b.description, isDraft: b.isDraft };
    if (b.workItemIds?.length) body.workItemRefs = b.workItemIds.map((id) => ({ id: String(id) }));
    return (await this.c.request<AdoPullRequest>('POST', `${git(repo)}/pullrequests`, { project, body })).data;
  }
  async updatePr(project: string, repo: string, prId: number, patch: Record<string, unknown>) {
    return (await this.c.request<AdoPullRequest>('PATCH', `${git(repo)}/pullrequests/${prId}`, { project, body: patch })).data;
  }
  /** Completion never sets bypassPolicy: the field is written explicitly as false so a changed server default cannot widen it. */
  completePr(project: string, repo: string, prId: number, lastMergeSourceCommit: string, o: { mergeStrategy: string; deleteSourceBranch: boolean; transitionWorkItems: boolean }) {
    return this.updatePr(project, repo, prId, { status: 'completed', lastMergeSourceCommit: { commitId: lastMergeSourceCommit }, completionOptions: { mergeStrategy: o.mergeStrategy, deleteSourceBranch: o.deleteSourceBranch, transitionWorkItems: o.transitionWorkItems, bypassPolicy: false } });
  }
  abandonPr(project: string, repo: string, prId: number) { return this.updatePr(project, repo, prId, { status: 'abandoned' }); }

  getBuild(project: string, buildId: number) { return this.c.get<AdoBuild>(`build/builds/${buildId}`, undefined, project); }
  // ---- release bundle (0.17.0): raw reads the bundle engine compares itself, a cancel, and the commit/artifact reads
  async getBuildRaw(project: string, buildId: number) { return this.c.get<Record<string, unknown>>(`build/builds/${buildId}`, undefined, project); }
  async buildsRaw(project: string, q: { definition: number; minTime: string; top: number }) {
    return list<Record<string, unknown>>(await this.c.get('build/builds', { definitions: q.definition, minTime: q.minTime, statusFilter: 'all', queryOrder: 'queueTimeDescending', $top: q.top }, project));
  }
  /** Ask Azure DevOps to cancel a run. Narrowing only; the bundle calls it for a run that still waits at the environment approval. */
  async cancelBuild(project: string, buildId: number) { await this.c.request('PATCH', `build/builds/${positive(buildId)}`, { project, body: { status: 'cancelling' } }); }
  /** Commits main has that `commit` lacks (aheadCount) and commits `commit` has that main lacks (behindCount). Base is the commit, target is main. */
  async commitVsBranch(project: string, repo: string, commit: string, branch: string, targetType: 'branch' | 'commit' = 'branch') {
    const r = await this.c.get<{ aheadCount?: number; behindCount?: number; changeCounts?: Record<string, number> }>(`${git(repo)}/diffs/commits`, { baseVersion: commit, baseVersionType: 'commit', targetVersion: branch, targetVersionType: targetType, $top: 1 }, project);
    return { ahead: Number(r.aheadCount ?? NaN), behind: Number(r.behindCount ?? NaN) };
  }
  async commitInfo(project: string, repo: string, commit: string) {
    const r = await this.c.get<{ commitId?: string; comment?: string; author?: { name?: string; date?: string }; parents?: string[] }>(`${git(repo)}/commits/${enc(commit)}`, undefined, project);
    return { commitId: String(r.commitId ?? ''), subject: String(r.comment ?? '').split('\n')[0] ?? '', author: String(r.author?.name ?? ''), parents: r.parents ?? [] };
  }
  async branchTip(project: string, repo: string, branch: string) {
    const r = await this.repoRefs(project, repo, branch.replace(/^refs\/heads\//, ''));
    return r.find((x) => x.name === (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`))?.objectId ?? null;
  }
  /** Completed pull requests whose merge commit is this commit. */
  async prsByMergeCommit(project: string, repo: string, commit: string) {
    const r = await this.c.request<{ results?: Array<Record<string, Array<{ pullRequestId?: number; title?: string; status?: string }>>> }>('POST', `${git(repo)}/pullrequestquery`, { project, body: { queries: [{ items: [commit], type: 'lastMergeCommit' }] } });
    return (r.data.results?.[0]?.[commit] ?? []).filter((p) => p.status === 'completed').map((p) => ({ prId: Number(p.pullRequestId), title: String(p.title ?? '') }));
  }
  async commitChangeCount(project: string, repo: string, base: string, target: string) {
    const r = await this.c.get<{ changeCounts?: Record<string, number>; changes?: unknown[] }>(`${git(repo)}/diffs/commits`, { baseVersion: base, baseVersionType: 'commit', targetVersion: target, targetVersionType: 'commit', $top: 100 }, project);
    return r.changeCounts ? Object.values(r.changeCounts).reduce((a, b) => a + Number(b), 0) : (r.changes?.length ?? null);
  }
  async buildArtifactsRaw(project: string, buildId: number) { return list<Record<string, any>>(await this.c.get(`build/builds/${buildId}/artifacts`, undefined, project)); }
  /** One text file of a Container build artifact (the form PublishBuildArtifacts creates). */
  async containerFileText(containerId: number, itemPath: string, maxBytes: number) {
    const res = await this.c.request<string>('GET', `resources/Containers/${positive(containerId)}`, { raw: true, accept: 'application/octet-stream', apiVersion: '7.1-preview.4', query: { itemPath } });
    return String(res.data ?? '').slice(0, maxBytes);
  }
  async buildTimeline(project: string, buildId: number) {
    const r = await this.c.get<{ records?: Array<{ id?: string; type?: string; name?: string; result?: string; state?: string; log?: { id?: number } }> }>(`build/builds/${buildId}/timeline`, undefined, project);
    return r.records ?? [];
  }
  async buildLog(project: string, buildId: number, logId: number, maxChars: number) {
    const res = await this.c.request<string>('GET', `build/builds/${buildId}/logs/${logId}`, { project, raw: true, accept: 'text/plain' });
    const t = String(res.data ?? '');
    return t.length > maxChars ? t.slice(t.length - maxChars) : t;
  }
  async queueRun(project: string, pipelineId: number, branch: string, parameters?: Record<string, unknown>, commit?: string) {
    const body: Record<string, unknown> = { resources: { repositories: { self: { refName: branch.startsWith('refs/') ? branch : `refs/heads/${branch}`, ...(commit ? { version: commit } : {}) } } } };
    if (parameters && Object.keys(parameters).length) body.templateParameters = parameters;
    return (await this.c.request<{ id: number; _links?: { web?: { href?: string } }; state?: string }>('POST', `pipelines/${pipelineId}/runs`, { project, body })).data;
  }

  getWorkItem(id: number, expandRelations = false) { return this.c.get<AdoWorkItem>(`wit/workitems/${id}`, expandRelations ? { $expand: 'relations' } : undefined); }
  async workItemStateCategory(project: string, type: string, state: string): Promise<string> {
    const states = list<{ name: string; category?: string }>(await this.c.get(`wit/workitemtypes/${enc(type)}/states`, undefined, project));
    return states.find((s) => s.name.toLowerCase() === state.toLowerCase())?.category ?? 'Unknown';
  }
  async patchWorkItem(id: number, ops: Array<{ op: 'add' | 'replace' | 'test'; path: string; value?: unknown }>) {
    return (await this.c.request<AdoWorkItem>('PATCH', `wit/workitems/${id}`, { body: ops, contentType: 'application/json-patch+json' })).data;
  }

  // ---- Exploration (read only). Every method returns trimmed fields; callers never see raw payloads.
  async repoTree(project: string, repo: string, scopePath: string, version: string, versionType: 'branch' | 'commit' | 'tag', recursive: boolean) {
    const r = await this.c.get<{ value?: Array<{ path?: string; isFolder?: boolean; gitObjectType?: string; size?: number }> }>(`${git(repo)}/items`, { scopePath, recursionLevel: recursive ? 'Full' : 'OneLevel', 'versionDescriptor.version': version, 'versionDescriptor.versionType': versionType }, project);
    return r.value ?? [];
  }
  async repoItemText(project: string, repo: string, path: string, version: string, versionType: 'branch' | 'commit' | 'tag', maxBytes: number) {
    const res = await this.c.request<string>('GET', `${git(repo)}/items`, { project, raw: true, accept: 'text/plain', query: { path, 'versionDescriptor.version': version, 'versionDescriptor.versionType': versionType, includeContent: true, $format: 'text' } });
    const text = String(res.data ?? '');
    return text.length > maxBytes ? { text: text.slice(0, maxBytes), truncated: true } : { text, truncated: false };
  }
  async repoRefs(project: string, repo: string, prefix: string) {
    const r = await this.c.get<{ value?: Array<{ name?: string; objectId?: string; creator?: { displayName?: string } }> }>(`${git(repo)}/refs`, { filter: `heads/${prefix}` }, project);
    return r.value ?? [];
  }
  async repoCommits(project: string, repo: string, branch: string, top: number) {
    const r = await this.c.get<{ value?: Array<{ commitId?: string; comment?: string; author?: { name?: string; date?: string } }> }>(`${git(repo)}/commits`, { 'searchCriteria.itemVersion.version': branch, $top: top }, project);
    return r.value ?? [];
  }
  async buildDefinitions(project: string, q: { repositoryId?: string; name?: string; top: number }) {
    const query: Record<string, string | number | boolean | undefined> = { includeAllProperties: false, $top: q.top };
    if (q.repositoryId) { query.repositoryId = q.repositoryId; query.repositoryType = 'TfsGit'; }
    if (q.name) query.name = q.name;
    const r = await this.c.get<{ value?: Array<{ id?: number; name?: string; path?: string; queueStatus?: string; revision?: number }> }>('build/definitions', query, project);
    return r.value ?? [];
  }
  getBuildDefinition(project: string, id: number) {
    return this.c.get<{ id?: number; name?: string; path?: string; queueStatus?: string; revision?: number; queue?: { id?: number; name?: string }; process?: { yamlFilename?: string; type?: number }; repository?: { id?: string; name?: string; defaultBranch?: string }; triggers?: Array<{ triggerType?: string }>; variableGroups?: Array<{ name?: string }> }>(`build/definitions/${id}`, undefined, project);
  }
  async builds(project: string, q: { definitions?: number[]; branchName?: string; repositoryId?: string; result?: string; top: number }) {
    const query: Record<string, string | number | boolean | undefined> = { statusFilter: 'all', queryOrder: 'queueTimeDescending', $top: q.top };
    if (q.definitions?.length) query.definitions = q.definitions.join(',');
    if (q.branchName) query.branchName = q.branchName;
    if (q.repositoryId) { query.repositoryId = q.repositoryId; query.repositoryType = 'TfsGit'; }
    if (q.result) query.resultFilter = q.result;
    const r = await this.c.get<{ value?: Array<{ id?: number; status?: string; result?: string; sourceBranch?: string; sourceVersion?: string; reason?: string; queueTime?: string; finishTime?: string; definition?: { id?: number; name?: string }; _links?: { web?: { href?: string } } }> }>('build/builds', query, project);
    return r.value ?? [];
  }
  async createBuildDefinition(project: string, d: { name: string; folder: string; yamlPath: string; repositoryId: string; repositoryName: string; branch: string; queueId: number }) {
    // Created disabled, with no triggers, variables or variable groups: enabling and running are separate, confirmed steps.
    const body = { name: d.name, path: d.folder, type: 'build', queueStatus: 'disabled', queue: { id: d.queueId }, process: { type: 2, yamlFilename: d.yamlPath },
      repository: { id: d.repositoryId, name: d.repositoryName, type: 'TfsGit', defaultBranch: d.branch.startsWith('refs/') ? d.branch : `refs/heads/${d.branch}` }, jobAuthorizationScope: 'project', triggers: [] };
    return (await this.c.request<{ id: number; name?: string; revision?: number }>('POST', 'build/definitions', { project, body })).data;
  }
  /** Full-object update as Azure DevOps requires: the caller passes the definition it just read, patched in allowed fields only. */
  async updateBuildDefinition(project: string, id: number, full: Record<string, unknown>) {
    return (await this.c.request<{ id: number; revision?: number }>('PUT', `build/definitions/${id}`, { project, body: full })).data;
  }
  async getBuildDefinitionRaw(project: string, id: number) { return this.c.get<Record<string, any>>(`build/definitions/${id}`, undefined, project); }
  async createRepository(project: string, projectId: string, name: string) {
    return (await this.c.request<{ id: string; name?: string }>('POST', 'git/repositories', { project, body: { name, project: { id: projectId } } })).data;
  }
  async buildLogs(project: string, buildId: number) {
    const r = await this.c.get<{ value?: Array<{ id?: number; lineCount?: number }> }>(`build/builds/${buildId}/logs`, undefined, project);
    return r.value ?? [];
  }
  async policies(project: string, repositoryId: string, refName: string) {
    const r = await this.c.get<{ value?: Array<{ id?: number; isEnabled?: boolean; isBlocking?: boolean; type?: { displayName?: string }; settings?: Record<string, unknown> }> }>('policy/configurations', { repositoryId, refName }, project);
    return r.value ?? [];
  }
  async previewPipeline(project: string, pipelineId: number, body: Record<string, unknown>) {
    return (await this.c.request<{ finalYaml?: string }>('POST', `pipelines/${pipelineId}/preview`, { project, body })).data;
  }
  async pipelinePermissions(project: string, resourceType: string, resourceId: string) {
    return (await this.c.request<{ allPipelines?: { authorized?: boolean }; pipelines?: Array<{ id?: number; authorized?: boolean }> }>('GET', `pipelines/pipelinepermissions/${enc(resourceType)}/${enc(resourceId)}`, { project, apiVersion: '7.1-preview.1' })).data;
  }
  async authorizeSecureFilePipelines(project: string, id: string, pipelineIds: number[]) {
    await this.c.request('PATCH', `pipelines/pipelinepermissions/securefile/${enc(id)}`, { project, apiVersion: '7.1-preview.1', body: { pipelines: pipelineIds.map((id) => ({ id, authorized: true })) } });
    return this.pipelinePermissions(project, 'securefile', id);
  }
  async environments(project: string, name?: string) {
    const r = await this.c.get<{ value?: Array<{ id: number; name: string }> }>('distributedtask/environments', { name }, project);
    return (r.value ?? []).map(({ id, name }) => ({ id, name }));
  }
  async environment(project: string, id: number) {
    const r = await this.c.get<{ id: number; name: string }>(`distributedtask/environments/${id}`, undefined, project);
    return { id: r.id, name: r.name };
  }
  async secureFiles(project: string, name?: string) {
    const r = await this.c.get<{ value?: Array<{ id: string; name: string; createdOn?: string; modifiedOn?: string; createdBy?: { displayName?: string } }> }>('distributedtask/securefiles', { namePattern: name }, project);
    return (r.value ?? []).map(({ id, name, createdOn, modifiedOn, createdBy }) => ({ id, name, createdOn, modifiedOn, createdBy: createdBy?.displayName }));
  }
  async secureFile(project: string, id: string) {
    const r = await this.c.get<{ id: string; name: string; createdOn?: string; modifiedOn?: string; createdBy?: { displayName?: string } }>(`distributedtask/securefiles/${enc(id)}`, undefined, project);
    return { id: r.id, name: r.name, createdOn: r.createdOn, modifiedOn: r.modifiedOn, createdBy: r.createdBy?.displayName };
  }
  async pipelineChecks(project: string, resourceType: string, resourceId: string) {
    const r = (await this.c.request<{ value?: Array<{ id?: number; type?: { id?: string; name?: string }; isDisabled?: boolean; timeout?: number; settings?: { approvers?: Array<{ id?: string; displayName?: string }>; executionOrder?: string; minRequiredApprovers?: number; requesterCannotBeApprover?: boolean } }> }>('GET', 'pipelines/checks/configurations', { project, apiVersion: '7.1-preview.1', query: { resourceType, resourceId, $expand: 'settings' } })).data;
    return (r.value ?? []).map((c) => ({ id: c.id, type: { id: c.type?.id, name: c.type?.name }, isDisabled: c.isDisabled, timeout: c.timeout,
      ...(c.type?.name === 'Approval' && c.settings ? { settings: { approvers: (c.settings.approvers ?? []).map((a) => ({ id: a.id, displayName: a.displayName })), executionOrder: c.settings.executionOrder, minRequiredApprovers: c.settings.minRequiredApprovers, requesterCannotBeApprover: c.settings.requesterCannotBeApprover } } : {}) }));
  }
  /** Org-level identities (vssps host; use the admin client's `identities` api). One lookup by id, or a General search by sign-in name. */
  async identities(q: { id?: string; signIn?: string }) {
    const query: Record<string, string> = q.id ? { identityIds: q.id } : { searchFilter: 'General', filterValue: q.signIn ?? '', properties: 'Account,Mail' };
    const r = await this.c.request<{ value?: Array<{ id?: string; providerDisplayName?: string; customDisplayName?: string; isActive?: boolean; isContainer?: boolean; properties?: Record<string, { $value?: unknown } | undefined> }> }>('GET', 'identities', { query, apiVersion: '7.1' });
    const prop = (x: { properties?: Record<string, { $value?: unknown } | undefined> }, k: string) => { const v = x.properties?.[k]?.$value; return typeof v === 'string' ? v : undefined; };
    return (r.data?.value ?? []).map((x) => ({ id: x.id, displayName: x.providerDisplayName ?? x.customDisplayName, isActive: x.isActive, isContainer: x.isContainer, account: prop(x, 'Account'), mail: prop(x, 'Mail') }));
  }
  async createApprovalCheck(project: string, body: { environmentId: number; environmentName: string; approverId: string; timeoutMinutes: number; instructions?: string }) {
    const r = await this.c.request<{ id?: number }>('POST', 'pipelines/checks/configurations', { project, apiVersion: '7.1-preview.1', body: {
      type: { id: APPROVAL_CHECK_TYPE, name: 'Approval' },
      settings: { approvers: [{ id: body.approverId }], executionOrder: 'anyOrder', minRequiredApprovers: 1, requesterCannotBeApprover: true, ...(body.instructions ? { instructions: body.instructions } : {}) },
      resource: { type: 'environment', id: String(body.environmentId), name: body.environmentName }, timeout: body.timeoutMinutes } });
    return { id: r.data?.id };
  }
  async pipelineCheck(project: string, id: number) {
    const c = (await this.c.request<{ id?: number; type?: { id?: string; name?: string }; isDisabled?: boolean; timeout?: number; resource?: { type?: string; id?: string }; settings?: { approvers?: Array<{ id?: string; displayName?: string }>; executionOrder?: string; minRequiredApprovers?: number; requesterCannotBeApprover?: boolean } }>('GET', `pipelines/checks/configurations/${id}`, { project, apiVersion: '7.1-preview.1', query: { $expand: 'settings' } })).data;
    return { id: c.id, type: { id: c.type?.id, name: c.type?.name }, isDisabled: c.isDisabled, timeout: c.timeout, resource: { type: c.resource?.type, id: c.resource?.id },
      settings: { approvers: (c.settings?.approvers ?? []).map((a) => ({ id: a.id, displayName: a.displayName })), executionOrder: c.settings?.executionOrder, minRequiredApprovers: c.settings?.minRequiredApprovers, requesterCannotBeApprover: c.settings?.requesterCannotBeApprover } };
  }
  async serviceEndpoints(project: string, type?: string, name?: string) {
    const query: Record<string, string | number | boolean | undefined> = { includeDetails: false };
    if (type) query.type = type; if (name) query.endpointNames = name;
    const r = await this.c.get<{ value?: Array<{ id?: string; name?: string; type?: string; isReady?: boolean; isShared?: boolean; authorization?: { scheme?: string } }> }>('serviceendpoint/endpoints', query, project);
    return r.value ?? [];
  }
  async variableGroups(project: string, name?: string) {
    const r = await this.c.get<{ value?: Array<{ id?: number; name?: string; description?: string; variables?: Record<string, { isSecret?: boolean }> }> }>('distributedtask/variablegroups', name ? { groupName: name } : undefined, project);
    return r.value ?? [];
  }
  /** One variable group by id. Secret values are never returned by Azure DevOps (value is null). */
  async variableGroup(project: string, id: number) {
    const r = await this.c.get<VariableGroupBody>(`distributedtask/variablegroups/${id}`, undefined, project);
    return r;
  }
  async createVariableGroup(project: string, projectName: string, body: { name: string; description?: string; variables: Record<string, { value?: string | null; isSecret?: boolean }> }) {
    const r = await this.c.request<VariableGroupBody>('POST', 'distributedtask/variablegroups', { project, apiVersion: '7.1-preview.2', body: { type: 'Vsts', ...body, variableGroupProjectReferences: [{ name: body.name, description: body.description ?? '', projectReference: { id: project, name: projectName } }] } });
    return r.data;
  }
  async updateVariableGroup(project: string, projectName: string, id: number, body: { name: string; description?: string; variables: Record<string, { value?: string | null; isSecret?: boolean }> }) {
    const r = await this.c.request<VariableGroupBody>('PUT', `distributedtask/variablegroups/${id}`, { project, apiVersion: '7.1-preview.2', body: { type: 'Vsts', id, ...body, variableGroupProjectReferences: [{ name: body.name, description: body.description ?? '', projectReference: { id: project, name: projectName } }] } });
    return r.data;
  }
  async agentQueues(project: string) {
    const r = await this.c.get<{ value?: Array<{ id?: number; name?: string; pool?: { id?: number; name?: string; isHosted?: boolean } }> }>('distributedtask/queues', { actionFilter: 'use' }, project);
    return r.value ?? [];
  }
  async orgPools() {
    const r = await this.c.get<{ value?: Array<{ id?: number; name?: string; isHosted?: boolean; poolType?: string; size?: number }> }>('distributedtask/pools', undefined);
    return r.value ?? [];
  }
  async poolAgents(poolId: number) {
    const r = await this.c.get<{ value?: Array<{ name?: string; status?: string; enabled?: boolean }> }>(`distributedtask/pools/${poolId}/agents`, undefined);
    return r.value ?? [];
  }
  async buildPermissions(projectId: string, definitionId?: number): Promise<Record<'viewBuilds' | 'queueBuilds' | 'viewDefinitions' | 'editDefinitions' | 'createDefinitions', boolean | null>> {
    const bits = { viewBuilds: 1, queueBuilds: 128, viewDefinitions: 1024, editDefinitions: 2048, createDefinitions: 32768 } as const;
    const out: Record<string, boolean | null> = {};
    for (const [name, bit] of Object.entries(bits)) {
      try { out[name] = (await this.c.get<{ value?: boolean[] }>(`permissions/33344d9c-fc72-4d6f-aba5-fa317101a7e9/${bit}`, { tokens: definitionId ? `${projectId}/${definitionId}` : projectId }, undefined, { apiVersion: '7.1' })).value?.[0] ?? null; } catch { out[name] = null; }
    }
    return out as never;
  }

  /** The caller's own permissions on the project's Git repositories (security namespace 2e9eb7ed-..., token repoV2/<projectId>). */
  async gitPermissions(projectId: string, repoId?: string): Promise<Record<'readRepos' | 'push' | 'createBranch' | 'editPolicies' | 'contributeToPullRequests' | 'bypassPullRequestPolicy' | 'managePermissions', boolean | null>> {
    const bits = { readRepos: 2, push: 4, createBranch: 16, editPolicies: 2048, managePermissions: 8192, contributeToPullRequests: 16384, bypassPullRequestPolicy: 32768 } as const;
    const out: Record<string, boolean | null> = {};
    for (const [name, bit] of Object.entries(bits)) {
      try {
        const r = await this.c.get<{ value?: boolean[] }>(`permissions/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87/${bit}`, { tokens: repoId ? `repoV2/${projectId}/${repoId}` : `repoV2/${projectId}` }, undefined, { apiVersion: '7.1' });
        out[name] = r.value?.[0] ?? null;
      } catch { out[name] = null; }
    }
    return out as never;
  }
}
export { AdoError };
