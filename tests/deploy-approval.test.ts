import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, validateConfig } from '../src/config.ts';
import { allowBuildPipeline, allowDeployEnvironment, allowDeployPipeline, requireDeployApproval } from '../src/platform-admin.ts';
import { roleAllowed, fail, finish } from '../src/tools/common.ts';
import { Service } from '../src/service.ts';
import type { Host } from '../src/host.ts';
import { FakeAdo } from './fake-ado.ts';
import { AdoShapeError, parsePipelineApproval, parseBuildFacts } from '../src/ado/api.ts';

const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
const [ceo, lead, qa, security, author] = ids as [string, string, string, string, string];
const ref = (secretId: string) => ({ type: 'secret_ref', secretId });
const deploy = () => ({ enabled: true, approverAgentIds: [ceo], environments: ['staging'], deployPipelineIds: [138], buildPipelineIds: [140], imageRepository: 'harbor.alroze.cloud/kippiowl/kippiowl', sourceBranch: 'refs/heads/main', releaseVerdictFunctions: { techlead: [lead], qa: [qa], security: [security] } });
const raw = () => ({ organization: { name: 'acme' }, identities: { author: { kind: 'pat', patRef: ref('author') }, reviewer: { kind: 'pat', patRef: ref('reviewer') }, admin: { kind: 'pat', patRef: ref('admin') } }, roles: { authorAgentIds: [author], reviewerAgentIds: [lead, qa, security] }, platformAdmin: { enabled: true, environments: ['staging'], deployApproval: deploy() } });
const approval = () => ({ id: ceo, status: 'pending', steps: [{ assignedApprover: { id: lead }, status: 'pending' }], pipeline: { id: 138 }, owner: { id: 77 }, checkConfiguration: { id: 21, resource: { type: 'environment', id: '9' } } });
const build = () => ({ id: 77, definition: { id: 138 }, status: 'inProgress', sourceBranch: 'refs/heads/main', sourceVersion: 'a'.repeat(40), reason: 'manual', requestedFor: { id: author }, requestedBy: { id: author }, templateParameters: { imageReference: 'image', buildId: '1' } });

test('deploy approval defaults deny all resources and roles', () => {
  const cfg = parseConfig({});
  assert.equal(cfg.platformAdmin.deployApproval.enabled, false);
  assert.throws(() => requireDeployApproval(cfg), { code: 'not_enabled' });
  assert.equal(allowDeployPipeline(cfg, 138), false);
  assert.equal(allowBuildPipeline(cfg, 140), false);
  assert.equal(allowDeployEnvironment(cfg, 'staging'), false);
  for (const id of ids) assert.equal(roleAllowed(cfg, id, 'deploy_approver'), false);
});

test('deploy approval configuration and exact default-deny allowlists', () => {
  const cfg = parseConfig(raw());
  assert.deepEqual(validateConfig(cfg).errors, []);
  requireDeployApproval(cfg);
  assert.equal(allowDeployPipeline(cfg, 138), true);
  for (const id of [140, 141, 0, 138.5, NaN]) assert.equal(allowDeployPipeline(cfg, id), false);
  assert.equal(allowBuildPipeline(cfg, 140), true);
  assert.equal(allowBuildPipeline(cfg, 138), false);
  assert.equal(allowDeployEnvironment(cfg, 'staging'), true);
  for (const name of ['STAGING', 'staging ', 'production', '*']) assert.equal(allowDeployEnvironment(cfg, name), false);
  assert.equal(roleAllowed(cfg, ceo.toUpperCase(), 'deploy_approver'), true);
  for (const role of ['author', 'reviewer', 'operator', 'approver', 'gate'] as const) assert.equal(roleAllowed(cfg, ceo, role), false);
  for (const id of [lead, qa, security, author]) assert.equal(roleAllowed(cfg, id, 'deploy_approver'), false);
  cfg.platformAdmin.enabled = false;
  assert.throws(() => requireDeployApproval(cfg), { code: 'not_enabled' });
  assert.equal(allowDeployPipeline(cfg, 138), false);
  assert.equal(allowDeployEnvironment(cfg, 'staging'), false);
});

test('deploy configuration rejects malformed types without echoing values', () => {
  for (const patch of [{ enabled: 'true' }, { approverAgentIds: [42] }, { deployPipelineIds: ['138'] }, { environments: 'staging' }, { releaseVerdictFunctions: { qa: 'id' } }, { extra: true }, { deployPipelineIds: [1, 2, 3, 4] }]) {
    const value = raw(); Object.assign(value.platformAdmin.deployApproval, patch);
    assert.throws(() => parseConfig(value));
  }
});

test('deploy configuration validates separation, UUIDs, bounded lists and required bindings', () => {
  const invalid = [
    (v: ReturnType<typeof raw>) => { v.platformAdmin.enabled = false; },
    (v: ReturnType<typeof raw>) => { delete (v.identities as { admin?: unknown }).admin; },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.approverAgentIds = []; },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.approverAgentIds = ['invalid']; },
    (v: ReturnType<typeof raw>) => { v.roles.authorAgentIds.push(ceo); },
    (v: ReturnType<typeof raw>) => { v.roles.reviewerAgentIds.push(ceo); },
    (v: ReturnType<typeof raw>) => { Object.assign(v.roles, { everyoneIsAuthor: true }); },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.releaseVerdictFunctions.qa = [lead]; },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.releaseVerdictFunctions.qa = [author]; },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.releaseVerdictFunctions.qa = []; },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.environments = ['Production']; v.platformAdmin.environments.push('Production'); },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.environments = ['STAGING']; },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.deployPipelineIds = [0]; },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.buildPipelineIds = [140, 140]; },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.imageRepository = 'harbor/*'; },
    (v: ReturnType<typeof raw>) => { v.platformAdmin.deployApproval.sourceBranch = 'main'; },
  ];
  for (const change of invalid) { const v = raw(); change(v); assert.equal(validateConfig(parseConfig(v)).ok, false); }
});

test('approval and build parsers reject unknown shapes with typed, value-free errors', () => {
  assert.equal(parsePipelineApproval(approval()).owner.id, 77);
  assert.equal(parseBuildFacts(build()).definition.id, 138);
  assert.deepEqual(parseBuildFacts({ ...build(), templateParameters: undefined, parameters: '{"buildId":"1"}' }).parameters, { buildId: '1' });
  for (const bad of [{}, { ...approval(), steps: [{}] }, { ...approval(), owner: { id: '77' } }, { ...approval(), status: 'surprise' }, { ...approval(), checkConfiguration: { id: '21' } }]) assert.throws(() => parsePipelineApproval(bad), AdoShapeError);
  for (const bad of [{}, { ...build(), requestedBy: {} }, { ...build(), parameters: 'sentinel-secret' }, { ...build(), templateParameters: [] }, { ...build(), sourceVersion: 'bad' }, { ...build(), parameters: '{"buildId":"2"}' }]) assert.throws(() => parseBuildFacts(bad), AdoShapeError);
});

test('admin approval API uses exact PATCH array; read never resolves admin; sentinel stays out of errors/logs', async () => {
  const fake = await new FakeAdo().start();
  const sentinel = 'admin-sentinel'; fake.validPats.add(sentinel);
  const resolved: string[] = [], logs: unknown[] = [];
  const cfg = parseConfig(raw());
  const host = { now: Date.now, config: async () => cfg, db: { query: async () => [], execute: async () => ({ rowCount: 0 }) }, fetch,
    resolveSecret: async (_company: string, r: { secretId: string }) => { resolved.push(r.secretId); return r.secretId === 'admin' ? sentinel : `${r.secretId}-pat`; },
    log: { info: (...v: unknown[]) => logs.push(v), warn: (...v: unknown[]) => logs.push(v), error: (...v: unknown[]) => logs.push(v) },
    clientDeps: { apiBase: () => fake.base, sleep: async () => {} } } as unknown as Host;
  const svc = new Service(host);
  try {
    fake.approvals.set(ceo, approval()); fake.builds.set(77, build());
    fake.checks = [{ id: 21, type: { id: '8C6F20A7-A545-4486-9777-F762FAFE0D4D', name: 'Approval' }, resource: { type: 'environment', id: '9' } }];
    await svc.read('c', cfg, api => api.listProjects());
    assert.equal(resolved.includes('admin'), false);
    for (const role of ['author', 'reviewer'] as const) {
      const ordinary = svc.api('c', cfg, role);
      for (const call of [() => ordinary.pipelineApprovals('p', {}), () => ordinary.decidePipelineApproval('p', ceo, 'approved', 'Reviewed'), () => ordinary.checkConfiguration('p', 21), () => ordinary.buildFacts('p', 77)]) await assert.rejects(call, { code: 'ado_config' });
    }
    const api = svc.admin('c', cfg).api;
    assert.equal((await api.pipelineApprovals('p', { approvalIds: [ceo], state: 'pending' }))[0]!.id, ceo);
    assert.equal((await api.checkConfiguration('p', 21)).resource.id, '9');
    assert.equal((await api.buildFacts('p', 77)).id, 77);
    await api.decidePipelineApproval('p', ceo, 'approved', 'Reviewed');
    const call = fake.calls.find(c => c.method === 'PATCH' && c.path.endsWith('/pipelines/approvals'))!;
    assert.deepEqual(call.body, [{ approvalId: ceo, status: 'approved', comment: 'Reviewed' }]);
    assert.equal(call.query.get('api-version'), '7.1-preview');
    const get = fake.calls.find(c => c.method === 'GET' && c.path.endsWith('/pipelines/approvals'))!;
    assert.equal(get.query.get('$expand'), 'steps');
    assert.equal(get.query.get('approvalIds'), ceo);
    fake.approvals.set(ceo, { id: sentinel });
    let output = '';
    try { await api.pipelineApprovals('p', {}); assert.fail('must reject'); } catch (e) { output += JSON.stringify(finish(fail(e))); output += String(e); }
    fake.fail(/pipelines\/approvals$/, 400, 1, {}, { message: sentinel });
    try { await api.pipelineApprovals('p', {}); assert.fail('must reject'); } catch (e) { output += JSON.stringify(finish(fail(e))); }
    assert.equal((output + JSON.stringify(logs)).includes(sentinel), false);
  } finally { await fake.stop(); }
});
