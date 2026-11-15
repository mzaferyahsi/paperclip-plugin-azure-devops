// In-process fake of the Azure DevOps REST subset the plugin uses, plus the Entra token endpoint. Scriptable failures.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeReviewer { id: string; displayName: string; vote: number; isRequired?: boolean }
export interface FakePr {
  pullRequestId: number; status: string; isDraft: boolean; title: string; description: string; sourceRefName: string; targetRefName: string; mergeStatus: string;
  createdBy: { id: string; displayName: string }; reviewers: FakeReviewer[]; lastMergeSourceCommit: { commitId: string }; lastMergeCommit?: { commitId: string };
  repository: { id: string; name: string; project: { id: string; name: string } };
  iterations: number; threads: Array<{ id: number; status: string; comments: Array<{ id: number; content: string }>; threadContext?: unknown }>;
  statuses: Array<{ id: number; state: string; description: string; context: { name: string; genre: string }; iterationId?: number }>;
  completionOptions?: Record<string, unknown>;
}
export interface Call { method: string; path: string; query: URLSearchParams; auth: string; body: unknown }

export class FakeAdo {
  server!: http.Server; base = ''; login = '';
  calls: Call[] = [];
  prs = new Map<number, FakePr>();
  evaluations = new Map<number, Array<{ status: string; configuration: { isBlocking: boolean; isEnabled: boolean; type: { displayName: string } } }>>();
  builds = new Map<number, Record<string, unknown>>();
  approvals = new Map<string, Record<string, unknown>>();
  /** Test hooks: apply no decision although the PATCH answers 200; run code on every approvals GET (1-based count). */
  patchNoop = false; onApprovalsGet: ((n: number) => void) | null = null; private approvalGets = 0;
  workItems = new Map<number, { id: number; rev: number; fields: Record<string, unknown>; relations?: unknown[] }>();
  files = new Map<string, string>();
  environments = [{ id: 9, name: 'staging' }, { id: 10, name: 'production' }];
  secureFiles = [{ id: 'sf1', name: 'staging.yaml', createdOn: '2026-01-01', modifiedOn: '2026-02-01', createdBy: { displayName: 'Creator', emailAddress: 'private@example.com' }, properties: { secret: 'content-secret' }, downloadTicket: 'content-secret' }, { id: 'sf2', name: 'production.yaml' }];
  /** Variable groups created or changed through the API; empty means the static single group is served. Secret values are stored but never returned. */
  variableGroups: Array<{ id: number; name: string; description: string; variables: Record<string, { value?: string | null; isSecret?: boolean }> }> = [];
  /** What secret variables were last written, for assertions. */
  hide(vg: { id: number; name: string; description: string; variables: Record<string, { value?: string | null; isSecret?: boolean }> }) { return { ...vg, variables: Object.fromEntries(Object.entries(vg.variables).map(([k, v]) => [k, v.isSecret ? { isSecret: true, value: null } : v])) }; }
  secureFilePermissions = { allPipelines: { authorized: false }, pipelines: [{ id: 136, authorized: true }] as Array<{ id: number; authorized: boolean }> };
  permissionPatchResult?: typeof this.secureFilePermissions;
  identities: Array<Record<string, unknown>> = [];
  checks: Array<Record<string, any>> = [{ id: 21, type: { id: 'approval-type', name: 'Approval' }, isDisabled: false, timeout: 4320, settings: { approvers: [{ id: 'approver1', displayName: 'Boss', emailAddress: 'private@example.com' }], executionOrder: 'anyOrder', minRequiredApprovers: 1, requesterCannotBeApprover: true, instructions: 'private-settings' } }];
  /** Test hook: stored value of requesterCannotBeApprover regardless of what the plugin sent. */
  forceCheckFlag?: boolean;
  /** Test hook: answer a request before the built-in routes (used by the release bundle adapter test). */
  extra: ((method: string, path: string, query: URLSearchParams, body: unknown, who: string) => { status: number; body?: unknown } | undefined) | null = null;
  validPats = new Set<string>(['author-pat', 'reviewer-pat']);
  clients = new Map<string, string>(); // clientId:secret -> identity id
  tokens = new Map<string, string>(); // access token -> identity id
  failures: Array<{ match: RegExp; status: number; headers?: Record<string, string>; times: number; body?: unknown }> = [];
  permBits = new Map<string, number>();
  nextId = 1000; tokenIssued = 0; org = 'acme';
  project = { id: '11111111-1111-4111-8111-111111111111', name: 'Platform' };
  states: Record<string, Record<string, string>> = { Task: { New: 'Proposed', Active: 'InProgress', Resolved: 'Resolved', Closed: 'Completed', Removed: 'Removed' } };

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => { this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const port = (this.server.address() as AddressInfo).port;
    this.base = `http://127.0.0.1:${port}/${this.org}`; this.login = `http://127.0.0.1:${port}/login`;
    return this;
  }
  async stop(): Promise<void> { await new Promise((r) => this.server.close(r)); }
  fail(match: RegExp, status: number, times = 1, headers?: Record<string, string>, body?: unknown): void { this.failures.push({ match, status, times, headers, body }); }

  addPr(partial: Partial<FakePr> & { pullRequestId: number }): FakePr {
    const pr: FakePr = {
      status: 'active', isDraft: false, title: 'Change', description: '', sourceRefName: 'refs/heads/alice/eng-12-topic', targetRefName: 'refs/heads/main', mergeStatus: 'succeeded',
      createdBy: { id: 'author-bot', displayName: 'Paperclip Author' }, reviewers: [], lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
      repository: { id: 'r1', name: 'widgets', project: this.project }, iterations: 1, threads: [], statuses: [], ...partial,
    };
    this.prs.set(pr.pullRequestId, pr);
    return pr;
  }

  private identityOf(auth: string): string | null {
    if (auth.startsWith('Basic ')) { const pat = Buffer.from(auth.slice(6), 'base64').toString().slice(1); return this.validPats.has(pat) ? (pat === 'author-pat' ? 'author-bot' : pat === 'admin-sentinel' ? 'a0000000-0000-4000-8000-0000000000ad' : 'reviewer-bot') : null; }
    if (auth.startsWith('Bearer ')) return this.tokens.get(auth.slice(7)) ?? null;
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const ctype = String(req.headers['content-type'] ?? '');
    let body: unknown = raw; if (ctype.includes('json') && raw) body = JSON.parse(raw);
    const auth = String(req.headers.authorization ?? '');
    const path = url.pathname;
    this.calls.push({ method: req.method ?? 'GET', path, query: url.searchParams, auth, body });
    const send = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
      res.statusCode = status; for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      if (typeof data === 'string') { res.setHeader('content-type', 'text/plain'); res.end(data); } else { res.setHeader('content-type', 'application/json'); res.end(data === undefined ? '' : JSON.stringify(data)); }
    };
    const m = /^\/login\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(path);
    if (m) {
      const p = new URLSearchParams(raw); const who = this.clients.get(`${p.get('client_id')}:${p.get('client_secret')}`);
      if (!who) return send(401, { error: 'invalid_client' });
      this.tokenIssued++; const tok = `tok-${this.tokenIssued}`; this.tokens.set(tok, who);
      return send(200, { access_token: tok, expires_in: 3600, token_type: 'Bearer' });
    }
    for (const f of this.failures) if (f.times > 0 && f.match.test(`${req.method} ${path}`)) { f.times--; return send(f.status, f.body ?? { message: `scripted ${f.status}` }, f.headers); }
    const who = this.identityOf(auth);
    if (!who) { res.statusCode = 203; res.setHeader('content-type', 'text/html'); return void res.end('<html>sign in</html>'); }

    const p = path.replace(new RegExp(`^/${this.org}`), '');
    if (this.extra) { const r = this.extra(req.method ?? 'GET', p, url.searchParams, body, who); if (r !== undefined) return send(r.status, r.body); }
    if (p === '/_apis/connectionData') return send(200, { authenticatedUser: { id: who, providerDisplayName: who === 'author-bot' ? 'Paperclip Author' : 'Paperclip Reviewer' } });
    if (p === '/_apis/projects') return send(200, { count: 1, value: [{ id: this.project.id, name: this.project.name, state: 'wellFormed' }] });
    let g: RegExpExecArray | null;
    if (/\/_apis\/pipelines\/approvals$/.test(p)) {
      if (req.method === 'PATCH') {
        if (!Array.isArray(body) || body.length !== 1) return send(400, {});
        const decision = body[0] as { approvalId: string; status: string; comment: string };
        if (Object.keys(decision).sort().join(',') !== 'approvalId,comment,status' || !['approved', 'rejected'].includes(decision.status)) return send(400, {});
        const a = this.approvals.get(decision.approvalId);
        if (!a) return send(404, {});
        if (this.patchNoop) return send(200, { value: [a] });
        a.status = decision.status;
        a.steps = (a.steps as Array<Record<string, unknown>>).map(s => ({ ...s, status: decision.status }));
        return send(200, { value: [a] });
      }
      this.onApprovalsGet?.(++this.approvalGets);
      const ids = url.searchParams.get('approvalIds')?.split(','); const state = url.searchParams.get('state');
      return send(200, { value: [...this.approvals.entries()].filter(([id, a]) => (!ids || ids.includes(id)) && (!state || a.status === state)).map(([, a]) => a) });
    }
    if ((g = /\/_apis\/distributedtask\/(environments|securefiles)(?:\/([^/]+))?$/.exec(p)) && req.method === 'GET') {
      const rows = g[1] === 'environments' ? this.environments : this.secureFiles;
      if (g[2]) return send(200, rows.find((r) => String(r.id) === g![2]) ?? {});
      const name = url.searchParams.get(g[1] === 'environments' ? 'name' : 'namePattern');
      return send(200, { value: rows.filter((r) => !name || r.name === name) });
    }
    if ((g = /^\/[^/]+\/_apis\/git\/repositories$/.exec(p)) && req.method === 'GET') return send(200, { value: [{ id: 'r1', name: 'widgets', defaultBranch: 'refs/heads/main' }] });
    if ((g = /^\/[^/]+\/_apis\/git\/repositories\/([^/]+)\/pullrequests$/.exec(p))) {
      if (req.method === 'GET') {
        const status = url.searchParams.get('searchCriteria.status') ?? 'active'; const src = url.searchParams.get('searchCriteria.sourceRefName');
        return send(200, { value: [...this.prs.values()].filter((x) => (status === 'all' || x.status === status) && (!src || x.sourceRefName === src)).map((x) => this.view(x)) });
      }
      const b = body as { sourceRefName: string; targetRefName: string; title: string; description: string; isDraft: boolean };
      if ([...this.prs.values()].some((x) => x.status === 'active' && x.sourceRefName === b.sourceRefName && x.targetRefName === b.targetRefName)) return send(409, { message: 'TF401179: An active pull request for the source and target branch already exists.' });
      const pr = this.addPr({ pullRequestId: this.nextId++, sourceRefName: b.sourceRefName, targetRefName: b.targetRefName, title: b.title, description: b.description, isDraft: b.isDraft, createdBy: { id: who, displayName: who } });
      return send(201, this.view(pr));
    }
    if ((g = /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullrequests\/(\d+)(?:\/(.*))?$/.exec(p))) {
      const pr = this.prs.get(Number(g[3])); if (!pr) return send(404, { message: 'TF401180: The requested pull request was not found.' });
      const pathProject = decodeURIComponent(g[1]!).toLowerCase(), pathRepo = decodeURIComponent(g[2]!).toLowerCase();
      if (![pr.repository.project.id, pr.repository.project.name].some((x) => x.toLowerCase() === pathProject) || ![pr.repository.id, pr.repository.name].some((x) => x.toLowerCase() === pathRepo)) return send(404, { message: 'TF401180: The requested pull request was not found.' });
      const sub = g[4] ?? '';
      if (sub === '') {
        if (req.method === 'GET') return send(200, this.view(pr), { etag: `"${pr.iterations}-${pr.status}-${pr.reviewers.map((r) => r.vote).join('')}"` });
        if (req.method === 'PATCH') {
          const b = body as Record<string, unknown>;
          if (b.status === 'completed') {
            if ((b.completionOptions as { bypassPolicy?: boolean } | undefined)?.bypassPolicy === true) return send(403, { message: 'bypass refused in test' });
            const ev = this.evaluations.get(pr.pullRequestId) ?? [];
            if (ev.some((e) => e.configuration.isBlocking && e.status !== 'approved')) return send(400, { message: 'TF401027: policies not satisfied' });
            pr.status = 'completed'; pr.lastMergeCommit = { commitId: 'c'.repeat(40) }; pr.completionOptions = b.completionOptions as Record<string, unknown>;
          } else if (b.status === 'abandoned') pr.status = 'abandoned';
          if (typeof b.title === 'string') pr.title = b.title; if (typeof b.description === 'string') pr.description = b.description; if (typeof b.isDraft === 'boolean') pr.isDraft = b.isDraft;
          return send(200, this.view(pr));
        }
      }
      if (sub === 'iterations') return send(200, { value: Array.from({ length: pr.iterations }, (_, i) => ({ id: i + 1 })) });
      if ((g = /^iterations\/(\d+)\/changes$/.exec(sub))) return send(200, { changeEntries: [{ changeType: 'edit', item: { path: '/apps/x/app.yaml' } }] });
      if (sub === 'statuses') {
        if (req.method === 'GET') return send(200, { value: pr.statuses });
        const b = body as { state: string; description: string; context: { name: string; genre: string }; iterationId?: number };
        pr.statuses = pr.statuses.filter((s) => !(s.context.name === b.context.name && s.context.genre === b.context.genre && s.iterationId === b.iterationId));
        pr.statuses.push({ id: this.nextId++, ...b }); return send(200, pr.statuses.at(-1));
      }
      if (sub === 'threads') {
        if (req.method === 'GET') return send(200, { value: pr.threads });
        const b = body as { comments: Array<{ content: string }>; status: string; threadContext?: unknown };
        const t = { id: this.nextId++, status: b.status, comments: b.comments.map((c) => ({ id: 1, content: c.content })), threadContext: b.threadContext }; pr.threads.push(t); return send(200, t);
      }
      if ((g = /^threads\/(\d+)\/comments$/.exec(sub))) { const t = pr.threads.find((x) => x.id === Number(g![1])); if (!t) return send(404, { message: 'thread' }); const c = { id: t.comments.length + 1, content: (body as { content: string }).content }; t.comments.push(c); return send(200, c); }
      if ((g = /^threads\/(\d+)$/.exec(sub)) && req.method === 'PATCH') { const t = pr.threads.find((x) => x.id === Number(g![1])); if (!t) return send(404, { message: 'thread' }); t.status = (body as { status: string }).status; return send(200, t); }
      if ((g = /^reviewers\/(.+)$/.exec(sub)) && req.method === 'PUT') {
        const id = decodeURIComponent(g[1]!); if (id !== who) return send(403, { message: 'cannot vote for another identity' });
        if (pr.isDraft) return send(400, { message: 'draft' });
        const r = pr.reviewers.find((x) => x.id === id) ?? (pr.reviewers.push({ id, displayName: id, vote: 0 }), pr.reviewers.at(-1)!); r.vote = (body as { vote: number }).vote; return send(200, r);
      }
    }
    if ((g = /^(?:\/[^/]+)?\/_apis\/policy\/evaluations\/([^/]+)$/.exec(p)) && req.method === 'PATCH') return send(200, { evaluationId: g[1], status: 'queued' });
    if ((g = /^(?:\/[^/]+)?\/_apis\/policy\/evaluations$/.exec(p))) {
      const art = url.searchParams.get('artifactId') ?? ''; const id = Number(art.split('/').pop());
      return send(200, { value: (this.evaluations.get(id) ?? []).map((e, i) => ({ evaluationId: `e${i}`, ...e })) });
    }
    if ((g = /^\/[^/]+\/_apis\/git\/repositories\/([^/]+)\/items$/.exec(p)) && !url.searchParams.get('scopePath')) { const f = this.files.get(url.searchParams.get('path') ?? ''); if (f === undefined) return send(404, { message: 'no file' }); if ((url.searchParams.get('path') ?? '').endsWith('.html')) { res.statusCode = 200; res.setHeader('content-type', 'text/html'); return void res.end(f); } return send(200, f); }
    if ((g = /^\/[^/]+\/_apis\/build\/builds\/(\d+)$/.exec(p))) { const b = this.builds.get(Number(g[1])); return b ? send(200, b) : send(404, { message: 'no build' }); }
    if ((g = /^\/[^/]+\/_apis\/build\/builds\/(\d+)\/timeline$/.exec(p))) return send(200, { records: [{ id: 't1', type: 'Task', name: 'Deploy', result: 'failed', log: { id: 7 } }] });
    if ((g = /^\/[^/]+\/_apis\/build\/builds\/(\d+)\/logs\/(\d+)$/.exec(p))) return send(200, 'line1\nline2\nerror: boom\n');
    if ((g = /^\/[^/]+\/_apis\/pipelines\/(\d+)\/runs$/.exec(p))) { const id = this.nextId++; return send(200, { id, state: 'inProgress', _links: { web: { href: `https://dev.azure.com/${this.org}/p/_build/results?buildId=${id}` } } }); }
    if ((g = /^\/_apis\/wit\/workitems\/(\d+)$/.exec(p))) {
      const wi = this.workItems.get(Number(g[1])); if (!wi) return send(404, { message: 'TF401232: Work item does not exist' });
      if (req.method === 'PATCH') {
        for (const op of body as Array<{ op: string; path: string; value: unknown }>) { if (op.path.startsWith('/fields/')) wi.fields[op.path.slice(8)] = op.value; }
        wi.rev++; return send(200, wi);
      }
      return send(200, wi);
    }
    if ((g = /^\/[^/]+\/_apis\/wit\/workitemtypes\/([^/]+)\/states$/.exec(p))) { const t = this.states[decodeURIComponent(g[1]!)] ?? {}; return send(200, { value: Object.entries(t).map(([name, category]) => ({ name, category })) }); }
    if ((g = /^\/_apis\/permissions\/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87\/(\d+)$/.exec(p))) return send(200, { count: 1, value: [((this.permBits.get(who) ?? 0) & Number(g[1])) !== 0] });
    if (p === '/_apis/hooks/subscriptions') return send(200, { value: [] });
    // exploration fixtures
    if (/\/_apis\/git\/repositories\/[^/]+\/items$/.test(p) && url.searchParams.get('scopePath')) return send(200, { value: [{ path: url.searchParams.get('scopePath'), isFolder: true }, { path: '/apps', isFolder: true }, { path: '/README.md', isFolder: false, size: 12 }] });
    if (/\/_apis\/git\/repositories\/[^/]+\/refs$/.test(p)) return send(200, { value: [{ name: 'refs/heads/alice/eng-1-x', objectId: 'a'.repeat(40), creator: { displayName: 'Author', uniqueName: 'secret@example.com' } }] });
    if (/\/_apis\/git\/repositories\/[^/]+\/commits$/.test(p)) return send(200, { value: [{ commitId: 'b'.repeat(40), comment: 'first line\nsecond', author: { name: 'A', email: 'a@example.com', date: '2026-10-27T10:00:00Z' } }] });
    if (/\/_apis\/build\/definitions$/.test(p) && req.method === 'POST') return send(200, { id: 200, name: (body as { name: string }).name, revision: 1 });
    if (/\/_apis\/build\/definitions\/\d+$/.test(p) && req.method === 'PUT') return send(200, { id: 135, revision: 4 });
    if (/\/_apis\/git\/repositories$/.test(p) && req.method === 'POST') return send(201, { id: 'r9', name: (body as { name: string }).name });
    if (/\/_apis\/build\/definitions$/.test(p)) return send(200, { value: [{ id: 135, name: 'preflight', path: '\\', queueStatus: 'disabled', revision: 3 }] });
    if ((g = /\/_apis\/build\/definitions\/(\d+)$/.exec(p))) return send(200, { id: Number(g[1]), name: 'preflight', path: '\\', queueStatus: 'disabled', revision: 3, queue: { id: 1, name: 'Default' }, process: { yamlFilename: 'azure-pipelines.yml', type: 2 }, repository: { id: 'r1', name: 'widgets', defaultBranch: 'refs/heads/main' }, triggers: [{ triggerType: 'continuousIntegration' }], variableGroups: [{ name: 'vg-one', variables: { A: { value: 'leaked' } } }], variables: { SECRET: { value: 'leaked' } } });
    if (/\/_apis\/build\/builds$/.test(p)) return send(200, { value: [{ id: 1, status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/main', sourceVersion: 'c'.repeat(40), reason: 'manual', definition: { id: 135, name: 'preflight' }, requestedFor: { uniqueName: 'x@example.com' } }, { id: 2, status: 'completed', result: 'failed', sourceBranch: 'refs/heads/main', sourceVersion: 'd'.repeat(40), definition: { id: 135, name: 'preflight' } }] });
    if (/\/_apis\/policy\/configurations$/.test(p)) return send(200, { value: [{ id: 9, isEnabled: true, isBlocking: true, type: { displayName: 'Build' }, settings: { buildDefinitionId: 77, displayName: 'validate', scope: [{ refName: 'refs/heads/main' }], note: 'free text must not leak' } }] });
    if (/\/_apis\/pipelines\/\d+\/preview$/.test(p)) return send(200, { finalYaml: 'steps:\n- script: echo hi\n' });
    if (/\/_apis\/pipelines\/pipelinepermissions\/securefile\//.test(p) && req.method === 'PATCH') {
      const grants = (body as { pipelines: Array<{ id: number; authorized: boolean }> }).pipelines;
      this.secureFilePermissions = this.permissionPatchResult ?? { ...this.secureFilePermissions, pipelines: [...this.secureFilePermissions.pipelines.filter((x) => !grants.some((g) => g.id === x.id)), ...grants] };
      return send(200, this.secureFilePermissions);
    }
    if (/\/_apis\/pipelines\/pipelinepermissions\/securefile\//.test(p)) return send(200, this.secureFilePermissions);
    if (/\/_apis\/pipelines\/pipelinepermissions\//.test(p)) return send(200, { allPipelines: { authorized: false }, pipelines: [{ id: 136, authorized: true }] });
    if ((g = /\/_apis\/pipelines\/checks\/configurations\/(\d+)$/.exec(p)) && req.method === 'GET') { const c = this.checks.find((x) => x.id === Number(g![1])); return c ? send(200, c) : send(404, { message: 'no check' }); }
    if (/\/_apis\/pipelines\/checks\/configurations$/.test(p) && req.method === 'POST') {
      const b = body as Record<string, any>; const c = { ...b, id: ++this.nextId, isDisabled: false, settings: { ...b.settings, ...(this.forceCheckFlag === undefined ? {} : { requesterCannotBeApprover: this.forceCheckFlag }) } };
      this.checks.push(c); return send(200, c);
    }
    if (/\/_apis\/pipelines\/checks\/configurations$/.test(p)) return send(200, { value: this.checks });
    if (/\/_apis\/identities$/.test(p)) {
      const ids = url.searchParams.get('identityIds'); const f = url.searchParams.get('filterValue')?.toLowerCase();
      return send(200, { count: 0, value: this.identities.filter((x) => (ids ? String(x.id).toLowerCase() === ids.toLowerCase() : f ? [x.providerDisplayName, (x.properties as any)?.Account?.$value].some((v) => String(v).toLowerCase().includes(f)) : false)) });
    }
    if (/\/_apis\/serviceendpoint\/endpoints$/.test(p)) return send(200, { value: [{ id: 'e1', name: 'k8s-test', type: 'kubernetes', isReady: true, isShared: false, url: 'https://secret.internal', authorization: { scheme: 'Token', parameters: { apiToken: 'leaked' } }, data: { x: 'leaked' } }] });
    if ((g = /\/_apis\/distributedtask\/variablegroups(?:\/(\d+))?$/.exec(p)) && (req.method === 'POST' || req.method === 'PUT')) {
      const bodyIn = body as { name: string; description?: string; variables: Record<string, { value?: string | null; isSecret?: boolean }> };
      const prev = g[1] ? this.variableGroups.find((x) => x.id === Number(g![1])) : undefined;
      const vars: Record<string, { value?: string | null; isSecret?: boolean }> = {};
      for (const [k, v] of Object.entries(bodyIn.variables)) vars[k] = v.isSecret ? { isSecret: true, value: v.value ?? (prev?.variables[k] as { value?: string | null } | undefined)?.value ?? null } : { value: v.value ?? '' };
      if (prev) Object.assign(prev, { name: bodyIn.name, description: bodyIn.description ?? '', variables: vars });
      else this.variableGroups.push({ id: 100 + this.variableGroups.length, name: bodyIn.name, description: bodyIn.description ?? '', variables: vars });
      return send(200, prev ?? this.variableGroups.at(-1));
    }
    if ((g = /\/_apis\/distributedtask\/variablegroups\/(\d+)$/.exec(p))) { const vg = this.variableGroups.find((x) => x.id === Number(g![1])); return vg ? send(200, this.hide(vg)) : send(404, { message: 'no group' }); }
    if (/\/_apis\/distributedtask\/variablegroups$/.test(p) && this.variableGroups.length) { const name = new URL(req.url ?? '', 'http://x').searchParams.get('groupName'); return send(200, { value: this.variableGroups.filter((x) => !name || x.name === name).map((x) => this.hide(x)) }); }
    if (/\/_apis\/distributedtask\/variablegroups$/.test(p)) return send(200, { value: [{ id: 4, name: 'vg-one', description: 'd', variables: { PLAIN: { value: 'leaked-plain' }, TOKEN: { isSecret: true, value: null } } }] });
    if (/\/_apis\/distributedtask\/queues$/.test(p)) return send(200, { value: [{ id: 1, name: 'Default', pool: { id: 5, name: 'Default', isHosted: false } }, { id: 2, name: 'Azure Pipelines', pool: { id: 6, name: 'Azure Pipelines', isHosted: true } }] });
    if (/\/_apis\/distributedtask\/pools\/\d+\/agents$/.test(p)) return send(200, { value: [{ name: 'a1', status: 'online', enabled: true }, { name: 'a2', status: 'offline', enabled: true }] });
    if ((g = /\/_apis\/permissions\/([0-9a-f-]+)\/(\d+)$/.exec(p))) return send(200, { value: [Number(g[2]) !== 2048 && Number(g[2]) !== 32768] });
    return send(404, { message: `fake: no route ${req.method} ${p}` });
  }
  private view(pr: FakePr): Record<string, unknown> {
    const { iterations: _i, threads: _t, statuses: _s, ...rest } = pr; return rest;
  }
}
