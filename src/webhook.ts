// Webhook ingress (spec D1-D4, 7.1). The host route is public, so a delivery is only a HINT: it is authenticated, deduplicated into the
// inbox, and later turned into "fetch object X from ADO with our own credentials". Payload contents never drive an action.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import type { Host } from './host.ts';
import { NS } from './namespace.ts';

export interface WebhookInput { headers: Record<string, string | string[]>; rawBody: string; parsedBody?: unknown; requestId: string }
export type WebhookOutcome = { result: 'accepted' | 'duplicate' | 'skipped' | 'rejected'; reason?: string; companyId?: string };

const ONE_WEEK = 7 * 24 * 3600_000;
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const header = (h: Record<string, string | string[]>, name: string): string => {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return Array.isArray(v) ? (v[0] ?? '') : v;
  return '';
};
/** Compare without leaking length or content through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest(), hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export interface ResourceRef { kind: 'pull_request' | 'build' | 'work_item' | 'other'; prId?: number; repoId?: string; buildId?: number; workItemId?: number }

/** Only ids are kept from the payload. */
export function extractRef(eventType: string, resource: Record<string, unknown>): ResourceRef {
  const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v) ? Number(v) : undefined);
  if (eventType.startsWith('git.pullrequest.') || eventType === 'ms.vss-code.git-pullrequest-comment-event') {
    const pr = rec(resource.pullRequest);
    const prId = int(resource.pullRequestId) ?? int(pr.pullRequestId);
    const repo = rec(resource.repository ?? pr.repository);
    return prId ? { kind: 'pull_request', prId, repoId: typeof repo.id === 'string' ? repo.id : undefined } : { kind: 'other' };
  }
  if (eventType === 'build.complete') { const id = int(resource.id); return id ? { kind: 'build', buildId: id } : { kind: 'other' }; }
  if (eventType === 'ms.vss-pipelines.run-state-changed-event') { const run = rec(resource.run); const id = int(run.id); return id ? { kind: 'build', buildId: id } : { kind: 'other' }; }
  if (eventType.startsWith('workitem.')) { const id = int(resource.workItemId) ?? int(resource.id); return id ? { kind: 'work_item', workItemId: id } : { kind: 'other' }; }
  return { kind: 'other' };
}

export class WebhookIngress {
  private readonly host: Host;
  private tokens = new Map<string, { hook: string; basic: string | null; at: number }>();
  rejected10m: number[] = [];
  private routes: { at: number; byProject: Map<string, Array<{ companyId: string; cfg: Config }>> } | null = null;
  constructor(host: Host) { this.host = host; }
  invalidate(companyId?: string): void { this.routes = null; if (companyId) this.tokens.delete(companyId); else this.tokens.clear(); }

  /** Project to company routing, cached for a minute: the route is public, so a flood must not cost a host call per request. */
  private async routing(projectId: string): Promise<Array<{ companyId: string; cfg: Config }>> {
    if (!this.routes || this.host.now() - this.routes.at > 60_000) {
      const byProject = new Map<string, Array<{ companyId: string; cfg: Config }>>();
      for (const companyId of await this.host.configuredCompanies()) {
        const cfg = await this.host.config(companyId);
        if (!cfg || cfg.reconcile.paused) continue;
        for (const p of cfg.projects) { const k = p.projectId.toLowerCase(); byProject.set(k, [...(byProject.get(k) ?? []), { companyId, cfg }]); }
      }
      this.routes = { at: this.host.now(), byProject };
    }
    return this.routes.byProject.get(projectId) ?? [];
  }

  /** Hook secrets are low value and cached for five minutes, so a flood of forged calls cannot exhaust the host's secret rate limit. */
  private async secretsFor(companyId: string, cfg: Config): Promise<{ hook: string; basic: string | null } | null> {
    const hit = this.tokens.get(companyId);
    if (hit && this.host.now() - hit.at < 300_000) return hit;
    if (!cfg.webhook.hookTokenRef) return null;
    const hook = await this.host.resolveSecret(companyId, cfg.webhook.hookTokenRef, 'webhook.hookTokenRef');
    const basic = cfg.webhook.basicAuthPasswordRef ? await this.host.resolveSecret(companyId, cfg.webhook.basicAuthPasswordRef, 'webhook.basicAuthPasswordRef') : null;
    // An empty or tiny secret would let a request with no header through: refuse to authenticate anything.
    if (hook.length < 16 || (basic !== null && basic.length < 16)) return null;
    const v = { hook, basic, at: this.host.now() };
    this.tokens.set(companyId, v);
    return v;
  }

  private reject(reason: string): WebhookOutcome {
    const now = this.host.now();
    this.rejected10m = this.rejected10m.filter((t) => now - t < 600_000);
    this.rejected10m.push(now);
    this.host.metric('ado.webhook.rejected', 1, { reason });
    return { result: 'rejected', reason };
  }

  async handle(input: WebhookInput): Promise<WebhookOutcome> {
    const body = rec(input.parsedBody ?? safeParse(input.rawBody));
    const eventType = typeof body.eventType === 'string' ? body.eventType.slice(0, 120) : '';
    if (!eventType) return this.reject('malformed');
    const containers = rec(body.resourceContainers);
    const projectId = typeof rec(containers.project).id === 'string' ? String(rec(containers.project).id).toLowerCase() : '';
    if (!projectId) return this.reject('no_project');
    // Route to the company that selected this project. Several companies on one project would be ambiguous: refuse rather than guess.
    const matches = await this.routing(projectId);
    if (matches.length !== 1) return this.reject(matches.length === 0 ? 'unknown_project' : 'ambiguous_project');
    const { companyId, cfg } = matches[0]!;
    const secrets = await this.secretsFor(companyId, cfg).catch(() => null);
    if (!secrets) return this.reject('no_token_configured');
    if (!safeEqual(header(input.headers, 'x-paperclip-hook-token'), secrets.hook)) return this.reject('bad_token');
    if (secrets.basic !== null) {
      const auth = header(input.headers, 'authorization');
      const expected = 'Basic ' + Buffer.from(`${cfg.webhook.basicAuthUser}:${secrets.basic}`).toString('base64');
      if (!safeEqual(auth, expected)) return this.reject('bad_basic_auth');
    }
    const created = typeof body.createdDate === 'string' ? Date.parse(body.createdDate) : NaN;
    if (Number.isFinite(created) && this.host.now() - created > ONE_WEEK) return { result: 'skipped', reason: 'too_old', companyId };
    const eventId = typeof body.id === 'string' && body.id ? body.id.slice(0, 100) : createHash('sha256').update(input.rawBody).digest('hex');
    const ref = extractRef(eventType, rec(body.resource));
    const nowIso = new Date(this.host.now()).toISOString();
    const r = await this.host.db.execute(
      `INSERT INTO ${NS}.webhook_inbox (id,company_id,event_id,subscription_id,event_type,resource_kind,resource_ref,project_id,received_at,status,attempts,next_attempt_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'pending',0,$9) ON CONFLICT (event_id) DO NOTHING`,
      [this.host.uuid(), companyId, eventId, typeof body.subscriptionId === 'string' ? body.subscriptionId.slice(0, 64) : null, eventType, ref.kind, JSON.stringify(ref), projectId, nowIso]);
    this.host.metric('ado.webhook.accepted', 1, { event: eventType });
    return { result: r.rowCount > 0 ? 'accepted' : 'duplicate', companyId };
  }
}
function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
