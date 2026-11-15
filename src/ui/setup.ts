// Pure helpers behind the setup wizard: guess secrets and roles, decide which tools each role may use, compute the checklist.
export interface SecretLite { id: string; key: string; name: string }
export interface AgentLite { id: string; name: string; role: string }
export interface ToolLite { name: string; cls: 'R' | 'W' | 'G'; role: string }
export type Role = 'author' | 'reviewer' | 'operator';

export interface SecretGuess { authorClientId?: string; authorClientSecret?: string; reviewerClientId?: string; reviewerClientSecret?: string; authorPat?: string; reviewerPat?: string; webhookToken?: string; webhookPassword?: string }

const label = (s: SecretLite) => `${s.name} ${s.key}`.toLowerCase().replace(/[_/ .]+/g, '-');
/** Find the secrets a person already created by the obvious names (azure-devops/author-client-id, ...). Ambiguous matches are left out. */
export function matchSecrets(secrets: SecretLite[]): SecretGuess {
  const pick = (re: RegExp, not?: RegExp): string | undefined => {
    const hits = secrets.filter((s) => { const l = label(s); return re.test(l) && (!not || !not.test(l)); });
    return hits.length === 1 ? hits[0]!.id : undefined;
  };
  const dev = /(azure-?devops|ado)/;
  return {
    authorClientId: pick(/author.*client-?id/, /secret/) ?? pick(/author.*(app|application)-?id/),
    authorClientSecret: pick(/author.*client-?secret/),
    reviewerClientId: pick(/reviewer.*client-?id/, /secret/) ?? pick(/reviewer.*(app|application)-?id/),
    reviewerClientSecret: pick(/reviewer.*client-?secret/),
    authorPat: pick(new RegExp(`${dev.source}.*author.*pat|author.*${dev.source}.*pat`)),
    reviewerPat: pick(new RegExp(`${dev.source}.*reviewer.*pat|reviewer.*${dev.source}.*pat`)),
    webhookToken: pick(/webhook.*token/),
    webhookPassword: pick(/webhook.*(password|pass)/),
  };
}

export interface RoleSuggestion { author: string[]; reviewer: string[]; operator: string[] }
/** Engineers and platform people author, QA and security review, leads review and operate. Nobody is both author and reviewer. */
export function suggestRoles(agents: AgentLite[]): RoleSuggestion {
  const out: RoleSuggestion = { author: [], reviewer: [], operator: [] };
  for (const a of agents) {
    const n = a.name.toLowerCase(); const r = a.role.toLowerCase();
    const lead = /(tech.?lead|\bcto\b|head|architect|principal|staff)/.test(n);
    if (lead) { out.reviewer.push(a.id); out.operator.push(a.id); continue; }
    if (/(qa|security|review|tester|quality)/.test(r + ' ' + n)) { out.reviewer.push(a.id); continue; }
    if (/(devops|platform|sre|infra)/.test(r + ' ' + n)) { out.author.push(a.id); out.operator.push(a.id); continue; }
    if (/(engineer|dev)/.test(r + ' ' + n)) out.author.push(a.id);
  }
  return out;
}

export const PLUGIN_KEY = 'mzaferyahsi.azure-devops';
export const fullToolName = (name: string): string => `${PLUGIN_KEY}:${name}`;
export const ALL_PROFILE_KEY = 'azure-devops-all';
export const ALL_PROFILE_NAME = 'Azure DevOps - all tools (roles enforced by the plugin)';
export const PROFILE_KEYS: Record<Role, string> = { author: 'azure-devops-author', reviewer: 'azure-devops-reviewer', operator: 'azure-devops-operator' };
export const PROFILE_NAMES: Record<Role, string> = { author: 'Azure DevOps - author tools', reviewer: 'Azure DevOps - reviewer tools', operator: 'Azure DevOps - operator tools' };

/** The tools a role may call: every read tool, plus the tools whose declared role matches. Deploy-approval tools have their own role, configured separately. */
export function toolsForRole(tools: ToolLite[], role: Role): string[] {
  const roleOk = (t: ToolLite): boolean => t.role === 'any' || (role === 'author' && (t.role === 'author' || t.role === 'author_or_reviewer' || t.role === 'author_or_operator')) || (role === 'reviewer' && (t.role === 'reviewer' || t.role === 'author_or_reviewer')) || (role === 'operator' && (t.role === 'operator' || t.role === 'author_or_operator' || t.role === 'proposer' || t.role === 'approver' || t.role === 'gate'));
  return tools.filter((t) => t.role !== 'deploy_approver' && (t.cls === 'R' || roleOk(t))).map((t) => fullToolName(t.name));
}

export type StepStatus = 'done' | 'todo' | 'warn' | 'optional';
export interface Step { key: string; title: string; status: StepStatus; detail: string }
export interface StepInput {
  orgName: string; tenantId: string; identitiesConfigured: boolean; identitiesOk: boolean; identityError?: string | null;
  projects: number; authors: number; reviewers: number; roleOverlap: boolean;
  toolsApplied: boolean | null; chipsOn: boolean | null;
  permissionReport: null | { missing: string[]; excessive: string[] };
  webhookConfigured: boolean;
  git?: { installed: boolean; missingProjects: string[]; pathApplied: boolean | null; lastIssuedAt: string | null } | null;
}
export function computeSteps(i: StepInput): Step[] {
  const s: Step[] = [];
  s.push(i.orgName && i.tenantId ? { key: 'org', title: 'Organization', status: 'done', detail: i.tenantId === 'pat' ? `${i.orgName}, personal access tokens` : `${i.orgName}, tenant detected` } : { key: 'org', title: 'Organization', status: 'todo', detail: 'Paste your Azure DevOps organization URL' });
  s.push(!i.identitiesConfigured ? { key: 'identities', title: 'Bot identities', status: 'todo', detail: 'Connect the author and reviewer bots' }
    : i.identitiesOk ? { key: 'identities', title: 'Bot identities', status: 'done', detail: 'Both bots signed in' }
      : { key: 'identities', title: 'Bot identities', status: 'warn', detail: i.identityError ? `A bot was rejected (${i.identityError})` : 'Not tested yet' });
  s.push(i.projects > 0 ? { key: 'projects', title: 'Projects', status: 'done', detail: `${i.projects} selected` } : { key: 'projects', title: 'Projects', status: 'todo', detail: 'Choose the projects agents may use' });
  s.push(i.roleOverlap ? { key: 'roles', title: 'Agent roles', status: 'warn', detail: 'An agent cannot be both author and reviewer' } : i.authors > 0 && i.reviewers > 0 ? { key: 'roles', title: 'Agent roles', status: 'done', detail: `${i.authors} authors, ${i.reviewers} reviewers` } : { key: 'roles', title: 'Agent roles', status: 'todo', detail: 'Pick at least one author and one reviewer' });
  s.push(i.toolsApplied === null ? { key: 'tools', title: 'Tool access', status: 'todo', detail: 'Checking' } : i.toolsApplied ? { key: 'tools', title: 'Tool access', status: 'done', detail: 'Agents can see the tools for their roles' } : { key: 'tools', title: 'Tool access', status: 'todo', detail: i.authors + i.reviewers === 0 ? 'Choose agent roles first' : 'Agents cannot see the tools yet' });
  const p = i.permissionReport;
  s.push(!p ? { key: 'permissions', title: 'Azure DevOps permissions', status: 'todo', detail: i.identitiesOk ? 'Run the check' : 'Needs both bots connected first' } : p.missing.length || p.excessive.length ? { key: 'permissions', title: 'Azure DevOps permissions', status: 'warn', detail: [...p.missing.map((m) => `missing: ${m}`), ...p.excessive.map((m) => `too much: ${m}`)].join('; ') } : { key: 'permissions', title: 'Azure DevOps permissions', status: 'done', detail: 'As expected' });
  s.push(i.chipsOn === null ? { key: 'chips', title: 'Live link chips', status: 'optional', detail: 'Could not read the setting' } : i.chipsOn ? { key: 'chips', title: 'Live link chips', status: 'done', detail: 'External objects is on' } : { key: 'chips', title: 'Live link chips', status: 'todo', detail: 'Turn on External objects in Experimental settings' });
  if (i.git !== undefined) {
    const g = i.git;
    s.push(!g ? { key: 'git', title: 'Git without SSH keys', status: 'todo', detail: 'Checking' }
      : !g.installed ? { key: 'git', title: 'Git without SSH keys', status: 'todo', detail: 'Install the host wrapper once (one command, shown below)' }
        : g.missingProjects.length ? { key: 'git', title: 'Git without SSH keys', status: 'warn', detail: `Wrapper does not cover: ${g.missingProjects.join(', ')}. Run the install command again` }
          : g.pathApplied === false ? { key: 'git', title: 'Git without SSH keys', status: 'todo', detail: 'Apply the wrapper to all runs (one setting in the default environment)' }
            : { key: 'git', title: 'Git without SSH keys', status: 'done', detail: g.lastIssuedAt ? `In use, last credential ${g.lastIssuedAt.slice(0, 16).replace('T', ' ')} UTC` : 'Ready; no agent has used it yet' });
  }
  s.push(i.webhookConfigured ? { key: 'webhook', title: 'Instant updates (webhook)', status: 'done', detail: 'Secrets ready; add the service hooks in Azure DevOps' } : { key: 'webhook', title: 'Instant updates (webhook)', status: 'optional', detail: 'Optional: without it updates arrive within minutes' });
  return s;
}
export const progress = (steps: Step[]): { done: number; total: number } => { const req = steps.filter((x) => x.status !== 'optional'); return { done: req.filter((x) => x.status === 'done').length, total: req.length }; };

/** Random secret value for webhook credentials: 32 bytes, hex, from the browser CSPRNG. */
export function randomSecret(bytes = 32): string {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Which of the wanted secret keys already exist (they are kept with their old values, so the board must be told). */
export function reusedSecretKeys(existing: SecretLite[], wanted: string[]): string[] {
  return wanted.filter((k) => existing.some((x) => x.key === k));
}
export const reuseNotice = (names: string[]): string => `Connected. These secrets already existed and were kept with their OLD values (change them under Secrets if they are wrong): ${names.join(', ')}.`;

/** Webhook secrets are random and shown once. Only newly created ones can be shown; existing ones cannot be read back. */
export function webhookReveal(existing: SecretLite[], token: string, password: string): { newToken: boolean; newPassword: boolean; reveal: { token?: string; password?: string } | null; message: string } {
  const newToken = !existing.some((x) => x.key === 'azure-devops-webhook-token');
  const newPassword = !existing.some((x) => x.key === 'azure-devops-webhook-password');
  const reveal = newToken || newPassword ? { ...(newToken ? { token } : {}), ...(newPassword ? { password } : {}) } : null;
  const message = reveal ? 'Webhook secrets created. Copy the values shown below now: they are shown once. Then add the service hooks in Azure DevOps.' : 'Webhook secrets already existed and were kept; their values are not shown again.';
  return { newToken, newPassword, reveal, message };
}
