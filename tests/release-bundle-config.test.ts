import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, validateConfig } from '../src/config.ts';
import { TOOLS } from '../src/tools/catalog.ts';

const UUID = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = 'c0000000-0000-4000-8000-000000000001';
const AUTHOR = UUID(1), REVIEWER = UUID(2), PROPOSER = UUID(10), CEO = UUID(4), TL = UUID(6), QA = UUID(7), SEC = UUID(5);
const pat = (id: string) => ({ kind: 'pat', patRef: { type: 'secret_ref', secretId: id } });
export const goodRaw = (rb: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  organization: { name: 'alroze' }, projects: [{ projectId: PROJECT, name: 'p', protectedBranches: ['refs/heads/main'], protectedPipelines: [] }],
  identities: { author: pat('s1'), reviewer: pat('s2'), admin: pat('s3') },
  roles: { authorAgentIds: [PROPOSER], reviewerAgentIds: [TL, QA, SEC] },
  platformAdmin: { enabled: true, environments: ['kippiowl-staging'], deployApproval: { enabled: true, approverAgentIds: [CEO], environments: ['kippiowl-staging'], deployPipelineIds: [138], buildPipelineIds: [140], imageRepository: 'harbor.alroze.cloud/kippiowl/kippiowl', sourceBranch: 'refs/heads/main',
    releaseVerdictFunctions: { techlead: [TL], qa: [QA], security: [SEC] },
    releaseBundle: { enabled: true, projectId: PROJECT, buildPipelineId: 140, deployPipelineId: 138, proposerAgentIds: [PROPOSER], approverUserIds: ['user-1'], ...rb } } },
  ...over,
});
const errs = (rb: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => validateConfig(parseConfig(goodRaw(rb, over))).errors.filter(e => e.includes('releaseBundle'));

test('tool names carry the verb the host classifies risk from: _get is read, _create and _apply are write (first test, design F13)', () => {
  const names = TOOLS.map(t => t.name);
  // The classifier lives in the host (catalog.ts header documents it): create|update|post|apply... = write, anything else = read.
  const write = /(create|update|write|edit|patch|post|send|publish|merge|commit|apply)/;
  for (const [name, cls] of [['ado_release_bundle_create', 'G'], ['ado_release_bundle_get', 'R'], ['ado_release_bundle_revoke_apply', 'W']] as const) {
    const spec = TOOLS.find(t => t.name === name);
    assert.ok(spec, `${name} is in the catalog`);
    assert.equal(spec.cls, cls);
    assert.equal(write.test(name.replace(/^ado_release_bundle/, '')), cls !== 'R');
  }
  assert.equal(new Set(names).size, names.length);
});

test('default config: release bundle is off and valid', () => {
  const cfg = parseConfig({});
  assert.equal(cfg.platformAdmin.deployApproval.releaseBundle.enabled, false);
  assert.deepEqual(validateConfig(cfg).errors.filter(e => e.includes('releaseBundle')), []);
});

test('a complete config validates with no release bundle error', () => { assert.deepEqual(errs(), []); });

test('parser rejects unknown keys, wrong types and oversize lists; nothing is clamped', () => {
  for (const bad of [{ extra: 1 }, { enabled: 'yes' }, { ttlMinutes: '120' }, { ttlMinutes: 1.5 }, { proposerAgentIds: 'x' }, { proposerAgentIds: [1] }, { proposerAgentIds: [1, 2, 3, 4, 5, 6].map(UUID) }, { projectId: 5 }])
    assert.throws(() => parseConfig(goodRaw(bad)), /releaseBundle/, JSON.stringify(bad));
  assert.throws(() => parseConfig(goodRaw({}, { platformAdmin: { enabled: true, deployApproval: { releaseBundle: [] } } })), /releaseBundle/);
  assert.equal(parseConfig(goodRaw({ ttlMinutes: 500 })).platformAdmin.deployApproval.releaseBundle.ttlMinutes, 500);
});

test('every range violation refuses the config (ttl above 120 included)', () => {
  for (const bad of [{ ttlMinutes: 121 }, { ttlMinutes: 0 }, { proposalTtlMinutes: 61 }, { proposalTtlMinutes: 0 }, { maxBuildAttempts: 3 }, { maxBuildAttempts: 0 }, { maxCommitsBehind: 21 }, { maxCommitsBehind: -1 }, { maxProposalsPerAgentPerDay: 21 }, { maxProposalsPerAgentPerDay: 0 }])
    assert.ok(errs(bad).length, JSON.stringify(bad));
  assert.deepEqual(errs({ ttlMinutes: 120, proposalTtlMinutes: 60, maxBuildAttempts: 2, maxCommitsBehind: 20, maxProposalsPerAgentPerDay: 20 }), []);
});

test('semantic rules: prerequisites, project, pipeline ids, protected ids, proposers, approver users', () => {
  assert.ok(errs({}, { platformAdmin: { enabled: false, deployApproval: goodRaw().platformAdmin.deployApproval } }).length, 'needs platformAdmin.enabled');
  assert.ok(errs({}, { identities: { author: pat('s1'), reviewer: pat('s2') } }).length, 'needs identities.admin');
  assert.ok(errs({ projectId: '' }).length); assert.ok(errs({ projectId: 'c0000000-0000-4000-8000-0000000000ff' }).length);
  assert.ok(errs({ buildPipelineId: 141 }).length, 'build id must be in buildPipelineIds'); assert.ok(errs({ deployPipelineId: 139 }).length);
  assert.ok(errs({ buildPipelineId: 138 }).length, 'ids must differ');
  assert.ok(errs({}, { projects: [{ projectId: PROJECT, name: 'p', protectedPipelines: [140] }] }).length, 'protected build id');
  assert.ok(errs({}, { projects: [{ projectId: PROJECT, name: 'p', protectedPipelines: [138] }] }).length, 'protected deploy id');
  assert.ok(errs({ proposerAgentIds: [] }).length); assert.ok(errs({ proposerAgentIds: [PROPOSER, PROPOSER] }).length);
  assert.ok(errs({ proposerAgentIds: [AUTHOR] }).length, 'proposer must be an author-role agent');
  assert.ok(errs({ proposerAgentIds: [TL] }, { roles: { authorAgentIds: [TL], reviewerAgentIds: [TL, QA, SEC] } }).length, 'proposer in reviewer list / attestation');
  assert.ok(errs({ proposerAgentIds: [CEO] }, { roles: { authorAgentIds: [CEO], reviewerAgentIds: [TL, QA, SEC] } }).length, 'proposer is the deploy approver');
  assert.ok(errs({ approverUserIds: [] }).length, 'approverUserIds required');
  assert.ok(errs({}, { platformAdmin: { enabled: true, environments: ['kippiowl-staging'], deployApproval: { ...goodRaw().platformAdmin.deployApproval, sourceBranch: 'refs/heads/dev' } } }).length, 'branch must be main');
});

test('a disabled bundle does not demand the other fields', () => {
  assert.deepEqual(errs({ enabled: false, projectId: '', proposerAgentIds: [], approverUserIds: [] }), []);
});
