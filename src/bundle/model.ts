// Pure parts of the release bundle: config snapshot, argument hash, expected run parameters, run read-back and artifact parsing. No I/O.
import type { Config } from '../config.ts';
import { hashArgs } from '../tools/gate.ts';

export const BRANCH = 'refs/heads/main';
export const SHA = /^[0-9a-f]{40}$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const ARTIFACT = 'image-provenance';

/** Values the card binds (design S5). Recomputed from live config at every step. */
export function snapshotOf(cfg: Config): Record<string, unknown> {
  const da = cfg.platformAdmin.deployApproval, rb = da.releaseBundle;
  const project = cfg.projects.find((p) => p.projectId.toLowerCase() === rb.projectId.toLowerCase());
  const sort = <T>(a: T[]) => [...a].sort();
  return {
    projectId: rb.projectId.toLowerCase(), buildPipelineId: rb.buildPipelineId, deployPipelineId: rb.deployPipelineId, imageRepository: da.imageRepository,
    buildPipelineIds: sort(da.buildPipelineIds), deployPipelineIds: sort(da.deployPipelineIds), environments: sort(da.environments), sourceBranch: da.sourceBranch,
    proposerAgentIds: sort(rb.proposerAgentIds.map((x) => x.toLowerCase())), deployApproverAgentIds: sort(da.approverAgentIds.map((x) => x.toLowerCase())),
    protectedPipelines: sort(project?.protectedPipelines ?? []), ttlMinutes: rb.ttlMinutes, maxBuildAttempts: rb.maxBuildAttempts, maxCommitsBehind: rb.maxCommitsBehind,
  };
}
export const configHashOf = (snapshot: Record<string, unknown>): string => hashArgs(snapshot);

export interface ArgsInput { companyId: string; projectId: string; issueId: string; proposerAgentId: string; sourceCommit: string; branch: string; buildPipelineId: number; deployPipelineId: number; ttlMinutes: number; configHash: string; reason: string }
export const argsHashOf = (a: ArgsInput): string => hashArgs({ companyId: a.companyId, projectId: a.projectId, issueId: a.issueId, proposerAgentId: a.proposerAgentId, sourceCommit: a.sourceCommit, branch: a.branch, buildPipelineId: a.buildPipelineId, deployPipelineId: a.deployPipelineId, ttlMinutes: a.ttlMinutes, configHash: a.configHash, reason: a.reason });

export type Kind = 'build' | 'deploy';
/** The exact template parameters the worker sends. 140 gets none; 138 gets the three names deploy approval control 4 reads. */
export function expectedParams(kind: Kind, o: { imageRepository: string; digest: string | null; commit: string; buildId: number | null }): Record<string, string> {
  if (kind === 'build') return {};
  return { imageReference: `${o.imageRepository}@${o.digest}`, sourceCommit: o.commit, buildId: String(o.buildId) };
}

/** What `GET build/builds/{id}` says about a run, trimmed to the facts the bundle compares (design section 7). */
export interface RunFacts {
  id: number; definitionId: number; status: string; result: string | null; sourceVersion: string; sourceBranch: string; reason: string; requestedForId: string; requestedById: string; queueTime: string | null;
  templateParameters: Record<string, string>; variables: Record<string, unknown>; resources: { repositories: Record<string, { refName: string; version: string }>; extra: string[] };
}
const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
export function parseRunReadback(raw: unknown): RunFacts {
  const b = o(raw);
  const id = Number(b.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('run has no id');
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(o(b.templateParameters))) params[k] = String(v);
  let variables: Record<string, unknown> = {};
  if (typeof b.parameters === 'string' && b.parameters.trim()) { try { variables = o(JSON.parse(b.parameters)); } catch { variables = { unreadable: true }; } }
  for (const k of Object.keys(params)) delete variables[k]; // Azure DevOps echoes template parameters in `parameters`
  const repos: Record<string, { refName: string; version: string }> = {};
  const res = o(b.resources); const extra: string[] = [];
  for (const [k, v] of Object.entries(res)) {
    if (k !== 'repositories') { extra.push(k); continue; }
    for (const [rk, rv] of Object.entries(o(v))) repos[rk] = { refName: s(o(rv).refName), version: s(o(rv).version) };
  }
  return {
    id, definitionId: Number(o(b.definition).id), status: s(b.status), result: b.result == null ? null : s(b.result), sourceVersion: s(b.sourceVersion).toLowerCase(), sourceBranch: s(b.sourceBranch), reason: s(b.reason),
    requestedForId: s(o(b.requestedFor).id).toLowerCase(), requestedById: s(o(b.requestedBy).id).toLowerCase(), queueTime: s(b.queueTime) || null,
    templateParameters: params, variables, resources: { repositories: repos, extra },
  };
}

/** Why a run is not the one the worker asked for, or null when it is exactly that run. */
export function runMismatch(run: RunFacts, e: { pipelineId: number; commit: string; authorId: string; params: Record<string, string> }): string | null {
  if (run.definitionId !== e.pipelineId) return 'definition';
  if (run.sourceVersion !== e.commit) return 'commit';
  if (run.sourceBranch !== BRANCH) return 'branch';
  if (run.reason !== 'manual') return 'reason';
  if (!run.requestedForId || run.requestedForId !== e.authorId.toLowerCase()) return 'requestedFor';
  const a = Object.keys(run.templateParameters).sort(), b = Object.keys(e.params).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i] || run.templateParameters[k] !== e.params[k])) return 'parameters';
  if (Object.keys(run.variables).length) return 'variables';
  if (run.resources.extra.length) return 'resources';
  const repos = Object.entries(run.resources.repositories);
  if (repos.some(([k, v]) => k !== 'self' || (v.refName && v.refName !== BRANCH) || (v.version && v.version.toLowerCase() !== e.commit))) return 'resources';
  return null;
}

export type Provenance = { ok: true; digest: string; imageReference: string; sourceCommit: string; buildId: number } | { ok: false; reason: string };
/**
 * Parse the `image-provenance` artifact of pipeline 140 (image-reference.txt, source-commit.txt, build-id.txt). Digest comes from the reference only,
 * and only after the reference equals `<imageRepository>@sha256:<64 hex>` and the commit and build id equal the pinned ones (design section 8).
 */
export function parseProvenance(files: Record<string, string>, want: { imageRepository: string; commit: string; buildId: number }): Provenance {
  const get = (n: string) => (files[n] ?? '').trim();
  const ref = get('image-reference.txt'), commit = get('source-commit.txt').toLowerCase(), build = get('build-id.txt');
  if (!ref || !commit || !build) return { ok: false, reason: 'artifact_incomplete' };
  if ([ref, commit, build].some((x) => x.includes('\n') || x.length > 300)) return { ok: false, reason: 'artifact_malformed' };
  const at = ref.lastIndexOf('@');
  if (at < 0 || ref.slice(0, at) !== want.imageRepository) return { ok: false, reason: 'repository_mismatch' };
  const digest = ref.slice(at + 1);
  if (!DIGEST.test(digest)) return { ok: false, reason: 'digest_format' };
  if (commit !== want.commit) return { ok: false, reason: 'commit_mismatch' };
  if (!/^[1-9][0-9]{0,14}$/.test(build) || Number(build) !== want.buildId) return { ok: false, reason: 'build_id_mismatch' };
  return { ok: true, digest, imageReference: ref, sourceCommit: commit, buildId: want.buildId };
}
