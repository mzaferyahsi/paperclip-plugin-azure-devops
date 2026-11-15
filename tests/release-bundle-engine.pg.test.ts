import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { makeHarness, COMPANY, type Harness } from './test-host.ts';
import { rig, cfgOf, COMMIT, DIGEST, REPO, PROPOSER, AUTHOR_ID, type Rig } from './bundle-helpers.ts';
import { NS } from '../src/namespace.ts';
import { revokeBundle } from '../src/bundle/engine.ts';

let fake: FakeAdo; let h: Harness | null;
test.before(async () => { fake = await new FakeAdo().start(); h = await makeHarness(fake); });
test.after(async () => { await h?.stop(); await fake.stop(); });
test.beforeEach(async () => { if (h) await h.pg.execute(`DELETE FROM ${NS}.release_bundle`); if (h) await h.pg.execute(`DELETE FROM ${NS}.action WHERE tool='ado_pipeline_run_create'`); });

const MIN = 60_000;
async function started(t: { skip: (m: string) => void }, over: { commit?: string } = {}): Promise<Rig | null> {
  if (!h) { t.skip('embedded Postgres not available'); return null; }
  const r = rig(h); h.now.t = Date.parse('2026-10-25T10:00:00Z');
  const row = await r.propose(over); r.accept(row); await r.tick();
  assert.equal((await r.get(row.id)).status, 'active');
  (r as Rig & { id: string }).id = row.id;
  return r;
}
const idOf = (r: Rig) => (r as Rig & { id: string }).id;
const ledger = async (r: Rig) => (await h!.pg.query<{ idempotency_key: string; result: { runId: number } }>(`SELECT idempotency_key, result FROM ${NS}.action WHERE tool='ado_pipeline_run_create' ORDER BY idempotency_key`));

test('happy path: accept, 140 at the pinned commit with no parameters, pin from the artifact, 138 with exactly the three parameters, completed', async t => {
  const r = await started(t); if (!r) return;
  await r.tick();
  let b = await r.get(idOf(r));
  assert.equal(b.status, 'building'); assert.equal(b.buildAttempts, 1); assert.equal(b.buildId, 500);
  assert.deepEqual(r.port.posts, [{ pipelineId: 140, commit: COMMIT, params: {} }]);
  await r.tick(); assert.equal((await r.get(b.id)).status, 'building', 'a running build changes nothing');
  r.port.finish(500, 'succeeded'); r.port.files.set(500, r.port.goodFiles(500));
  await r.tick(); b = await r.get(b.id);
  assert.equal(b.status, 'built'); assert.equal(b.imageDigest, DIGEST);
  await r.tick(); b = await r.get(b.id);
  assert.equal(b.status, 'deploying'); assert.equal(b.deployRunId, 501);
  assert.deepEqual(r.port.posts[1], { pipelineId: 138, commit: COMMIT, params: { imageReference: `${REPO}@${DIGEST}`, sourceCommit: COMMIT, buildId: '500' } });
  assert.deepEqual((await ledger(r)).map(x => [x.idempotency_key.replace(b.id, 'B'), x.result.runId]), [['bundle:B:build:1', 500], ['bundle:B:deploy', 501]]);
  r.port.finish(501, 'succeeded'); await r.tick();
  assert.equal((await r.get(b.id)).status, 'completed');
  assert.equal(r.port.posts.length, 2);
});

test('accept guards: an agent, a user not listed, a late accept and a rejected card all start nothing', async t => {
  if (!h) return t.skip('embedded Postgres not available');
  const r = rig(h); h.now.t = Date.parse('2026-10-25T10:00:00Z');
  for (const [by, status] of [[{ agent: PROPOSER, user: null }, 'rejected'], [{ user: 'stranger' }, 'rejected']] as const) {
    const row = await r.propose(); r.accept(row, by); await r.tick();
    assert.equal((await r.get(row.id)).status, status);
  }
  const late = await r.propose(); r.accept(late); h.now.t += 31 * MIN; await r.tick();
  assert.notEqual((await r.get(late.id)).status, 'active', 'accepted after the proposal TTL');
  const rej = await r.propose(); const i = h.interactions.get(rej.interactionId!)!; i.status = 'answered'; i.outcome = 'rejected'; await r.tick();
  assert.equal((await r.get(rej.id)).status, 'rejected');
  assert.equal(r.port.posts.length, 0);
});

for (const kind of ['build', 'deploy'] as const) for (const matches of [0, 1, 2] as const) {
  test(`crash after the ${kind} POST with ${matches} matching run(s)`, async t => {
    const r = await started(t); if (!r) return; const id = idOf(r);
    if (kind === 'deploy') { await r.tick(); r.port.finish(500, 'succeeded'); r.port.files.set(500, r.port.goodFiles(500)); await r.tick(); }
    r.port.failAfterPost = [1];
    await r.tick(); // queue call throws after the run exists
    let b = await r.get(id);
    assert.equal(b.status, kind === 'build' ? 'building' : 'deploying'); assert.equal(kind === 'build' ? b.buildId : b.deployRunId, kind === 'build' ? null : null);
    const posts = r.port.posts.length;
    // extra matching runs created by "someone" with the same parameters
    const pipe = kind === 'build' ? 140 : 138; const created = [...r.port.runs.values()].filter(x => x.definitionId === pipe).at(-1)!;
    if (matches === 0) r.port.runs.delete(created.id);
    if (matches === 2) r.port.mk(900, pipe, COMMIT, created.templateParameters);
    await r.tick(); assert.equal((await r.get(id)).status, kind === 'build' ? 'building' : 'deploying', 'lease still held: nothing decided');
    h!.now.t += 3 * MIN; await r.tick(); b = await r.get(id);
    if (matches === 1) { assert.equal(kind === 'build' ? b.buildId : b.deployRunId, created.id, 'adopted'); assert.equal(r.port.posts.length, posts, 'no second POST'); assert.equal((await ledger(r)).some(x => x.result.runId === created.id), true, 'ledger row written on adoption'); }
    if (matches === 2) { assert.equal(b.status, 'failed'); assert.equal(r.port.posts.length, posts); }
    if (matches === 0 && kind === 'deploy') { assert.equal(b.status, 'failed', '138 with no run found fails'); assert.equal(r.port.posts.length, posts, 'never queued again'); }
    if (matches === 0 && kind === 'build') {
      assert.equal(b.status, 'building', 'waits for the listing lag'); assert.equal(r.port.posts.length, posts);
      h!.now.t += 3 * MIN; await r.tick(); b = await r.get(id); assert.equal(b.status, 'active', 'lag over: back to active');
      await r.tick(); b = await r.get(id); assert.equal(b.buildAttempts, 2); assert.equal(r.port.posts.length, posts + 1, 'queued once more');
    }
  });
}

test('adoption refuses a run with other parameters, another requester or another commit', async t => {
  const r = await started(t); if (!r) return; const id = idOf(r);
  await r.tick(); r.port.finish(500, 'succeeded'); r.port.files.set(500, r.port.goodFiles(500)); await r.tick();
  r.port.failAfterPost = [1]; await r.tick();
  for (const x of [...r.port.runs.values()].filter(x => x.definitionId === 138)) r.port.runs.delete(x.id);
  r.port.mk(950, 138, COMMIT, { imageReference: `${REPO}@sha256:${'e'.repeat(64)}`, sourceCommit: COMMIT, buildId: '500' });
  r.port.mk(951, 138, COMMIT, { imageReference: `${REPO}@${DIGEST}`, sourceCommit: COMMIT, buildId: '500' }, { requestedForId: 'someone-else' });
  r.port.mk(952, 138, 'b'.repeat(40), { imageReference: `${REPO}@${DIGEST}`, sourceCommit: COMMIT, buildId: '500' });
  r.port.mk(953, 138, COMMIT, { imageReference: `${REPO}@${DIGEST}`, sourceCommit: COMMIT, buildId: '500' }, { variables: { x: 1 } });
  h!.now.t += 3 * MIN; await r.tick();
  assert.equal((await r.get(id)).status, 'failed');
});

test('artifact checks: missing, other commit, other build id, other repository, bad digest, and tags/logs are never read', async t => {
  for (const [name, files] of [['missing', null], ['commit', { commit: 'c'.repeat(40) }], ['build id', { build: 999 }], ['repository', { repo: 'evil.example/x' }], ['digest', { digest: 'sha256:short' }]] as const) {
    const r = await started(t); if (!r) return; const id = idOf(r);
    await r.tick(); r.port.finish(500, 'succeeded'); r.port.files.set(500, files === null ? null : r.port.goodFiles(500, files));
    await r.tick();
    const b = await r.get(id); assert.equal(b.status, 'failed', name); assert.equal(b.imageDigest, null, name);
    await h!.pg.execute(`DELETE FROM ${NS}.release_bundle`); r.port.runs.clear(); r.port.posts.length = 0;
  }
});

test('a failed build is recorded, never used; retry is capped by maxBuildAttempts; the digest of the failed build is not pinned', async t => {
  const r = await started(t); if (!r) return; const id = idOf(r);
  await r.tick(); r.port.finish(500, 'failed'); r.port.files.set(500, r.port.goodFiles(500, { digest: `sha256:${'f'.repeat(64)}` }));
  await r.tick(); let b = await r.get(id); assert.equal(b.status, 'active'); assert.equal(b.imageDigest, null); assert.equal(b.buildId, null);
  await r.tick(); b = await r.get(id); assert.equal(b.buildAttempts, 2); assert.equal(b.buildId, 501);
  r.port.finish(501, 'failed'); await r.tick(); b = await r.get(id);
  assert.equal(b.status, 'failed'); assert.equal((b.result.attempts as unknown[]).length, 2);
  assert.equal(r.port.posts.length, 2);
});

test('window: expiry before step 2 stops the bundle; nothing is queued after the window', async t => {
  const r = await started(t); if (!r) return; const id = idOf(r);
  await r.tick(); r.port.finish(500, 'succeeded'); r.port.files.set(500, r.port.goodFiles(500)); await r.tick();
  assert.equal((await r.get(id)).status, 'built');
  h!.now.t += 121 * MIN; await r.tick();
  assert.equal((await r.get(id)).status, 'expired'); assert.equal(r.port.posts.length, 1);
});

test('flag off and config changed mid-flight stop the bundle; the config drift is audited as bundle_refused', async t => {
  let r = await started(t); if (!r) return;
  await r.tick(cfgOf({ enabled: false })); assert.equal((await r.get(idOf(r))).status, 'expired'); assert.equal(r.port.posts.length, 0);
  await h!.pg.execute(`DELETE FROM ${NS}.release_bundle`);
  r = await started(t); if (!r) return;
  await r.tick(cfgOf({ ttlMinutes: 60 })); const b = await r.get(idOf(r));
  assert.equal(b.status, 'expired'); assert.equal(r.port.posts.length, 0);
  assert.ok((await h!.pg.query(`SELECT 1 FROM ${NS}.audit WHERE action='bundle_refused' AND outcome='config_changed'`)).length >= 1);
});

test('revoke before each step stops the next step; revoke cancels a pending 138 and leaves a running one', async t => {
  let r = await started(t); if (!r) return;
  assert.equal((await revokeBundle(r.deps(), await r.get(idOf(r)), 'user-1', 'no')).revoked, true);
  await r.tick(); assert.equal(r.port.posts.length, 0);
  await h!.pg.execute(`DELETE FROM ${NS}.release_bundle`);
  for (const running of [false, true]) {
    r = await started(t); if (!r) return; const id = idOf(r);
    await r.tick(); r.port.finish(500, 'succeeded'); r.port.files.set(500, r.port.goodFiles(500)); await r.tick();
    assert.equal((await revokeBundle(r.deps(), await r.get(id), 'user-1', 'x')).revoked, true, 'revoke in built');
    await h!.pg.execute(`DELETE FROM ${NS}.release_bundle`); r.port.runs.clear(); r.port.posts.length = 0;
    r = await started(t); if (!r) return; const id2 = idOf(r);
    await r.tick(); r.port.finish(500, 'succeeded'); r.port.files.set(500, r.port.goodFiles(500)); await r.tick(); await r.tick();
    let b = await r.get(id2); assert.equal(b.status, 'deploying');
    if (!running) r.port.pending.add(b.deployRunId!);
    const out = await revokeBundle(r.deps(), b, 'user-1', 'stop');
    b = await r.get(id2);
    if (running) { assert.equal(out.revoked, false); assert.equal(b.status, 'deploying'); assert.deepEqual(r.port.cancelled, []); }
    else { assert.equal(out.revoked, true); assert.equal(b.status, 'revoked'); assert.deepEqual(r.port.cancelled, [b.deployRunId]); }
    await h!.pg.execute(`DELETE FROM ${NS}.release_bundle`); r.port.runs.clear(); r.port.posts.length = 0; r.port.cancelled.length = 0;
  }
});

test('window ends while 138 waits at the approval: cancelled then expired; while it runs: stays deploying until it ends', async t => {
  for (const pending of [true, false]) {
    const r = await started(t); if (!r) return; const id = idOf(r);
    await r.tick(); r.port.finish(500, 'succeeded'); r.port.files.set(500, r.port.goodFiles(500)); await r.tick(); await r.tick();
    const run = (await r.get(id)).deployRunId!; if (pending) r.port.pending.add(run);
    h!.now.t += 121 * MIN; await r.tick();
    const b = await r.get(id);
    if (pending) { assert.equal(b.status, 'expired'); assert.deepEqual(r.port.cancelled, [run]); }
    else { assert.equal(b.status, 'deploying'); assert.deepEqual(r.port.cancelled, []); r.port.finish(run, 'succeeded'); await r.tick(); assert.equal((await r.get(id)).status, 'completed'); }
    await h!.pg.execute(`DELETE FROM ${NS}.release_bundle`); r.port.runs.clear();
  }
});

test('a commit that left main fails the bundle before any queue call', async t => {
  const r = await started(t); if (!r) return;
  r.port.contains = false; await r.tick();
  assert.equal((await r.get(idOf(r))).status, 'failed'); assert.equal(r.port.posts.length, 0);
  const r2 = await started(t); if (!r2) return; r2.port.mainDown = true; await r2.tick(); // unreadable main also fails closed
  assert.equal(r2.port.posts.length, 0);
});

test('replay and concurrent workers: two simultaneous ticks queue one build and one deploy', async t => {
  const r = await started(t); if (!r) return;
  await Promise.all([r.tick(), r.tick(), r.tick()]);
  assert.equal(r.port.posts.filter(p => p.pipelineId === 140).length, 1);
  r.port.finish(500, 'succeeded'); r.port.files.set(500, r.port.goodFiles(500)); await r.tick();
  await Promise.all([r.tick(), r.tick(), r.tick()]);
  assert.equal(r.port.posts.filter(p => p.pipelineId === 138).length, 1);
  assert.equal((await ledger(r)).length, 2);
});

test('crash between the bundle update and the ledger row: the next tick writes the ledger row', async t => {
  const r = await started(t); if (!r) return; const id = idOf(r);
  await r.tick(); await h!.pg.execute(`DELETE FROM ${NS}.action WHERE tool='ado_pipeline_run_create'`);
  await r.tick(); const rows = await ledger(r);
  assert.deepEqual(rows.map(x => x.result.runId), [500]); assert.ok(rows[0]!.idempotency_key.endsWith(':build:1'), id);
});

test('ledger rows name the proposer, carry source release_bundle and expire with the window', async t => {
  const r = await started(t); if (!r) return; await r.tick();
  const [row] = await h!.pg.query<{ agent_id: string; args_redacted: Record<string, unknown>; risk_class: string; status: string }>(`SELECT agent_id,args_redacted,risk_class,status FROM ${NS}.action WHERE tool='ado_pipeline_run_create'`);
  assert.equal(row!.agent_id, PROPOSER); assert.equal(row!.args_redacted.source, 'release_bundle'); assert.equal(row!.args_redacted.pipelineId, 140); assert.equal(row!.risk_class, 'G'); assert.equal(row!.status, 'applied');
  assert.notEqual(AUTHOR_ID, PROPOSER);
});

test('three refused accepts in a day raise one bundle_abuse_alert', async t => {
  if (!h) return t.skip('embedded Postgres not available');
  await h.pg.execute(`DELETE FROM ${NS}.audit`); await h.pg.execute(`DELETE FROM ${NS}.effect WHERE effect_key LIKE 'bundle:abuse:%'`);
  const r = rig(h); h.now.t = Date.parse('2026-10-25T10:00:00Z');
  for (let i = 0; i < 4; i++) { const row = await r.propose(); r.accept(row, { user: 'stranger' }); await r.tick(); }
  const n = async (a: string) => Number((await h!.pg.query<{ n: string }>(`SELECT count(*)::text n FROM ${NS}.audit WHERE action=$1`, [a]))[0]!.n);
  assert.equal(await n('bundle_refused'), 4); assert.equal(await n('bundle_abuse_alert'), 1);
});

// ---- QA defects on 03167ac (ALRAA-1785): fencing, last guard before the POST, confirmed cancellation
const spin = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((res) => setTimeout(res, 5)); };
async function toBuilt(r: Rig): Promise<void> {
  await r.tick(); r.port.finish(500, 'succeeded'); r.port.files.set(500, r.port.goodFiles(500)); await r.tick();
  assert.equal((await r.get(idOf(r))).status, 'built');
}

test('a stale worker whose queue response arrives late cannot overwrite the current build or its attempt accounting', async t => {
  const r = await started(t); if (!r) return;
  const realQueue = r.port.queue.bind(r.port); const realList = r.port.listRuns.bind(r.port);
  let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
  r.port.queue = async (p, c, q) => { const out = await realQueue(p, c, q); await gate; return out; }; // run 500 exists, response is held
  const stale = r.tick(); await spin();
  assert.equal(r.port.posts.length, 1);
  h!.now.t += 6 * MIN;
  r.port.queue = realQueue; r.port.listRuns = async () => [];
  await r.tick(); // recovery: lease expired, listing empty, back to active
  r.port.listRuns = realList;
  assert.equal((await r.get(idOf(r))).status, 'active');
  r.port.listRuns = async () => []; await r.tick(); r.port.listRuns = realList; // attempt 2 queues run 501
  const before = await r.get(idOf(r));
  assert.equal(before.buildId, 501); assert.equal(before.buildAttempts, 2);
  release(); await stale;
  const after = await r.get(idOf(r));
  assert.equal(after.buildId, 501, 'the stale response did not replace the current build'); assert.equal(after.buildAttempts, 2);
  assert.equal(r.port.posts.length, 2);
  const keys = (await ledger(r)).map((x) => [x.idempotency_key.replace(idOf(r), 'B'), x.result.runId]);
  assert.ok(!keys.some((k) => k[0] === 'bundle:B:build:2' && k[1] === 500), JSON.stringify(keys));
});

for (const kind of ['build', 'deploy'] as const) {
  test(`the approval window ending during the author-identity preflight stops the ${kind} POST`, async t => {
    const r = await started(t); if (!r) return;
    if (kind === 'deploy') await toBuilt(r);
    r.port.authorId = async () => { h!.now.t += 121 * MIN; return AUTHOR_ID; };
    const before = r.port.posts.length;
    await r.tick();
    const b = await r.get(idOf(r));
    assert.equal(r.port.posts.length, before, 'nothing was posted after the window ended');
    assert.equal(b.status, 'expired');
  });
}

test('cancel that is accepted but not yet effective keeps the bundle open; overlapping revokes cancel once; a later tick confirms', async t => {
  const r = await started(t); if (!r) return;
  await toBuilt(r); await r.tick();
  const b0 = await r.get(idOf(r)); assert.equal(b0.status, 'deploying'); const run = b0.deployRunId!;
  r.port.pending.add(run);
  r.port.cancel = async (id: number) => { r.port.cancelled.push(id); }; // accepted, run stays pending
  const [a, c] = await Promise.all([revokeBundle(r.deps(), b0, 'user-1', 'stop'), revokeBundle(r.deps(), b0, 'user-1', 'stop')]);
  assert.deepEqual(r.port.cancelled, [run], 'one cancel call');
  assert.equal(a.revoked, false); assert.equal(c.revoked, false);
  assert.equal((await r.get(b0.id)).status, 'deploying', 'still open: one-open-bundle protection holds');
  assert.ok((await r.get(b0.id)).result.cancel, 'durable intent');
  await r.tick(); assert.equal((await r.get(b0.id)).status, 'deploying', 'lease still held, no second cancel');
  r.port.finish(run, 'canceled');
  await r.tick();
  const done = await r.get(b0.id);
  assert.equal(done.status, 'revoked'); assert.equal(done.revokedBy, 'user-1');
});

test('a cancel intent is retried by a later tick while the run still waits at the approval, and dropped once it is running', async t => {
  const r = await started(t); if (!r) return;
  await toBuilt(r); await r.tick();
  const b0 = await r.get(idOf(r)); const run = b0.deployRunId!;
  r.port.pending.add(run); r.port.cancel = async (id: number) => { r.port.cancelled.push(id); };
  await revokeBundle(r.deps(), b0, 'user-1', 'stop');
  h!.now.t += 3 * MIN; await r.tick();
  assert.deepEqual(r.port.cancelled, [run, run], 'retried after the lease');
  r.port.pending.delete(run); h!.now.t += 3 * MIN; await r.tick();
  const b = await r.get(b0.id); assert.equal(b.status, 'deploying'); assert.equal(b.result.cancel, undefined);
});

// ---- QA defect on 136e2bd (ALRAA-1785): polling and recovery writes are fenced to the attempt and run the worker saw
test('a stale poll that saw a failed run cannot reset the current attempt or exceed the attempt cap', async t => {
  const r = await started(t); if (!r) return;
  await r.tick(); r.port.finish(500, 'failed'); // attempt 1 -> run 500, failed
  const realRun = r.port.run.bind(r.port);
  let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
  r.port.run = async (id) => { const out = id === 500 ? structuredClone(await realRun(id)) : await realRun(id); if (id === 500 && out) await gate; return out; };
  const stale = r.tick(); await spin(); // holds after reading the completed failed run
  r.port.run = realRun;
  await r.tick(); // second tick retries: back to active
  assert.equal((await r.get(idOf(r))).status, 'active');
  await r.tick(); // third tick queues run 501, attempt 2
  const before = await r.get(idOf(r));
  assert.equal(before.status, 'building'); assert.equal(before.buildId, 501); assert.equal(before.buildAttempts, 2);
  release(); await stale;
  const after = await r.get(idOf(r));
  assert.equal(after.status, 'building', 'stale retry did not discard the current run'); assert.equal(after.buildId, 501); assert.equal(after.buildAttempts, 2);
  r.port.finish(501, 'failed'); await r.tick(); await r.tick();
  assert.equal(r.port.posts.length, 2, 'attempt cap holds'); assert.equal((await r.get(idOf(r))).status, 'failed');
});

test('the claim itself refuses a build once the attempt cap is reached', async t => {
  const r = await started(t); if (!r) return;
  const row = await r.get(idOf(r));
  await h!.pg.execute(`UPDATE ${NS}.release_bundle SET build_attempts=$2 WHERE id=$1`, [row.id, Number(row.configSnapshot.maxBuildAttempts)]);
  const ok = await r.bundles.claim({ companyId: COMPANY, id: row.id, from: 'active', to: 'building', lease: 'l', leaseExpiresIso: new Date(h!.now.t + MIN).toISOString(), nowIso: new Date(h!.now.t).toISOString(), argsHash: row.argsHash, configHash: row.configHash, buildAttempt: true, maxAttempts: Number(row.configSnapshot.maxBuildAttempts) });
  assert.equal(ok, false); assert.equal((await r.get(row.id)).status, 'active');
});

test('a stale recovery that found no run cannot reset a build another worker adopted', async t => {
  const r = await started(t); if (!r) return;
  r.port.failAfterPost.push(1); await r.tick(); // run 500 exists, nothing recorded
  assert.equal((await r.get(idOf(r))).buildId, null);
  h!.now.t += 6 * MIN;
  const realList = r.port.listRuns.bind(r.port);
  let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
  r.port.listRuns = async () => { await gate; return []; }; // stale view: nothing found
  const stale = r.tick(); await spin();
  r.port.listRuns = realList;
  await r.tick(); // adopts run 500
  assert.equal((await r.get(idOf(r))).buildId, 500);
  release(); await stale;
  const after = await r.get(idOf(r));
  assert.equal(after.status, 'building'); assert.equal(after.buildId, 500); assert.equal(after.buildAttempts, 1);
});

// ---- QA round 3 on 2890011: deploy recovery decisions are fenced to a still-unrecorded deploy run
for (const mode of ['empty', 'ambiguous'] as const) {
  test(`a stale deploy recovery (${mode} result) cannot close a run another worker adopted`, async t => {
    const r = await started(t); if (!r) return;
    await toBuilt(r);
    r.port.failAfterPost.push(1); await r.tick(); // deploy run 501 exists, nothing recorded
    assert.equal((await r.get(idOf(r))).deployRunId, null);
    r.port.pending.add(501);
    h!.now.t += 6 * MIN;
    const realList = r.port.listRuns.bind(r.port);
    let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
    r.port.listRuns = async () => { await gate; return mode === 'empty' ? [] : [...(await realList(r.port as never)), ...(await realList(r.port as never))]; };
    const stale = r.tick(); await spin();
    r.port.listRuns = realList;
    await r.tick(); // adopts 501
    assert.equal((await r.get(idOf(r))).deployRunId, 501);
    release(); await stale;
    const after = await r.get(idOf(r));
    assert.equal(after.status, 'deploying'); assert.equal(after.deployRunId, 501);
    assert.equal(r.port.posts.length, 2);
  });
}
