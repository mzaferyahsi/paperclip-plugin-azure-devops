// BundlePort over the real Azure DevOps API. Queueing and cancelling use the author identity only; every read uses identities.admin (design rule 6).
import type { Config } from '../config.ts';
import type { Service } from '../service.ts';
import { identityId } from '../tools/common.ts';
import type { BundlePort } from './engine.ts';
import { ARTIFACT, BRANCH, parseRunReadback } from './model.ts';

const FILES = ['image-reference.txt', 'source-commit.txt', 'build-id.txt'];

export function projectOfBundle(cfg: Config) {
  const rb = cfg.platformAdmin.deployApproval.releaseBundle;
  const p = cfg.projects.find((x) => x.projectId.toLowerCase() === rb.projectId.toLowerCase());
  if (!p) throw new Error('release bundle project is not configured');
  return p;
}
/** The git repository of the build pipeline: the pinned commit is looked up there. */
export async function bundleRepoId(svc: Service, companyId: string, cfg: Config): Promise<string> {
  const rb = cfg.platformAdmin.deployApproval.releaseBundle; const project = projectOfBundle(cfg);
  const def = await svc.admin(companyId, cfg).api.getBuildDefinition(project.name, rb.buildPipelineId);
  const id = def.repository?.id;
  if (!id) throw new Error('the build pipeline has no repository');
  return id;
}

export function makePort(svc: Service, companyId: string, cfg: Config): BundlePort {
  const project = projectOfBundle(cfg);
  const admin = () => svc.admin(companyId, cfg).api;
  const author = () => svc.api(companyId, cfg, 'author');
  let repo: string | null = null;
  const repoId = async () => (repo ??= await bundleRepoId(svc, companyId, cfg));
  return {
    authorId: () => identityId(svc, companyId, cfg, 'author'),
    async mainState(commit) {
      const r = await admin().commitVsBranch(project.name, await repoId(), commit, BRANCH);
      if (!Number.isFinite(r.ahead) || !Number.isFinite(r.behind)) throw new Error('main state unreadable');
      return { contains: r.behind === 0, behind: r.ahead };
    },
    async queue(pipelineId, commit, params) { const r = await author().queueRun(project.projectId, pipelineId, BRANCH, params, commit); return { id: r.id }; },
    async run(runId) { try { return parseRunReadback(await admin().getBuildRaw(project.name, runId)); } catch (e) { if ((e as { code?: string })?.code === 'not_found_or_forbidden') return null; throw e; } },
    async listRuns(pipelineId, minTimeIso) { return (await admin().buildsRaw(project.name, { definition: pipelineId, minTime: minTimeIso, top: 50 })).map((b) => parseRunReadback(b)); },
    async provenance(buildId) {
      const arts = await admin().buildArtifactsRaw(project.name, buildId);
      const mine = arts.filter((a) => a?.name === ARTIFACT);
      if (mine.length !== 1) return null; // none, or two with one name: refused by the caller as missing
      const a = mine[0]!; const data = String(a.resource?.data ?? '');
      const m = /^#\/(\d{1,15})\//.exec(data);
      if (a.resource?.type !== 'Container' || !m) return null;
      const out: Record<string, string> = {};
      for (const f of FILES) out[f] = await admin().containerFileText(Number(m[1]), `${ARTIFACT}/${f}`, 1000);
      return out;
    },
    async pendingAtApproval(runId) {
      const pending = await admin().pipelineApprovals(project.name, { state: 'pending' });
      if (!pending.some((a) => a.owner.id === runId)) return false;
      const timeline = await admin().buildTimeline(project.name, runId);
      return !timeline.some((r) => r.type === 'Stage' && r.state !== 'pending');
    },
    async cancel(runId) { await author().cancelBuild(project.name, runId); },
  };
}

import { BundleStore } from './store.ts';
import type { Deps } from './engine.ts';
import { neutralize } from '../sanitize.ts';

export const bundleDeps = (svc: Service, companyId: string, cfg: Config): Deps => ({ host: svc.host, companyId, cfg, bundles: new BundleStore(svc.host.db), store: svc.store, port: makePort(svc, companyId, cfg) });

export interface CommitFacts { inMain: boolean; subject: string; author: string; pr: { id: number; url: string | null } | null; changedFiles: number | null; comparedTo: string | null; behind: number; tip: boolean; parents: number }
/** Live facts for the card and the commit rule. Free text is neutralised here; nothing comes from the proposer. */
export async function readCommitFacts(svc: Service, companyId: string, cfg: Config, commit: string, lastCompleted: string | null): Promise<CommitFacts> {
  const project = projectOfBundle(cfg); const api = svc.admin(companyId, cfg).api; const repo = await bundleRepoId(svc, companyId, cfg);
  const st = await api.commitVsBranch(project.name, repo, commit, BRANCH);
  if (!Number.isFinite(st.ahead) || !Number.isFinite(st.behind)) throw new Error('commit state unreadable');
  if (st.behind !== 0) return { inMain: false, subject: '', author: '', pr: null, changedFiles: null, comparedTo: null, behind: st.ahead, tip: false, parents: 0 }; // not in main
  const info = await api.commitInfo(project.name, repo, commit);
  const prs = await api.prsByMergeCommit(project.name, repo, commit).catch(() => []);
  const pr = prs[0] ? { id: prs[0].prId, url: `${cfg.organization.hostForm === 'visualstudio.com' ? `https://${cfg.organization.name}.visualstudio.com` : `https://dev.azure.com/${cfg.organization.name}`}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(repo)}/pullrequest/${prs[0].prId}` } : null;
  const changedFiles = lastCompleted ? await api.commitChangeCount(project.name, repo, lastCompleted, commit).catch(() => null) : null;
  return { inMain: true, subject: neutralize(info.subject).slice(0, 200), author: neutralize(info.author).slice(0, 80), pr, changedFiles, comparedTo: lastCompleted, behind: st.ahead, tip: st.ahead === 0, parents: info.parents.length };
}
/** Is `descendant` strictly after `ancestor`: it has commits the ancestor lacks and the ancestor has none that it lacks. */
export async function strictlyAfter(svc: Service, companyId: string, cfg: Config, ancestor: string, descendant: string): Promise<boolean> {
  const project = projectOfBundle(cfg); const api = svc.admin(companyId, cfg).api; const repo = await bundleRepoId(svc, companyId, cfg);
  const r = await api.commitVsBranch(project.name, repo, ancestor, descendant, 'commit');
  return r.ahead > 0 && r.behind === 0;
}

import { tickCompany } from './engine.ts';
/** The `release-bundle` job body. One company failing never stops another (design F7). */
export async function releaseBundleJob(svc: Service, depsFor: (companyId: string, cfg: Config) => Deps = (c, cfg) => bundleDeps(svc, c, cfg)): Promise<number> {
  let n = 0;
  for (const companyId of await svc.host.configuredCompanies()) {
    try {
      const cfg = await svc.host.config(companyId); if (!cfg) continue;
      if (!(await new BundleStore(svc.host.db).open(companyId)).length) continue;
      n += await tickCompany(depsFor(companyId, cfg));
    } catch (e) { svc.host.log.error('release bundle tick failed', { company: companyId, error: String((e as Error)?.message ?? e).slice(0, 300) }); }
  }
  return n;
}
