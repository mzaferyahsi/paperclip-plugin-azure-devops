// Exploration tools (class R): read repositories, pipelines, builds, policies and the resources pipelines depend on, without a PAT or `az`.
// Everything is trimmed to an allowlist of fields. Secret values, URLs of service connections, variable values, agent capabilities and
// e-mail addresses never leave this file. Free text is fenced as untrusted data.
import { neutralize, untrusted } from '../sanitize.ts';
import type { Service } from '../service.ts';
import { requireRepo, toRef, ToolError, type RunCtx, type ToolOut } from './common.ts';

type A = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const short = (s: string, n = 120): string => neutralize(s.replace(/\s+/g, ' ').slice(0, n));
const HEX = /^[0-9a-f]{7,40}$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._*-]{0,99}$/;
const REF = /^[A-Za-z0-9._/-]{1,200}$/;

export const cleanPath = (p: string | undefined, dflt = '/'): string => {
  const path = p ?? dflt;
  if (path.length > 1024 || path.includes('\0') || path.split('/').some((s) => s === '..')) throw new ToolError('bad_path', 'Invalid path');
  return path.startsWith('/') ? path : `/${path}`;
};

/** A branch, tag or commit to read at. Defaults to the branch given or `main`. */
export function versionOf(a: A, defaultBranch = 'main'): { version: string; type: 'branch' | 'commit' | 'tag' } {
  const ref = str(a.ref) ?? defaultBranch;
  const type = a.refType === 'commit' || a.refType === 'tag' ? a.refType : HEX.test(ref) && a.refType !== 'branch' ? 'commit' : 'branch';
  const v = ref.replace(/^refs\/(heads|tags)\//, '');
  if (type === 'commit' ? !HEX.test(v) : (!REF.test(v) || v.includes('..'))) throw new ToolError('bad_ref', 'Invalid branch, tag or commit');
  return { version: v, type };
}

export function makeExploreTools(svc: Service) {
  const cfgOf = (run: RunCtx) => svc.cfg(run.companyId);
  const read = <T>(run: RunCtx, cfg: Awaited<ReturnType<typeof cfgOf>>, fn: Parameters<typeof svc.read<T>>[2]) => svc.read(run.companyId, cfg, fn);
  const repoId = async (run: RunCtx, cfg: Awaited<ReturnType<typeof cfgOf>>, projectId: string, repo: string): Promise<string> => {
    const repos = await read(run, cfg, (api) => api.listRepos(projectId));
    const hit = repos.find((r) => r.name.toLowerCase() === repo.toLowerCase() || r.id.toLowerCase() === repo.toLowerCase());
    if (!hit) throw new ToolError('not_found_or_forbidden', 'Repository not found');
    return hit.id;
  };
  const defaultBranchOf = async (run: RunCtx, cfg: Awaited<ReturnType<typeof cfgOf>>, projectId: string, repo: string): Promise<string> => {
    const repos = await read(run, cfg, (api) => api.listRepos(projectId)).catch(() => []);
    return (repos.find((r) => r.name.toLowerCase() === repo.toLowerCase())?.defaultBranch ?? 'refs/heads/main').replace('refs/heads/', '');
  };

  async function repoFileRead(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(a.repository), project: str(a.project) });
    const path = cleanPath(str(a.path), '');
    if (path === '/') throw new ToolError('bad_path', 'path is required');
    const v = versionOf(a, await defaultBranchOf(run, cfg, project.projectId, repo));
    const maxBytes = Math.min(65536, num(a.maxBytes) ?? 32768);
    const file = await read(run, cfg, (api) => api.repoItemText(project.projectId, repo, path, v.version, v.type, maxBytes * 2));
    if (file.text.includes('\u0000')) throw new ToolError('binary_file', 'Binary files are not returned');
    let text = file.text; const start = num(a.startLine);
    if (start && start > 1) text = text.split('\n').slice(start - 1).join('\n');
    const truncated = file.truncated || text.length > maxBytes;
    return { content: `File ${path} at ${v.type} ${v.version}${truncated ? ', truncated' : ''}.`, data: { path, ref: v.version, refType: v.type, truncated, text: untrusted(text.slice(0, maxBytes), maxBytes) } };
  }

  async function repoTreeList(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(a.repository), project: str(a.project) });
    const path = cleanPath(str(a.path));
    const v = versionOf(a, await defaultBranchOf(run, cfg, project.projectId, repo));
    const max = Math.min(2000, num(a.maxEntries) ?? 300);
    const items = await read(run, cfg, (api) => api.repoTree(project.projectId, repo, path, v.version, v.type, a.recursive === true));
    const entries = items.filter((i) => i.path && i.path !== path).slice(0, max).map((i) => ({ path: short(i.path!, 300), type: i.isFolder ? 'folder' : 'file', ...(i.size !== undefined ? { size: i.size } : {}) }));
    return { content: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} under ${path} at ${v.version}.`, data: { path, ref: v.version, entries, truncated: items.length > max + 1 } };
  }

  async function repoBranchFind(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(a.repository), project: str(a.project) });
    const prefix = (str(a.branchPrefix) ?? '').replace(/^refs\/heads\//, '');
    if (prefix && (!REF.test(prefix) || prefix.includes('..'))) throw new ToolError('bad_ref', 'Invalid branch prefix');
    const top = Math.min(50, num(a.top) ?? 25);
    const refs = await read(run, cfg, (api) => api.repoRefs(project.projectId, repo, prefix));
    const branches: Array<Record<string, unknown>> = refs.slice(0, top).map((r) => ({ name: (r.name ?? '').replace('refs/heads/', ''), head: r.objectId ?? '', creator: short(r.creator?.displayName ?? '', 60) }));
    if (a.includeCommits === true && branches[0]) {
      for (const b of branches.slice(0, 5)) {
        const commits = await read(run, cfg, (api) => api.repoCommits(project.projectId, repo, String(b.name), 5)).catch(() => []);
        b.commits = commits.map((c) => ({ id: (c.commitId ?? '').slice(0, 12), message: short((c.comment ?? '').split('\n')[0] ?? '', 120), at: c.author?.date ?? null }));
      }
    }
    return { content: `${branches.length} branch(es)${prefix ? ` starting with ${prefix}` : ''}.`, data: { branches } };
  }

  async function pipelineFind(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const project = svc.projectOf(cfg, str(a.project));
    const id = num(a.pipelineId);
    if (id) {
      const d = await read(run, cfg, (api) => api.getBuildDefinition(project.projectId, id));
      return { content: `Pipeline ${id}: ${d.queueStatus ?? 'unknown'}.`, data: { pipeline: {
        id, name: short(d.name ?? '', 100), folder: short(d.path ?? '', 100), queueStatus: d.queueStatus ?? null, revision: d.revision ?? null, queue: d.queue ? { id: d.queue.id ?? null, name: short(d.queue.name ?? '', 60) } : null,
        yamlPath: d.process?.yamlFilename ? short(d.process.yamlFilename, 200) : null, repository: d.repository?.name ? short(d.repository.name, 80) : null, defaultBranch: (d.repository?.defaultBranch ?? '').replace('refs/heads/', '') || null,
        triggerTypes: (d.triggers ?? []).map((t) => t.triggerType ?? 'unknown'), variableGroupNames: (d.variableGroups ?? []).map((g) => short(g.name ?? '', 80)), protected: project.protectedPipelines.includes(id) } } };
    }
    const name = str(a.name); if (name && !NAME.test(name)) throw new ToolError('bad_request', 'Invalid name filter');
    let rid: string | undefined; const repository = str(a.repository);
    if (repository) { await requireRepo(svc, run.companyId, cfg, { repository, project: str(a.project) }); rid = await repoId(run, cfg, project.projectId, repository); }
    const defs = await read(run, cfg, (api) => api.buildDefinitions(project.projectId, { ...(rid ? { repositoryId: rid } : {}), ...(name ? { name } : {}), top: Math.min(200, num(a.top) ?? 100) }));
    return { content: `${defs.length} pipeline(s).`, data: { pipelines: defs.map((d) => ({ id: d.id, name: short(d.name ?? '', 100), folder: short(d.path ?? '', 100), queueStatus: d.queueStatus ?? null, protected: d.id !== undefined && project.protectedPipelines.includes(d.id) })) } };
  }

  async function pipelineRunFind(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const project = svc.projectOf(cfg, str(a.project));
    const commit = str(a.commit); if (commit && !HEX.test(commit)) throw new ToolError('bad_ref', 'commit must be 7 to 40 hex characters');
    const branch = str(a.branch); if (branch && (!REF.test(branch.replace(/^refs\/heads\//, '')) || branch.includes('..'))) throw new ToolError('bad_ref', 'Invalid branch');
    const result = str(a.result); if (result && !['succeeded', 'partiallySucceeded', 'failed', 'canceled'].includes(result)) throw new ToolError('bad_request', 'Invalid result filter');
    let rid: string | undefined; const repository = str(a.repository);
    if (repository) { await requireRepo(svc, run.companyId, cfg, { repository, project: str(a.project) }); rid = await repoId(run, cfg, project.projectId, repository); }
    const top = Math.min(50, num(a.top) ?? 20);
    const all = await read(run, cfg, (api) => api.builds(project.projectId, { ...(num(a.pipelineId) ? { definitions: [num(a.pipelineId)!] } : {}), ...(branch ? { branchName: toRef(branch) } : {}), ...(rid ? { repositoryId: rid } : {}), ...(result ? { result } : {}), top: commit ? 100 : top }));
    const rows = all.filter((b) => !commit || (b.sourceVersion ?? '').toLowerCase().startsWith(commit.toLowerCase())).slice(0, top);
    return { content: `${rows.length} run(s)${commit ? ` on commit ${commit.slice(0, 7)}` : ''}.`, data: { runs: rows.map((b) => ({ id: b.id, pipelineId: b.definition?.id ?? null, pipeline: short(b.definition?.name ?? '', 80), status: b.status ?? null, result: b.result ?? null, branch: (b.sourceBranch ?? '').replace('refs/heads/', ''), commit: (b.sourceVersion ?? '').slice(0, 12), reason: b.reason ?? null, queuedAt: b.queueTime ?? null, finishedAt: b.finishTime ?? null, url: b._links?.web?.href ?? null })) } };
  }

  const ALLOWED_SETTINGS = ['buildDefinitionId', 'displayName', 'queueOnSourceUpdateOnly', 'manualQueueOnly', 'validDuration', 'minimumApproverCount', 'creatorVoteCounts', 'allowDownvotes', 'resetOnSourcePush', 'requireVoteOnLastIteration', 'blockLastPusherVote', 'statusName', 'statusGenre'];
  async function policyList(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const { project, repo } = await requireRepo(svc, run.companyId, cfg, { repository: str(a.repository), project: str(a.project) });
    const branch = (str(a.branch) ?? 'main').replace(/^refs\/heads\//, ''); if (!REF.test(branch) || branch.includes('..')) throw new ToolError('bad_ref', 'Invalid branch');
    const rid = await repoId(run, cfg, project.projectId, repo);
    const all = await read(run, cfg, (api) => api.policies(project.projectId, rid, toRef(branch)));
    const rows = all.filter((p) => a.includeDisabled === true || p.isEnabled !== false).map((p) => {
      const settings: Record<string, unknown> = {};
      for (const k of ALLOWED_SETTINGS) if (p.settings && k in p.settings) { const v = p.settings[k]; settings[k] = typeof v === 'string' ? short(v, 120) : v; }
      return { id: p.id, type: short(p.type?.displayName ?? 'policy', 60), enabled: p.isEnabled !== false, blocking: p.isBlocking === true, settings };
    });
    return { content: `${rows.length} polic${rows.length === 1 ? 'y' : 'ies'} on ${branch}.`, data: { branch, policies: rows } };
  }

  async function pipelinePreview(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const project = svc.projectOf(cfg, str(a.project));
    const id = num(a.pipelineId); if (!id) throw new ToolError('bad_request', 'pipelineId is required');
    const body: Record<string, unknown> = { previewRun: true };
    const branch = str(a.branch); const commit = str(a.commit);
    if (commit && !HEX.test(commit)) throw new ToolError('bad_ref', 'commit must be 7 to 40 hex characters');
    if (branch && (!REF.test(branch.replace(/^refs\/heads\//, '')) || branch.includes('..'))) throw new ToolError('bad_ref', 'Invalid branch');
    if (branch || commit) body.resources = { repositories: { self: { ...(branch ? { refName: toRef(branch) } : {}), ...(commit ? { version: commit } : {}) } } };
    const maxBytes = Math.min(65536, num(a.maxBytes) ?? 32768);
    // This POST only expands the YAML; it never queues a run.
    const r = await read(run, cfg, (api) => api.previewPipeline(project.projectId, id, body));
    const yaml = String(r.finalYaml ?? '');
    return { content: `Expanded YAML of pipeline ${id} (${yaml.length} characters${yaml.length > maxBytes ? ', truncated' : ''}). Nothing was run.`, data: { pipelineId: id, truncated: yaml.length > maxBytes, yaml: untrusted(yaml.slice(0, maxBytes), maxBytes) } };
  }

  async function pipelineAccessGet(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const project = svc.projectOf(cfg, str(a.project));
    const type = str(a.resourceType); const rid = str(a.resourceId);
    if (!type || !['endpoint', 'queue', 'variablegroup', 'environment', 'repository', 'securefile'].includes(type)) throw new ToolError('bad_request', 'resourceType must be endpoint, queue, variablegroup, environment, repository or securefile');
    if (!rid || !/^[A-Za-z0-9._-]{1,100}$/.test(rid)) throw new ToolError('bad_request', 'Invalid resourceId');
    const perm = await read(run, cfg, (api) => api.pipelinePermissions(project.projectId, type, rid));
    const checks = await read(run, cfg, (api) => api.pipelineChecks(project.projectId, type, rid)).catch(() => []);
    return { content: perm.allPipelines?.authorized ? 'Authorized for ALL pipelines.' : `Authorized for ${(perm.pipelines ?? []).filter((p) => p.authorized !== false).length} pipeline(s).`, data: {
      resourceType: type, resourceId: rid, allPipelines: perm.allPipelines?.authorized === true, pipelines: (perm.pipelines ?? []).map((p) => ({ id: p.id, authorized: p.authorized !== false })),
      checks: checks.map((c) => ({ type: short(c.type?.name ?? 'check', 60), disabled: c.isDisabled === true, timeoutMinutes: c.timeout ?? null })) } };
  }

  async function serviceConnectionFind(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const project = svc.projectOf(cfg, str(a.project));
    const type = str(a.type); if (type && !/^[A-Za-z0-9._-]{1,60}$/.test(type)) throw new ToolError('bad_request', 'Invalid type');
    const name = str(a.name); if (name && !NAME.test(name)) throw new ToolError('bad_request', 'Invalid name');
    const rows = await read(run, cfg, (api) => api.serviceEndpoints(project.projectId, type, name));
    return { content: `${rows.length} service connection(s).`, data: { connections: rows.map((e) => ({ id: e.id, name: short(e.name ?? '', 100), type: e.type ?? null, ready: e.isReady === true, shared: e.isShared === true, authScheme: e.authorization?.scheme ?? null })) } };
  }

  async function variableGroupFind(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const project = svc.projectOf(cfg, str(a.project));
    const name = str(a.name); if (name && !NAME.test(name)) throw new ToolError('bad_request', 'Invalid name');
    const rows = await read(run, cfg, (api) => api.variableGroups(project.projectId, name));
    return { content: `${rows.length} variable group(s). Values are never returned.`, data: { groups: rows.map((g) => ({ id: g.id, name: short(g.name ?? '', 100), description: short(g.description ?? '', 160),
      ...(a.includeKeys === true ? { variables: Object.entries(g.variables ?? {}).slice(0, 200).map(([key, v]) => ({ key: short(key, 80), masked: v?.isSecret === true })) } : { variableCount: Object.keys(g.variables ?? {}).length }) })) } };
  }

  async function agentPoolFind(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const project = svc.projectOf(cfg, str(a.project));
    const queues = await read(run, cfg, (api) => api.agentQueues(project.projectId));
    const out = [];
    for (const q of queues.slice(0, 20)) {
      const row: Record<string, unknown> = { queueId: q.id, name: short(q.name ?? '', 80), pool: short(q.pool?.name ?? '', 80), hosted: q.pool?.isHosted === true };
      if (a.includeAgents === true && q.pool?.id && !q.pool.isHosted) {
        const agents = await read(run, cfg, (api) => api.poolAgents(q.pool!.id!)).catch(() => null);
        row.agents = agents ? { total: agents.length, online: agents.filter((x) => x.status === 'online').length, enabled: agents.filter((x) => x.enabled !== false).length } : null;
      }
      out.push(row);
    }
    return { content: `${out.length} agent queue(s) usable by this project (point in time).`, data: { queues: out } };
  }

  async function permissionsGet(a: A, run: RunCtx): Promise<ToolOut> {
    const cfg = await cfgOf(run);
    const project = svc.projectOf(cfg, str(a.project));
    const pid = num(a.pipelineId);
    const roles = ['author', 'reviewer'] as const;
    const out: Record<string, unknown> = {};
    for (const r of roles) {
      const api = svc.api(run.companyId, cfg, r);
      out[r] = { git: await api.gitPermissions(project.projectId), build: await api.buildPermissions(project.projectId, pid) };
    }
    return { content: 'Permissions of the two plugin identities (not of any person).', data: { project: project.name, ...(pid ? { pipelineId: pid } : {}), identities: out } };
  }

  return { ado_repo_file_read: repoFileRead, ado_repo_tree_list: repoTreeList, ado_repo_branch_find: repoBranchFind, ado_pipeline_find: pipelineFind, ado_pipeline_run_find: pipelineRunFind, ado_policy_list: policyList, ado_pipeline_preview: pipelinePreview, ado_pipeline_access_get: pipelineAccessGet, ado_service_connection_find: serviceConnectionFind, ado_variable_group_find: variableGroupFind, ado_agent_pool_find: agentPoolFind, ado_permissions_get: permissionsGet };
}
