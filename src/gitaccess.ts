// Git access status for the setup wizard: is the host wrapper installed, which projects does it cover, has it been used.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Db } from './host.ts';
import { NS } from './namespace.ts';

export const ADO_ROOT = (): string => process.env.PAPERCLIP_ADO_ROOT || '/opt/paperclip-ado';

export interface GitAccessStatus {
  installed: boolean; installedAt: string | null; binDir: string; coveredProjects: string[]; missingProjects: string[];
  installCommand: string; lastIssued: { at: string; role: string } | null; issuedLast24h: number; deniedLast24h: number;
}

export function readInstall(root = ADO_ROOT(), requireRoot = true): { installed: boolean; installedAt: string | null; covered: string[] } {
  const wrapper = join(root, 'bin/git'); const helper = join(root, 'bin/git-credential-paperclip-ado');
  if (!existsSync(wrapper) || !existsSync(helper)) return { installed: false, installedAt: null, covered: [] };
  let st; try { st = statSync(wrapper); } catch { return { installed: false, installedAt: null, covered: [] }; }
  // A copy another user could rewrite would be a credential interception point: only root-owned, not group/world writable counts as installed.
  if ((requireRoot && st.uid !== 0) || (st.mode & 0o022) !== 0) return { installed: false, installedAt: null, covered: [] };
  let covered: string[] = [];
  try { covered = readFileSync(join(root, 'etc/git-access.conf'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); } catch { /* none */ }
  let installedAt: string | null = null; try { installedAt = readFileSync(join(root, 'etc/installed-at'), 'utf8').trim() || null; } catch { /* none */ }
  return { installed: true, installedAt, covered };
}

export async function gitAccessStatus(db: Db, companyId: string, cfg: Config, scriptPath: string, root = ADO_ROOT(), requireRoot = true): Promise<GitAccessStatus & { serverPath: string }> {
  const inst = readInstall(root, requireRoot);
  const want = cfg.projects.map((p) => `${cfg.organization.name}/${p.name}`);
  const have = new Set(inst.covered.map((x) => x.toLowerCase()));
  const since = new Date(Date.now() - 86400_000).toISOString();
  const rows = await db.query<{ outcome: string; n: string; last: Date | null }>(`SELECT CASE WHEN outcome='issued' THEN 'issued' ELSE 'denied' END AS outcome, count(*)::text n, max(at) AS last FROM ${NS}.audit WHERE company_id=$1 AND action='git_credential' AND at>$2 GROUP BY 1`, [companyId, since]).catch(() => []);
  const issued = rows.find((r) => r.outcome === 'issued'); const denied = rows.find((r) => r.outcome === 'denied');
  const lastRow = (await db.query<{ at: Date; detail: { role?: string } }>(`SELECT at, detail FROM ${NS}.audit WHERE company_id=$1 AND action='git_credential' AND outcome='issued' ORDER BY at DESC LIMIT 1`, [companyId]).catch(() => []))[0];
  return {
    installed: inst.installed, installedAt: inst.installedAt, binDir: join(root, 'bin'), coveredProjects: inst.covered, missingProjects: want.filter((w) => !have.has(w.toLowerCase())),
    installCommand: `sudo ${scriptPath} --org ${cfg.organization.name} --projects ${cfg.projects.map((p) => (/[ ,]/.test(p.name) ? JSON.stringify(p.name) : p.name)).join(',')}`,
    serverPath: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    lastIssued: lastRow ? { at: new Date(lastRow.at).toISOString(), role: lastRow.detail?.role ?? '' } : null, issuedLast24h: Number(issued?.n ?? 0), deniedLast24h: Number(denied?.n ?? 0),
  };
}
