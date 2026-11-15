import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.ts';
import { MCP_SOURCE } from './mcp-source.ts';

/** Name of the MCP server in an agent's opencode config; opencode shows its tools as `azdo_ado_*`. */
export const MCP_KEY = 'azdo';
export const PERMISSION_KEY = 'azdo_*';
const SERVER_FILE = 'azdo-mcp.mjs';

export interface AgentRow { id: string; name: string; status: string; adapter_config: unknown }
export interface WireResult { agent: string; changed: boolean; note?: string }

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Agents that hold an Azure DevOps role (all agents when everyone is an author). */
export function agentsNeedingTools(cfg: Config, agents: AgentRow[]): AgentRow[] {
  const ids = new Set<string>([...cfg.roles.authorAgentIds, ...cfg.roles.reviewerAgentIds, ...cfg.roles.operatorAgentIds, ...cfg.approval.approverAgentIds, ...cfg.approval.stagingGateAgentIds, ...Object.values(cfg.approval.verdictFunctions).flat()]);
  return agents.filter((a) => cfg.roles.everyoneIsAuthor || ids.has(a.id));
}

/** The opencode config file an agent runs with, when it names one explicitly. */
export function configPathOf(adapterConfig: unknown): string | null {
  const env = rec(rec(adapterConfig).env);
  const v = rec(env.OPENCODE_CONFIG);
  const p = typeof env.OPENCODE_CONFIG === 'string' ? env.OPENCODE_CONFIG : typeof v.value === 'string' ? v.value : '';
  return p && path.isAbsolute(p) && path.basename(p) === 'opencode.json' ? p : null;
}

/** Add (enabled) or remove (disabled) our MCP server and permission in one opencode.json. Touches nothing else. */
export async function wireOne(file: string, enabled: boolean): Promise<boolean> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return false; }
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw) as Record<string, unknown>; } catch { return false; }
  const serverPath = path.join(path.dirname(file), SERVER_FILE);
  const mcp = { ...rec(j.mcp) }; const perm = { ...rec(j.permission) };
  let changed = false;
  if (enabled) {
    const want = { type: 'local', command: ['node', serverPath], enabled: true };
    if (JSON.stringify(mcp[MCP_KEY]) !== JSON.stringify(want)) { mcp[MCP_KEY] = want; changed = true; }
    if (perm[PERMISSION_KEY] !== 'allow') { perm[PERMISSION_KEY] = 'allow'; changed = true; }
    let cur = ''; try { cur = await fs.readFile(serverPath, 'utf8'); } catch { /* new */ }
    if (cur !== MCP_SOURCE) { await fs.writeFile(serverPath, MCP_SOURCE, { mode: 0o644 }); changed = true; }
  } else {
    if (MCP_KEY in mcp) { delete mcp[MCP_KEY]; changed = true; }
    if (PERMISSION_KEY in perm) { delete perm[PERMISSION_KEY]; changed = true; }
  }
  if (!changed) return false;
  if (Object.keys(mcp).length) j.mcp = mcp; else delete j.mcp;
  j.permission = perm;
  try { await fs.copyFile(file, `${file}.bak-azdo`, fs.constants.COPYFILE_EXCL); } catch { /* backup exists */ }
  const tmp = `${file}.azdo-tmp`;
  await fs.writeFile(tmp, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
  return true;
}

export interface WireDb { query<T>(sql: string, params?: unknown[]): Promise<T[]> }

/** Idempotent. Runs every minute from the inbox job; reads small files and writes only when something differs. */
export async function wireOpencodeAgents(db: WireDb, companyId: string, cfg: Config): Promise<WireResult[]> {
  const rows = await db.query<AgentRow>(`SELECT id::text AS id, name, status, adapter_config FROM public.agents WHERE company_id=$1 AND adapter_type='opencode_local' AND status<>'terminated'`, [companyId]);
  const targets = cfg.agentTools.opencodeNative ? agentsNeedingTools(cfg, rows) : rows;
  const out: WireResult[] = [];
  for (const a of targets) {
    const file = configPathOf(a.adapter_config);
    if (!file) { if (cfg.agentTools.opencodeNative) out.push({ agent: a.name, changed: false, note: 'no explicit OPENCODE_CONFIG path' }); continue; }
    try { out.push({ agent: a.name, changed: await wireOne(file, cfg.agentTools.opencodeNative) }); }
    catch (e) { out.push({ agent: a.name, changed: false, note: String(e).slice(0, 120) }); }
  }
  return out;
}
