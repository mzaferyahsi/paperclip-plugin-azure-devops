import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseAttestation, type ReleaseAttestationConfig } from '../src/tools/release.ts';
import type { ReleaseVerdictRow } from '../src/store.ts';

const cfg: ReleaseAttestationConfig = {
  companyId: 'company', releaseIssueId: 'release', sourceCommit: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`, buildId: 140,
  releaseVerdictFunctions: { techlead: ['lead'], qa: ['qa'], security: ['security'] }, approverAgentIds: ['ceo'],
};
const row = (over: Partial<ReleaseVerdictRow> = {}): ReleaseVerdictRow => ({
  id: '1', companyId: cfg.companyId, releaseIssueId: cfg.releaseIssueId, sourceCommit: cfg.sourceCommit, imageDigest: cfg.imageDigest, buildId: cfg.buildId,
  fn: 'techlead', agentId: 'lead', vote: 10, summaryRedacted: 'Reviewed', runId: 'run', createdAt: '2026-11-07T01:00:00.000Z', ...over,
});

test('release attestation requires exact company, release, digest, commit and build', () => {
  assert.equal(releaseAttestation([row()], cfg).techlead.satisfied, true);
  for (const mismatch of [{ companyId: 'other' }, { releaseIssueId: 'other' }, { imageDigest: `sha256:${'c'.repeat(64)}` }, { sourceCommit: 'c'.repeat(40) }, { buildId: 141 }]) {
    assert.equal(releaseAttestation([row(mismatch)], cfg).techlead.satisfied, false);
  }
  const all = releaseAttestation([row(), row({ id: '2', fn: 'qa', agentId: 'qa', vote: 5 }), row({ id: '3', fn: 'security', agentId: 'security' })], cfg);
  assert.ok(Object.values(all).every(f => f.satisfied));
});

test('release attestation uses latest vote independent of input order; revocation and zero clear approval', () => {
  for (const vote of [-10, -5, 0]) {
    const revoked = row({ id: '2', vote, createdAt: '2026-11-07T01:00:01.000Z' });
    assert.equal(releaseAttestation([revoked, row()], cfg).techlead.satisfied, false);
    assert.equal(releaseAttestation([revoked, row({ id: '3', vote: 5, createdAt: '2026-11-07T01:00:02.000Z' })], cfg).techlead.satisfied, true);
  }
  assert.equal(releaseAttestation([row(), row({ id: '2', vote: -5 })], cfg).techlead.satisfied, false);
  assert.equal(releaseAttestation([row({ vote: -5 }), row({ id: '2' })], cfg).techlead.satisfied, false);
});

test('release attestation rechecks function membership, CEO exclusion, and disjoint functions', () => {
  assert.equal(releaseAttestation([row({ agentId: 'former' })], cfg).techlead.satisfied, false);
  assert.equal(releaseAttestation([row({ fn: 'qa' })], cfg).qa.satisfied, false);
  assert.equal(releaseAttestation([row()], { ...cfg, approverAgentIds: ['LEAD'] }).techlead.satisfied, false);
  assert.equal(releaseAttestation([row()], { ...cfg, requesterAgentId: 'LEAD' }).techlead.satisfied, false);
  const duplicate = { ...cfg, releaseVerdictFunctions: { ...cfg.releaseVerdictFunctions, qa: ['LEAD'] } };
  const result = releaseAttestation([row(), row({ fn: 'qa' })], duplicate);
  assert.equal(result.techlead.satisfied, false);
  assert.equal(result.qa.satisfied, false);
});
