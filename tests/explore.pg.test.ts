// Exploration tools: what agents used to do with a PAT and az, now read-only and trimmed to an allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { AUTHOR_AGENT, COMPANY, makeHarness, REVIEWER_AGENT, type Harness } from './test-host.ts';
import { Service } from '../src/service.ts';
import { makeToolRunner } from '../src/tools/index.ts';

let fake: FakeAdo; let h: Harness | null; let svc: Service; let run: ReturnType<typeof makeToolRunner>;
test.before(async () => { fake = await new FakeAdo().start(); h = await makeHarness(fake); if (!h) return; svc = new Service(h.host); run = makeToolRunner(svc, async () => 'Agent'); fake.files.set('/README.md', 'hello\nworld\n'); });
test.after(async () => { await h?.stop(); await fake.stop(); });
let n = 0; const ctx = (agentId: string) => ({ agentId, runId: `f0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, companyId: COMPANY });
const ok = (name: string, fn: () => Promise<void>) => test(name, async (t) => { if (!h) return t.skip('embedded Postgres not available'); await fn(); });
const data = (r: { data?: unknown }) => r.data as Record<string, any>;
const call = (tool: string, args: Record<string, unknown>) => run(tool, args, ctx(REVIEWER_AGENT));

ok('repository files and trees can be read at a ref; bad paths and refs are refused; nothing outside scope', async () => {
  const f = await call('ado_repo_file_read', { repository: 'widgets', path: 'README.md', ref: 'main', startLine: 2 });
  assert.equal(f.error, undefined, JSON.stringify(f)); assert.match(JSON.stringify(data(f).text), /world/); assert.doesNotMatch(JSON.stringify(data(f).text), /hello/);
  assert.equal((await call('ado_repo_file_read', { repository: 'widgets', path: '../etc/passwd' })).error, 'bad_path');
  assert.equal((await call('ado_repo_file_read', { repository: 'widgets', path: 'README.md', ref: 'a..b' })).error, 'bad_ref');
  assert.equal((await call('ado_repo_file_read', { repository: 'widgets', path: 'missing.txt' })).error, 'not_found_or_forbidden');
  assert.equal((await call('ado_repo_file_read', { repository: 'other', path: 'README.md', project: 'Nope' })).error !== undefined, true);
  const t = await call('ado_repo_tree_list', { repository: 'widgets', path: '/' });
  assert.deepEqual(data(t).entries.map((e: any) => e.type), ['folder', 'file']);
});

ok('branches: names and heads, commit text neutralised, no e-mail addresses anywhere', async () => {
  const r = await call('ado_repo_branch_find', { repository: 'widgets', branchPrefix: 'alice/', includeCommits: true });
  assert.equal(data(r).branches[0].name, 'alice/eng-1-x');
  assert.doesNotMatch(JSON.stringify(r), /@example\.com/);
  assert.equal(data(r).branches[0].commits[0].message, 'first line');
});

ok('pipelines and runs: the definition shows names only, runs can be matched to an exact commit, no variable values leak', async () => {
  const d = await call('ado_pipeline_find', { pipelineId: 135 });
  assert.equal(data(d).pipeline.queueStatus, 'disabled'); assert.deepEqual(data(d).pipeline.variableGroupNames, ['vg-one']);
  assert.doesNotMatch(JSON.stringify(d), /leaked/);
  assert.equal(data(await call('ado_pipeline_find', {})).pipelines[0].id, 135);
  const runs = await call('ado_pipeline_run_find', { pipelineId: 135, commit: 'cccccccc' });
  assert.equal(data(runs).runs.length, 1); assert.equal(data(runs).runs[0].result, 'succeeded');
  assert.doesNotMatch(JSON.stringify(runs), /@example\.com/);
  assert.equal((await call('ado_pipeline_run_find', { commit: 'zz' })).error !== undefined, true);
});

ok('policies list an allowlist of settings only; the preview never queues a run', async () => {
  const p = await call('ado_policy_list', { repository: 'widgets', branch: 'main' });
  assert.equal(data(p).policies[0].type, 'Build'); assert.equal(data(p).policies[0].blocking, true);
  assert.doesNotMatch(JSON.stringify(p), /free text must not leak|scope/);
  const before = fake.calls.filter((c) => c.method === 'POST' && /pipelines\/\d+\/runs/.test(c.path)).length;
  const pv = await call('ado_pipeline_preview', { pipelineId: 135 });
  assert.match(JSON.stringify(data(pv).yaml), /echo hi/);
  assert.equal(fake.calls.filter((c) => c.method === 'POST' && /pipelines\/\d+\/runs/.test(c.path)).length, before);
});

ok('resources pipelines depend on: no URLs, credentials or variable values ever; secret variables are named, not shown', async () => {
  const sc = await call('ado_service_connection_find', { type: 'kubernetes' });
  assert.equal(data(sc).connections[0].name, 'k8s-test'); assert.doesNotMatch(JSON.stringify(sc), /leaked|secret\.internal/);
  const vg = await call('ado_variable_group_find', { includeKeys: true });
  assert.deepEqual(data(vg).groups[0].variables, [{ key: 'PLAIN', masked: false }, { key: 'TOKEN', masked: true }]); assert.doesNotMatch(JSON.stringify(vg), /leaked/);
  const acc = await call('ado_pipeline_access_get', { resourceType: 'endpoint', resourceId: 'e1' });
  assert.equal(data(acc).allPipelines, false); assert.doesNotMatch(JSON.stringify(acc), /Boss/);
  assert.equal((await call('ado_pipeline_access_get', { resourceType: 'bogus', resourceId: 'e1' })).error, 'bad_request');
  const q = await call('ado_agent_pool_find', { includeAgents: true });
  assert.deepEqual(data(q).queues.map((x: any) => x.hosted), [false, true]); assert.deepEqual(data(q).queues[0].agents, { total: 2, online: 1, enabled: 2 });
});

ok('permissions of the two plugin identities; any agent may ask', async () => {
  const r = await run('ado_permissions_get', {}, ctx(AUTHOR_AGENT));
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(data(r).identities.author.build.createDefinitions, false); assert.equal(data(r).identities.author.build.viewBuilds, true);
});

ok('a pipeline run can be pinned to an exact commit; short hashes are refused', async () => {
  const OPERATOR = 'a0000000-0000-4000-8000-000000000003';
  const bad = await run('ado_pipeline_run_create', { pipelineId: 135, branch: 'feature/x', commit: 'abc1234' }, ctx(OPERATOR));
  assert.equal(bad.error, 'bad_request');
  const full = 'e'.repeat(40);
  const r = await run('ado_pipeline_run_create', { pipelineId: 135, branch: 'feature/x', commit: full }, ctx(OPERATOR));
  assert.equal(r.error, undefined, JSON.stringify(r));
  const post = fake.calls.filter((c) => c.method === 'POST' && /pipelines\/135\/runs/.test(c.path)).at(-1)!;
  assert.equal((post.body as any).resources.repositories.self.version, full);
});

import { addIssue, baseConfig, OPERATOR_AGENT } from './test-host.ts';
import { parseConfig } from '../src/config.ts';
import { settleApprovedActions } from '../src/tools/index.ts';
import { NS } from '../src/namespace.ts';

const accept = (id: string) => { const c = h!.interactions.get(id)!; c.status = 'resolved'; c.outcome = 'accepted'; c.resolvedByUserId = 'gX9MVIvukHQLc5Lz3dvW8go3YSHnrkOE'; };
const enable = (over: Record<string, unknown>) => h!.configs.set(COMPANY, parseConfig(baseConfig(fake, over)));

ok('creating pipelines, changing them and creating repositories: off by default, always confirmed by a person, created disabled', async () => {
  const issue = addIssue(h!, 'ENG-400', { assigneeAgentId: OPERATOR_AGENT });
  const create = { repository: 'widgets', name: 'validate', yamlPath: 'azure-pipelines.yml', queueId: 1 };
  assert.equal((await run('ado_pipeline_create', create, ctx(OPERATOR_AGENT))).error, 'not_enabled');
  assert.equal((await run('ado_repo_create', { name: 'new-repo' }, ctx(OPERATOR_AGENT))).error, 'not_enabled');
  enable({ pipelines: { allowCreate: true, allowedQueueIds: [1] }, repos: { allowCreate: true } });
  fake.files.set('/azure-pipelines.yml', 'steps:\n- script: echo ok\n');
  assert.equal((await run('ado_pipeline_create', { ...create, queueId: 7 }, ctx(OPERATOR_AGENT))).error, 'queue_not_allowed');
  assert.equal((await run('ado_pipeline_create', { ...create, yamlPath: 'missing.yml' }, ctx(OPERATOR_AGENT))).error, 'yaml_missing');
  const p = await run('ado_pipeline_create', create, ctx(OPERATOR_AGENT));
  assert.equal(p.error, undefined, JSON.stringify(p)); assert.equal(data(p).status, 'awaiting_confirmation');
  assert.equal(fake.calls.filter((c) => c.method === 'POST' && /build\/definitions$/.test(c.path)).length, 0, 'nothing created before the person confirms');
  fake.files.set('/azure-pipelines.yml', 'steps:\n- script: echo changed\n');
  accept(data(p).interactionId);
  assert.equal(await settleApprovedActions(svc, run), 1);
  assert.equal(fake.calls.filter((c) => c.method === 'POST' && /build\/definitions$/.test(c.path)).length, 0, 'the YAML changed after approval, so nothing was created');
  fake.files.set('/azure-pipelines.yml', 'steps:\n- script: echo ok\n');
  const p2 = await run('ado_pipeline_create', create, ctx(OPERATOR_AGENT)); accept(data(p2).interactionId);
  assert.equal(await settleApprovedActions(svc, run), 1);
  const made = fake.calls.filter((c) => c.method === 'POST' && /build\/definitions$/.test(c.path)).at(-1)!.body as any;
  assert.equal(made.queueStatus, 'disabled'); assert.deepEqual(made.triggers, []); assert.equal(made.variables, undefined);
  assert.ok(issue.comments.some((c) => /Pipeline 200/.test(c)));
  issue.status = 'done';
});

ok('pipeline update: disabling is immediate, enabling needs a person and the approved revision', async () => {
  const i401 = addIssue(h!, 'ENG-401', { assigneeAgentId: OPERATOR_AGENT });
  enable({ pipelines: { allowCreate: true, allowedQueueIds: [1] } });
  const off = await run('ado_pipeline_update', { pipelineId: 135, queueStatus: 'disabled' }, ctx(OPERATOR_AGENT));
  assert.equal(off.error, undefined, JSON.stringify(off));
  assert.equal(fake.calls.filter((c) => c.method === 'PUT' && /build\/definitions\/135$/.test(c.path)).at(-1)!.path.endsWith('135'), true);
  const puts = () => fake.calls.filter((c) => c.method === 'PUT' && /build\/definitions\/135$/.test(c.path)).length;
  const before = puts();
  const on = await run('ado_pipeline_update', { pipelineId: 135, queueStatus: 'enabled' }, ctx(OPERATOR_AGENT));
  assert.equal(on.error, undefined, JSON.stringify(on)); assert.equal(data(on).status, 'awaiting_confirmation'); assert.equal(puts(), before);
  accept(data(on).interactionId); await settleApprovedActions(svc, run);
  assert.equal(puts(), before + 1);
  assert.equal((fake.calls.filter((c) => c.method === 'PUT').at(-1)!.body as any).queueStatus, 'enabled');
  i401.status = 'done';
});

ok('repository creation: confirmed by a person, then created; an existing name is refused', async () => {
  addIssue(h!, 'ENG-402', { assigneeAgentId: OPERATOR_AGENT });
  enable({ repos: { allowCreate: true } });
  assert.equal((await run('ado_repo_create', { name: 'widgets' }, ctx(OPERATOR_AGENT))).error, 'already_exists');
  assert.equal((await run('ado_repo_create', { name: 'bad.git' }, ctx(OPERATOR_AGENT))).error, 'bad_request');
  const p = await run('ado_repo_create', { name: 'new-repo' }, ctx(OPERATOR_AGENT));
  assert.equal(p.error, undefined, JSON.stringify(p)); assert.equal(data(p).status, 'awaiting_confirmation'); accept(data(p).interactionId); await settleApprovedActions(svc, run);
  const row = (await h!.pg.query<{ status: string }>(`SELECT status FROM ${NS}.action WHERE id=$1`, [data(p).actionId]))[0]!;
  assert.equal(row.status, 'applied');
  assert.equal(fake.calls.filter((c) => c.method === 'POST' && /git\/repositories$/.test(c.path)).length, 1);
});
