// External object provider: link chips for ADO pull requests and work items (spec §10). Builds cannot be chips because the host
// drops URL query strings before detection; they are shown in the issue tab instead.
import { AdoError } from './ado/client.ts';
import { prChipStatus, wiChipStatus } from './ado/model.ts';
import { externalIdFor, parseAdoUrl, parseExternalId } from './ado/urls.ts';
import { neutralize } from './sanitize.ts';
import { ScopeError, type Service } from './service.ts';

export const PROVIDER_KEY = 'azure-devops';

interface UrlCandidate { sanitizedCanonicalUrl: string; canonicalIdentityHash: string }
export interface Detection { urlIdentityHash: string; providerKey: string; objectType: string; externalId: string; displayKey: string; iconKey: string; displayTitle: string; confidence: 'exact' }
type Resolve = { ok: true; snapshot: Record<string, unknown> } | { ok: false; liveness: 'auth_required' | 'unreachable'; errorCode: string; errorMessage?: string; retryAfterSeconds?: number };

export async function detect(svc: Service, companyId: string, urls: UrlCandidate[]): Promise<{ detections: Detection[] }> {
  const cfg = await svc.host.config(companyId);
  if (!cfg) return { detections: [] };
  const out: Detection[] = [];
  for (const u of urls) {
    const ref = parseAdoUrl(u.sanitizedCanonicalUrl);
    if (!ref || ref.org.toLowerCase() !== cfg.organization.name.toLowerCase()) continue;
    const project = cfg.projects.find((p) => p.name.toLowerCase() === ref.project.toLowerCase());
    if (!project || (ref.repo && !svc.repoAllowed(project, ref.repo))) continue;
    out.push({
      urlIdentityHash: u.canonicalIdentityHash, providerKey: PROVIDER_KEY, objectType: ref.kind, externalId: externalIdFor(ref),
      displayKey: ref.kind === 'pull_request' ? 'Azure DevOps Pull Request' : 'Azure DevOps Work Item', iconKey: ref.kind === 'pull_request' ? 'git-pull-request' : 'circle-dot',
      displayTitle: ref.kind === 'pull_request' ? `${ref.repo}!${ref.id}` : `#${ref.id}`, confidence: 'exact',
    });
  }
  return { detections: out };
}

const notFound = (title: string): Resolve => ({ ok: true, snapshot: { displayTitle: title, statusKey: 'not_found', statusLabel: 'Not found', statusIconKey: 'archive', statusCategory: 'archived', statusTone: 'muted', isTerminal: true, ttlSeconds: 3600, data: { provider: 'azure-devops', notFound: true } } });

export async function resolve(svc: Service, companyId: string, externalId: string): Promise<Resolve> {
  const ref = parseExternalId(externalId);
  if (!ref) return { ok: false, liveness: 'unreachable', errorCode: 'bad_external_id', retryAfterSeconds: 3600 };
  try {
    const cfg = await svc.cfg(companyId);
    const project = svc.projectOf(cfg, ref.project);
    if (ref.kind === 'pull_request') {
      if (!svc.repoAllowed(project, ref.repo!)) return notFound(`${ref.repo}!${ref.id}`);
      const { snap } = await svc.syncPr(companyId, cfg, project, ref.repo!, ref.id, 'chip');
      const chip = prChipStatus(snap, cfg.review.publishStatus);
      const votes = { approved: snap.reviewers.filter((r) => r.vote >= 5).length, rejected: snap.reviewers.filter((r) => r.vote <= -5).length, waiting: snap.reviewers.filter((r) => r.vote === 0).length };
      const blocking = snap.policies.filter((p) => p.blocking);
      return { ok: true, snapshot: {
        displayKey: 'Azure DevOps Pull Request', iconKey: 'git-pull-request', displayTitle: `${snap.repoName}!${snap.prId}: ${neutralize(snap.title.slice(0, 120))}`, ...chip,
        remoteVersion: `${snap.iterationCount}:${snap.lastMergeSourceCommit.slice(0, 12)}`, ttlSeconds: snap.isDraft ? 3600 : 300,
        data: { provider: 'azure-devops', org: snap.org, project: snap.projectName, repository: snap.repoName, prId: snap.prId, sourceBranch: snap.sourceRef.replace('refs/heads/', ''), targetBranch: snap.targetRef.replace('refs/heads/', ''), iteration: snap.iterationCount, isDraft: snap.isDraft, mergeStatus: snap.mergeStatus, votes, checks: { total: blocking.length, approved: blocking.filter((p) => p.status === 'approved').length, failed: blocking.filter((p) => p.status === 'rejected' || p.status === 'broken').length }, reviewStatus: snap.reviewStatus, headSha: snap.lastMergeSourceCommit },
      } };
    }
    const w = await svc.syncWorkItem(companyId, cfg, project, ref.id);
    return { ok: true, snapshot: { displayKey: 'Azure DevOps Work Item', iconKey: 'circle-dot', displayTitle: `#${w.id}: ${neutralize(w.title.slice(0, 120))}`, ...wiChipStatus(w), remoteVersion: String(w.rev), ttlSeconds: 600, data: { provider: 'azure-devops', org: w.org, project: w.projectName, workItemId: w.id, type: w.type, state: w.state, stateCategory: w.stateCategory } } };
  } catch (e) {
    if (e instanceof ScopeError) return notFound(ref.kind === 'pull_request' ? `${ref.repo}!${ref.id}` : `#${ref.id}`);
    if (e instanceof AdoError) {
      if (e.code === 'not_found_or_forbidden' && e.status === 404) return notFound(ref.kind === 'pull_request' ? `${ref.repo}!${ref.id}` : `#${ref.id}`);
      if (e.code === 'ado_auth' || e.code === 'ado_config') return { ok: false, liveness: 'auth_required', errorCode: 'ado_auth', errorMessage: 'Azure DevOps rejected the configured credentials', retryAfterSeconds: 900 };
      if (e.code === 'not_found_or_forbidden') return { ok: false, liveness: 'auth_required', errorCode: 'ado_forbidden', errorMessage: 'The Azure DevOps identity cannot see this object', retryAfterSeconds: 900 };
      return { ok: false, liveness: 'unreachable', errorCode: e.code, retryAfterSeconds: e.retryAfterSeconds ?? 300 };
    }
    return { ok: false, liveness: 'unreachable', errorCode: 'ado_unavailable', retryAfterSeconds: 300 };
  }
}
