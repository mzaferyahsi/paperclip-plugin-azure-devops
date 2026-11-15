/** Same-origin calls with the signed-in board session. Secret values are never requested; only names and ids. */
export const PLUGIN_KEY = 'mzaferyahsi.azure-devops';
export class UiHttpError extends Error { status: number; constructor(status: number) { super(`http_${status}`); this.status = status; } }

export async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new UiHttpError(res.status);
  return res.status === 204 ? null : res.json();
}
export interface SecretMeta { id: string; key: string; name: string; status: string }
export async function listSecrets(companyId: string): Promise<SecretMeta[]> {
  const out = (await call('GET', `/companies/${encodeURIComponent(companyId)}/secrets`)) as Array<Record<string, unknown>>;
  return out.filter((r) => (r.status ?? 'active') === 'active').map((r) => ({ id: String(r.id), key: String(r.key ?? ''), name: String(r.name ?? ''), status: String(r.status ?? 'active') }));
}
export interface AgentMeta { id: string; name: string; role: string }
export async function listAgents(companyId: string): Promise<AgentMeta[]> {
  const out = (await call('GET', `/companies/${encodeURIComponent(companyId)}/agents`)) as Array<Record<string, unknown>>;
  return out.filter((a) => a.status !== 'terminated').map((a) => ({ id: String(a.id), name: String(a.name ?? ''), role: String(a.role ?? '') }));
}
export async function getConfig(companyId: string): Promise<Record<string, any>> {
  const out = (await call('GET', `/plugins/${PLUGIN_KEY}/config?companyId=${encodeURIComponent(companyId)}`)) as Record<string, any> | null;
  const cfg = out && 'configJson' in out ? out.configJson : out;
  return cfg && typeof cfg === 'object' ? cfg : {};
}
export async function saveConfig(companyId: string, configJson: Record<string, unknown>): Promise<void> { await call('POST', `/plugins/${PLUGIN_KEY}/config`, { companyId, configJson }); }
export const errText = (e: unknown): string => (e instanceof UiHttpError ? (e.status === 403 ? 'You need instance admin rights to save plugin settings.' : `The request failed (HTTP ${e.status}).`) : e instanceof Error ? e.message : 'The request failed.');
