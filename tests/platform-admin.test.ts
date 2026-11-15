// Slice 1 of the platform administration work: configuration and credential plumbing. Contract invariants 3 and 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { parseConfig, validateConfig } from '../src/config.ts';
import { Service, ConfigError } from '../src/service.ts';
import { requirePlatformAdmin, allowEnvironment, allowSecureFile, allowPipeline } from '../src/platform-admin.ts';
import { ToolError, fail } from '../src/tools/common.ts';
import type { Host } from '../src/host.ts';

const REF = (id: string) => ({ type: 'secret_ref' as const, secretId: id });
const SENTINEL = 'SENTINEL-ADMIN-SECRET-9f3c1d';
const PID = '11111111-1111-4111-8111-111111111111';
const base = (extra: Record<string, unknown> = {}, admin: unknown = { kind: 'pat', patRef: REF('s-admin') }) => ({
  organization: { name: 'acme' }, projects: [{ projectId: PID, name: 'P' }],
  identities: { author: { kind: 'pat', patRef: REF('s-a') }, reviewer: { kind: 'pat', patRef: REF('s-r') }, ...(admin ? { admin } : {}) }, ...extra,
});

test('default config disables platform administration and has no admin identity', () => {
  const cfg = parseConfig({});
  const { releaseBundle, ...deployApprovalRest } = cfg.platformAdmin.deployApproval;
  assert.equal(releaseBundle.enabled, false); // the release bundle block is covered by release-bundle-config.test.ts
  assert.deepEqual({ ...cfg.platformAdmin, deployApproval: deployApprovalRest }, { enabled: false, environments: [], secureFiles: [], pipelineIds: [], variableGroups: [], deployApproval: { enabled: false, approverAgentIds: [], environments: [], deployPipelineIds: [], buildPipelineIds: [], imageRepository: '', sourceBranch: '', releaseVerdictFunctions: { techlead: [], qa: [], security: [] } } });
  assert.equal(cfg.identities.admin, undefined);
  assert.throws(() => requirePlatformAdmin(cfg), (e: unknown) => e instanceof ToolError && e.code === 'not_enabled');
  assert.throws(() => requirePlatformAdmin(parseConfig({ platformAdmin: { enabled: 'true' } })), (e: unknown) => e instanceof ToolError && e.code === 'not_enabled');
  requirePlatformAdmin(parseConfig({ platformAdmin: { enabled: true } }));
});

test('allowlist helpers deny empty lists and unknown names, exact match only', () => {
  const empty = parseConfig({ platformAdmin: { enabled: true } });
  assert.ok(!allowEnvironment(empty, 'kippiowl-staging') && !allowSecureFile(empty, 'a.p12') && !allowPipeline(empty, 5) && !allowEnvironment(empty, ''));
  const cfg = parseConfig({ platformAdmin: { enabled: true, environments: ['kippiowl-staging'], secureFiles: ['a.p12'], pipelineIds: [5, 7] } });
  assert.ok(allowEnvironment(cfg, 'kippiowl-staging') && allowSecureFile(cfg, 'a.p12') && allowPipeline(cfg, 5));
  assert.ok(!allowEnvironment(cfg, 'KIPPIOWL-STAGING') && !allowEnvironment(cfg, 'kippiowl-staging ') && !allowEnvironment(cfg, 'prod') && !allowEnvironment(cfg, '*'));
  assert.ok(!allowSecureFile(cfg, 'b.p12') && !allowPipeline(cfg, 141) && !allowPipeline(cfg, 0) && !allowPipeline(cfg, 5.5) && !allowPipeline(cfg, Number.NaN));
});

test('platformAdmin validation: bounds, name shape, positive integers, duplicates, admin required when enabled', () => {
  const ok = validateConfig(parseConfig(base({ platformAdmin: { enabled: true, environments: ['kippiowl-staging'], secureFiles: ['a.p12'], pipelineIds: [5] } })));
  assert.deepEqual(ok.errors, []);
  const bad = (pa: unknown, re: RegExp, withAdmin = true) => {
    const v = validateConfig(parseConfig(base({ platformAdmin: pa }, withAdmin ? undefined : null)));
    assert.ok(v.errors.some((e) => re.test(e)), `${JSON.stringify(pa)} -> ${v.errors.join('|')}`);
  };
  bad({ environments: Array.from({ length: 21 }, (_, i) => `e${i}`) }, /at most 20/);
  bad({ secureFiles: ['ok', '../etc'] }, /invalid name/);
  bad({ environments: ['*'] }, /invalid name/);
  bad({ environments: ['a', 'A'] }, /twice/);
  bad({ pipelineIds: [0] }, /positive integers/);
  bad({ pipelineIds: [-3] }, /positive integers/);
  bad({ pipelineIds: [1.5] }, /positive integers/);
  bad({ pipelineIds: [1, 1] }, /twice/);
  bad({ pipelineIds: Array.from({ length: 51 }, (_, i) => i + 1) }, /at most 50/);
  bad({ enabled: true, environments: ['e'] }, /identities\.admin is not configured/, false);
});

test('duplicate secret refs across author, reviewer and admin are rejected', () => {
  for (const [admin, other] of [[{ kind: 'pat', patRef: REF('s-a') }, 'author'], [{ kind: 'pat', patRef: REF('s-r') }, 'reviewer']] as const) {
    const v = validateConfig(parseConfig(base({}, admin)));
    assert.ok(v.errors.some((e) => e.startsWith('admin.patRef reuses the secret of') && e.includes(other)), v.errors.join('|'));
  }
  const entra = validateConfig(parseConfig(base({}, { kind: 'entra', tenantId: PID, clientId: PID, clientSecretRef: REF('s-a') })));
  assert.ok(entra.errors.some((e) => /admin\.clientSecretRef reuses/.test(e)));
  assert.deepEqual(validateConfig(parseConfig(base())).errors, []);
  // incomplete admin identity is rejected, never silently accepted
  assert.ok(validateConfig(parseConfig(base({}, { kind: 'pat' }))).errors.some((e) => /admin: patRef is required/.test(e)));
});

// ---- service wiring -------------------------------------------------------------------------------------------------
function harness(cfgRaw: unknown) {
  const urls: Array<{ url: string; auth: string }> = []; const logs: string[] = []; const resolved: string[] = [];
  const host = {
    now: () => 1_000_000, db: { query: async () => [], execute: async () => ({ rowCount: 0 }) },
    log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
    fetch: async (url: string, init?: RequestInit) => {
      urls.push({ url, auth: String((init?.headers as Record<string, string>)?.authorization ?? '') });
      return new Response(JSON.stringify({ value: [], count: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    config: async () => parseConfig(cfgRaw),
    resolveSecret: async (_c: string, ref: { secretId: string }) => { resolved.push(ref.secretId); return ref.secretId === 's-admin' ? SENTINEL : `value-of-${ref.secretId}`; },
    clientDeps: {},
  } as unknown as Host;
  return { svc: new Service(host), cfg: parseConfig(cfgRaw), urls, logs, resolved };
}
const b64 = (s: string) => 'Basic ' + Buffer.from(`:${s}`).toString('base64');

test('svc.admin without identities.admin throws not_configured naming the setting', async () => {
  const { svc, cfg } = harness(base({}, null));
  assert.throws(() => svc.admin('c1', cfg), (e: unknown) => e instanceof ConfigError && e.code === 'not_configured' && /identities\.admin/.test(e.message));
  assert.equal(fail(new ConfigError("x")).error, 'not_configured');
});

test('svc.admin binds the admin identity; the identities client uses the vssps host (both host forms)', async () => {
  const h = harness(base());
  const { api, identities } = h.svc.admin('c1', h.cfg);
  await api.c.request('GET', 'distributedtask/environments', { project: PID });
  await identities.c.request('GET', 'identities', { query: { searchFilter: 'General' } });
  assert.match(h.urls[0]!.url, /^https:\/\/dev\.azure\.com\/acme\/11111111-.*\/_apis\/distributedtask\/environments/);
  assert.match(h.urls[1]!.url, /^https:\/\/vssps\.dev\.azure\.com\/acme\/_apis\/identities\?/);
  assert.ok(h.urls.every((u) => u.auth === b64(SENTINEL)));
  const vs = harness({ ...base(), organization: { name: 'acme', hostForm: 'visualstudio.com' } });
  await vs.svc.admin('c1', vs.cfg).identities.c.request('GET', 'identities');
  assert.match(vs.urls[0]!.url, /^https:\/\/acme\.vssps\.visualstudio\.com\/_apis\/identities/);
  // same instance is reused until the admin identity changes
  assert.equal(h.svc.admin('c1', h.cfg).api, api);
});

test('svc.read never uses the admin identity, even when author and reviewer fail', async () => {
  const h = harness(base());
  (h.svc.host as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => { h.urls.push({ url, auth: String((init?.headers as Record<string, string>)?.authorization ?? '') }); return new Response('', { status: 401 }); };
  await assert.rejects(() => h.svc.read('c1', h.cfg, (api) => api.c.get('projects')));
  assert.ok(h.urls.length >= 2, 'reviewer then author were tried');
  assert.ok(!h.urls.some((u) => u.auth === b64(SENTINEL)), 'admin credential was never sent');
  assert.ok(!h.resolved.includes('s-admin'), 'admin secret was never even resolved');
  for (const role of ['author', 'reviewer'] as const) assert.ok(h.svc.clientFor('c1', h.cfg, role).role === role);
});

test('sentinel secret never appears in errors or logs, including a rejected credential', async () => {
  const h = harness(base());
  (h.svc.host as unknown as { fetch: unknown }).fetch = async () => new Response('', { status: 401 });
  const { api } = h.svc.admin('c1', h.cfg);
  let msg = '';
  try { await api.c.get('projects'); } catch (e) { msg = JSON.stringify({ m: (e as Error).message, s: (e as Error).stack, c: (e as { code?: string }).code }); }
  assert.ok(msg.length > 0);
  // a host failure while reading the secret must not leak either
  const h2 = harness(base());
  (h2.svc.host as unknown as { resolveSecret: unknown }).resolveSecret = async () => { throw new Error(`boom ${'x'}`); };
  try { await h2.svc.admin('c1', h2.cfg).api.c.get('projects'); assert.fail('should throw'); } catch (e) { msg += JSON.stringify({ m: (e as Error).message }); }
  assert.ok(!msg.includes(SENTINEL) && !h.logs.join('\n').includes(SENTINEL) && !h2.logs.join('\n').includes(SENTINEL));
  assert.ok(!JSON.stringify(h.cfg).includes(SENTINEL), 'config holds references only');
});

test('migration history includes only the additive release verdict and approval status migrations', () => {
  assert.deepEqual(readdirSync(new URL('../migrations/', import.meta.url)).sort(), ['001_init.sql', '002_approval.sql', '003_approver_user_text.sql', '004_release_verdict.sql', '005_env_approval_status.sql', '006_release_bundle.sql']);
});
