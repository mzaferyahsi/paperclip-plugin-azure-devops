import { homedir } from 'node:os';
// A Host backed by a real throwaway Postgres (real SQL, real migration) and in-memory issues, for service-level scenario tests.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startPg, type TestPg } from './pg-helper.ts';
import { NS } from '../src/namespace.ts';
import type { Host, IssueRef, InteractionState } from '../src/host.ts';
import { parseConfig, type Config } from '../src/config.ts';
import type { FakeAdo } from './fake-ado.ts';

// Every statement the plugin sends is also checked by the REAL host guard (plugin-database.js) when the host install is present.
const HOST_DB = process.env.PC_HOST_PLUGIN_DB ?? `${process.env.PC_HOST_NODE_MODULES ?? `${homedir()}/.paperclip/cli/current/node_modules`}/@paperclipai/server/dist/services/plugin-database.js`;
const guard = await import(HOST_DB).catch(() => null) as null | { validatePluginRuntimeQuery(sql: string, ns: string, core: string[]): void; validatePluginRuntimeExecute(sql: string, ns: string): void };
function checkParams(sql: string, params: unknown[] = []): void {
  const seen = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) { const i = Number(m[1]); if (i < 1 || i > params.length) throw new Error(`placeholder ${i} has no parameter`); seen.add(i); }
  if (params.length && seen.size !== params.length) throw new Error(`${params.length} params but ${seen.size} referenced`);
  params.forEach((p, i) => { if (p === undefined) throw new Error(`param ${i + 1} is undefined`); });
}
const guarded = (pg: TestPg): TestPg => (!guard ? pg : {
  query: async (sql, params) => { guard.validatePluginRuntimeQuery(sql, NS, ['issues', 'agents', 'projects', 'heartbeat_runs']); checkParams(sql, params); return pg.query(sql, params); },
  execute: async (sql, params) => { guard.validatePluginRuntimeExecute(sql, NS); checkParams(sql, params); return pg.execute(sql, params); },
  stop: () => pg.stop(),
});

export const COMPANY = '11111111-1111-4111-8111-aaaaaaaaaaaa';
export const OTHER_COMPANY = '22222222-2222-4222-8222-bbbbbbbbbbbb';
export const AUTHOR_AGENT = 'a0000000-0000-4000-8000-000000000001';
export const REVIEWER_AGENT = 'a0000000-0000-4000-8000-000000000002';
export const OPERATOR_AGENT = 'a0000000-0000-4000-8000-000000000003';
export const SECRET_IDS = { author: 's0000000-0000-4000-8000-000000000001', reviewer: 's0000000-0000-4000-8000-000000000002', hook: 's0000000-0000-4000-8000-000000000003', basic: 's0000000-0000-4000-8000-000000000004' };

export interface TestIssue extends IssueRef { comments: string[]; wakes: Array<{ reason: string; key: string }>; companyId: string; parentId?: string; description?: string; blockedBy?: string[]; blockersUnreadable?: boolean }
export interface Harness {
  host: Host; pg: TestPg; fake: FakeAdo; now: { t: number }; issues: Map<string, TestIssue>; checkouts: Map<string, string>; configs: Map<string, Config | null>; secrets: Record<string, string>;
  interactions: Map<string, InteractionState & { issueId: string; prompt: string }>; childIssues: { allowed: boolean }; metrics: Array<[string, number]>; logs: string[]; stop(): Promise<void>;
}

export const baseConfig = (fake: FakeAdo, over: Record<string, unknown> = {}) => ({
  organization: { name: fake.org }, projects: [{ projectId: fake.project.id, name: fake.project.name, protectedBranches: ['refs/heads/main'] }],
  identities: { author: { kind: 'pat', patRef: { type: 'secret_ref', secretId: SECRET_IDS.author } }, reviewer: { kind: 'pat', patRef: { type: 'secret_ref', secretId: SECRET_IDS.reviewer } } },
  webhook: { hookTokenRef: { type: 'secret_ref', secretId: SECRET_IDS.hook }, basicAuthPasswordRef: { type: 'secret_ref', secretId: SECRET_IDS.basic } },
  roles: { authorAgentIds: [AUTHOR_AGENT], reviewerAgentIds: [REVIEWER_AGENT], operatorAgentIds: [OPERATOR_AGENT] },
  ...over,
});

export async function makeHarness(fake: FakeAdo, configOver: Record<string, unknown> = {}): Promise<Harness | null> {
  const pg = await startPg('UTC');
  if (!pg) return null;
  await pg.query(`CREATE TABLE public.issues (id uuid PRIMARY KEY, company_id uuid NOT NULL, identifier text, status text, assignee_agent_id uuid)`);
  await pg.query(`CREATE TABLE public.heartbeat_runs (id uuid PRIMARY KEY, company_id uuid NOT NULL, agent_id uuid NOT NULL, status text NOT NULL)`);
  await pg.query(`CREATE SCHEMA ${NS}`);
  await pg.query(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  await pg.query(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')); // idempotent
  for (let i = 0; i < 2; i++) await pg.query(readFileSync(new URL('../migrations/002_approval.sql', import.meta.url), 'utf8'));
  for (let i = 0; i < 2; i++) await pg.query(readFileSync(new URL('../migrations/003_approver_user_text.sql', import.meta.url), 'utf8'));
  for (let i = 0; i < 2; i++) await pg.query(readFileSync(new URL('../migrations/004_release_verdict.sql', import.meta.url), 'utf8'));
  for (let i = 0; i < 2; i++) await pg.query(readFileSync(new URL('../migrations/005_env_approval_status.sql', import.meta.url), 'utf8'));
  for (let i = 0; i < 2; i++) await pg.query(readFileSync(new URL('../migrations/006_release_bundle.sql', import.meta.url), 'utf8'));
  const now = { t: Date.parse('2026-10-25T10:00:00Z') };
  const issues = new Map<string, TestIssue>();
  const interactions = new Map<string, InteractionState & { issueId: string; prompt: string }>();
  const configs = new Map<string, Config | null>([[COMPANY, parseConfig(baseConfig(fake, configOver))]]);
  const secrets: Record<string, string> = { [SECRET_IDS.author]: 'author-pat', [SECRET_IDS.reviewer]: 'reviewer-pat', [SECRET_IDS.hook]: 'hook-secret-value', [SECRET_IDS.basic]: 'basic-secret-value' };
  const childIssues = { allowed: true };
  const checkouts = new Map<string, string>();
  const metrics: Array<[string, number]> = []; const logs: string[] = [];
  const host: Host = {
    db: guarded(pg), now: () => now.t, uuid: () => randomUUID(),
    log: { info: (m) => logs.push(`i:${m}`), warn: (m, x) => logs.push(`w:${m} ${JSON.stringify(x ?? {})}`), error: (m, x) => logs.push(`e:${m} ${JSON.stringify(x ?? {})}`) },
    fetch: (u, i) => fetch(u, i),
    config: async (c) => configs.get(c) ?? null,
    configuredCompanies: async () => [...configs.entries()].filter(([, v]) => v).map(([k]) => k),
    resolveSecret: async (_c, ref) => { const v = secrets[ref.secretId]; if (v === undefined) throw new Error('no secret'); return v; },
    issues: {
      findByIdentifier: async (c, key) => { const i = [...issues.values()].find((x) => x.companyId === c && x.identifier.toUpperCase() === key.toUpperCase()); return i ?? null; },
      get: async (c, id) => { const i = issues.get(id); return i && i.companyId === c ? i : null; },
      blockers: async (c, id) => { const i = issues.get(id); if (!i || i.companyId !== c || i.blockersUnreadable) throw new Error('blockers unreadable'); return (i.blockedBy ?? []).map((b) => { const x = issues.get(b); if (!x) throw new Error('unknown blocker'); return { id: x.id, identifier: x.identifier, status: x.status }; }); },
      checkedOutBy: async (c, _agent, runId) => { const id = checkouts.get(runId); const i = id ? issues.get(id) : undefined; return i && i.companyId === c ? i : null; },
      inProgressFor: async (c, agent) => [...issues.values()].filter((x) => x.companyId === c && x.assigneeAgentId === agent && x.status === 'in_progress'),
      comment: async (_c, id, body) => { issues.get(id)!.comments.push(body); },
      setStatus: async (_c, id, status) => { issues.get(id)!.status = status; },
      wake: async (_c, id, reason, key) => { issues.get(id)!.wakes.push({ reason, key }); },
      requestConfirmation: async (_c, issueId, c) => { const id = randomUUID(); interactions.set(id, { id, issueId, status: 'pending', outcome: null, resolvedByUserId: null, resolvedByAgentId: null, prompt: c.prompt }); return { id }; },
      interaction: async (_c, _i, id) => interactions.get(id) ?? null,
      createChild: async (c, parentId, d) => {
        if (!childIssues.allowed) throw new Error('capability issues.create not granted');
        const i: TestIssue = { id: randomUUID(), identifier: `CH-${issues.size + 1}`, status: 'todo', assigneeAgentId: d.assigneeAgentId, comments: [], wakes: [], companyId: c, title: d.title, parentId, description: d.description } as TestIssue;
        issues.set(i.id, i); return i;
      },
    },
    metric: (n, v) => { metrics.push([n, v]); },
    clientDeps: { apiBase: () => fake.base, loginBase: fake.login, sleep: async () => {} },
  };
  return { host, pg, fake, now, issues, checkouts, configs, secrets, interactions, childIssues, metrics, logs, stop: () => pg.stop() };
}

export function addIssue(h: Harness, identifier: string, over: Partial<TestIssue> = {}): TestIssue {
  const i: TestIssue = { id: randomUUID(), identifier, status: 'in_progress', assigneeAgentId: AUTHOR_AGENT, comments: [], wakes: [], companyId: COMPANY, ...over };
  h.issues.set(i.id, i);
  return i;
}
