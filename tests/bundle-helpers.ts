// Shared test setup for the release bundle: a config, a scriptable fake Azure DevOps port, and helpers to propose, accept and tick.
import { randomUUID } from 'node:crypto';
import { parseConfig, type Config } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { BundleStore, type BundleRow } from '../src/bundle/store.ts';
import { argsHashOf, configHashOf, snapshotOf, type RunFacts } from '../src/bundle/model.ts';
import { tickCompany, type BundlePort, type Deps } from '../src/bundle/engine.ts';
import { COMPANY, type Harness } from './test-host.ts';

export const U = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const PROJECT = 'c0000000-0000-4000-8000-000000000001';
export const PROPOSER = U(10), CEO = U(4), TL = U(6), QA = U(7), SEC = U(5);
export const AUTHOR_ID = 'b0000000-0000-4000-8000-0000000000aa';
export const REPO = 'harbor.alroze.cloud/kippiowl/kippiowl';
export const COMMIT = 'a'.repeat(40);
export const DIGEST = `sha256:${'d'.repeat(64)}`;
const pat = (id: string) => ({ kind: 'pat', patRef: { type: 'secret_ref', secretId: id } });
export const rawConfig = (rb: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  organization: { name: 'alroze' }, projects: [{ projectId: PROJECT, name: 'p', protectedBranches: ['refs/heads/main'], protectedPipelines: [] }],
  identities: { author: pat('s0000000-0000-4000-8000-000000000001'), reviewer: pat('s0000000-0000-4000-8000-000000000002'), admin: pat('s0000000-0000-4000-8000-000000000005') },
  webhook: { hookTokenRef: { type: 'secret_ref', secretId: 's0000000-0000-4000-8000-000000000003' }, basicAuthPasswordRef: { type: 'secret_ref', secretId: 's0000000-0000-4000-8000-000000000004' } },
  roles: { authorAgentIds: [PROPOSER], reviewerAgentIds: [TL, QA, SEC] },
  platformAdmin: { enabled: true, environments: ['kippiowl-staging'], deployApproval: { enabled: true, approverAgentIds: [CEO], environments: ['kippiowl-staging'], deployPipelineIds: [138], buildPipelineIds: [140], imageRepository: REPO, sourceBranch: 'refs/heads/main',
    releaseVerdictFunctions: { techlead: [TL], qa: [QA], security: [SEC] },
    releaseBundle: { enabled: true, projectId: PROJECT, buildPipelineId: 140, deployPipelineId: 138, proposerAgentIds: [PROPOSER], approverUserIds: ['user-1'], ...rb } } },
  ...over,
});
export const cfgOf = (rb: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Config => parseConfig(rawConfig(rb, over));

export class FakePort implements BundlePort {
  runs = new Map<number, RunFacts>(); next = 500; posts: Array<{ pipelineId: number; commit: string; params: Record<string, string> }> = [];
  /** Create the run, then throw: the crash after the POST. */
  failAfterPost: Array<number> = [];
  files = new Map<number, Record<string, string> | null>(); contains = true; pending = new Set<number>(); cancelled: number[] = []; mainDown = false;
  authorId = async () => AUTHOR_ID;
  async mainState() { if (this.mainDown) throw new Error('down'); return { contains: this.contains, behind: 0 }; }
  mk(id: number, pipelineId: number, commit: string, params: Record<string, string>, over: Partial<RunFacts> = {}): RunFacts {
    const r: RunFacts = { id, definitionId: pipelineId, status: 'notStarted', result: null, sourceVersion: commit, sourceBranch: 'refs/heads/main', reason: 'manual', requestedForId: AUTHOR_ID, requestedById: AUTHOR_ID, queueTime: new Date(this.nowMs()).toISOString(),
      templateParameters: params, variables: {}, resources: { repositories: { self: { refName: 'refs/heads/main', version: commit } }, extra: [] }, ...over };
    this.runs.set(id, r); return r;
  }
  nowMs = () => Date.now();
  async queue(pipelineId: number, commit: string, params: Record<string, string>) {
    this.posts.push({ pipelineId, commit, params });
    const id = this.next++; this.mk(id, pipelineId, commit, params);
    if (this.failAfterPost.length) { this.failAfterPost.shift(); throw new Error('connection reset after POST'); }
    return { id };
  }
  async run(id: number) { return this.runs.get(id) ?? null; }
  async listRuns(pipelineId: number) { return [...this.runs.values()].filter((r) => r.definitionId === pipelineId); }
  async provenance(buildId: number) { return this.files.has(buildId) ? this.files.get(buildId)! : null; }
  async pendingAtApproval(id: number) { return this.pending.has(id); }
  async cancel(id: number) { this.cancelled.push(id); const r = this.runs.get(id); if (r) { r.status = 'completed'; r.result = 'canceled'; } }
  /** Finish a run as the pipeline would. */
  finish(id: number, result: string) { const r = this.runs.get(id)!; r.status = 'completed'; r.result = result; }
  goodFiles(buildId: number, o: { commit?: string; repo?: string; digest?: string; build?: number } = {}) {
    return { 'image-reference.txt': `${o.repo ?? REPO}@${o.digest ?? DIGEST}\n`, 'source-commit.txt': `${o.commit ?? COMMIT}\n`, 'build-id.txt': `${o.build ?? buildId}\n` };
  }
}

export interface Rig { h: Harness; port: FakePort; bundles: BundleStore; store: Store; issueId: string; deps: (cfg?: Config) => Deps; propose(o?: { commit?: string; project?: string }): Promise<BundleRow>; accept(row: BundleRow, by?: { user?: string | null; agent?: string | null }): void; tick(cfg?: Config): Promise<void>; get(id: string): Promise<BundleRow> }
export function rig(h: Harness): Rig {
  const port = new FakePort(); port.nowMs = () => h.now.t;
  const bundles = new BundleStore(h.host.db); const store = new Store(h.host.db);
  const issueId = randomUUID();
  h.issues.set(issueId, { id: issueId, identifier: 'REL-1', status: 'in_progress', assigneeAgentId: PROPOSER, comments: [], wakes: [], companyId: COMPANY });
  h.configs.set(COMPANY, cfgOf());
  const deps = (cfg?: Config): Deps => ({ host: h.host, companyId: COMPANY, cfg: cfg ?? h.configs.get(COMPANY)!, bundles, store, port });
  return {
    h, port, bundles, store, issueId, deps,
    async propose(o = {}) {
      const cfg = h.configs.get(COMPANY)!; const snap = snapshotOf(cfg); const configHash = configHashOf(snap); const id = randomUUID(); const now = new Date(h.now.t).toISOString();
      const row = { id, companyId: COMPANY, issueId, projectId: o.project ?? PROJECT, proposerAgentId: PROPOSER, sourceCommit: o.commit ?? COMMIT, buildPipelineId: 140, deployPipelineId: 138, configSnapshot: snap, configHash, reason: 'release', commitFacts: { subject: 'x' }, createdAt: now,
        expiresAt: new Date(h.now.t + cfg.platformAdmin.deployApproval.releaseBundle.proposalTtlMinutes * 60_000).toISOString() };
      const argsHash = argsHashOf({ companyId: COMPANY, projectId: row.projectId, issueId, proposerAgentId: PROPOSER, sourceCommit: row.sourceCommit, branch: 'refs/heads/main', buildPipelineId: 140, deployPipelineId: 138, ttlMinutes: Number(snap.ttlMinutes), configHash, reason: 'release' });
      if (!(await bundles.insert({ ...row, argsHash }))) throw new Error('insert failed');
      const card = (await h.host.issues.requestConfirmation(COMPANY, issueId, { prompt: 'p', detailsMarkdown: 'd', acceptLabel: 'a', rejectLabel: 'r', idempotencyKey: `bundle:${id}:${argsHash}`, humanOnly: true })).id;
      await bundles.setInteraction(COMPANY, id, card);
      return (await bundles.get(COMPANY, id))!;
    },
    accept(row, by = {}) {
      const i = h.interactions.get(row.interactionId!)!;
      i.status = 'answered'; i.outcome = 'accepted'; i.resolvedByUserId = by.user === undefined ? 'user-1' : by.user; i.resolvedByAgentId = by.agent ?? null;
    },
    tick: async (cfg) => { await tickCompany(deps(cfg)); },
    get: async (id) => (await bundles.get(COMPANY, id))!,
  };
}
