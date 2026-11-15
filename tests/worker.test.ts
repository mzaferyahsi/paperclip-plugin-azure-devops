// Wiring test with the SDK's in-memory host: setup() registers every declared tool/job/data/action under the declared capabilities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import plugin from '../src/worker.ts';
import manifest from '../manifest.json' with { type: 'json' };
import { TOOLS } from '../src/tools/catalog.ts';

test('setup registers all tools and jobs without capability errors, and unconfigured companies get stable answers', async () => {
  const harness = createTestHarness({ manifest: manifest as never });
  await plugin.definition.setup(harness.ctx);
  const C = '11111111-1111-4111-8111-aaaaaaaaaaaa';
  const r = await harness.executeTool<{ error?: string }>('ado_health', {}, { agentId: 'a0000000-0000-4000-8000-000000000001', runId: 'c0000000-0000-4000-8000-000000000001', companyId: C, projectId: C });
  assert.equal(r.error, 'not_configured');
  for (const t of TOOLS) assert.ok(manifest.tools.some((m) => m.name === t.name));
  const o = await harness.getData<{ configured: boolean }>('overview', { companyId: C });
  assert.equal(o.configured, false);
  assert.deepEqual(await plugin.definition.onValidateConfig!({}), { ok: true, warnings: ['Azure DevOps is not configured for this company yet.'] });
  const bad = await plugin.definition.onValidateConfig!({ organization: { name: 'acme' }, projects: [], identities: {} });
  assert.equal(bad.ok, false);
  await plugin.definition.onWebhook!({ endpointKey: 'ado', headers: {}, rawBody: 'x', requestId: 'r' }); // must not throw
  await harness.runJob('housekeeping').catch(() => {});
  const health = await plugin.definition.onHealth!();
  assert.equal(health.status, 'ok');
  assert.equal((await plugin.definition.onDetectExternalObjects!({ companyId: C, urls: [], sourceContext: {} as never })).detections.length, 0);
});

test('board-only actions refuse non-board actors', async () => {
  const harness = createTestHarness({ manifest: manifest as never });
  await plugin.definition.setup(harness.ctx);
  const C = '11111111-1111-4111-8111-aaaaaaaaaaaa';
  await assert.rejects(() => harness.performAction('test-connection', { companyId: C }, { actor: { type: 'agent' } as never, companyId: C }), /Only board members/);
  await assert.rejects(() => harness.performAction('discover', { companyId: C }, { actor: null, companyId: C }), /Only board members/);
});
