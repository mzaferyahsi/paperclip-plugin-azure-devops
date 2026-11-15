import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { addIssue, baseConfig, COMPANY, makeHarness, OPERATOR_AGENT, REVIEWER_AGENT, type Harness } from './test-host.ts';
import { parseConfig, validateConfig } from '../src/config.ts';
import { Service } from '../src/service.ts';
import { makeToolRunner } from '../src/tools/index.ts';
import { NS } from '../src/namespace.ts';

const tool = 'ado_variable_group_update';
const adminRef = 's0000000-0000-4000-8000-000000000005';
const dbRef = 's0000000-0000-4000-8000-0000000000a1';
const SECRET = 'db-pass-sentinel-9f3';
let fake: FakeAdo; let h: Harness | null; let run: ReturnType<typeof makeToolRunner>;
const raw = () => baseConfig(fake, {
  identities: { ...baseConfig(fake).identities, admin: { kind: 'pat', patRef: { type: 'secret_ref', secretId: adminRef } } },
  platformAdmin: { enabled: true, variableGroups: [{ name: 'kippiowl-staging-vars', secrets: { DB_PASSWORD: { type: 'secret_ref', secretId: dbRef } } }] },
  approval: { mode: 'approvers', approverAgentIds: [REVIEWER_AGENT], pipelineRunsByApprovers: true },
});
test.before(async () => {
  fake = await new FakeAdo().start(); h = await makeHarness(fake); if (!h) return;
  fake.validPats.add('admin-sentinel'); h.secrets[adminRef] = 'admin-sentinel'; h.secrets[dbRef] = SECRET;
  addIssue(h, 'ENG-600', { assigneeAgentId: OPERATOR_AGENT });
  run = makeToolRunner(new Service(h.host), async () => 'Agent');
});
test.after(async () => { await h?.stop(); await fake.stop(); });
let n = 0;
const call = (args: Record<string, unknown>, name = tool, agentId = OPERATOR_AGENT) => run(name, args, { companyId: COMPANY, agentId, runId: `f0000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
const data = (r: { data?: unknown }) => r.data as Record<string, any>;
const ok = (name: string, fn: () => Promise<void>) => test(name, async (t) => {
  if (!h) return t.skip('embedded Postgres not available');
  h.configs.set(COMPANY, parseConfig(raw())); fake.variableGroups = [];
  await h.pg.execute(`DELETE FROM ${NS}.action`); await fn();
});
const accept = (r: { data?: unknown }) => { const inter = h!.interactions.get(data(r).interactionId)!; inter.status = 'resolved'; inter.outcome = 'accepted'; inter.resolvedByUserId = 'human'; inter.resolvedByAgentId = null; };
const args = { group: 'kippiowl-staging-vars', reason: 'Staging config', variables: [{ name: 'API_URL', value: 'https://staging.example' }], secretVariables: ['DB_PASSWORD'] };

test('config: a secret bound to a plugin credential is refused, and a good binding validates', () => {
  const vg = (c: ReturnType<typeof raw>) => validateConfig(parseConfig(c)).errors.filter((e) => /variableGroups/.test(e));
  assert.deepEqual(vg(raw()), []);
  const bad = raw(); ((bad as any).platformAdmin).variableGroups[0].secrets.DB_PASSWORD.secretId = adminRef;
  assert.equal(vg(bad).length, 1);
});

ok('create: human-only approval, secret read from its bound Paperclip secret, readback, nothing sensitive stored', async () => {
  const start = fake.calls.length;
  const p = await call(args); assert.equal(p.error, undefined, JSON.stringify(p));
  
  const rows = await h!.pg.query<{ gate_mode: string; args_redacted: any }>(`SELECT gate_mode,args_redacted FROM ${NS}.action`);
  assert.equal(rows[0]!.gate_mode, 'board');
  const card = h!.interactions.get(data(p).interactionId)!;
  assert.match(card.prompt, /Create Library variable group kippiowl-staging-vars/);
  assert.match(JSON.stringify(await h!.pg.query(`SELECT args_redacted FROM ${NS}.action`)), /API_URL/);
  assert.equal(fake.calls.slice(start).filter((c) => c.method !== 'GET').length, 0, 'nothing written before approval');
  assert.equal((await call({ actionId: data(p).actionId, decision: 'approve' }, 'ado_pr_approval_post', REVIEWER_AGENT)).error, 'action_not_found');
  accept(p);
  const applied = await call({ actionId: data(p).actionId }); if (applied.error) console.log('LOGS', JSON.stringify(h!.logs).slice(0, 2500)); assert.equal(applied.error, undefined, JSON.stringify(applied));
  const g = fake.variableGroups[0]!;
  assert.equal(g.name, 'kippiowl-staging-vars');
  assert.deepEqual(g.variables.API_URL, { value: 'https://staging.example' });
  assert.deepEqual(g.variables.DB_PASSWORD, { isSecret: true, value: SECRET });
  const writes = fake.calls.slice(start).filter((c) => c.method !== 'GET'); assert.equal(writes.length, 1);
  assert.equal(writes[0]!.method, 'POST');
  const audit = await h!.pg.query(`SELECT * FROM ${NS}.audit WHERE action=$1`, [tool]);
  const everything = JSON.stringify([p, applied, card, audit, await h!.pg.query(`SELECT * FROM ${NS}.action`), h!.logs]);
  assert.doesNotMatch(everything, new RegExp(`${SECRET}|admin-sentinel`));
});

ok('update: untouched variables and untouched secrets survive; unchanged plain values are already applied', async () => {
  fake.variableGroups = [{ id: 7, name: 'kippiowl-staging-vars', description: 'old', variables: { KEEP: { value: 'k' }, OLD_SECRET: { isSecret: true, value: 'orig' }, API_URL: { value: 'old' } } }];
  const p = await call({ ...args, secretVariables: [] }); accept(p);
  assert.equal((await call({ actionId: data(p).actionId })).error, undefined);
  const g = fake.variableGroups[0]!;
  assert.equal(g.variables.KEEP!.value, 'k'); assert.equal(g.variables.API_URL!.value, 'https://staging.example');
  assert.deepEqual(g.variables.OLD_SECRET, { isSecret: true, value: 'orig' });
  assert.equal(data(await call({ ...args, secretVariables: [] })).status, 'already_applied');
});

ok('refusals: not allowlisted, credential-looking plain name, unbound secret, bound name set as plain, secret downgrade, off switch', async () => {
  assert.equal((await call({ ...args, group: 'other-group' })).error, 'resource_not_allowed');
  assert.equal((await call({ group: 'kippiowl-staging-vars', reason: 'x', variables: [{ name: 'DB_TOKEN', value: 'abc' }] })).error, 'sensitive_name_plain');
  assert.equal((await call({ group: 'kippiowl-staging-vars', reason: 'x', secretVariables: ['NOT_BOUND'] })).error, 'secret_not_bound');
  assert.equal((await call({ group: 'kippiowl-staging-vars', reason: 'x', variables: [{ name: 'DB_PASSWORD', value: 'x' }] })).error, 'sensitive_name_plain');
  fake.variableGroups = [{ id: 7, name: 'kippiowl-staging-vars', description: '', variables: { LEVEL: { isSecret: true, value: 'x' } } }];
  assert.equal((await call({ group: 'kippiowl-staging-vars', reason: 'x', variables: [{ name: 'LEVEL', value: '1' }] })).error, 'secret_downgrade');
  assert.equal((await call({ group: 'kippiowl-staging-vars', reason: 'x' })).error, 'bad_request');
  const off = raw(); ((off as any).platformAdmin).enabled = false; h!.configs.set(COMPANY, parseConfig(off));
  assert.equal((await call(args)).error, 'not_enabled');
});
