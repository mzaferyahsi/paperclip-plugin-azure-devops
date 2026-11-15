import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { addIssue, baseConfig, COMPANY, makeHarness, OPERATOR_AGENT, REVIEWER_AGENT, type Harness } from './test-host.ts';
import { parseConfig } from '../src/config.ts';
import { Service } from '../src/service.ts';
import { makeToolRunner } from '../src/tools/index.ts';
import { NS } from '../src/namespace.ts';

const tool = 'ado_securefile_pipeline_permission_update';
const adminRef = 's0000000-0000-4000-8000-000000000005';
let fake: FakeAdo; let h: Harness | null; let run: ReturnType<typeof makeToolRunner>;
const config = () => parseConfig(baseConfig(fake, {
  identities: { ...baseConfig(fake).identities, admin: { kind: 'pat', patRef: { type: 'secret_ref', secretId: adminRef } } },
  platformAdmin: { enabled: true, secureFiles: ['staging.yaml'], pipelineIds: [136, 137] },
  approval: { mode: 'approvers', approverAgentIds: [REVIEWER_AGENT], pipelineRunsByApprovers: true },
}));
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
const args = { secureFile: 'staging.yaml', pipelineIds: [137, 136], reason: 'Scope staging access' };
const ok = (name: string, fn: () => Promise<void>) => test(name, async (t) => {
  if (!h) return t.skip('embedded Postgres not available');
  h.configs.set(COMPANY, config()); fake.secureFilePermissions = { allPipelines: { authorized: false }, pipelines: [] };
  await h.pg.execute(`DELETE FROM ${NS}.action`); await fn();
});
const accept = (r: { data?: unknown }, agent = false) => {
  const inter = h!.interactions.get(data(r).interactionId)!;
  inter.status = 'resolved'; inter.outcome = 'accepted';
  inter.resolvedByUserId = agent ? null : 'human'; inter.resolvedByAgentId = agent ? REVIEWER_AGENT : null;
};

ok('invariants 1, 2, 5, 7, 9: human-only named grants, additive PATCH, safe readback and replay audited', async () => {
  const start = fake.calls.length;
  fake.secureFilePermissions.pipelines = [{ id: 99, authorized: true }];
  const p = await call(args); assert.equal(p.error, undefined, JSON.stringify(p));
  const rows = await h!.pg.query<{ gate_mode: string; args_redacted: any }>(`SELECT gate_mode,args_redacted FROM ${NS}.action`);
  assert.equal(rows[0]!.gate_mode, 'board');
  assert.equal(rows[0]!.args_redacted.secureFileId, 'sf1');
  assert.deepEqual(rows[0]!.args_redacted.pipelineIds, [136, 137]);
  assert.match(h!.interactions.get(data(p).interactionId)!.prompt, /staging.yaml.*sf1/);
  assert.equal((await call({ actionId: data(p).actionId, decision: 'approve' }, 'ado_pr_approval_post', REVIEWER_AGENT)).error, 'action_not_found');
  assert.equal(data(await call({ actionId: data(p).actionId })).status, 'awaiting_confirmation');
  accept(p);
  const applied = await call({ actionId: data(p).actionId }); assert.equal(applied.error, undefined, JSON.stringify(applied));
  assert.ok(fake.secureFilePermissions.pipelines.some((p) => p.id === 99 && p.authorized));
  const replay = await call({ actionId: data(p).actionId }); assert.equal(replay.error, undefined);
  const replayAudit = await h!.pg.query<{ target: any }>(`SELECT target FROM ${NS}.audit WHERE action=$1 ORDER BY at DESC LIMIT 1`, [tool]);
  assert.equal(replayAudit[0]!.target.secureFileId, 'sf1');
  assert.equal(data(await call(args)).status, 'already_applied');
  const calls = fake.calls.slice(start);
  const patches = calls.filter((c) => c.method === 'PATCH'); assert.equal(patches.length, 1);
  assert.deepEqual(patches[0]!.body, { pipelines: [{ id: 136, authorized: true }, { id: 137, authorized: true }] });
  assert.equal(calls.at(-1)!.method, 'GET');
  for (const c of calls) {
    assert.doesNotMatch(c.path + '?' + c.query, /download|includeDownloadTicket|\/content|\/141(?:\/|\?|$)/i);
    assert.ok(c.method === 'GET' || (c.method === 'PATCH' && c.path.endsWith('/pipelinepermissions/securefile/sf1')));
  }
  const audit = await h!.pg.query(`SELECT * FROM ${NS}.audit WHERE action=$1`, [tool]);
  assert.ok(audit.length >= 5);
  assert.doesNotMatch(JSON.stringify([p, applied, replay, audit, h!.logs]), /admin-sentinel|downloadTicket|properties|content-secret/);
});

ok('invariants 2, 3, 9: forbidden keys, disabled scope, empty allowlists and invalid inputs fail before ADO and are audited', async () => {
  const start = fake.calls.length;
  for (const v of [true, false, null, {}]) assert.equal((await call({ ...args, allPipelines: v })).error, 'all_pipelines_refused');
  const cfg = config(); cfg.platformAdmin.enabled = false; h!.configs.set(COMPANY, cfg);
  assert.equal((await call(args)).error, 'not_enabled');
  cfg.platformAdmin.enabled = true; cfg.platformAdmin.pipelineIds = [];
  assert.equal((await call(args)).error, 'pipeline_not_allowed');
  cfg.platformAdmin.pipelineIds = [136, 137]; cfg.platformAdmin.secureFiles = [];
  assert.equal((await call(args)).error, 'resource_not_allowed');
  h!.configs.set(COMPANY, config());
  for (const pipelineIds of [[], [1.5], ['136'], Array(11).fill(136)]) assert.equal((await call({ ...args, pipelineIds })).error, 'bad_request');
  assert.equal(fake.calls.length, start);
  assert.equal((await call({ ...args, secureFile: 'sf2' })).error, 'resource_not_allowed');
  const audit = await h!.pg.query(`SELECT * FROM ${NS}.audit WHERE action=$1`, [tool]); assert.ok(audit.length >= 12);
});

ok('invariant 5: changed resolved id, revoked allowlist and agent acceptance cannot apply', async () => {
  const p = await call(args); accept(p);
  const original = fake.secureFiles[0]!.id; fake.secureFiles[0]!.id = 'changed';
  assert.equal((await call({ actionId: data(p).actionId })).error, 'state_changed'); fake.secureFiles[0]!.id = original;
  await h!.pg.execute(`DELETE FROM ${NS}.action`);
  const p2 = await call(args); accept(p2);
  const cfg = config(); cfg.platformAdmin.pipelineIds = []; h!.configs.set(COMPANY, cfg);
  assert.equal((await call({ actionId: data(p2).actionId })).error, 'state_changed');
  h!.configs.set(COMPANY, config()); await h!.pg.execute(`DELETE FROM ${NS}.action`);
  const p3 = await call(args); accept(p3, true);
  assert.equal((await call({ actionId: data(p3).actionId })).error, 'action_resolved_by_agent');
});

ok('invariant 9: role refusals before the handler are audited without ADO calls', async () => {
  const start = fake.calls.length;
  const before = await h!.pg.query(`SELECT id FROM ${NS}.audit WHERE action=$1`, [tool]);
  assert.equal((await call(args, tool, REVIEWER_AGENT)).error, 'role_denied');
  const after = await h!.pg.query(`SELECT id FROM ${NS}.audit WHERE action=$1`, [tool]);
  assert.equal(after.length, before.length + 1);
  assert.equal(fake.calls.length, start);
});

ok('invariants 2, 9: unsafe all-pipelines or missing requested authorization fails postcondition and ledger', async () => {
  for (const permissions of [{ allPipelines: { authorized: true }, pipelines: [{ id: 136, authorized: true }, { id: 137, authorized: true }] }, { allPipelines: { authorized: false }, pipelines: [] }]) {
    await h!.pg.execute(`DELETE FROM ${NS}.action`);
    fake.secureFilePermissions = { allPipelines: { authorized: false }, pipelines: [] };
    const p = await call(args); accept(p);
    fake.permissionPatchResult = permissions;
    const r = await call({ actionId: data(p).actionId }); assert.equal(r.error, 'postcondition_failed', JSON.stringify(r));
    const rows = await h!.pg.query<{ status: string }>(`SELECT status FROM ${NS}.action`); assert.equal(rows[0]!.status, 'failed');
  }
  fake.permissionPatchResult = undefined;
  const rows = await h!.pg.query<{ outcome: string }>(`SELECT outcome FROM ${NS}.audit WHERE action=$1`, [tool]);
  assert.ok(rows.some((r) => r.outcome.includes('postcondition_failed')));
});
