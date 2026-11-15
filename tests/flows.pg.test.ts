// Scenario tests over real SQL + the fake ADO server: webhook ingest, drain, reconcile, effects, idempotency, two-company isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { addIssue, baseConfig, COMPANY, makeHarness, OTHER_COMPANY, type Harness } from './test-host.ts';
import { Service } from '../src/service.ts';
import { WebhookIngress } from '../src/webhook.ts';
import { drainInbox, housekeeping, reconcileCompany } from '../src/reconcile.ts';
import { parseConfig } from '../src/config.ts';
import { NS } from '../src/namespace.ts';

let fake: FakeAdo; let h: Harness | null; let svc: Service; let ingress: WebhookIngress;
test.before(async () => {
  fake = await new FakeAdo().start();
  h = await makeHarness(fake);
  if (!h) return;
  svc = new Service(h.host); ingress = new WebhookIngress(h.host);
});
test.after(async () => { await h?.stop(); await fake.stop(); });

const hook = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  const body = { id: `evt-${Math.random()}`, eventType: 'git.pullrequest.updated', createdDate: new Date(h!.now.t).toISOString(), resourceContainers: { project: { id: fake.project.id } }, resource: { pullRequestId: 500, repository: { id: 'r1' } }, ...over };
  return { headers: { 'x-paperclip-hook-token': 'hook-secret-value', authorization: 'Basic ' + Buffer.from('paperclip:basic-secret-value').toString('base64'), ...headers }, rawBody: JSON.stringify(body), parsedBody: body, requestId: 'req-1' };
};
const project = () => parseConfig(baseConfig(fake)).projects[0]!;
const cfg = () => parseConfig(baseConfig(fake));
const ok = (name: string, fn: () => Promise<void>) => test(name, async (t) => { if (!h) return t.skip('embedded Postgres not available'); await fn(); });

ok('lost webhook: the reconciler discovers a PR, links it by branch, and heals state without any event', async () => {
  const issue = addIssue(h!, 'ENG-12');
  fake.addPr({ pullRequestId: 500, title: 'Add thing', sourceRefName: 'refs/heads/alice/eng-12-thing' });
  fake.evaluations.set(500, [{ status: 'running', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  const rep = await reconcileCompany(svc, h!.host, COMPANY, cfg());
  assert.equal(rep.discovered, 1, JSON.stringify(rep));
  const links = await svc.store.linksForIssue(COMPANY, issue.id);
  assert.equal(links.length, 1); assert.equal(links[0]!.source, 'branch'); assert.equal(links[0]!.confidence, 'exact');
  // pending review status published for iteration 1, exactly once
  assert.equal(fake.prs.get(500)!.statuses.filter((s) => s.context.name === 'review').length, 1);
  // the ADO side changes with NO webhook: build policy fails
  fake.evaluations.set(500, [{ status: 'rejected', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  h!.now.t += 11 * 60_000;
  await reconcileCompany(svc, h!.host, COMPANY, cfg());
  assert.equal(issue.comments.filter((c) => /failed on !500/.test(c)).length, 1);
  assert.equal(issue.wakes.length, 1); assert.equal(issue.wakes[0]!.reason, 'ado_build_failed');
  // reconciling again with no change produces no duplicate comment or wake
  h!.now.t += 11 * 60_000;
  await reconcileCompany(svc, h!.host, COMPANY, cfg());
  assert.equal(issue.comments.filter((c) => /failed on !500/.test(c)).length, 1);
  assert.equal(issue.wakes.length, 1);
});

ok('webhook path: authenticated delivery is queued once, drained, and produces the same effects; replay is a no-op', async () => {
  const issue = addIssue(h!, 'ENG-30');
  fake.addPr({ pullRequestId: 501, title: '[ENG-30] Title token only', sourceRefName: 'refs/heads/feature/x' });
  const d = hook({ resource: { pullRequestId: 501, repository: { id: 'r1' } } });
  assert.equal((await ingress.handle(d)).result, 'accepted');
  assert.equal((await ingress.handle(d)).result, 'duplicate', 'same event id twice');
  const first = await drainInbox(svc, h!.host);
  assert.equal(first.done, 1);
  const links = await svc.store.linksForIssue(COMPANY, issue.id);
  assert.equal(links[0]!.confidence, 'likely', 'title token is only a likely link');
  fake.prs.get(501)!.mergeStatus = 'conflicts';
  assert.equal((await ingress.handle(hook({ resource: { pullRequestId: 501, repository: { id: 'r1' } } }))).result, 'accepted');
  await drainInbox(svc, h!.host);
  assert.equal(issue.comments.filter((c) => /merge conflicts/.test(c)).length, 1, 'likely link still earns a comment');
  assert.equal(issue.wakes.length, 0, 'but a likely link never wakes an agent');
});

ok('merge: comment once, in_progress issue moves to in_review (never done), only for the primary exact link', async () => {
  const issue = addIssue(h!, 'ENG-40');
  const pr = fake.addPr({ pullRequestId: 502, title: 'Merge me', sourceRefName: 'refs/heads/alice/eng-40-merge' });
  const proj = project();
  await svc.syncPr(COMPANY, cfg(), proj, 'r1', 502, 'test');
  pr.status = 'completed'; pr.lastMergeCommit = { commitId: 'd'.repeat(40) };
  await svc.syncPr(COMPANY, cfg(), proj, 'r1', 502, 'test');
  await svc.syncPr(COMPANY, cfg(), proj, 'r1', 502, 'test');
  assert.equal(issue.comments.filter((c) => /was completed into main \(commit ddddddd\)/.test(c)).length, 1);
  assert.equal(issue.status, 'in_review');
  const done = addIssue(h!, 'ENG-41', { status: 'done' });
  fake.addPr({ pullRequestId: 503, status: 'completed', sourceRefName: 'refs/heads/alice/eng-41-x' });
  await svc.syncPr(COMPANY, cfg(), proj, 'r1', 503, 'test');
  assert.equal(done.status, 'done'); assert.equal(done.wakes.length, 0);
});

ok('iteration: a new push re-requests review, resets the status to pending, and comments once', async () => {
  const issue = addIssue(h!, 'ENG-50');
  const pr = fake.addPr({ pullRequestId: 504, sourceRefName: 'refs/heads/alice/eng-50-it' });
  const proj = project();
  await svc.syncPr(COMPANY, cfg(), proj, 'r1', 504, 'test');
  pr.iterations = 2; pr.lastMergeSourceCommit = { commitId: 'b'.repeat(40) };
  await svc.syncPr(COMPANY, cfg(), proj, 'r1', 504, 'test');
  await svc.syncPr(COMPANY, cfg(), proj, 'r1', 504, 'test');
  assert.equal(issue.comments.filter((c) => /new iteration \(2\)/.test(c)).length, 1);
  assert.ok(pr.statuses.some((s) => s.iterationId === 2 && s.state === 'pending'));
});

ok('webhook security: bad token, bad basic auth, unknown project, stale event and malformed bodies are rejected without any ADO call', async () => {
  const before = fake.calls.length;
  assert.deepEqual([(await ingress.handle(hook({}, { 'x-paperclip-hook-token': 'wrong' }))).reason], ['bad_token']);
  assert.deepEqual([(await ingress.handle(hook({}, { authorization: 'Basic ' + Buffer.from('paperclip:nope').toString('base64') }))).reason], ['bad_basic_auth']);
  assert.equal((await ingress.handle(hook({ resourceContainers: { project: { id: '99999999-9999-4999-8999-999999999999' } } }))).reason, 'unknown_project');
  assert.equal((await ingress.handle({ headers: {}, rawBody: 'not json', requestId: 'x' })).reason, 'malformed');
  assert.equal((await ingress.handle(hook({ createdDate: '2020-01-01T00:00:00Z' }))).result, 'skipped');
  assert.equal(fake.calls.length, before, 'rejected events cost no ADO call');
  assert.ok(ingress.rejected10m.length >= 4);
  // a forged event with a valid structure and a foreign PR id is accepted only as a hint; the drain fetches truth and cannot be steered
  const inbox = await h!.pg.query<{ n: string }>(`SELECT count(*)::text n FROM ${NS}.webhook_inbox WHERE status='rejected'`);
  assert.equal(inbox[0]!.n, '0', 'rejections never create rows');
});

ok('hook secrets are cached so a flood of forged calls cannot exhaust the host secret rate limit', async () => {
  let resolves = 0; const orig = h!.host.resolveSecret;
  h!.host.resolveSecret = async (...a) => { resolves++; return orig(...a); };
  const ing = new WebhookIngress(h!.host);
  for (let i = 0; i < 50; i++) await ing.handle(hook({}, { 'x-paperclip-hook-token': 'bad' }));
  h!.host.resolveSecret = orig;
  assert.ok(resolves <= 2, `resolved ${resolves} times`);
});

ok('two companies on different projects do not cross-talk; the same project in two companies is refused as ambiguous', async () => {
  const proj2 = '33333333-3333-4333-8333-333333333333';
  h!.configs.set(OTHER_COMPANY, parseConfig(baseConfig(fake, { projects: [{ projectId: proj2, name: 'Other' }] }))); ingress.invalidate();
  assert.equal((await ingress.handle(hook({ resourceContainers: { project: { id: proj2 } } }))).companyId, OTHER_COMPANY);
  assert.equal((await ingress.handle(hook())).companyId, COMPANY);
  h!.configs.set(OTHER_COMPANY, parseConfig(baseConfig(fake))); ingress.invalidate();
  assert.equal((await ingress.handle(hook())).reason, 'ambiguous_project');
  h!.configs.delete(OTHER_COMPANY); ingress.invalidate();
});

ok('rate limiting: a parked identity stops the reconciler early and never loses state; budget cap bounds calls', async () => {
  fake.addPr({ pullRequestId: 510, sourceRefName: 'refs/heads/alice/eng-99-x' });
  await svc.syncPr(COMPANY, cfg(), project(), 'r1', 510, 'test');
  h!.now.t += 12 * 60_000;
  svc.gate(COMPANY, 'reviewer')!.park(120); svc.gate(COMPANY, 'author')!.park(120);
  const rep = await reconcileCompany(svc, h!.host, COMPANY, cfg());
  assert.equal(rep.stoppedEarly, 'budget');
  svc.gate(COMPANY, 'reviewer')!.parkedUntil = 0; svc.gate(COMPANY, 'author')!.parkedUntil = 0;
});

ok('drain: failures back off then fail; a stuck processing row is released by housekeeping; old rows are pruned', async () => {
  fake.fail(/GET .*pullrequests\/777$/, 503, 50);
  await ingress.handle(hook({ id: 'evt-fail', resource: { pullRequestId: 777, repository: { id: 'r1' } } }));
  fake.addPr({ pullRequestId: 777 });
  await drainInbox(svc, h!.host);
  const row = await h!.pg.query<{ status: string; attempts: number }>(`SELECT status,attempts FROM ${NS}.webhook_inbox WHERE event_id='evt-fail'`);
  assert.deepEqual([row[0]!.status, row[0]!.attempts], ['pending', 1]);
  for (let i = 0; i < 6; i++) { h!.now.t += 3600_000; await drainInbox(svc, h!.host); }
  assert.equal((await h!.pg.query<{ status: string }>(`SELECT status FROM ${NS}.webhook_inbox WHERE event_id='evt-fail'`))[0]!.status, 'failed');
  await h!.pg.execute(`INSERT INTO ${NS}.webhook_inbox (id,company_id,event_id,event_type,received_at,status,next_attempt_at) VALUES (gen_random_uuid(),$1,'stuck','x',$2,'processing',$2)`, [COMPANY, new Date(h!.now.t - 3600_000).toISOString()]);
  await housekeeping(h!.host);
  assert.equal((await h!.pg.query<{ status: string }>(`SELECT status FROM ${NS}.webhook_inbox WHERE event_id='stuck'`))[0]!.status, 'pending');
  h!.now.t += 20 * 86400_000; await housekeeping(h!.host);
  assert.equal((await h!.pg.query<{ n: string }>(`SELECT count(*)::text n FROM ${NS}.webhook_inbox WHERE event_id='evt-fail'`))[0]!.n, '0');
});

ok('build.complete webhook refreshes the PR it belongs to and stores the build', async () => {
  const issue = addIssue(h!, 'ENG-60');
  fake.addPr({ pullRequestId: 520, sourceRefName: 'refs/heads/alice/eng-60-ci' });
  await svc.syncPr(COMPANY, cfg(), project(), 'r1', 520, 'test');
  fake.builds.set(9001, { id: 9001, status: 'completed', result: 'failed', sourceBranch: 'refs/heads/alice/eng-60-ci', sourceVersion: 'abc', definition: { id: 3 }, _links: { web: { href: 'https://dev.azure.com/acme/p/_build/results?buildId=9001' } } });
  fake.evaluations.set(520, [{ status: 'rejected', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build validation' } } }]);
  await ingress.handle(hook({ id: 'evt-build', eventType: 'build.complete', resource: { id: 9001 } }));
  await drainInbox(svc, h!.host);
  assert.equal((await h!.pg.query<{ result: string }>(`SELECT result FROM ${NS}.build WHERE build_id=9001`))[0]!.result, 'failed');
  assert.equal(issue.comments.filter((c) => /Build validation" failed/.test(c)).length, 1);
});

ok('author and reviewer credentials fall back: reviewer auth failure still serves reads through the author identity', async () => {
  h!.secrets['s0000000-0000-4000-8000-000000000002'] = 'revoked';
  h!.now.t += 6 * 60_000; // the PAT is memoised for five minutes
  fake.addPr({ pullRequestId: 530 });
  const s = await svc.loadPr(COMPANY, cfg(), project(), 'r1', 530);
  assert.equal(s.prId, 530);
  const conns = await svc.store.connections(COMPANY);
  assert.equal(conns.find((c) => c.role === 'reviewer')!.last_error_code, 'ado_auth');
  h!.secrets['s0000000-0000-4000-8000-000000000002'] = 'reviewer-pat';
  h!.now.t += 6 * 60_000;
});

ok('a Build policy that stays queued with no build is evaluated again once, on the unchanged head, after the next look', async () => {
  fake.addPr({ pullRequestId: 520, title: 'Stuck policy', sourceRefName: 'refs/heads/alice/eng-520-stuck' });
  const stuck = [{ status: 'queued', context: { buildId: 0 }, configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }] as any;
  fake.evaluations.set(520, stuck);
  const patches = () => fake.calls.filter((c) => c.method === 'PATCH' && /policy\/evaluations/.test(c.path)).length;
  const before = patches();
  await reconcileCompany(svc, h!.host, COMPANY, cfg());
  assert.equal(patches(), before, 'the first look only notes it');
  h!.now.t += 4 * 60_000;
  await reconcileCompany(svc, h!.host, COMPANY, cfg());
  assert.equal(patches(), before, 'not before 8 minutes');
  h!.now.t += 11 * 60_000;
  await reconcileCompany(svc, h!.host, COMPANY, cfg());
  assert.equal(patches(), before + 1, 'asked Azure DevOps to evaluate it again');
  h!.now.t += 11 * 60_000;
  await reconcileCompany(svc, h!.host, COMPANY, cfg());
  assert.equal(patches(), before + 1, 'not again within the hour');
  // a policy that really has a build is left alone
  fake.addPr({ pullRequestId: 521, title: 'Running', sourceRefName: 'refs/heads/alice/eng-521-run' });
  fake.evaluations.set(521, [{ status: 'queued', context: { buildId: 99 }, configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }] as any);
  await reconcileCompany(svc, h!.host, COMPANY, cfg()); h!.now.t += 11 * 60_000; await reconcileCompany(svc, h!.host, COMPANY, cfg());
  assert.equal(patches(), before + 1);
});
