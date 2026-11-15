// What the setup wizard does through Paperclip's own API with the signed-in board session. `call` is injected so the logic is testable.
import { ALL_PROFILE_KEY, ALL_PROFILE_NAME, PROFILE_KEYS, PROFILE_NAMES, fullToolName, toolsForRole, type Role, type SecretLite, type ToolLite } from './setup.ts';

export type Call = (method: string, path: string, body?: unknown) => Promise<unknown>;
const ROLES: Role[] = ['author', 'reviewer', 'operator'];
const enc = encodeURIComponent;

/** Create a company secret unless one with the same key exists. Returns the id either way; a reused secret keeps its OLD value, so callers must say so. Values are never read back. */
export async function ensureSecret(call: Call, companyId: string, existing: SecretLite[], name: string, key: string, value: string, description: string): Promise<string> {
  const hit = existing.find((s) => s.key === key);
  if (hit) return hit.id;
  const r = (await call('POST', `/companies/${enc(companyId)}/secrets`, { name, key, value, description })) as { id: string };
  return r.id;
}

interface ProfileRow { id: string; profileKey: string; bindings?: Array<{ targetType: string; targetId: string }> }
export interface ApplyResult { created: string[]; updated: string[]; bound: number; unbound: number }

export type ToolScope = 'company' | 'roles';
const entriesFor = (names: string[]) => names.map((toolName) => ({ selectorType: 'tool_name', effect: 'include', toolName }));
async function ensureProfile(call: Call, companyId: string, profiles: ProfileRow[], key: string, name: string, names: string[], res: ApplyResult): Promise<void> {
  const existing = profiles.find((p) => p.profileKey === key);
  if (!existing) { await call('POST', `/companies/${enc(companyId)}/tools/profiles`, { profileKey: key, name, description: 'Managed by the Azure DevOps plugin.', defaultAction: 'deny', entries: entriesFor(names) }); res.created.push(key); }
  else { await call('PATCH', `/tool-profiles/${existing.id}`, { entries: entriesFor(names) }); res.updated.push(key); }
}
async function bindTo(call: Call, companyId: string, p: ProfileRow, targetType: 'agent' | 'company', want: Set<string>, res: ApplyResult): Promise<void> {
  const bound = new Set((p.bindings ?? []).filter((b) => b.targetType === targetType).map((b) => b.targetId));
  for (const id of want) if (!bound.has(id)) { try { await call('POST', `/companies/${enc(companyId)}/tools/profiles/${p.id}/bind`, { targetType, targetId: id, priority: 100 }); res.bound++; } catch (e) { if (!/409/.test(String((e as Error).message))) throw e; } }
  for (const id of bound) if (!want.has(id)) { await call('POST', `/companies/${enc(companyId)}/tools/profiles/${p.id}/unbind`, { targetType, targetId: id }); res.unbound++; }
}

/**
 * company (default): ONE profile with every tool bound to the whole company, so every agent, present and future, can use Azure DevOps like GitHub;
 * the plugin itself still enforces author/reviewer/operator roles on every call.
 * roles: one profile per role with exactly that role's tools, bound agent by agent.
 */
export async function applyToolProfiles(call: Call, companyId: string, roles: Record<Role, string[]>, tools: ToolLite[], scope: ToolScope = 'company'): Promise<ApplyResult> {
  const res: ApplyResult = { created: [], updated: [], bound: 0, unbound: 0 };
  const list = async () => ((await call('GET', `/companies/${enc(companyId)}/tools/profiles`)) as { profiles: ProfileRow[] }).profiles;
  let profiles = await list();
  if (scope === 'company') await ensureProfile(call, companyId, profiles, ALL_PROFILE_KEY, ALL_PROFILE_NAME, tools.map((t) => fullToolName(t.name)), res);
  else for (const role of ROLES) await ensureProfile(call, companyId, profiles, PROFILE_KEYS[role], PROFILE_NAMES[role], toolsForRole(tools, role), res);
  profiles = await list();
  const all = profiles.find((p) => p.profileKey === ALL_PROFILE_KEY);
  if (scope === 'company') {
    await bindTo(call, companyId, all!, 'company', new Set([companyId]), res);
    for (const role of ROLES) { const p = profiles.find((x) => x.profileKey === PROFILE_KEYS[role]); if (p) await bindTo(call, companyId, p, 'agent', new Set(), res); }
  } else {
    if (all) await bindTo(call, companyId, all, 'company', new Set(), res);
    for (const role of ROLES) await bindTo(call, companyId, profiles.find((x) => x.profileKey === PROFILE_KEYS[role])!, 'agent', new Set(roles[role]), res);
  }
  return res;
}

/** True when every agent that has a role is bound to the profile of each of its roles that has a role is bound to the profile of each of its roles. */
export async function toolAccessApplied(call: Call, companyId: string, roles: Record<Role, string[]>, scope: ToolScope = 'company'): Promise<boolean> {
  const profiles = ((await call('GET', `/companies/${enc(companyId)}/tools/profiles`)) as { profiles: ProfileRow[] }).profiles;
  if (scope === 'company') return !!profiles.find((p) => p.profileKey === ALL_PROFILE_KEY)?.bindings?.some((b) => b.targetType === 'company' && b.targetId === companyId);
  const any = ROLES.some((r) => roles[r].length > 0);
  if (!any) return false;
  for (const role of ROLES) {
    if (roles[role].length === 0) continue;
    const p = profiles.find((x) => x.profileKey === PROFILE_KEYS[role]);
    const bound = new Set((p?.bindings ?? []).filter((b) => b.targetType === 'agent').map((b) => b.targetId));
    if (!p || roles[role].some((id) => !bound.has(id))) return false;
  }
  return true;
}

export async function chipsEnabled(call: Call): Promise<boolean | null> {
  try { return ((await call('GET', '/instance/settings/experimental')) as { enableExternalObjects?: boolean }).enableExternalObjects === true; } catch { return null; }
}
export async function enableChips(call: Call): Promise<void> { await call('PATCH', '/instance/settings/experimental', { enableExternalObjects: true }); }

interface EnvRow { id: string; name: string; status?: string; envVars?: Record<string, { type: string; value?: string }> | null; metadata?: { defaultForInstance?: boolean } | null }
interface ProjectRow { id: string; name: string; archivedAt?: string | null; status?: string; env?: Record<string, { type: string; value?: string }> | null }
const asList = <T,>(x: unknown, key: string): T[] => (Array.isArray(x) ? (x as T[]) : Array.isArray((x as Record<string, unknown>)?.[key]) ? ((x as Record<string, T[]>)[key]) : []);
const liveEnvs = (envs: EnvRow[]) => envs.filter((e) => e.status !== 'archived' && e.status !== 'disabled');
const defaultEnv = (envs: EnvRow[]): EnvRow | null => liveEnvs(envs).find((e) => e.metadata?.defaultForInstance) ?? liveEnvs(envs)[0] ?? null;

/**
 * Put the git wrapper first on PATH in the company's DEFAULT execution environment, so every run of every agent and every project, including
 * ones created later, gets it. A project with its own PATH from an earlier setup is cleaned up so one place decides.
 */
export async function applyGitPath(call: Call, companyId: string, binDir: string, basePath: string): Promise<{ changed: number; total: number; environment: string | null }> {
  const envs = asList<EnvRow>(await call('GET', `/companies/${enc(companyId)}/environments`), 'environments');
  const env = defaultEnv(envs);
  if (!env) throw new Error('No execution environment found for this company.');
  let changed = 0;
  const cur = env.envVars?.PATH?.type === 'plain' ? env.envVars.PATH.value ?? '' : '';
  if (cur.split(':')[0] !== binDir) {
    const rest = (cur || basePath).split(':').filter((x) => x && x !== binDir).join(':');
    // the environment may be instance scoped: the company context for its variables travels in the query
    await call('PATCH', `/environments/${env.id}?companyId=${enc(companyId)}`, { envVars: { ...(env.envVars ?? {}), PATH: { type: 'plain', value: `${binDir}:${rest}` } } });
    changed++;
  }
  const projects = (await call('GET', `/companies/${enc(companyId)}/projects`)) as ProjectRow[];
  for (const p of projects.filter((x) => !x.archivedAt && x.status !== 'archived')) {
    const pv = p.env?.PATH;
    if (pv?.type === 'plain' && (pv.value ?? '').split(':')[0] === binDir) {
      const rest = { ...(p.env ?? {}) }; delete rest.PATH; delete rest.PAPERCLIP_ADO_ROOT;
      await call('PATCH', `/projects/${p.id}`, { env: rest }); changed++;
    }
  }
  return { changed, total: 1 + projects.length, environment: env.name };
}

/** Applied when the default environment starts with the wrapper directory and no project overrides PATH with something else. */
export async function gitPathApplied(call: Call, companyId: string, binDir: string): Promise<boolean> {
  const env = defaultEnv(asList<EnvRow>(await call('GET', `/companies/${enc(companyId)}/environments`), 'environments'));
  if (!env || env.envVars?.PATH?.type !== 'plain' || (env.envVars.PATH.value ?? '').split(':')[0] !== binDir) return false;
  const projects = (await call('GET', `/companies/${enc(companyId)}/projects`)) as ProjectRow[];
  return projects.filter((p) => !p.archivedAt && p.status !== 'archived').every((p) => !p.env?.PATH || (p.env.PATH.type === 'plain' && (p.env.PATH.value ?? '').split(':')[0] === binDir));
}
