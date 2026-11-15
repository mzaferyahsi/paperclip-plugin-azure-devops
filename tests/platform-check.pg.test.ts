import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { addIssue, baseConfig, COMPANY, makeHarness, OPERATOR_AGENT, REVIEWER_AGENT, type Harness } from './test-host.ts';
import { parseConfig } from '../src/config.ts';
import { Service } from '../src/service.ts';
import { makeToolRunner } from '../src/tools/index.ts';
import { NS } from '../src/namespace.ts';

const tool = 'ado_environment_check_create';
const adminRef = 's0000000-0000-4000-8000-000000000005';
const BOSS = '1b3f8c2e-0000-4000-8000-000000000001';
const GROUP = '1b3f8c2e-0000-4000-8000-000000000002';
const GONE = '1b3f8c2e-0000-4000-8000-000000000003';
const ADMIN = 'a0000000-0000-4000-8000-0000000000ad';
let fake: FakeAdo; let h: Harness | null; let run: ReturnType<typeof makeToolRunner>;
const config = () => parseConfig(baseConfig(fake, {
  identities: { ...baseConfig(fake).identities, admin: { kind: 'pat', patRef: { type: 'secret_ref', secretId: adminRef } } },
  platformAdmin: { enabled: true, environments: ['staging'] },
  approval: { mode: 'approvers', approverAgentIds: [REVIEWER_AGENT], pipelineRunsByApprovers: true },
}));
const user = (id: string, name: string, account: string, extra: Record<string, unknown> = {}) => ({ id, providerDisplayName: name, isActive: true, isContainer: false, properties: { Account: { $type: 'System.String', $value: account } }, ...extra });
test.before(async () => {
  fake = await new FakeAdo().start(); h = await makeHarness(fake); if (!h) return;
  fake.validPats.add('admin-sentinel'); h.secrets[adminRef] = 'admin-sentinel';
  addIssue(h, 'ENG-500', { assigneeAgentId: OPERATOR_AGENT });
  run = makeToolRunner(new Service(h.host), async () => 'Agent');
});
test.after(async () => { await h?.stop(); await fake.stop(); });
let n = 0;
const call = (args: Record<string, unknown>, name = tool, agentId = OPERATOR_AGENT) => run(name, args, { companyId: COMPANY, agentId, runId: `e0000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
const data = (r: { data?: unknown }) => r.data as Record<string, any>;
const args = { environment: 'staging', approver: BOSS, reason: 'Gate staging deploys', timeoutMinutes: 60, instructions: 'Check the change ticket' };
const ok = (name: string, fn: () => Promise<void>) => test(name, async (t) => {
  if (!h) return t.skip('embedded Postgres not available');
  h.configs.set(COMPANY, config()); fake.forceCheckFlag = undefined; fake.checks = fake.checks.filter((c) => c.id === 21);
  fake.identities = [user(BOSS, 'Boss Person', 'boss@example.com'), user(GROUP, 'Staging Admins', 'group@example.com', { isContainer: true }), user(GONE, 'Gone Person', 'gone@example.com', { isActive: false }),
    user('1b3f8c2e-0000-4000-8000-000000000004', 'Dup A', 'dup@example.com'), user('1b3f8c2e-0000-4000-8000-000000000005', 'Dup B', 'dup@example.com'),
    user('author-bot', 'Paperclip Author', 'author@example.com'), user('reviewer-bot', 'Paperclip Reviewer', 'reviewer@example.com'), user(ADMIN, 'Paperclip Admin', 'admin@example.com')];
  await h.pg.execute(`DELETE FROM ${NS}.action`); await fn();
});
const accept = (r: { data?: unknown }, agent = false) => {
  const inter = h!.interactions.get(data(r).interactionId)!;
  inter.status = 'resolved'; inter.outcome = 'accepted';
  inter.resolvedByUserId = agent ? null : 'human'; inter.resolvedByAgentId = agent ? REVIEWER_AGENT : null;
};
const auditRows = () => h!.pg.query<{ outcome: string; target: any }>(`SELECT outcome,target FROM ${NS}.audit WHERE action=$1 ORDER BY at`, [tool]);

ok('invariants 4, 5, 7, 9: human-only card with names, ids and approver; forced flag; replay; no pipeline side effects; audited', async () => {
  const start = fake.calls.length;
  const p = await call(args); assert.equal(p.error, undefined, JSON.stringify(p));
  const rows = await h!.pg.query<{ gate_mode: string; args_redacted: any }>(`SELECT gate_mode,args_redacted FROM ${NS}.action`);
  assert.equal(rows[0]!.gate_mode, 'board');
  assert.equal(rows[0]!.args_redacted.environmentId, 9);
  assert.equal(rows[0]!.args_redacted.approverId, BOSS);
  const card = h!.interactions.get(data(p).interactionId)!;
  assert.match(card.prompt, /staging.*\(9\).*Boss Person.*1b3f8c2e-0000-4000-8000-000000000001/);
  assert.equal(fake.calls.slice(start).some((c) => c.method === 'POST'), false, 'nothing is created before approval');
  // an approver agent can neither see nor decide it
  assert.equal((await call({ actionId: data(p).actionId, decision: 'approve' }, 'ado_pr_approval_post', REVIEWER_AGENT)).error, 'action_not_found');
  assert.equal(data(await call({ actionId: data(p).actionId })).status, 'awaiting_confirmation');
  accept(p);
  const applied = await call({ actionId: data(p).actionId }); assert.equal(applied.error, undefined, JSON.stringify(applied));
  const posts = fake.calls.slice(start).filter((c) => c.method === 'POST'); assert.equal(posts.length, 1);
  assert.match(posts[0]!.path, /\/_apis\/pipelines\/checks\/configurations$/);
  const b = posts[0]!.body as any;
  assert.equal(b.type.id, '8C6F20A7-A545-4486-9777-F762FAFE0D4D'); assert.equal(b.settings.requesterCannotBeApprover, true);
  assert.deepEqual(b.settings.approvers, [{ id: BOSS }]); assert.equal(b.settings.minRequiredApprovers, 1); assert.equal(b.settings.executionOrder, 'anyOrder');
  assert.deepEqual(b.resource, { type: 'environment', id: '9', name: 'staging' }); assert.equal(b.timeout, 60);
  assert.equal(fake.calls.slice(start).at(-1)!.method, 'GET', 'readback is last');
  const replay = await call({ actionId: data(p).actionId }); assert.equal(replay.error, undefined);
  assert.equal(fake.calls.slice(start).filter((c) => c.method === 'POST').length, 1);
  // idempotent: an equal check now exists
  assert.equal(data(await call(args)).status, 'already_exists');
  assert.equal(fake.calls.slice(start).filter((c) => c.method === 'POST').length, 1);
  for (const c of fake.calls.slice(start)) assert.doesNotMatch(`${c.method} ${c.path}`, /pipelines\/\d+\/runs|PUT build\/definitions|build\/definitions|\/141(?:\/|$)/);
  const a = await auditRows(); assert.ok(a.length >= 4);
  assert.ok(a.some((r) => r.outcome === 'applied') && a.some((r) => r.outcome === 'already_exists'));
  assert.equal(a.at(-1)!.target.environmentId, 9);
  assert.doesNotMatch(JSON.stringify([p, applied, replay, a, h!.logs]), /admin-sentinel/);
});

ok('invariant 4: group, inactive, ambiguous, unknown, agent id and bot identities are refused before any card', async () => {
  const cards = h!.interactions.size;
  const sign = (approver: string) => call({ ...args, approver });
  assert.equal((await sign(GROUP)).error, 'not_an_ado_identity');
  assert.equal((await sign(GONE)).error, 'not_an_ado_identity');
  assert.equal((await sign('dup@example.com')).error, 'not_an_ado_identity');
  assert.equal((await sign('nobody@example.com')).error, 'not_an_ado_identity');
  assert.equal((await sign('1b3f8c2e-0000-4000-8000-0000000000ff')).error, 'not_an_ado_identity');
  assert.equal((await sign(OPERATOR_AGENT)).error, 'not_an_ado_identity', 'a Paperclip agent id is not an ADO identity');
  assert.equal((await sign('bad name with spaces')).error, 'not_an_ado_identity');
  assert.equal((await sign('author@example.com')).error, 'approver_refused');
  assert.equal((await sign('reviewer@example.com')).error, 'approver_refused');
  assert.equal((await sign('admin@example.com')).error, 'approver_refused');
  assert.equal((await sign(ADMIN)).error, 'approver_refused');
  assert.equal((await h!.pg.query(`SELECT 1 FROM ${NS}.action`)).length, 0);
  assert.equal(h!.interactions.size, cards, 'no card was created for a refused approver');
  assert.equal((await sign('boss@example.com')).error, undefined, 'a sign-in name resolves to the same single user');
  assert.ok((await auditRows()).some((r) => r.outcome === 'refused:approver_refused'));
});

ok('invariants 3, 4: disabled scope, empty lists, bad inputs and the fixed flag are refused before ADO', async () => {
  const start = fake.calls.length;
  assert.equal((await call({ ...args, requesterCannotBeApprover: false })).error, 'bad_request');
  assert.equal((await call({ ...args, requesterCannotBeApprover: true })).error, 'bad_request');
  const cfg = config(); cfg.platformAdmin.enabled = false; h!.configs.set(COMPANY, cfg);
  assert.equal((await call(args)).error, 'not_enabled');
  cfg.platformAdmin.enabled = true; cfg.platformAdmin.environments = [];
  assert.equal((await call(args)).error, 'resource_not_allowed');
  h!.configs.set(COMPANY, config());
  for (const bad of [{ timeoutMinutes: 0 }, { timeoutMinutes: 43201 }, { timeoutMinutes: 1.5 }, { timeoutMinutes: '60' }, { reason: '' }, { environment: '' }, { instructions: 'x'.repeat(501) }]) assert.equal((await call({ ...args, ...bad })).error, 'bad_request');
  assert.equal(fake.calls.length, start);
  assert.equal((await call({ ...args, environment: 'production' })).error, 'resource_not_allowed');
  assert.equal((await call({ ...args, environment: '10' })).error, 'resource_not_allowed');
  assert.equal(data(await call({ ...args, environment: '9' })).status, 'awaiting_confirmation', 'id form resolves to the allowed name');
  assert.equal((await call({ ...args, approver: BOSS }, tool, REVIEWER_AGENT)).error, 'role_denied');
  assert.ok((await auditRows()).length >= 12);
});

ok('invariant 5: changed environment id, changed approver, revoked allowlist and agent acceptance end in state_changed / refusal', async () => {
  const start = fake.calls.length;
  let p = await call(args); accept(p);
  fake.environments[0]!.id = 99;
  assert.equal((await call({ actionId: data(p).actionId })).error, 'state_changed'); fake.environments[0]!.id = 9;
  await h!.pg.execute(`DELETE FROM ${NS}.action`);
  p = await call(args); accept(p);
  fake.identities = fake.identities.filter((x) => x.id !== BOSS);
  assert.equal((await call({ actionId: data(p).actionId })).error, 'state_changed');
  await h!.pg.execute(`DELETE FROM ${NS}.action`);
  fake.identities.push(user(BOSS, 'Boss Person', 'boss@example.com'));
  p = await call(args); accept(p);
  const cfg = config(); cfg.platformAdmin.environments = []; h!.configs.set(COMPANY, cfg);
  assert.equal((await call({ actionId: data(p).actionId })).error, 'state_changed');
  h!.configs.set(COMPANY, config()); await h!.pg.execute(`DELETE FROM ${NS}.action`);
  p = await call(args); accept(p, true);
  assert.equal((await call({ actionId: data(p).actionId })).error, 'action_resolved_by_agent');
  assert.equal(fake.calls.slice(start).filter((c) => c.method === 'POST' && /checks/.test(c.path)).length, 0);
  assert.ok((await auditRows()).some((r) => r.outcome === 'refused:state_changed'));
});

ok('invariants 4, 9: a stored check without requesterCannotBeApprover fails the postcondition and the ledger', async () => {
  const p = await call(args); accept(p);
  fake.forceCheckFlag = false;
  const r = await call({ actionId: data(p).actionId }); assert.equal(r.error, 'postcondition_failed', JSON.stringify(r));
  const rows = await h!.pg.query<{ status: string }>(`SELECT status FROM ${NS}.action`); assert.equal(rows[0]!.status, 'failed');
  assert.ok((await auditRows()).some((x) => x.outcome.includes('postcondition_failed')));
});

ok('invariant 9: an equal check with the same approver is already_exists, a different approver is not', async () => {
  const start = fake.calls.length;
  fake.checks.push({ id: 50, type: { id: '8c6f20a7-a545-4486-9777-f762fafe0d4d', name: 'Approval' }, isDisabled: false, timeout: 60, settings: { approvers: [{ id: BOSS.toUpperCase(), displayName: 'Boss Person' }], executionOrder: 'anyOrder', minRequiredApprovers: 1, requesterCannotBeApprover: true } });
  assert.equal(data(await call(args)).status, 'already_exists');
  fake.identities.push(user('1b3f8c2e-0000-4000-8000-000000000009', 'Other Person', 'other@example.com'));
  assert.equal(data(await call({ ...args, approver: 'other@example.com' })).status, 'awaiting_confirmation');
  assert.equal(fake.calls.slice(start).filter((c) => c.method === 'POST').length, 0);
});
