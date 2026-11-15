// Organization detection for the setup wizard: accepts a pasted URL or a bare name and finds the Entra tenant from the
// organization's own (unauthenticated) response header, so nobody has to look the tenant id up by hand.
export interface OrgGuess { org: string; hostForm: 'dev.azure.com' | 'visualstudio.com' }
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;

/** `https://dev.azure.com/acme/`, `https://acme.visualstudio.com`, `dev.azure.com/acme/proj/_git/x` or `acme`. */
export function parseOrgInput(input: string): OrgGuess | null {
  const raw = input.trim();
  if (!raw) return null;
  if (NAME.test(raw)) return { org: raw, hostForm: 'dev.azure.com' };
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'dev.azure.com') {
    const org = u.pathname.split('/').filter(Boolean)[0];
    return org && NAME.test(org) ? { org, hostForm: 'dev.azure.com' } : null;
  }
  const m = /^([a-z0-9][a-z0-9-]{0,49})\.visualstudio\.com$/.exec(host);
  return m ? { org: m[1]!, hostForm: 'visualstudio.com' } : null;
}

export interface OrgDetection { org: string; hostForm: OrgGuess['hostForm']; tenantId: string | null; reachable: boolean; note?: string }

export async function detectOrg(fetchFn: (url: string, init?: RequestInit) => Promise<Response>, guess: OrgGuess): Promise<OrgDetection> {
  const base = guess.hostForm === 'visualstudio.com' ? `https://${guess.org}.visualstudio.com` : `https://dev.azure.com/${guess.org}`;
  try {
    const res = await fetchFn(`${base}/_apis/connectionData?api-version=7.1-preview.1`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' });
    const tenant = res.headers.get('x-vss-resourcetenant');
    const ok = tenant && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant) ? tenant.toLowerCase() : null;
    if (!ok && res.status === 404) return { ...guess, tenantId: null, reachable: true, note: 'Azure DevOps does not know this organization' };
    return { ...guess, tenantId: ok, reachable: true, note: ok ? undefined : 'The tenant could not be read from the organization; enter it by hand' };
  } catch {
    return { ...guess, tenantId: null, reachable: false, note: 'Azure DevOps could not be reached' };
  }
}
