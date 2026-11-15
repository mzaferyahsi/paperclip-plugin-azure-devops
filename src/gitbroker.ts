// Git credential broker (phase 1). A git credential helper on the host calls this route with the run's own agent token; the plugin decides,
// then returns a short-lived Entra access token for exactly the bot that role may use. The token goes straight to `git`, never through
// a tool result and never to disk. Authors get the author bot (can push); everyone else gets the reviewer bot (read only by design).
import { AdoError } from './ado/client.ts';
import type { Config, Role } from './config.ts';
import type { Host } from './host.ts';
import { NS } from './namespace.ts';
import type { Service } from './service.ts';
import { isAuthorAgent } from './tools/common.ts';

export interface BrokerRequest { companyId: string; agentId: string | null; runId: string | null; body: unknown }
export interface BrokerResponse { status: number; body: Record<string, unknown> }
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const SEG = /^[^/\\?#\u0000-\u001f]{1,256}$/;

/** `acme/Platform/_git/widgets` (dev.azure.com) or `proj/_git/repo`, `DefaultCollection/proj/_git/repo` (visualstudio.com). */
export function parseGitPath(host: string, rawPath: string, orgName: string): { org: string; project: string; repo: string } | null {
  const h = host.toLowerCase();
  let parts = rawPath.replace(/^\/+/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  let org: string;
  try { parts = parts.map(decodeURIComponent); } catch { return null; }
  if (h === 'dev.azure.com') { org = parts.shift() ?? ''; }
  else if (h === `${orgName.toLowerCase()}.visualstudio.com`) { org = orgName; if (parts[0]?.toLowerCase() === 'defaultcollection') parts.shift(); }
  else return null;
  if ([...parts, org].some((p) => p === '.' || p === '..')) return null;
  if (parts.length !== 3 || parts[1]!.toLowerCase() !== '_git' || !SEG.test(parts[0]!) || !SEG.test(parts[2]!) || !SEG.test(org)) return null;
  return { org, project: parts[0]!, repo: parts[2]! };
}

export class GitBroker {
  private readonly svc: Service;
  private readonly host: Host;
  private hits = new Map<string, number[]>();
  constructor(svc: Service) { this.svc = svc; this.host = svc.host; }

  private limited(agentId: string): boolean {
    const now = this.host.now(); const arr = (this.hits.get(agentId) ?? []).filter((t) => now - t < 60_000);
    arr.push(now); this.hits.set(agentId, arr);
    if (this.hits.size > 500) for (const [k, v] of this.hits) if (v.every((t) => now - t > 60_000)) this.hits.delete(k);
    return arr.length > 120;
  }

  async handle(req: BrokerRequest): Promise<BrokerResponse> {
    const audit = (outcome: string, detail: unknown) => this.svc.store.audit({ id: this.host.uuid(), companyId: req.companyId, at: new Date(this.host.now()).toISOString(), agentId: req.agentId, runId: req.runId, action: 'git_credential', target: rec(detail).target ?? {}, outcome, detail: rec(detail).info ?? {} }).catch(() => {});
    const deny = async (status: number, error: string, message: string, detail: unknown = {}): Promise<BrokerResponse> => { this.host.metric('ado.git.credential', 1, { outcome: error }); await audit(`denied:${error}`, detail); return { status, body: { error, message } }; };
    if (!req.agentId) return deny(403, 'agent_required', 'Only agent runs can request git credentials');
    if (!req.runId) return deny(403, 'run_required', 'No run id: call this from inside an agent run');
    const cfg = await this.host.config(req.companyId);
    if (!cfg) return deny(404, 'not_configured', 'Azure DevOps is not configured for this company');
    const b = rec(req.body);
    if (b.protocol !== 'https' || typeof b.host !== 'string' || typeof b.path !== 'string') return deny(400, 'bad_request', 'protocol=https, host and path are required (set credential.useHttpPath=true)');
    const target = parseGitPath(b.host, b.path, cfg.organization.name);
    if (!target || target.org.toLowerCase() !== cfg.organization.name.toLowerCase()) return deny(403, 'out_of_scope', 'This is not a repository of the configured organization', { target: { host: String(b.host).slice(0, 100) } });
    const project = cfg.projects.find((p) => p.name.toLowerCase() === target.project.toLowerCase());
    if (!project || !this.svc.repoAllowed(project, target.repo)) return deny(403, 'out_of_scope', 'This repository is outside the projects and repositories selected in the plugin settings', { target });
    if (this.limited(req.agentId)) return deny(429, 'rate_limited', 'Too many credential requests; wait a minute', { target });
    // The run must be the agent's own and still alive: a leaked run token stops working with the run.
    const run = await this.host.db.query<{ status: string }>(`SELECT status FROM public.heartbeat_runs WHERE id=$1 AND company_id=$2 AND agent_id=$3`, [req.runId, req.companyId, req.agentId]).catch(() => []);
    if (!run[0] || !['running', 'queued'].includes(run[0].status)) return deny(403, 'run_not_active', 'This run is not active', { target });
    const role: Role = isAuthorAgent(cfg, req.agentId) ? 'author' : 'reviewer';
    try {
      const t = await this.svc.clientFor(req.companyId, cfg, role).accessToken();
      const ttl = t.expiresAt ? Math.max(60, Math.floor((t.expiresAt - this.host.now()) / 1000)) : 300;
      this.host.metric('ado.git.credential', 1, { outcome: 'issued', role });
      await audit('issued', { target, info: { role, ttl } });
      return { status: 200, body: { username: 'paperclip', password: t.token, expiresAt: Math.floor(this.host.now() / 1000) + ttl, ttlSeconds: ttl, identity: role } };
    } catch (e) {
      const code = e instanceof AdoError ? e.code : 'error';
      this.host.metric('ado.git.credential', 1, { outcome: code });
      await audit(`failed:${code}`, { target });
      return { status: code === 'ado_rate_limited' ? 429 : 502, body: { error: code, message: e instanceof AdoError ? e.message : 'The bot token could not be obtained' } };
    }
  }
}
export { NS };
