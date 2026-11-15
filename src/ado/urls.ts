// Azure DevOps web URL forms (spec §5, §10). Names in the path are URL-decoded and compared case-insensitively.
export type AdoObjectKind = 'pull_request' | 'work_item';
export interface AdoUrlRef {
  kind: AdoObjectKind;
  org: string;
  project: string;
  repo?: string;
  id: number;
  hostForm: 'dev.azure.com' | 'visualstudio.com';
}
const ID = /^[1-9][0-9]{0,9}$/;
const NAME = /^[^/\\?#]{1,256}$/;

function dec(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** Parse a canonical (query-stripped) URL. Returns null for anything that is not a PR or work item page. */
export function parseAdoUrl(raw: string): AdoUrlRef | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  let org: string;
  let hostForm: AdoUrlRef['hostForm'];
  let parts = u.pathname.split('/').filter(Boolean).map(dec);
  if (parts.some((p) => p === null)) return null;
  let segs = parts as string[];
  if (host === 'dev.azure.com') {
    if (segs.length < 1) return null;
    org = segs[0]!; segs = segs.slice(1); hostForm = 'dev.azure.com';
  } else if (host.endsWith('.visualstudio.com') && host.split('.').length === 3) {
    org = host.split('.')[0]!; hostForm = 'visualstudio.com';
    if (segs[0]?.toLowerCase() === 'defaultcollection') segs = segs.slice(1);
  } else return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(org)) return null;
  // <project>/_git/<repo>/pullrequest/<id>   or   <project>/_workitems/edit/<id>
  if (segs.length === 5 && segs[1]!.toLowerCase() === '_git' && segs[3]!.toLowerCase() === 'pullrequest') {
    const [project, , repo, , id] = segs as [string, string, string, string, string];
    if (!NAME.test(project) || !NAME.test(repo) || !ID.test(id)) return null;
    return { kind: 'pull_request', org, project, repo, id: Number(id), hostForm };
  }
  if (segs.length === 4 && segs[1]!.toLowerCase() === '_workitems' && segs[2]!.toLowerCase() === 'edit') {
    const [project, , , id] = segs as [string, string, string, string];
    if (!NAME.test(project) || !ID.test(id)) return null;
    return { kind: 'work_item', org, project, id: Number(id), hostForm };
  }
  return null;
}

export const externalIdFor = (r: AdoUrlRef): string =>
  r.kind === 'pull_request'
    ? `pr:${r.org.toLowerCase()}/${r.project.toLowerCase()}/${r.repo!.toLowerCase()}/${r.id}`
    : `wi:${r.org.toLowerCase()}/${r.project.toLowerCase()}/${r.id}`;

export function parseExternalId(externalId: string): AdoUrlRef | null {
  const m = /^(pr|wi):([^/]+)\/([^/]+)\/(?:([^/]+)\/)?([1-9][0-9]*)$/.exec(externalId);
  if (!m) return null;
  if (m[1] === 'pr') return m[4] ? { kind: 'pull_request', org: m[2]!, project: m[3]!, repo: m[4], id: Number(m[5]), hostForm: 'dev.azure.com' } : null;
  return m[4] ? null : { kind: 'work_item', org: m[2]!, project: m[3]!, id: Number(m[5]), hostForm: 'dev.azure.com' };
}

/** Tools accept URLs from agents. Only these hosts may ever be called; everything else is refused before any request is made. */
export function isAllowedAdoHost(host: string, org: string): boolean {
  const h = host.toLowerCase();
  return h === 'dev.azure.com' || h === `${org.toLowerCase()}.visualstudio.com` || h === 'vssps.dev.azure.com' ||
    h === 'app.vssps.visualstudio.com' || h === 'login.microsoftonline.com';
}
