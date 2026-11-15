import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { AUTHOR_AGENT, baseConfig, COMPANY, makeHarness, REVIEWER_AGENT, type Harness } from './test-host.ts';
import { Service } from '../src/service.ts';
import { GitBroker, parseGitPath } from '../src/gitbroker.ts';
import { parseConfig } from '../src/config.ts';
import { NS } from '../src/namespace.ts';

let fake: FakeAdo; let h: Harness | null; let svc: Service; let broker: GitBroker;
const RUN = 'e0000000-0000-4000-8000-000000000001'; const RUN2 = 'e0000000-0000-4000-8000-000000000002';
test.before(async () => {
  fake = await new FakeAdo().start(); h = await makeHarness(fake); if (!h) return;
  svc = new Service(h.host); broker = new GitBroker(svc);
  await h.pg.execute(`INSERT INTO public.heartbeat_runs VALUES ($1,$2,$3,'running'), ($4,$2,$3,'succeeded')`, [RUN, COMPANY, AUTHOR_AGENT, RUN2]);
  await h.pg.execute(`INSERT INTO public.heartbeat_runs VALUES ('e0000000-0000-4000-8000-000000000003',$1,$2,'running')`, [COMPANY, REVIEWER_AGENT]);
});
test.after(async () => { await h?.stop(); await fake.stop(); });
const ok = (name: string, fn: () => Promise<void>) => test(name, async (t) => { if (!h) return t.skip('embedded Postgres not available'); await fn(); });
const body = (path = 'acme/Platform/_git/widgets', host = 'dev.azure.com') => ({ protocol: 'https', host, path });

test('git paths: dev.azure.com and visualstudio.com forms, decoding, rejects', () => {
  assert.deepEqual(parseGitPath('dev.azure.com', 'acme/platform/_git/widgets', 'acme'), { org: 'acme', project: 'platform', repo: 'widgets' });
  assert.deepEqual(parseGitPath('dev.azure.com', '/acme/My%20Proj/_git/repo.git', 'acme'), { org: 'acme', project: 'My Proj', repo: 'repo' });
  assert.deepEqual(parseGitPath('acme.visualstudio.com', 'DefaultCollection/P/_git/r', 'acme'), { org: 'acme', project: 'P', repo: 'r' });
  for (const [host, p] of [['dev.azure.com', 'acme/P/widgets'], ['dev.azure.com', 'acme/P/_git/a/b'], ['evil.example', 'acme/P/_git/r'], ['other.visualstudio.com', 'P/_git/r'], ['dev.azure.com', 'acme/../_git/r']] as const) assert.equal(parseGitPath(host, p, 'acme'), null, `${host}/${p}`);
});

ok('an author run gets the author bot token, any other agent gets the reviewer bot token', async () => {
  const a = await broker.handle({ companyId: COMPANY, agentId: AUTHOR_AGENT, runId: RUN, body: body() });
  assert.equal(a.status, 200); assert.equal(a.body.identity, 'author'); assert.equal(a.body.password, 'author-pat'); assert.equal(a.body.username, 'paperclip');
  const r = await broker.handle({ companyId: COMPANY, agentId: REVIEWER_AGENT, runId: 'e0000000-0000-4000-8000-000000000003', body: body() });
  assert.equal(r.status, 200); assert.equal(r.body.identity, 'reviewer'); assert.equal(r.body.password, 'reviewer-pat');
});

ok('requests outside scope, without a live run of the same agent, or in the wrong shape are refused and never reach the bot credential', async () => {
  const deny = async (req: { agentId: string | null; runId: string | null; body: unknown }, code: string, status: number) => {
    const r = await broker.handle({ companyId: COMPANY, ...req }); assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error, code); assert.ok(!('password' in r.body));
  };
  await deny({ agentId: null, runId: RUN, body: body() }, 'agent_required', 403);
  await deny({ agentId: AUTHOR_AGENT, runId: null, body: body() }, 'run_required', 403);
  await deny({ agentId: AUTHOR_AGENT, runId: RUN2, body: body() }, 'run_not_active', 403);
  await deny({ agentId: REVIEWER_AGENT, runId: RUN, body: body() }, 'run_not_active', 403);
  await deny({ agentId: AUTHOR_AGENT, runId: RUN, body: body('acme/Other/_git/widgets') }, 'out_of_scope', 403);
  await deny({ agentId: AUTHOR_AGENT, runId: RUN, body: body('otherorg/Platform/_git/widgets') }, 'out_of_scope', 403);
  await deny({ agentId: AUTHOR_AGENT, runId: RUN, body: body('acme/Platform/_git/widgets', 'github.com') }, 'out_of_scope', 403);
  await deny({ agentId: AUTHOR_AGENT, runId: RUN, body: { protocol: 'https', host: 'dev.azure.com' } }, 'bad_request', 400);
  await deny({ agentId: AUTHOR_AGENT, runId: RUN, body: { protocol: 'http', host: 'dev.azure.com', path: 'acme/Platform/_git/widgets' } }, 'bad_request', 400);
  h!.configs.set(COMPANY, parseConfig(baseConfig(fake, { projects: [{ projectId: fake.project.id, name: fake.project.name, repositories: ['only-this'] }] })));
  await deny({ agentId: AUTHOR_AGENT, runId: RUN, body: body() }, 'out_of_scope', 403);
  h!.configs.set(COMPANY, parseConfig(baseConfig(fake)));
});

ok('audit rows record who got a credential for what, and never the token', async () => {
  const rows = await h!.pg.query<{ outcome: string; detail: unknown; target: unknown }>(`SELECT outcome, detail, target FROM ${NS}.audit WHERE action='git_credential'`);
  assert.ok(rows.some((r) => r.outcome === 'issued') && rows.some((r) => r.outcome.startsWith('denied:')));
  assert.ok(!JSON.stringify(rows).includes('author-pat') && !JSON.stringify(rows).includes('reviewer-pat'));
});

ok('a burst of requests from one agent is rate limited', async () => {
  let limited = 0;
  for (let i = 0; i < 130; i++) { const r = await broker.handle({ companyId: COMPANY, agentId: AUTHOR_AGENT, runId: RUN, body: body() }); if (r.status === 429) limited++; }
  assert.ok(limited >= 1, 'rate limit kicked in');
});

ok('a rejected bot credential becomes a clear error, not a token', async () => {
  const b2 = new GitBroker(svc);
  h!.secrets['s0000000-0000-4000-8000-000000000002'] = '';
  h!.now.t += 6 * 60_000;
  const r = await b2.handle({ companyId: COMPANY, agentId: REVIEWER_AGENT, runId: 'e0000000-0000-4000-8000-000000000003', body: body() });
  assert.notEqual(r.status, 200); assert.ok(!('password' in r.body));
  h!.secrets['s0000000-0000-4000-8000-000000000002'] = 'reviewer-pat';
});

ok('with everyone-is-author a new agent that is not a reviewer gets the author token, reviewers keep the reviewer token', async () => {
  const NEW = 'a0000000-0000-4000-8000-0000000000c1';
  await h!.pg.execute(`INSERT INTO public.heartbeat_runs VALUES ('e0000000-0000-4000-8000-0000000000c1',$1,$2,'running')`, [COMPANY, NEW]);
  const cfg = baseConfig(fake); (cfg.roles as Record<string, unknown>).everyoneIsAuthor = true;
  h!.configs.set(COMPANY, parseConfig(cfg));
  const n = await new GitBroker(svc).handle({ companyId: COMPANY, agentId: NEW, runId: 'e0000000-0000-4000-8000-0000000000c1', body: body() });
  assert.equal(n.body.identity, 'author');
  const r = await new GitBroker(svc).handle({ companyId: COMPANY, agentId: REVIEWER_AGENT, runId: 'e0000000-0000-4000-8000-000000000003', body: body() });
  assert.equal(r.body.identity, 'reviewer');
  h!.configs.set(COMPANY, parseConfig(baseConfig(fake)));
  const strict = await new GitBroker(svc).handle({ companyId: COMPANY, agentId: NEW, runId: 'e0000000-0000-4000-8000-0000000000c1', body: body() });
  assert.equal(strict.body.identity, 'reviewer', 'default stays read-only for unlisted agents');
});
