import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { agentsNeedingTools, configPathOf, wireOne, wireOpencodeAgents } from '../src/opencode.ts';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

test('opencode wiring adds the MCP server once, keeps other settings, and removes only its own entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-'));
  const f = path.join(dir, 'opencode.json');
  await fs.writeFile(f, JSON.stringify({ model: 'x', mcp: { other: { type: 'remote', url: 'u' } }, permission: { '*': 'ask', bash: { '*': 'allow' } } }));
  assert.equal(await wireOne(f, true), true);
  const j = JSON.parse(await fs.readFile(f, 'utf8'));
  assert.equal(j.model, 'x'); assert.deepEqual(j.mcp.other, { type: 'remote', url: 'u' });
  assert.deepEqual(j.mcp.azdo.command, ['node', path.join(dir, 'azdo-mcp.mjs')]);
  assert.equal(j.permission['azdo_*'], 'allow'); assert.deepEqual(j.permission.bash, { '*': 'allow' });
  assert.match(await fs.readFile(path.join(dir, 'azdo-mcp.mjs'), 'utf8'), /tools\/list/);
  assert.equal(await wireOne(f, true), false, 'second run changes nothing');
  assert.equal(await wireOne(f, false), true);
  const k = JSON.parse(await fs.readFile(f, 'utf8'));
  assert.equal(k.mcp.azdo, undefined); assert.ok(k.mcp.other); assert.equal(k.permission['azdo_*'], undefined);
  assert.equal(await wireOne(f, false), false);
  assert.equal(await wireOne(path.join(dir, 'missing.json'), true), false);
});

test('only agents with an Azure DevOps role are wired, and only when the setting is on', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-'));
  const mk = async (n: string) => { const p = path.join(dir, n, 'opencode.json'); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, '{}'); return p; };
  const pa = await mk('a'), pb = await mk('b');
  const rows = [{ id: A, name: 'A', status: 'idle', adapter_config: { env: { OPENCODE_CONFIG: { type: 'plain', value: pa } } } }, { id: B, name: 'B', status: 'idle', adapter_config: { env: { OPENCODE_CONFIG: { type: 'plain', value: pb } } } }];
  const db = { query: async () => rows } as never;
  const cfg = (on: boolean) => parseConfig({ organization: { name: 'o' }, roles: { authorAgentIds: [A] }, agentTools: { opencodeNative: on } });
  assert.deepEqual(agentsNeedingTools(cfg(true), rows as never).map((r) => r.name), ['A']);
  assert.equal(configPathOf({ env: { OPENCODE_CONFIG: { value: 'relative/opencode.json' } } }), null);
  await wireOpencodeAgents(db, 'c', cfg(true));
  assert.ok(JSON.parse(await fs.readFile(pa, 'utf8')).mcp.azdo); assert.equal(JSON.parse(await fs.readFile(pb, 'utf8')).mcp, undefined);
  await wireOpencodeAgents(db, 'c', cfg(false));
  assert.equal(JSON.parse(await fs.readFile(pa, 'utf8')).mcp, undefined);
});
