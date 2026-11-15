import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { baseConfig, COMPANY, makeHarness, OPERATOR_AGENT, REVIEWER_AGENT, type Harness } from './test-host.ts';
import { parseConfig } from '../src/config.ts';
import { Service } from '../src/service.ts';
import { makeToolRunner } from '../src/tools/index.ts';
import { NS } from '../src/namespace.ts';

const sentinel = 'PLATFORM-ADMIN-SENTINEL';
const adminRef = 's0000000-0000-4000-8000-000000000005';
const tools = ['ado_environment_find', 'ado_environment_get', 'ado_securefile_find', 'ado_securefile_get', 'ado_securefile_pipeline_permission_get'];
let fake: FakeAdo; let h: Harness | null; let run: ReturnType<typeof makeToolRunner>;
const config = (over: Record<string, unknown> = {}) => parseConfig(baseConfig(fake, {
  identities: { ...baseConfig(fake).identities, admin: { kind: 'pat', patRef: { type: 'secret_ref', secretId: adminRef } } },
  platformAdmin: { enabled: true, environments: ['staging'], secureFiles: ['staging.yaml'], pipelineIds: [136] }, ...over,
}));
test.before(async () => {
  fake = await new FakeAdo().start(); h = await makeHarness(fake); if (!h) return;
  fake.validPats.add(sentinel); h.secrets[adminRef] = sentinel; h.configs.set(COMPANY, config());
  run = makeToolRunner(new Service(h.host), async () => 'Agent');
});
test.after(async () => { await h?.stop(); await fake.stop(); });
let n = 0;
const call = (tool: string, args: Record<string, unknown> = {}, agentId = OPERATOR_AGENT) => run(tool, args, { companyId: COMPANY, agentId, runId: `f0000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
const ok = (name: string, fn: () => Promise<void>) => test(name, async (t) => { if (!h) return t.skip('embedded Postgres not available'); h.configs.set(COMPANY, config()); await fn(); });
const data = (r: { data?: unknown }) => r.data as Record<string, any>;

ok('invariants 1, 6, 7: metadata only, admin credential isolated, no pipeline side effects', async () => {
  const before = fake.calls.length;
  const results = [];
  for (const tool of tools) {
    const r = await call(tool, tool === 'ado_environment_get' ? { environmentId: 9 } : tool.endsWith('_get') ? { secureFileId: 'sf1' } : {});
    assert.equal(r.error, undefined, JSON.stringify(r)); results.push(r);
  }
  assert.deepEqual(data(results[0]!).environments, [{ id: 9, name: 'staging' }]);
  assert.deepEqual(data(results[2]!).secureFiles.map((f: any) => f.name), ['staging.yaml']);
  assert.deepEqual(data(results[1]!).checks[0].settings, { approvers: [{ id: 'approver1', displayName: 'Boss' }], executionOrder: 'anyOrder', minRequiredApprovers: 1, requesterCannotBeApprover: true });
  const calls = fake.calls.slice(before);
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.equal(c.method, 'GET');
    assert.doesNotMatch(c.path + '?' + c.query, /download|includeDownloadTicket|\/content|\/141(?:\/|\?|$)/i);
    assert.equal(c.auth, 'Basic ' + Buffer.from(':' + sentinel).toString('base64'));
  }
  assert.doesNotMatch(JSON.stringify(results), /downloadTicket|properties|content-secret|private-settings|emailAddress/);
  const audit = await h!.pg.query(`SELECT * FROM ${NS}.audit`);
  assert.doesNotMatch(JSON.stringify([results, audit, h!.logs]), new RegExp(sentinel));
});

ok('invariant 3: all five tools default deny, empty allowlists and unknown names or ids refused', async () => {
  h!.configs.set(COMPANY, config({ platformAdmin: { enabled: false } }));
  const before = fake.calls.length;
  for (const tool of tools) assert.equal((await call(tool)).error, 'not_enabled');
  assert.equal(fake.calls.length, before);
  h!.configs.set(COMPANY, config({ platformAdmin: { enabled: true } }));
  for (const tool of tools) assert.ok((await call(tool)).error);
  assert.equal(fake.calls.length, before);
  h!.configs.set(COMPANY, config());
  for (const tool of tools) {
    assert.equal((await call(tool, { name: 'STAGING' })).error, 'resource_not_allowed');
    assert.equal((await call(tool, {}, REVIEWER_AGENT)).error, 'role_denied');
  }
  assert.equal((await call('ado_environment_get', { environmentId: 10 })).error, 'resource_not_allowed');
  assert.equal((await call('ado_securefile_get', { secureFileId: 'sf2' })).error, 'resource_not_allowed');
  assert.equal((await call('ado_securefile_pipeline_permission_get', { secureFileId: 'sf2' })).error, 'resource_not_allowed');
  assert.equal((await call('ado_environment_get', { environmentId: 9, name: 'other' })).error, 'resource_not_allowed');
  assert.equal((await call('ado_securefile_get', { secureFileId: 'sf2', name: 'staging.yaml' })).error, 'resource_not_allowed');
});

ok('invariants 3, 6: changed resolved names are refused and missing admin never falls back', async () => {
  const original = fake.environments;
  fake.environments = [{ id: 9, name: 'production' }];
  assert.equal((await call('ado_environment_get', { environmentId: 9 })).error, 'resource_not_allowed');
  fake.environments = original;
  const cfg = config(); delete cfg.identities.admin; h!.configs.set(COMPANY, cfg);
  const before = fake.calls.length;
  for (const tool of tools) {
    const r = await call(tool);
    assert.equal(r.error, 'not_configured'); assert.match(r.content ?? '', /identities.admin/);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(sentinel));
  }
  assert.equal(fake.calls.length, before);
});

ok('invariant 8: securefile pipeline access is additive and uses ordinary read identity', async () => {
  h!.configs.set(COMPANY, parseConfig(baseConfig(fake)));
  const before = fake.calls.length;
  const r = await call('ado_pipeline_access_get', { resourceType: 'securefile', resourceId: 'sf1' }, REVIEWER_AGENT);
  assert.equal(r.error, undefined, JSON.stringify(r)); assert.equal(data(r).allPipelines, false);
  assert.deepEqual(data(r).pipelines, [{ id: 136, authorized: true }]);
  for (const c of fake.calls.slice(before)) assert.notEqual(c.auth, 'Basic ' + Buffer.from(':' + sentinel).toString('base64'));
  assert.equal((await call('ado_pipeline_access_get', { resourceType: 'invalid', resourceId: 'sf1' })).error, 'bad_request');
});
