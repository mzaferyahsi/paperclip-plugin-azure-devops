// Azure DevOps REST client. Credentials are resolved per call batch, never logged, never persisted. The HTTP function is injected so
// production uses ctx.http.fetch (SSRF-pinned by the host) and tests use the in-process fake server.
import type { Config, IdentityConfig, Role, SecretRef } from '../config.ts';
import { RateGate } from './rate.ts';
import { neutralize } from '../sanitize.ts';

/** Identity a client is bound to. `admin` is the optional platform administration identity; it is never a stored connection role. */
export type ClientRole = Role | 'admin';
export type FetchPort = (url: string, init?: RequestInit) => Promise<Response>;
export type SecretResolver = (ref: SecretRef, configPath: string) => Promise<string>;

export type AdoErrorCode = 'ado_auth' | 'not_found_or_forbidden' | 'ado_rate_limited' | 'ado_unavailable' | 'ado_conflict' | 'ado_bad_request' | 'ado_config';
export class AdoError extends Error {
  code: AdoErrorCode; status: number; retryAfterSeconds?: number;
  constructor(code: AdoErrorCode, status: number, message: string, retryAfterSeconds?: number) {
    super(message); this.code = code; this.status = status; this.retryAfterSeconds = retryAfterSeconds;
  }
}

const API = '7.1';
const ENTRA_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

interface CachedToken { value: string; expiresAt: number }

export interface ClientDeps {
  fetch: FetchPort; resolveSecret: SecretResolver; now?: () => number; sleep?: (ms: number) => Promise<void>;
  /** Override only in tests; production always talks to Microsoft hosts. */
  loginBase?: string; apiBase?: (cfg: Config) => string;
}

export class AdoClient {
  readonly gate: RateGate;
  private token: CachedToken | null = null;
  private pat: CachedToken | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly role: ClientRole;
  /** `identities`: org-level identities host (vssps) instead of the organization host. */
  private readonly host: 'org' | 'identities';
  private readonly cfg: Config;
  private readonly deps: ClientDeps;
  constructor(role: ClientRole, cfg: Config, deps: ClientDeps, gate?: RateGate, host: 'org' | 'identities' = 'org') {
    this.role = role; this.host = host; this.cfg = cfg; this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.gate = gate ?? new RateGate(this.now);
  }
  private get identity(): IdentityConfig {
    const id = this.cfg.identities[this.role];
    if (!id) throw new AdoError('ado_config', 0, `${this.role}: no identity is configured (identities.${this.role})`);
    return id;
  }
  get orgBase(): string {
    if (this.deps.apiBase) return this.deps.apiBase(this.cfg);
    const { name, hostForm } = this.cfg.organization;
    if (this.host === 'identities') return hostForm === 'visualstudio.com' ? `https://${name}.vssps.visualstudio.com` : `https://vssps.dev.azure.com/${name}`;
    return hostForm === 'visualstudio.com' ? `https://${name}.visualstudio.com` : `https://dev.azure.com/${name}`;
  }

  private async authHeader(): Promise<string> {
    const id = this.identity;
    if (id.kind === 'pat') {
      if (!id.patRef) throw new AdoError('ado_config', 0, `${this.role}: no PAT configured`);
      // The host allows 30 secret resolutions a minute per company: keep the PAT in memory for five minutes, drop it on a rejection.
      if (!this.pat || this.pat.expiresAt <= this.now()) this.pat = { value: await this.secret(id.patRef, `identities.${this.role}.patRef`), expiresAt: this.now() + 300_000 };
      return 'Basic ' + Buffer.from(`:${this.pat.value}`).toString('base64');
    }
    if (this.token && this.token.expiresAt - this.now() > 300_000) return `Bearer ${this.token.value}`;
    if (!id.tenantId || !id.clientSecretRef || (!id.clientId && !id.clientIdRef)) throw new AdoError('ado_config', 0, `${this.role}: Entra identity is incomplete`);
    // The client id may live in a Paperclip secret; it is read together with the client secret, once per token lifetime.
    const clientId = id.clientId ?? (await this.secret(id.clientIdRef!, `identities.${this.role}.clientIdRef`)).trim();
    const secretValue = await this.secret(id.clientSecretRef, `identities.${this.role}.clientSecretRef`);
    const loginBase = this.deps.loginBase ?? 'https://login.microsoftonline.com';
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secretValue, scope: id.tokenScope ?? ENTRA_SCOPE });
    const res = await this.deps.fetch(`${loginBase}/${id.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!res.ok) {
      const code = res.status >= 500 ? 'ado_unavailable' : 'ado_auth';
      throw new AdoError(code, res.status, `${this.role}: Entra token request failed (HTTP ${res.status})`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new AdoError('ado_auth', 401, `${this.role}: Entra token response had no access token`);
    this.token = { value: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 };
    return `Bearer ${this.token.value}`;
  }

  /** A fresh-enough access token for git over HTTPS (Entra) or the PAT. Callers must treat it as a credential: never log or return it to an agent as tool output. */
  async accessToken(): Promise<{ token: string; expiresAt: number | null }> {
    const header = await this.authHeader();
    if (header.startsWith('Bearer ')) return { token: header.slice(7), expiresAt: this.token?.expiresAt ?? null };
    return { token: Buffer.from(header.slice(6), 'base64').toString().slice(1), expiresAt: this.pat?.expiresAt ?? null };
  }

  invalidateToken(): void { this.token = null; this.pat = null; }

  /** Secret resolution can fail for reasons that are not Azure DevOps errors (host rate limit, deleted secret): map them so callers back off or fail over. */
  private async secret(ref: SecretRef, path: string): Promise<string> {
    try {
      const v = await this.deps.resolveSecret(ref, path);
      if (!v) throw new AdoError('ado_config', 0, `${this.role}: the configured secret is empty`);
      return v;
    } catch (e) {
      if (e instanceof AdoError) throw e;
      if (/rate.?limit/i.test(String((e as Error)?.name) + String((e as Error)?.message))) { this.gate.park(60); throw new AdoError('ado_rate_limited', 429, `${this.role}: the host limited secret reads`, 60); }
      throw new AdoError('ado_config', 0, `${this.role}: the configured secret could not be read`);
    }
  }

  /** One REST call. Retries only idempotent transient failures, at most twice, honouring Retry-After. */
  async request<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; contentType?: string; apiVersion?: string; project?: string; etag?: string; allowNotModified?: boolean; baseUrl?: string; raw?: boolean; accept?: string } = {}): Promise<{ status: number; data: T; etag: string | null; headers: Headers }> {
    const parked = this.gate.parkedSeconds();
    if (parked > 0) throw new AdoError('ado_rate_limited', 429, `identity ${this.role} is parked`, parked);
    const base = opts.baseUrl ?? this.orgBase;
    const url = new URL(`${base}${opts.project ? '/' + encodeURIComponent(opts.project) : ''}/_apis/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', opts.apiVersion ?? API);
    const idempotent = method === 'GET' || method === 'PUT' || method === 'DELETE';
    let attempt = 0;
    for (;;) {
      attempt++;
      const headers: Record<string, string> = { authorization: await this.authHeader(), accept: opts.accept ?? 'application/json' };
      if (opts.body !== undefined) headers['content-type'] = opts.contentType ?? 'application/json';
      if (opts.etag) headers['if-none-match'] = opts.etag;
      let res: Response;
      try {
        res = await this.deps.fetch(url.toString(), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' });
      } catch (e) {
        if (idempotent && attempt <= 2) { await this.sleep(300 * attempt); continue; }
        throw new AdoError('ado_unavailable', 0, this.role === 'admin' ? 'admin: network request failed' : `network error: ${(e as Error).name}`);
      }
      this.gate.record(res.headers);
      if (res.status === 304 && opts.allowNotModified) return { status: 304, data: undefined as T, etag: opts.etag ?? null, headers: res.headers };
      // ADO answers a bad credential with 401, or with a 203/302 sign-in page. Never follow it.
      if (res.status === 401 || res.status === 203 || res.status === 302 || (!opts.raw && (res.headers.get('content-type') ?? '').includes('text/html'))) {
        if (this.identity.kind === 'entra') this.invalidateToken();
        throw new AdoError('ado_auth', 401, `${this.role}: Azure DevOps rejected the credential`);
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after')) || 30;
        this.gate.park(ra);
        if (idempotent && attempt <= 2 && ra <= 5) { await this.sleep(ra * 1000); continue; }
        throw new AdoError('ado_rate_limited', 429, 'Azure DevOps rate limit reached', ra);
      }
      if (res.status >= 500 || res.status === 408) {
        if (idempotent && attempt <= 2) { await this.sleep(400 * attempt); continue; }
        throw new AdoError('ado_unavailable', res.status, `Azure DevOps returned HTTP ${res.status}`);
      }
      const text = await res.text();
      let data: unknown = undefined;
      if (opts.raw) data = text;
      else if (text) { try { data = JSON.parse(text); } catch { data = undefined; } }
      if (this.role === 'admin' && res.status >= 400) {
        const code = res.status === 403 || res.status === 404 ? 'not_found_or_forbidden' : res.status === 409 ? 'ado_conflict' : 'ado_bad_request';
        throw new AdoError(code, res.status, `admin: Azure DevOps returned HTTP ${res.status}`);
      }
      if (res.status === 403) throw new AdoError('not_found_or_forbidden', 403, adoMessage(data, 'forbidden'));
      if (res.status === 404) throw new AdoError('not_found_or_forbidden', 404, adoMessage(data, 'not found'));
      if (res.status === 409) throw new AdoError('ado_conflict', 409, adoMessage(data, 'conflict'));
      if (res.status >= 400) throw new AdoError('ado_bad_request', res.status, adoMessage(data, `HTTP ${res.status}`));
      return { status: res.status, data: data as T, etag: res.headers.get('etag'), headers: res.headers };
    }
  }

  async get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>, project?: string, extra: { apiVersion?: string; etag?: string } = {}): Promise<T> {
    return (await this.request<T>('GET', path, { query, project, ...extra })).data;
  }
}

/** ADO error bodies carry `message`. It is untrusted text: cap it and neutralise instruction-like spans. */
function adoMessage(data: unknown, fallback: string): string {
  const m = data && typeof data === 'object' ? (data as { message?: unknown }).message : undefined;
  return typeof m === 'string' && m ? neutralize(m.replace(/\s+/g, ' ').slice(0, 300)) : fallback;
}
