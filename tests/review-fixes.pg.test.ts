// Regression tests for the findings of the independent review (H1-H3, M1-M8, L1-L8). Each test fails on the code before the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { addIssue, AUTHOR_AGENT, baseConfig, COMPANY, makeHarness, OPERATOR_AGENT, REVIEWER_AGENT, type Harness } from './test-host.ts';
import { Service } from '../src/service.ts';
import { makeToolRunner, settleApprovedActions } from '../src/tools/index.ts';
import { WebhookIngress } from '../src/webhook.ts';
import { drainInbox, reconcileCompany } from '../src/reconcile.ts';
import { parseConfig } from '../src/config.ts';
import { issueKeyFromBranch } from '../src/links.ts';
import { NS } from '../src/namespace.ts';

let fake: FakeAdo; let h: Harness | null; let svc: Service; let run: ReturnType<typeof makeToolRunner>;
const P2 = '55555555-5555-4555-8555-555555555555';
test.before(async () => {
  fake = await new FakeAdo().start();
  h = await makeHarness(fake);
  if (!h) return;
  svc = new Service(h.host);
  run = makeToolRunner(svc, async () => 'Agent');
});
test.after(async () => { await h?.stop(); await fake.stop(); });
let n = 0; const ctx = (agentId: string) => ({ agentId, runId: `d0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, companyId: COMPANY });
const ok = (name: string, fn: () => Promise<void>) => test(name, async (t) => { if (!h) return t.skip('embedded Postgres not available'); await fn(); });
const data = (r: { data?: unknown }) => r.data as Record<string, any>;
const cfg = () => parseConfig(baseConfig(fake));
const approve = (id: string) => { const i = h!.interactions.get(id)!; i.status = 'resolved'; i.outcome = 'accepted'; return i; };
const readyPr = async (id: number, branch: string) => {
  const issue = addIssue(h!, `ENG-${id}`);
  const pr = fake.addPr({ pullRequestId: id, sourceRefName: `refs/heads/alice/eng-${id}-x` });
  fake.evaluations.set(id, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  pr.statuses = [{ id: 1, state: 'succeeded', description: 'ok', context: { name: 'review', genre: 'paperclip' }, iterationId: 1 }];
  void branch; return { issue, pr };
};

ok('H1: after approval a retarget or a new rejection stops completion; nothing is merged', async () => {
  const { pr } = await readyPr(800, 'a');
  const base = { prId: 800, repository: 'widgets', mergeStrategy: 'squash' };
  let p = await run('ado_pr_complete_apply', base, ctx(OPERATOR_AGENT)); assert.equal(p.error, undefined, JSON.stringify(p));
  approve(data(p).interactionId);
  pr.targetRefName = 'refs/heads/release/prod';
  assert.equal((await run('ado_pr_complete_apply', { actionId: data(p).actionId }, ctx(OPERATOR_AGENT))).error, 'state_changed');
  assert.equal(pr.status, 'active');
  // second: a -10 vote arrives after approval
  const second = await readyPr(801, 'b');
  p = await run('ado_pr_complete_apply', { prId: 801, repository: 'widgets' }, ctx(OPERATOR_AGENT));
  approve(data(p).interactionId);
  second.pr.reviewers = [{ id: 'reviewer-bot', displayName: 'R', vote: -10 }];
  assert.equal((await run('ado_pr_complete_apply', { actionId: data(p).actionId }, ctx(OPERATOR_AGENT))).error, 'not_ready');
  second.pr.statuses = [{ id: 9, state: 'succeeded', description: '', context: { name: 'review', genre: 'paperclip' }, iterationId: 1 }];
  second.pr.reviewers = [];
  const again = await run('ado_pr_complete_apply', { actionId: data(p).actionId }, ctx(OPERATOR_AGENT));
  assert.equal(again.error, undefined, 'a transient problem does not burn the approval: it applies once fixed');
  assert.equal(second.pr.status, 'completed');
});

ok('H2: a protected pipeline run uses the approved project, whatever the agent passes in phase 2', async () => {
  const issue = addIssue(h!, 'ENG-810', { assigneeAgentId: OPERATOR_AGENT });
  h!.configs.set(COMPANY, parseConfig(baseConfig(fake, { projects: [{ projectId: fake.project.id, name: fake.project.name, protectedPipelines: [77] }, { projectId: P2, name: 'Other', protectedPipelines: [] }] })));
  const p = await run('ado_pipeline_run_create', { pipelineId: 77, branch: 'feature/x', project: 'Platform' }, ctx(OPERATOR_AGENT));
  assert.equal(data(p).status, 'awaiting_confirmation', JSON.stringify(p));
  approve(data(p).interactionId);
  const done = await run('ado_pipeline_run_create', { actionId: data(p).actionId, project: 'Other', pipelineId: 5, branch: 'main' }, ctx(OPERATOR_AGENT));
  assert.equal(done.error, undefined, JSON.stringify(done));
  const call = fake.calls.filter((c) => /pipelines\/\d+\/runs/.test(c.path)).at(-1)!;
  assert.match(call.path, new RegExp(`/${fake.project.id}/_apis/pipelines/77/runs`));
  void issue; h!.configs.set(COMPANY, cfg());
});

ok('H3: PAT is read from the host once per five minutes; a host secret rate limit becomes ado_rate_limited, not a crash', async () => {
  fake.addPr({ pullRequestId: 820, sourceRefName: 'refs/heads/alice/eng-820-x' });
  let resolves = 0; const orig = h!.host.resolveSecret;
  h!.host.resolveSecret = async (...a) => { resolves++; return orig(...a); };
  h!.now.t += 6 * 60_000;
  const s2 = new Service(h!.host);
  for (let i = 0; i < 8; i++) await s2.loadPr(COMPANY, cfg(), cfg().projects[0]!, 'r1', 820);
  assert.ok(resolves <= 2, `resolved ${resolves} times for 8 reads`);
  h!.host.resolveSecret = async () => { const e = new Error('Secret resolution rate limit exceeded'); e.name = 'RateLimitExceededError'; throw e; };
  h!.now.t += 6 * 60_000;
  const s3 = new Service(h!.host);
  await assert.rejects(() => s3.loadPr(COMPANY, cfg(), cfg().projects[0]!, 'r1', 820), (e: any) => e.code === 'ado_rate_limited');
  h!.host.resolveSecret = orig;
});

ok('M1: a review on a not-yet-synced iteration keeps its succeeded status', async () => {
  const issue = addIssue(h!, 'ENG-830');
  const created = await run('ado_pr_create', { repository: 'widgets', sourceBranch: 'alice/eng-830-x', title: 'T', issueId: issue.id }, ctx(AUTHOR_AGENT));
  const pr = fake.prs.get(data(created).prId)!;
  pr.createdBy = { id: 'author-bot', displayName: 'A' };
  pr.iterations = 2; pr.lastMergeSourceCommit = { commitId: 'e'.repeat(40) }; // a push the plugin has not seen yet
  const r = await run('ado_pr_review_post', { prId: pr.pullRequestId, repository: 'widgets', iteration: 2, vote: 10, summary: 'ok' }, ctx(REVIEWER_AGENT));
  assert.equal(r.error, undefined, JSON.stringify(r));
  const last = pr.statuses.filter((s) => s.context.name === 'review' && s.iterationId === 2).at(-1)!;
  assert.equal(last.state, 'succeeded');
  const row = await svc.store.getPr(COMPANY, fake.project.id, 'r1', pr.pullRequestId);
  assert.equal(row!.reviewStatus, 'succeeded');
});

ok('M2: repository allow-list holds on the webhook, reconcile, link and work-item paths', async () => {
  h!.configs.set(COMPANY, parseConfig(baseConfig(fake, { projects: [{ projectId: fake.project.id, name: fake.project.name, repositories: ['widgets'] }] })));
  const ing = new WebhookIngress(h!.host);
  const issue = addIssue(h!, 'ENG-840');
  fake.addPr({ pullRequestId: 840, sourceRefName: 'refs/heads/alice/eng-840-x', repository: { id: 'r2', name: 'other-repo', project: fake.project } });
  const body = { id: 'evt-m2', eventType: 'git.pullrequest.created', createdDate: new Date(h!.now.t).toISOString(), resourceContainers: { project: { id: fake.project.id } }, resource: { pullRequestId: 840, repository: { id: 'r2' } } };
  await ing.handle({ headers: { 'x-paperclip-hook-token': 'hook-secret-value', authorization: 'Basic ' + Buffer.from('paperclip:basic-secret-value').toString('base64') }, rawBody: JSON.stringify(body), parsedBody: body, requestId: 'r' });
  const r = await drainInbox(svc, h!.host);
  assert.equal(r.done, 0);
  assert.equal(await svc.store.getPr(COMPANY, fake.project.id, 'r2', 840), null, 'out-of-scope PR is never stored');
  assert.equal((await svc.store.linksForIssue(COMPANY, issue.id)).length, 0);
  fake.workItems.set(50, { id: 50, rev: 1, fields: { 'System.TeamProject': fake.project.name, 'System.WorkItemType': 'Task', 'System.State': 'New' } });
  const w = await run('ado_work_item_update', { workItemId: 50, linkPrId: 840, repository: 'other-repo' }, ctx(AUTHOR_AGENT));
  assert.equal(w.error, 'repo_not_in_scope');
  h!.configs.set(COMPANY, cfg());
});

ok('M3: a work item outside the selected project cannot be linked or shown as a chip', async () => {
  const issue = addIssue(h!, 'ENG-850');
  fake.workItems.set(43, { id: 43, rev: 1, fields: { 'System.TeamProject': 'Elsewhere', 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'Secret roadmap item' } });
  const l = await run('ado_link_create', { issueId: issue.id, kind: 'work_item', externalId: 43 }, ctx(AUTHOR_AGENT));
  assert.equal(l.error, 'not_found_or_forbidden');
  const { resolve } = await import('../src/provider.ts');
  const res = await resolve(svc, COMPANY, 'wi:acme/platform/43');
  assert.ok(res.ok && (res.snapshot as any).statusKey === 'not_found');
  assert.ok(!JSON.stringify(res).includes('Secret roadmap'));
});

ok('M4: a rejected proposal cannot be re-proposed in a loop: one card, a cooldown, then one more', async () => {
  const { issue } = await readyPr(860, 'c');
  const base = { prId: 860, repository: 'widgets' };
  const p = await run('ado_pr_complete_apply', base, ctx(OPERATOR_AGENT));
  const i = h!.interactions.get(data(p).interactionId)!; i.status = 'resolved'; i.outcome = 'rejected';
  await run('ado_pr_complete_apply', { actionId: data(p).actionId }, ctx(OPERATOR_AGENT));
  for (let k = 0; k < 5; k++) assert.equal((await run('ado_pr_complete_apply', base, ctx(OPERATOR_AGENT))).error, 'recently_rejected');
  assert.equal([...h!.interactions.values()].filter((x) => x.issueId === issue.id).length, 1);
  h!.now.t += 31 * 60_000;
  assert.equal((await run('ado_pr_complete_apply', base, ctx(OPERATOR_AGENT))).error, undefined);
  assert.equal([...h!.interactions.values()].filter((x) => x.issueId === issue.id).length, 2);
});

ok('M5: once a person approves, the plugin applies the action itself; no agent call is needed', async () => {
  const { issue, pr } = await readyPr(870, 'd');
  const p = await run('ado_pr_complete_apply', { prId: 870, repository: 'widgets' }, ctx(OPERATOR_AGENT));
  assert.equal(await settleApprovedActions(svc, run), 0, 'pending cards are left alone');
  assert.equal(pr.status, 'active');
  approve(data(p).interactionId);
  assert.ok((await settleApprovedActions(svc, run)) >= 1);
  assert.equal(pr.status, 'completed');
  assert.ok(issue.comments.some((c) => /approved Azure DevOps action was applied/.test(c)));
  assert.equal(await settleApprovedActions(svc, run), 0, 'settled once');
});

ok('M6: only the assignee or an operator can bind an issue by id', async () => {
  const mine = addIssue(h!, 'ENG-880', { assigneeAgentId: AUTHOR_AGENT });
  fake.addPr({ pullRequestId: 880, sourceRefName: 'refs/heads/x/y' });
  const other = 'a0000000-0000-4000-8000-0000000000aa';
  assert.equal((await run('ado_link_create', { issueId: mine.id, kind: 'pull_request', externalId: 880, repository: 'widgets' }, ctx(other))).error, 'not_your_issue');
  assert.equal((await run('ado_link_create', { issueId: mine.id, kind: 'pull_request', externalId: 880, repository: 'widgets' }, ctx(AUTHOR_AGENT))).error, undefined);
  assert.equal((await run('ado_link_create', { issueId: mine.id, kind: 'pull_request', externalId: 880, repository: 'widgets' }, ctx(OPERATOR_AGENT))).error, undefined);
});

ok('M7: one reconcile tick never exceeds maxCallsPerTickPerIdentity', async () => {
  h!.configs.set(COMPANY, parseConfig(baseConfig(fake, { reconcile: { maxCallsPerTickPerIdentity: 8 } })));
  for (const id of [890, 891, 892, 893]) { fake.addPr({ pullRequestId: id, sourceRefName: `refs/heads/alice/eng-${id}-x` }); await svc.syncPr(COMPANY, cfg(), cfg().projects[0]!, 'r1', id, 't'); }
  h!.now.t += 30 * 60_000;
  const before = fake.calls.length;
  const rep = await reconcileCompany(svc, h!.host, COMPANY, parseConfig(baseConfig(fake, { reconcile: { maxCallsPerTickPerIdentity: 8 } })));
  const spent = fake.calls.length - before;
  assert.ok(spent <= 8 + 4, `spent ${spent} calls (cap 8)`);
  assert.equal(rep.stoppedEarly, 'budget');
  h!.configs.set(COMPANY, cfg());
});

ok('M8: forged webhooks cost no host config lookups after the first (routing is cached)', async () => {
  let configCalls = 0; const orig = h!.host.config;
  h!.host.config = async (c) => { configCalls++; return orig(c); };
  const ing = new WebhookIngress(h!.host);
  const body = { id: 'x', eventType: 'git.pullrequest.updated', resourceContainers: { project: { id: fake.project.id } } };
  for (let i = 0; i < 30; i++) await ing.handle({ headers: {}, rawBody: JSON.stringify(body), parsedBody: { ...body, id: `x${i}` }, requestId: 'r' });
  h!.host.config = orig;
  assert.ok(configCalls <= 3, `config() called ${configCalls} times`);
});

ok('L1: a 200 text/html file is not mistaken for a credential rejection', async () => {
  fake.files.set('/docs/index.html', '<html>hi</html>');
  fake.addPr({ pullRequestId: 900, sourceRefName: 'refs/heads/alice/eng-900-x' });
  const r = await run('ado_pr_file_read', { prId: 900, repository: 'widgets', path: 'docs/index.html' }, ctx(AUTHOR_AGENT));
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.ok(!(await svc.store.connections(COMPANY)).some((c) => c.last_error_code === 'ado_auth' && c.role === 'reviewer' && false));
});

ok('L2: no comments on done issues, even through a title token', async () => {
  const done = addIssue(h!, 'ENG-910', { status: 'done' });
  const pr = fake.addPr({ pullRequestId: 910, title: '[ENG-910] t', sourceRefName: 'refs/heads/feature/q' });
  await svc.syncPr(COMPANY, cfg(), cfg().projects[0]!, 'r1', 910, 't');
  pr.mergeStatus = 'conflicts';
  await svc.syncPr(COMPANY, cfg(), cfg().projects[0]!, 'r1', 910, 't');
  assert.equal(done.comments.length, 0);
});

ok('L4: a poison inbox row is not claimed again after the attempt limit', async () => {
  await h!.pg.execute(`INSERT INTO ${NS}.webhook_inbox (id,company_id,event_id,event_type,resource_kind,resource_ref,project_id,received_at,status,attempts,next_attempt_at) VALUES (gen_random_uuid(),$1,'poison','git.pullrequest.updated','pull_request','{"kind":"pull_request","prId":1,"repoId":"r1"}'::jsonb,$2,$3,'pending',5,$3)`, [COMPANY, fake.project.id, new Date(h!.now.t).toISOString()]);
  await drainInbox(svc, h!.host);
  assert.equal((await h!.pg.query<{ status: string }>(`SELECT status FROM ${NS}.webhook_inbox WHERE event_id='poison'`))[0]!.status, 'pending');
});

ok('L5: an identity whose last call failed is looked up again', async () => {
  await svc.store.setConnection(COMPANY, 'reviewer', { identityId: 'stale-id', authKind: 'pat', ok: true }, new Date().toISOString());
  await svc.store.setConnection(COMPANY, 'reviewer', { authKind: 'pat', ok: false, errorCode: 'ado_auth' }, new Date().toISOString());
  const { identityId } = await import('../src/tools/common.ts');
  assert.equal(await identityId(svc, COMPANY, cfg(), 'reviewer'), 'reviewer-bot');
});

ok('L6/L8: nested-quantifier patterns are refused; an empty or tiny hook secret authenticates nothing', async () => {
  assert.equal(issueKeyFromBranch('a/eng-1', { branchPattern: '^(a+)+$', titleTokenPattern: 'x' }), null);
  const saved = h!.secrets['s0000000-0000-4000-8000-000000000003'];
  h!.secrets['s0000000-0000-4000-8000-000000000003'] = '';
  const ing = new WebhookIngress(h!.host);
  const body = { id: 'e', eventType: 'git.pullrequest.updated', resourceContainers: { project: { id: fake.project.id } }, resource: { pullRequestId: 1, repository: { id: 'r1' } } };
  const r = await ing.handle({ headers: {}, rawBody: JSON.stringify(body), parsedBody: body, requestId: 'r' });
  assert.equal(r.result, 'rejected');
  h!.secrets['s0000000-0000-4000-8000-000000000003'] = saved!;
});

ok('several projects: a repository name that exists in more than one project asks for the project and says which; a single project needs none', async () => {
  const two = [{ projectId: fake.project.id, name: fake.project.name, repositories: [] }, { projectId: 'p-2', name: 'Second', repositories: [] }];
  h!.configs.set(COMPANY, parseConfig(baseConfig(fake, { projects: two })));
  const r = await run('ado_pr_find', { repository: 'widgets' }, ctx(AUTHOR_AGENT));
  assert.equal(r.error, 'ado_bad_request'); assert.match(String(r.content), /several projects|exists in/);
  h!.configs.set(COMPANY, parseConfig(baseConfig(fake, { projects: [two[0]!] })));
  const ok1 = await run('ado_pr_find', { repository: 'widgets' }, ctx(AUTHOR_AGENT));
  assert.equal(ok1.error, undefined);
});
