import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeAdo } from './fake-ado.ts';
import { makeHarness, COMPANY, type Harness } from './test-host.ts';
import { NS } from '../src/namespace.ts';

let fake: FakeAdo; let h: Harness | null;
test.before(async () => { fake = await new FakeAdo().start(); h = await makeHarness(fake); });
test.after(async () => { await h?.stop(); await fake.stop(); });

const base = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), company_id: COMPANY, issue_id: crypto.randomUUID(), project_id: 'p1', proposer_agent_id: crypto.randomUUID(), source_commit: 'a'.repeat(40), branch: 'refs/heads/main',
  build_pipeline_id: 140, deploy_pipeline_id: 138, config_snapshot: JSON.stringify({ ttlMinutes: 120 }), config_hash: 'h', args_hash: 'a', reason: 'r', commit_facts: '{}', status: 'awaiting_confirmation',
  expires_at: '2026-10-25T10:30:00Z', created_at: '2026-10-25T10:00:00Z', ...over,
} as Record<string, unknown>);
const insert = (r: Record<string, unknown>) => {
  const cols = Object.keys(r);
  return h!.pg.execute(`INSERT INTO ${NS}.release_bundle (${cols.join(',')}) VALUES (${cols.map((c, i) => `$${i + 1}${['config_snapshot', 'commit_facts'].includes(c) ? '::jsonb' : ''}`).join(',')})`, cols.map(c => r[c]));
};
const T0 = '2026-10-25T10:00:00Z';
const approved = { approved_by_user_id: 'u', approved_at: T0, status: 'active' };

test('migration 006 applies twice on a database that already has 001-005 (idempotent)', async t => {
  if (!h) return t.skip('embedded Postgres not available');
  const sql = readFileSync(new URL('../migrations/006_release_bundle.sql', import.meta.url), 'utf8');
  await h.pg.query(sql); await h.pg.query(sql);
  assert.equal((await h.pg.query<{ n: number }>(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name='release_bundle'`, [NS]))[0]!.n, 1);
  assert.equal(/create\s+(or\s+replace\s+)?(trigger|function)/i.test(sql.replace(/--.*$/gm, '')), false, 'the host refuses triggers and functions in plugin migrations');
});

test('CHECK constraints reject: bad commit, other branch, bad status, unapproved active, late expiry, bad digest, digest without build, completed without run', async t => {
  if (!h) return t.skip('embedded Postgres not available');
  const no = (r: Record<string, unknown>, what: string) => assert.rejects(insert(r), (_e: unknown) => true, what);
  await no(base({ source_commit: 'A'.repeat(40) }), 'upper-case commit');
  await no(base({ branch: 'refs/heads/dev' }), 'other branch');
  await no(base({ status: 'bogus' }), 'status');
  await no(base({ status: 'active' }), 'active without approval');
  await no(base({ image_digest: 'sha256:xyz', digest_pinned_at: T0, build_id: 1 }), 'digest format');
  await no(base({ image_digest: `sha256:${'b'.repeat(64)}`, digest_pinned_at: T0 }), 'digest without build id');
  await no(base({ ...approved, expires_at: '2026-10-25T12:00:01Z' }), 'expiry beyond approved_at + ttl');
  await insert(base({ ...approved, expires_at: '2026-10-25T12:00:00Z', project_id: 'p-ok' }));
  await no(base({ ...approved, project_id: 'p-c', status: 'completed', expires_at: '2026-10-25T11:00:00Z', build_id: 5, image_digest: `sha256:${'b'.repeat(64)}`, digest_pinned_at: T0 }), 'completed without deploy run');
  await no(base({ ...approved, project_id: 'p-b', status: 'built', expires_at: '2026-10-25T11:00:00Z', build_id: 5 }), 'built without digest');
});

test('one open bundle per company and project; a terminal row frees the slot', async t => {
  if (!h) return t.skip('embedded Postgres not available');
  await insert(base({ project_id: 'p-one' }));
  await assert.rejects(insert(base({ project_id: 'p-one', source_commit: 'b'.repeat(40) })), (_e: unknown) => true, 'second open bundle');
  await insert(base({ project_id: 'p-two' }));
  await h.pg.execute(`UPDATE ${NS}.release_bundle SET status='rejected' WHERE project_id='p-one'`);
  await insert(base({ project_id: 'p-one', source_commit: 'c'.repeat(40) }));
});
