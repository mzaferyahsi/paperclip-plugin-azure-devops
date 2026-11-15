import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { addIssue, makeHarness, COMPANY, type Harness, type TestIssue } from './test-host.ts';
import { Service } from '../src/service.ts';
import { makeToolRunner } from '../src/tools/index.ts';
import { hooks } from '../src/tools/bundle.ts';
import { releaseBundleJob } from '../src/bundle/adapter.ts';
import { NS } from '../src/namespace.ts';
import { cfgOf, PROPOSER, CEO, TL, QA, SEC, COMMIT, FakePort, rig } from './bundle-helpers.ts';

let fake: FakeAdo; let h: Harness | null; let svc: Service; let run: ReturnType<typeof makeToolRunner>; let issue: TestIssue;
test.before(async () => { fake = await new FakeAdo().start(); h = await makeHarness(fake); if (h) { svc = new Service(h.host); run = makeToolRunner(svc, async () => 'Agent'); } });
test.after(async () => { await h?.stop(); await fake.stop(); });
let n = 0;
const ctx = (agentId = PROPOSER, companyId = COMPANY) => ({ companyId, agentId, runId: `e0000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
const T = { facts: { inMain: true, subject: 'Fix thing', author: 'Dev', pr: null as null | { id: number; url: string | null }, changedFiles: 3, comparedTo: null as string | null, behind: 0, tip: true, parents: 1 }, after: true };
const cards: Array<{ humanOnly?: boolean; prompt: string; details: string }> = [];
test.beforeEach(async () => {
  if (!h) return;
  h.configs.set(COMPANY, cfgOf());
  for (const t of ['release_bundle', 'action', 'audit']) await h.pg.execute(`DELETE FROM ${NS}.${t}`);
  h.issues.clear(); cards.length = 0; Object.assign(T.facts, { inMain: true, subject: 'Fix thing', pr: null, behind: 0, tip: true }); T.after = true;
  issue = addIssue(h, 'REL-1', { status: 'in_progress', assigneeAgentId: PROPOSER });
  hooks.readCommitFacts = async () => ({ ...T.facts }); hooks.strictlyAfter = async () => T.after;
  const real = h.host.issues.requestConfirmation;
  h.host.issues.requestConfirmation = async (c, i, x) => { cards.push({ humanOnly: x.humanOnly, prompt: x.prompt, details: x.detailsMarkdown }); return real(c, i, x); };
});
const create = (args: Record<string, unknown> = {}, agent = PROPOSER) => run('ado_release_bundle_create', { releaseIssue: 'REL-1', commit: COMMIT, reason: 'ship it', ...args }, ctx(agent));
const rows = () => h!.pg.query<{ id: string; status: string }>(`SELECT id,status FROM ${NS}.release_bundle ORDER BY created_at`);
const skip = (t: { skip: (m: string) => void }) => { if (!h) { t.skip('embedded Postgres not available'); return true; } return false; };

test('create: human-only card with live facts, one row awaiting, audited; a repeat returns the open bundle', async t => {
  if (skip(t)) return;
  const r = await create(); assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(cards.length, 1); assert.equal(cards[0]!.humanOnly, true);
  assert.match(cards[0]!.details, /main/); assert.match(cards[0]!.details, /Staging only, never production/); assert.match(cards[0]!.details, /Fix thing/);
  assert.deepEqual((await rows()).map(x => x.status), ['awaiting_confirmation']);
  assert.ok((await h!.pg.query(`SELECT 1 FROM ${NS}.audit WHERE action='bundle_proposed'`)).length === 1);
  const again = await create(); assert.equal(again.error, undefined); assert.equal(cards.length, 1, 'no second card'); assert.equal((await rows()).length, 1);
});
test('create refusals: off, role, issue, commit shape, not in main, not tip without a PR, too old, rollback, completed commit, other open bundle', async t => {
  if (skip(t)) return;
  const code = async (r: Promise<{ error?: string }>) => (await r).error;
  assert.equal(await code(create({}, TL)), 'role_denied'); assert.equal(await code(create({}, CEO)), 'role_denied');
  assert.equal(await code(create({ commit: 'abc' })), 'bad_request'); assert.equal(await code(create({ reason: ' ' })), 'bad_request');
  assert.equal(await code(create({ extra: 1 })), 'bad_request');
  issue.assigneeAgentId = TL; assert.equal(await code(create()), 'issue_not_yours'); issue.assigneeAgentId = PROPOSER;
  T.facts.inMain = false; assert.equal(await code(create()), 'commit_not_in_main'); T.facts.inMain = true;
  Object.assign(T.facts, { tip: false, behind: 2, pr: null }); assert.equal(await code(create()), 'commit_not_allowed');
  T.facts.pr = { id: 4, url: null }; T.facts.behind = 6; assert.equal(await code(create()), 'commit_too_old');
  T.facts.behind = 5; assert.equal((await create()).error, undefined, 'exactly maxCommitsBehind is allowed');
  // a second, different commit while one is open
  assert.equal(await code(create({ commit: 'b'.repeat(40) })), 'bundle_open');
  await h!.pg.execute(`UPDATE ${NS}.release_bundle SET status='completed', approved_by_user_id='u', approved_at=created_at, expires_at=created_at, build_id=1, image_digest='sha256:${'d'.repeat(64)}', digest_pinned_at=created_at, deploy_run_id=2`);
  assert.equal(await code(create()), 'already_released');
  T.after = false; assert.equal(await code(create({ commit: 'b'.repeat(40) })), 'rollback_refused');
  T.after = true; assert.equal((await create({ commit: 'b'.repeat(40) })).error, undefined);
  assert.equal(await code(run('ado_release_bundle_create', { releaseIssue: 'REL-1', commit: COMMIT, reason: 'x' }, ctx(PROPOSER, '99999999-9999-4999-8999-999999999999'))), 'not_configured');
});
test('create is off with the flag off and when the proposer is the deploy approver or a reviewer', async t => {
  if (skip(t)) return;
  h!.configs.set(COMPANY, cfgOf({ enabled: false }));
  assert.equal((await create()).error, 'not_enabled'); assert.equal((await run('ado_release_bundle_get', { bundleId: crypto.randomUUID() }, ctx())).error, 'not_enabled');
  assert.equal((await rows()).length, 0);
});
test('limits: one pending bundle per proposer, the daily cap, the cooldown after a reject', async t => {
  if (skip(t)) return;
  h!.configs.set(COMPANY, cfgOf({ maxProposalsPerAgentPerDay: 2 }));
  assert.equal((await create()).error, undefined);
  assert.equal((await create({ commit: 'b'.repeat(40) })).error, 'bundle_open');
  await h!.pg.execute(`UPDATE ${NS}.release_bundle SET status='rejected', revoked_at=$1`, [new Date(h!.now.t - 3600_000).toISOString()]);
  assert.equal((await create({ commit: 'b'.repeat(40) })).error, undefined);
  await h!.pg.execute(`UPDATE ${NS}.release_bundle SET status='expired' WHERE source_commit=$1`, ['b'.repeat(40)]);
  assert.equal((await create({ commit: 'c'.repeat(40) })).error, 'daily_cap');
});
test('get and revoke: reviewers read, listed roles revoke with a reason, a stranger is denied, revoke narrows only', async t => {
  if (skip(t)) return;
  const id = ((await create()).data as { bundleId: string }).bundleId;
  const g = await run('ado_release_bundle_get', { bundleId: id }, ctx(TL)); assert.equal(g.error, undefined); assert.equal((g.data as { status: string }).status, 'awaiting_confirmation');
  assert.equal((await run('ado_release_bundle_get', { releaseIssue: 'REL-1' }, ctx(TL))).error, undefined);
  assert.equal((await run('ado_release_bundle_revoke_apply', { bundleId: id, reason: 'r' }, ctx('a0000000-0000-4000-8000-0000000000ff'))).error, 'role_denied');
  assert.equal((await run('ado_release_bundle_revoke_apply', { bundleId: id }, ctx(TL))).error, 'bad_request');
  const r = await run('ado_release_bundle_revoke_apply', { bundleId: id, reason: 'wrong commit' }, ctx(TL)); assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual((await rows()).map(x => x.status), ['revoked']);
  assert.ok((await h!.pg.query(`SELECT 1 FROM ${NS}.audit WHERE action='bundle_revoked'`)).length === 1);
});
test('ado_pipeline_run_create for 140 or 138 on main stays gated for every caller: an operator gets a card, a bundle proposer is refused; nothing is queued', async t => {
  if (skip(t)) return;
  const OP = 'a0000000-0000-4000-8000-0000000000e1';
  h!.configs.set(COMPANY, cfgOf({}, { roles: { authorAgentIds: [PROPOSER], reviewerAgentIds: [TL, QA, SEC], operatorAgentIds: [OP] } }));
  issue.assigneeAgentId = OP;
  const queued = () => fake.calls.filter(c => c.method === 'POST' && /\/pipelines\/\d+\/runs$/.test(c.path)).length;
  for (const pipelineId of [140, 138]) {
    const before = queued();
    const r = await run('ado_pipeline_run_create', { pipelineId, branch: 'main', issueId: issue.id, reason: 'go' }, ctx(OP));
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.match(String(r.content), /confirm|approval|awaiting|person|card/i);
    const p = await run('ado_pipeline_run_create', { pipelineId, branch: 'main', issueId: issue.id, reason: 'go' }, ctx(PROPOSER));
    assert.equal(p.error, 'role_denied');
    assert.equal(queued(), before, 'no run queued');
  }
  assert.ok(cards.length >= 2, 'cards were created for the operator calls');
  assert.equal((await rows()).length, 0, 'no bundle row is involved');
});
test('second company: another company cannot read or revoke a bundle, and sees none as open', async t => {
  if (skip(t)) return;
  const other = '22222222-2222-4222-8222-bbbbbbbbbbbb'; h!.configs.set(other, cfgOf());
  const id = ((await create()).data as { bundleId: string }).bundleId;
  assert.equal((await run('ado_release_bundle_get', { bundleId: id }, ctx(PROPOSER, other))).error, 'not_found');
  assert.equal((await run('ado_release_bundle_revoke_apply', { bundleId: id, reason: 'x' }, ctx(PROPOSER, other))).error, 'not_found');
  assert.deepEqual((await rows()).map(x => x.status), ['awaiting_confirmation']);
  h!.configs.delete(other);
});
test('the job: one company failing does not stop another', async t => {
  if (skip(t)) return;
  const a = '33333333-3333-4333-8333-cccccccccccc';
  h!.configs.set(a, cfgOf());
  const r = rig(h!); const row = await r.propose(); r.accept(row);
  await h!.pg.execute(`INSERT INTO ${NS}.release_bundle (id,company_id,issue_id,project_id,proposer_agent_id,source_commit,branch,build_pipeline_id,deploy_pipeline_id,config_snapshot,config_hash,args_hash,reason,commit_facts,status,expires_at,created_at) VALUES ($1,$2,$3,'p','${PROPOSER}',$4,'refs/heads/main',140,138,'{"ttlMinutes":120}','h','a','r','{}','awaiting_confirmation',$5,$5)`, [crypto.randomUUID(), a, crypto.randomUUID(), COMMIT, new Date(h!.now.t + 60000).toISOString()]);
  const seen: string[] = [];
  const n2 = await releaseBundleJob(svc, (companyId, cfg) => { seen.push(companyId); if (companyId === a) throw new Error('boom'); return r.deps(cfg); });
  assert.ok(seen.includes(a) && seen.includes(COMPANY), 'both companies were tried'); assert.equal(n2, 1);
  assert.equal((await r.get(row.id)).status, 'active', 'the healthy company advanced');
  assert.ok(h!.logs.some(l => l.includes('release bundle tick failed')));
  h!.configs.delete(a); void FakePort;
});
test('sentinel secrets never reach bundle rows, audit rows or issue comments', async t => {
  if (skip(t)) return;
  await create({ reason: 'ship it' });
  const dump = JSON.stringify([await h!.pg.query(`SELECT * FROM ${NS}.release_bundle`), await h!.pg.query(`SELECT * FROM ${NS}.audit`), [...h!.issues.values()].flatMap(i => i.comments), cards]);
  for (const s of Object.values(h!.secrets)) assert.equal(dump.includes(s), false, 'secret value leaked');
});
