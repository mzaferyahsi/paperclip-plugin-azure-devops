import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { argsHashOf, configHashOf, expectedParams, parseProvenance, parseRunReadback, runMismatch, snapshotOf } from '../src/bundle/model.ts';
import { cfgOf, COMMIT, DIGEST, REPO, AUTHOR_ID } from './bundle-helpers.ts';

const good = { id: 7, definition: { id: 138 }, status: 'notStarted', sourceVersion: COMMIT, sourceBranch: 'refs/heads/main', reason: 'manual', requestedFor: { id: AUTHOR_ID }, requestedBy: { id: AUTHOR_ID },
  templateParameters: { imageReference: `${REPO}@${DIGEST}`, sourceCommit: COMMIT, buildId: 5 }, resources: { repositories: { self: { refName: 'refs/heads/main', version: COMMIT } } } };
const exp = { pipelineId: 138, commit: COMMIT, authorId: AUTHOR_ID, params: expectedParams('deploy', { imageRepository: REPO, digest: DIGEST, commit: COMMIT, buildId: 5 }) };

test('run read-back: string-normalised parameters match; every deviation is named', () => {
  assert.equal(runMismatch(parseRunReadback(good), exp), null);
  const bad = (over: Record<string, unknown>) => runMismatch(parseRunReadback({ ...good, ...over }), exp);
  assert.equal(bad({ definition: { id: 140 } }), 'definition'); assert.equal(bad({ sourceVersion: 'b'.repeat(40) }), 'commit'); assert.equal(bad({ sourceBranch: 'refs/heads/dev' }), 'branch');
  assert.equal(bad({ reason: 'schedule' }), 'reason'); assert.equal(bad({ requestedFor: { id: 'other' } }), 'requestedFor');
  assert.equal(bad({ templateParameters: { ...good.templateParameters, extra: 'x' } }), 'parameters'); assert.equal(bad({ templateParameters: { ...good.templateParameters, buildId: 6 } }), 'parameters');
  assert.equal(bad({ parameters: '{"SYSTEM_DEBUG":"true"}' }), 'variables'); assert.equal(bad({ resources: { pipelines: {}, repositories: {} } }), 'resources');
  assert.equal(bad({ resources: { repositories: { other: { refName: 'refs/heads/main', version: COMMIT } } } }), 'resources');
  assert.equal(bad({ resources: { repositories: { self: { refName: 'refs/heads/main', version: 'b'.repeat(40) } } } }), 'resources');
  assert.equal(runMismatch(parseRunReadback({ ...good, parameters: JSON.stringify(good.templateParameters) }), exp), null, 'Azure DevOps echoing template parameters is not a variable');
  assert.deepEqual(expectedParams('build', { imageRepository: REPO, digest: null, commit: COMMIT, buildId: null }), {});
  assert.throws(() => parseRunReadback({ id: 0 }));
});

test('provenance artifact parser: only a well-formed reference of the configured repository, the pinned commit and the pinned build id', () => {
  const want = { imageRepository: REPO, commit: COMMIT, buildId: 5 };
  const f = (o: Record<string, string> = {}) => ({ 'image-reference.txt': `${REPO}@${DIGEST}\n`, 'source-commit.txt': `${COMMIT}\n`, 'build-id.txt': '5\n', ...o });
  assert.deepEqual(parseProvenance(f(), want), { ok: true, digest: DIGEST, imageReference: `${REPO}@${DIGEST}`, sourceCommit: COMMIT, buildId: 5 });
  const why = (o: Record<string, string>) => { const r = parseProvenance(f(o), want); return r.ok ? 'ok' : r.reason; };
  assert.equal(why({ 'image-reference.txt': `other/repo@${DIGEST}` }), 'repository_mismatch'); assert.equal(why({ 'image-reference.txt': `${REPO}:latest` }), 'repository_mismatch');
  assert.equal(why({ 'image-reference.txt': `${REPO}@sha256:abc` }), 'digest_format'); assert.equal(why({ 'image-reference.txt': `${REPO}@${DIGEST.toUpperCase()}` }), 'digest_format');
  assert.equal(why({ 'source-commit.txt': 'b'.repeat(40) }), 'commit_mismatch'); assert.equal(why({ 'build-id.txt': '6' }), 'build_id_mismatch'); assert.equal(why({ 'build-id.txt': '05' }), 'build_id_mismatch');
  assert.equal(why({ 'build-id.txt': '' }), 'artifact_incomplete'); assert.equal(why({ 'image-reference.txt': `${REPO}@${DIGEST}\nsecond` }), 'artifact_malformed');
});

test('args hash binds the card to the row: every bound field changes it; the config snapshot is order independent and changes with every bound setting', () => {
  const cfg = cfgOf(); const snap = snapshotOf(cfg); const configHash = configHashOf(snap);
  const base = { companyId: 'c', projectId: 'p', issueId: 'i', proposerAgentId: 'a', sourceCommit: COMMIT, branch: 'refs/heads/main', buildPipelineId: 140, deployPipelineId: 138, ttlMinutes: 120, configHash, reason: 'r' };
  const h = argsHashOf(base);
  for (const [k, v] of Object.entries({ companyId: 'x', projectId: 'x', issueId: 'x', proposerAgentId: 'x', sourceCommit: 'b'.repeat(40), branch: 'refs/heads/dev', buildPipelineId: 1, deployPipelineId: 2, ttlMinutes: 60, configHash: 'x', reason: 'x' })) assert.notEqual(argsHashOf({ ...base, [k]: v }), h, k);
  assert.equal(argsHashOf({ ...base }), h);
  for (const rb of [{ ttlMinutes: 60 }, { maxBuildAttempts: 1 }, { maxCommitsBehind: 1 }, { buildPipelineId: 141 }]) assert.notEqual(configHashOf(snapshotOf(cfgOf(rb, rb.buildPipelineId ? { platformAdmin: { enabled: true, environments: ['kippiowl-staging'], deployApproval: { enabled: true, approverAgentIds: [], environments: ['kippiowl-staging'], deployPipelineIds: [138], buildPipelineIds: [140, 141], imageRepository: REPO, sourceBranch: 'refs/heads/main', releaseBundle: { enabled: true, projectId: 'c0000000-0000-4000-8000-000000000001', buildPipelineId: 141, deployPipelineId: 138 } } } } : {}))), configHash, JSON.stringify(rb));
  assert.notEqual(configHashOf(snapshotOf(cfgOf({}, { projects: [{ projectId: 'c0000000-0000-4000-8000-000000000001', name: 'p', protectedBranches: ['refs/heads/main'], protectedPipelines: [7] }] }))), configHash, 'protected pipelines are bound');
});

test('the store never names a frozen column in an UPDATE (integrity without a trigger, which the host refuses)', () => {
  const src = readFileSync(new URL('../src/bundle/store.ts', import.meta.url), 'utf8');
  const frozen = ['company_id', 'issue_id', 'project_id', 'proposer_agent_id', 'source_commit', 'branch', 'build_pipeline_id', 'deploy_pipeline_id', 'config_snapshot', 'config_hash', 'args_hash', 'reason', 'commit_facts', 'created_at'];
  const updates = [...src.matchAll(/UPDATE \$\{NS\}\.release_bundle SET ([\s\S]*?) WHERE/g)].map(m => m[1]!);
  assert.ok(updates.length >= 8, 'found the UPDATE statements');
  for (const set of updates) for (const col of frozen) assert.equal(new RegExp(`(^|[\\s,])${col}\\s*=`).test(set), false, `${col} in SET: ${set.slice(0, 60)}`);
  // set-once columns only move from null
  assert.match(src, /interaction_id IS NULL/); assert.match(src, /image_digest IS NULL/); assert.match(src, /deploy_run_id IS NULL/);
  // every statement is company scoped
  for (const m of src.matchAll(/(UPDATE|DELETE FROM|SELECT[^`]*FROM) \$\{NS\}\.release_bundle[^`]*/g)) assert.match(m[0], /company_id\s*=\s*\$1/, m[0].slice(0, 80));
});

test('every other reader of the action ledger ignores bundle rows: they are applied, never proposed, escalated or awaiting', () => {
  const idx = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
  assert.match(idx, /status='awaiting_approval'/); assert.match(idx, /status IN \('awaiting_confirmation','escalated'\)/);
  const engine = readFileSync(new URL('../src/bundle/store.ts', import.meta.url), 'utf8');
  assert.match(engine, /'applied'/); assert.match(engine, /source|ado_pipeline_run_create/);
});
