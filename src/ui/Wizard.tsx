import { reusedSecretKeys, reuseNotice, webhookReveal } from './setup.ts';
import { useEffect, useMemo, useState } from 'react';
import { usePluginAction } from '@paperclipai/plugin-sdk/ui';
import { Banner, Btn, Chip } from './kit.tsx';
import { call, type AgentMeta, type SecretMeta } from './api.ts';
import { computeSteps, matchSecrets, progress, randomSecret, suggestRoles, type Role, type StepStatus } from './setup.ts';
import { applyGitPath, applyToolProfiles, chipsEnabled, enableChips, ensureSecret, gitPathApplied, toolAccessApplied } from './setupApi.ts';

type Cfg = Record<string, any>;
interface Props { companyId: string; cfg: Cfg; setCfg: (patch: Cfg) => void; getCfg: () => Cfg; save: (c: Cfg) => Promise<void>; secrets: SecretMeta[]; reloadSecrets: () => Promise<SecretMeta[]>; agents: AgentMeta[]; overview: any; refresh: () => void }

/** Bridge errors arrive as plain objects; say what is wrong in words a person can act on. */
export function friendly(e: unknown): string {
  const m = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : typeof e === 'string' ? e : 'That did not work.';
  if (/Entra token request failed \(HTTP 4\d\d\)/.test(m)) return 'Microsoft Entra rejected the bot credentials. Check the client id, client secret and tenant, then try again.';
  if (/rejected the credential|ado_auth/.test(m)) return 'Azure DevOps rejected a bot. Check that it was added to the organization with Basic access.';
  if (/not_found_or_forbidden/.test(m)) return 'Azure DevOps does not show this to the bot (missing or no access).';
  return m;
}

const ICON: Record<StepStatus, string> = { done: '✓', warn: '!', todo: '○', optional: '•' };
const TONE: Record<StepStatus, string> = { done: 'success', warn: 'danger', todo: '', optional: '' };
const ref = (secretId: string) => ({ type: 'secret_ref', secretId });
const ADO = (org: string) => `https://dev.azure.com/${org}`;

export function Wizard({ companyId, cfg, setCfg, getCfg, save, secrets, reloadSecrets, agents, overview, refresh }: Props) {
  const detect = usePluginAction('detect-org');
  const discover = usePluginAction('discover');
  const test = usePluginAction('test-connection');
  const gitStatusAction = usePluginAction('git-access-status');
  const gitTestAction = usePluginAction('git-access-test');
  const [orgInput, setOrgInput] = useState('');
  const [tenantInput, setTenantInput] = useState('');
  const [credMode, setCredMode] = useState<'entra' | 'pat'>('entra');
  const [pats, setPats] = useState({ author: '', reviewer: '' });
  const [shownHook, setShownHook] = useState<{ token?: string; password?: string } | null>(null);
  const [creds, setCreds] = useState({ authorId: '', authorSecret: '', reviewerId: '', reviewerSecret: '' });
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<any>(null);
  const [found, setFound] = useState<Array<{ projectId: string; name: string }>>([]);
  const [toolsApplied, setToolsApplied] = useState<boolean | null>(null);
  const [chipsOn, setChipsOn] = useState<boolean | null>(null);
  const [git, setGit] = useState<any>(null);
  const [gitPath, setGitPath] = useState<boolean | null>(null);
  const [gitTest, setGitTest] = useState<any>(null);

  const roles = cfg.roles ?? {};
  const rolesObj = useMemo<Record<Role, string[]>>(() => ({ author: roles.authorAgentIds ?? [], reviewer: roles.reviewerAgentIds ?? [], operator: roles.operatorAgentIds ?? [] }), [roles.authorAgentIds, roles.reviewerAgentIds, roles.operatorAgentIds]);
  const scope: 'company' | 'roles' = cfg.access?.tools === 'roles' ? 'roles' : 'company';
  const guess = useMemo(() => matchSecrets(secrets), [secrets]);
  const tools = overview?.tools ?? [];
  const orgName: string = cfg.organization?.name ?? '';
  const ids = cfg.identities ?? {};
  const identitiesConfigured = ['author', 'reviewer'].every((r) => { const i = ids[r]; return i && (i.kind === 'pat' ? i.patRef : i.tenantId && i.clientSecretRef && (i.clientIdRef || i.clientId)); });
  const conns: any[] = overview?.identities ?? [];
  const identitiesOk = conns.length === 2 && conns.every((c) => c.lastOkAt && !c.lastErrorCode);
  const permissionReport = useMemo(() => {
    if (!report?.results || report.results.some((r: any) => !r.ok)) return null;
    const missing: string[] = [], excessive: string[] = [];
    for (const r of report.results) for (const p of r.projects ?? []) {
      const pm = p.permissions; if (!pm) continue;
      if (pm.contributeToPullRequests === false) missing.push(`${r.role}: contribute to pull requests`);
      if (pm.bypassPullRequestPolicy) excessive.push(`${r.role}: bypass policies`);
      if (pm.editPolicies || pm.managePermissions) excessive.push(`${r.role}: edit policies or permissions`);
      if (r.role === 'reviewer' && pm.push) excessive.push('reviewer: push');
    }
    return { missing: [...new Set(missing)], excessive: [...new Set(excessive)] };
  }, [report]);

  useEffect(() => { chipsEnabled(call).then(setChipsOn); }, []);
  const loadGit = async () => { if (!overview?.configured || !(cfg.projects ?? []).length) { setGit(null); return; } try { const s = (await gitStatusAction({})) as any; setGit(s); setGitPath(await gitPathApplied(call, companyId, s.binDir)); } catch { setGit(null); } };
  useEffect(() => { void loadGit(); }, [companyId, overview?.configured, (cfg.projects ?? []).length]);
  useEffect(() => { if (overview?.configured) toolAccessApplied(call, companyId, rolesObj, scope).then(setToolsApplied).catch(() => setToolsApplied(null)); else setToolsApplied(false); }, [companyId, rolesObj, overview?.configured, scope]);

  const steps = computeSteps({
    orgName, tenantId: ids.author?.tenantId || (ids.author?.kind === 'pat' || credMode === 'pat' ? 'pat' : ''), identitiesConfigured: !!identitiesConfigured, identitiesOk, identityError: conns.find((c) => c.lastErrorCode)?.lastErrorCode,
    projects: (cfg.projects ?? []).length, authors: rolesObj.author.length, reviewers: rolesObj.reviewer.length, roleOverlap: rolesObj.author.some((a) => rolesObj.reviewer.includes(a)),
    toolsApplied, chipsOn, permissionReport, webhookConfigured: !!(cfg.webhook?.hookTokenRef && cfg.webhook?.basicAuthPasswordRef),
    git: (cfg.projects ?? []).length === 0 ? undefined : git ? { installed: git.installed, missingProjects: git.missingProjects ?? [], pathApplied: gitPath, lastIssuedAt: git.lastIssued?.at ?? null } : null,
  });
  const prog = progress(steps);

  const run = async (name: string, fn: () => Promise<string | void>) => {
    setBusy(name); setMsg(null);
    try { const m = await fn(); if (m) setMsg({ tone: 'ok', text: m }); refresh(); } catch (e) { setMsg({ tone: 'error', text: friendly(e) }); } finally { setBusy(null); }
  };

  const doDetect = async (): Promise<string> => {
    const r = (await detect({ input: orgInput || orgName })) as { org: string; hostForm: string; tenantId: string | null; note?: string };
    const manual = tenantInput.trim();
    const tenant = r.tenantId ?? (/^[0-9a-fA-F-]{36}$/.test(manual) ? manual : null);
    if (!tenant && (credMode === 'pat' || ids.author?.kind === 'pat')) { const c0 = getCfg(); const n0 = { ...c0, organization: { name: r.org, hostForm: r.hostForm } }; setCfg(n0); await save(n0); return `Found ${r.org}. Personal access tokens do not need a tenant.`; }
    if (!tenant) throw new Error(`${r.note ?? 'Could not read the Entra tenant from Azure DevOps.'} Type the Directory (tenant) ID from the Entra portal in the box below and try again.`);
    const c = getCfg();
    const next = { ...c, organization: { name: r.org, hostForm: r.hostForm }, identities: { author: { kind: 'entra', ...(c.identities?.author ?? {}), tenantId: tenant }, reviewer: { kind: 'entra', ...(c.identities?.reviewer ?? {}), tenantId: tenant } } };
    setCfg(next); await save(next);
    return `Found ${r.org} and its Entra tenant.`;
  };
  const useExisting = async (): Promise<string> => {
    const g = guess; if (!g.authorClientId || !g.authorClientSecret || !g.reviewerClientId || !g.reviewerClientSecret) throw new Error('The four credential secrets were not all found.');
    const c = getCfg();
    const next = { ...c, identities: { author: { ...(c.identities?.author ?? {}), kind: 'entra', clientIdRef: ref(g.authorClientId), clientSecretRef: ref(g.authorClientSecret) }, reviewer: { ...(c.identities?.reviewer ?? {}), kind: 'entra', clientIdRef: ref(g.reviewerClientId), clientSecretRef: ref(g.reviewerClientSecret) } } };
    setCfg(next); await save(next);
    return 'Using the secrets you already created.';
  };
  const createCreds = async (): Promise<string> => {
    const need = Object.values(creds).every((v) => v.trim());
    if (!need) throw new Error('Fill in all four fields.');
    const reused = reusedSecretKeys(secrets, ['author-client-id', 'author-client-secret', 'reviewer-client-id', 'reviewer-client-secret'].map((k) => `azure-devops-${k}`)).map((k) => k.replace('azure-devops-', ''));
    const mk = (n: string, k: string, v: string) => ensureSecret(call, companyId, secrets, `azure-devops/${n}`, `azure-devops-${k}`, v.trim(), 'Azure DevOps plugin credential');
    const [aId, aSec, rId, rSec] = [await mk('author-client-id', 'author-client-id', creds.authorId), await mk('author-client-secret', 'author-client-secret', creds.authorSecret), await mk('reviewer-client-id', 'reviewer-client-id', creds.reviewerId), await mk('reviewer-client-secret', 'reviewer-client-secret', creds.reviewerSecret)];
    const c = getCfg();
    const next = { ...c, identities: { author: { ...(c.identities?.author ?? {}), kind: 'entra', clientIdRef: ref(aId), clientSecretRef: ref(aSec) }, reviewer: { ...(c.identities?.reviewer ?? {}), kind: 'entra', clientIdRef: ref(rId), clientSecretRef: ref(rSec) } } };
    setCreds({ authorId: '', authorSecret: '', reviewerId: '', reviewerSecret: '' });
    setCfg(next); await save(next); await reloadSecrets();
    return reused.length ? reuseNotice(reused) : 'Credentials stored as Paperclip secrets and connected.';
  };
  const createPats = async (): Promise<string> => {
    if (!pats.author.trim() || !pats.reviewer.trim()) throw new Error('Paste both tokens.');
    const patReused = reusedSecretKeys(secrets, ['azure-devops-author-pat', 'azure-devops-reviewer-pat']).map((k) => k.replace('azure-devops-', ''));
    const aId = await ensureSecret(call, companyId, secrets, 'azure-devops/author-pat', 'azure-devops-author-pat', pats.author.trim(), 'Azure DevOps plugin author PAT');
    const rId = await ensureSecret(call, companyId, secrets, 'azure-devops/reviewer-pat', 'azure-devops-reviewer-pat', pats.reviewer.trim(), 'Azure DevOps plugin reviewer PAT');
    const c = getCfg();
    const next = { ...c, identities: { author: { ...(c.identities?.author ?? {}), kind: 'pat', patRef: ref(aId) }, reviewer: { ...(c.identities?.reviewer ?? {}), kind: 'pat', patRef: ref(rId) } } };
    setPats({ author: '', reviewer: '' }); setCfg(next); await save(next); await reloadSecrets();
    return patReused.length ? reuseNotice(patReused) : 'Tokens stored as Paperclip secrets and connected.';
  };
  const findProjects = async (): Promise<string> => {
    const r = (await discover({})) as { projects: Array<{ projectId: string; name: string }> };
    setFound(r.projects);
    if (r.projects.length === 1 && !(getCfg().projects ?? []).length) { toggleProject(r.projects[0]!, true); return `One project found (${r.projects[0]!.name}) and selected.`; }
    return `${r.projects.length} project(s) visible to the bots. Tick the ones agents may use.`;
  };
  const toggleProject = (p: { projectId: string; name: string }, on: boolean) => {
    const c = getCfg(); const cur: Cfg[] = c.projects ?? [];
    const projects = on ? [...cur.filter((x) => x.projectId !== p.projectId), { projectId: p.projectId, name: p.name, repositories: [], protectedBranches: ['refs/heads/main'], protectedPipelines: [] }] : cur.filter((x) => x.projectId !== p.projectId);
    const next = { ...c, projects }; setCfg(next); void save(next);
  };
  const suggest = async (): Promise<string> => {
    const s = suggestRoles(agents);
    const c = getCfg(); const next = { ...c, roles: { authorAgentIds: s.author, reviewerAgentIds: s.reviewer, operatorAgentIds: s.operator } };
    setCfg(next); await save(next);
    return `Suggested ${s.author.length} authors, ${s.reviewer.length} reviewers, ${s.operator.length} operators. Adjust them on the Agents and access tab.`;
  };
  const applyTools = async (): Promise<string> => {
    const r = await applyToolProfiles(call, companyId, rolesObj, tools, scope);
    setToolsApplied(await toolAccessApplied(call, companyId, rolesObj, scope));
    return scope === 'company' ? 'Every agent, including future ones, can now use the Azure DevOps tools. The plugin still enforces author, reviewer and operator roles.' : `Tool access set: ${r.created.length} profile(s) created, ${r.updated.length} updated, ${r.bound} agent(s) bound${r.unbound ? `, ${r.unbound} unbound` : ''}.`;
  };
  const checkPerms = async (): Promise<string> => { const r = await test({}); setReport(r); return 'Permissions checked.'; };
  const turnOnChips = async (): Promise<string> => { await enableChips(call); setChipsOn(await chipsEnabled(call)); return 'Live link chips are on.'; };
  const applyGit = async (): Promise<string> => {
    if (!git?.installed) throw new Error('Install the host wrapper first (the command is shown below), then check again.');
    const r = await applyGitPath(call, companyId, git.binDir, git.serverPath);
    setGitPath(await gitPathApplied(call, companyId, git.binDir));
    return r.changed ? `Git wrapper put first on the PATH of the ${r.environment} environment: every run of every agent and project, including future ones, uses it.` : 'Already applied to the default environment.';
  };
  const testGit = async (): Promise<string> => { setGitTest(await gitTestAction({})); return 'Git test finished.'; };
  const prepareWebhook = async (): Promise<string> => {
    const fresh = await reloadSecrets();
    const tVal = randomSecret(), pVal = randomSecret();
    const plan = webhookReveal(fresh, tVal, pVal);
    const tId = await ensureSecret(call, companyId, fresh, 'azure-devops/webhook-token', 'azure-devops-webhook-token', tVal, 'Azure DevOps plugin webhook token (random)');
    const pId = await ensureSecret(call, companyId, fresh, 'azure-devops/webhook-password', 'azure-devops-webhook-password', pVal, 'Azure DevOps plugin webhook password (random)');
    if (plan.reveal) setShownHook(plan.reveal);
    const c = getCfg(); const next = { ...c, webhook: { ...(c.webhook ?? {}), basicAuthUser: 'paperclip', hookTokenRef: ref(tId), basicAuthPasswordRef: ref(pId), publicBaseUrl: c.webhook?.publicBaseUrl || window.location.origin } };
    setCfg(next); await save(next); await reloadSecrets();
    return plan.message;
  };

  const everything = async (): Promise<string> => {
    const done: string[] = [];
    const attempt = async (label: string, fn: () => Promise<string | void>) => { try { await fn(); done.push(`${label} ✓`); } catch (e) { done.push(`${label}: ${friendly(e)}`); } };
    if (orgInput.trim() || !ids.author?.tenantId) await attempt('Organization', doDetect);
    if (!identitiesConfigured && guess.authorClientId && guess.authorClientSecret && guess.reviewerClientId && guess.reviewerClientSecret) await attempt('Credentials', useExisting);
    if (!(cfg.webhook?.hookTokenRef)) await attempt('Webhook secrets', prepareWebhook);
    if (!rolesObj.author.length && !rolesObj.reviewer.length) await attempt('Roles', suggest);
    if (identitiesConfigured || guess.authorClientId) await attempt('Projects', findProjects);
    await attempt('Tool access', applyTools);
    if (chipsOn === false) await attempt('Chips', turnOnChips);
    await attempt('Permissions', checkPerms);
    return done.join('  ·  ');
  };

  const org = orgName || 'yourorg';
  const row = (key: string) => steps.find((s) => s.key === key)!;
  const StepRow = ({ k, action, label, children }: { k: string; action?: () => Promise<string | void>; label?: string; children?: React.ReactNode }) => {
    const s = row(k);
    return (
      <div style={{ borderTop: '1px solid var(--border)', padding: '8px 0', display: 'grid', gap: 6 }}>
        <div className="row"><span aria-hidden style={{ width: 18, textAlign: 'center', fontWeight: 700 }}><Chip label={ICON[s.status]} t={TONE[s.status]} /></span><strong>{s.title}</strong><span className="muted">{s.detail}</span>{action && s.status !== 'done' ? <Btn disabled={!!busy} onClick={() => run(k, action)}>{busy === k ? 'Working' : label ?? 'Fix it for me'}</Btn> : null}</div>
        {children}
      </div>
    );
  };

  return (
    <fieldset>
      <legend>Setup {prog.done} of {prog.total} ready</legend>
      <div className="row">
        <Btn primary disabled={!!busy} onClick={() => run('all', everything)}>{busy === 'all' ? 'Setting up' : 'Set up everything I can'}</Btn>
        <span className="hint">Detects your organization, uses secrets you already created, suggests roles, gives agents their tools, turns on chips and checks permissions. You only decide the projects and the credentials.</span>
      </div>
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      <StepRow k="org" action={doDetect} label="Detect">
        {row('org').status !== 'done' || orgInput ? (
          <div className="field"><label htmlFor="wiz-org">Organization URL</label><input id="wiz-org" type="text" placeholder="https://dev.azure.com/yourorg" value={orgInput} onChange={(e) => setOrgInput(e.target.value)} /></div>) : null}
        {row('org').status !== 'done' ? (
          <div className="field"><label htmlFor="wiz-tenant">Directory (tenant) ID, only if it cannot be detected</label><input id="wiz-tenant" type="text" placeholder="00000000-0000-0000-0000-000000000000" value={tenantInput} onChange={(e) => setTenantInput(e.target.value)} /></div>) : null}
      </StepRow>

      <StepRow k="identities" action={identitiesConfigured ? checkPerms : guess.authorClientId && guess.authorClientSecret && guess.reviewerClientId && guess.reviewerClientSecret ? useExisting : undefined} label={identitiesConfigured ? 'Test connection' : 'Use my azure-devops/* secrets'}>
        {!identitiesConfigured ? (
          <div className="field"><label htmlFor="wiz-mode">Credential type</label><select id="wiz-mode" value={credMode} onChange={(e) => setCredMode(e.target.value as 'entra' | 'pat')}><option value="entra">Microsoft Entra service principals (recommended)</option><option value="pat">Personal access tokens (no Entra needed)</option></select></div>) : null}
        {!identitiesConfigured && credMode === 'pat' ? (
          <details open><summary>Paste the two personal access tokens</summary>
            <p className="hint">Create one PAT per bot account in Azure DevOps (User settings &gt; Personal access tokens), scoped to this organization, with Code (read, write and status), Pull Request Threads, Work Items (read and write), Build (read and execute) and Project and Team (read). The two must belong to two different accounts. A PAT belongs to a person and expires; plan to rotate it.</p>
            <div className="field"><label htmlFor="wiz-pa">Author PAT</label><input id="wiz-pa" type="password" autoComplete="off" value={pats.author} onChange={(e) => setPats({ ...pats, author: e.target.value })} /></div>
            <div className="field"><label htmlFor="wiz-pr">Reviewer PAT</label><input id="wiz-pr" type="password" autoComplete="off" value={pats.reviewer} onChange={(e) => setPats({ ...pats, reviewer: e.target.value })} /></div>
            <Btn primary disabled={!!busy} onClick={() => run('pats', createPats)}>Store and connect</Btn>
          </details>) : null}
        {!identitiesConfigured && credMode === 'entra' ? (
          <details open><summary>Paste the two service principals</summary>
            <p className="hint">Application (client) id and a client secret for each bot. They are stored as Paperclip secrets named azure-devops/…; the tenant comes from the organization. Both bots need Basic access in the organization.</p>
            <div className="field"><label htmlFor="wiz-a1">Author client id</label><input id="wiz-a1" type="text" value={creds.authorId} onChange={(e) => setCreds({ ...creds, authorId: e.target.value })} /></div>
            <div className="field"><label htmlFor="wiz-a2">Author client secret</label><input id="wiz-a2" type="password" autoComplete="off" value={creds.authorSecret} onChange={(e) => setCreds({ ...creds, authorSecret: e.target.value })} /></div>
            <div className="field"><label htmlFor="wiz-r1">Reviewer client id</label><input id="wiz-r1" type="text" value={creds.reviewerId} onChange={(e) => setCreds({ ...creds, reviewerId: e.target.value })} /></div>
            <div className="field"><label htmlFor="wiz-r2">Reviewer client secret</label><input id="wiz-r2" type="password" autoComplete="off" value={creds.reviewerSecret} onChange={(e) => setCreds({ ...creds, reviewerSecret: e.target.value })} /></div>
            <Btn primary disabled={!!busy} onClick={() => run('creds', createCreds)}>Store and connect</Btn>
          </details>) : null}
      </StepRow>

      <StepRow k="projects" action={findProjects} label="Find projects">
        {found.length > 0 || (cfg.projects ?? []).length > 0 ? (
          <div className="scroll" role="group" aria-label="Projects">
            {(found.length ? found : (cfg.projects ?? []).map((p: Cfg) => ({ projectId: p.projectId, name: p.name }))).map((p: { projectId: string; name: string }) => (
              <div className="opt" key={p.projectId}><input type="checkbox" id={`wp-${p.projectId}`} checked={(cfg.projects ?? []).some((x: Cfg) => x.projectId === p.projectId)} onChange={(e) => toggleProject(p, e.target.checked)} /><label htmlFor={`wp-${p.projectId}`}>{p.name}</label></div>))}
          </div>) : null}
      </StepRow>

      <StepRow k="roles" action={suggest} label="Suggest roles" />
      <StepRow k="tools" action={applyTools} label="Give agents their tools" />
      <StepRow k="permissions" action={checkPerms} label="Check permissions">
        {permissionReport && (permissionReport.missing.length || permissionReport.excessive.length) ? (
          <div className="hint">
            Fix these in Azure DevOps, then check again:{' '}
            <a href={`${ADO(org)}/${encodeURIComponent((cfg.projects?.[0]?.name) ?? '')}/_settings/repositories`} target="_blank" rel="noreferrer noopener">Repositories, Security tab</a>{' · '}
            <a href={`${ADO(org)}/${encodeURIComponent((cfg.projects?.[0]?.name) ?? '')}/_settings/permissions`} target="_blank" rel="noreferrer noopener">Project permissions and groups</a>
          </div>) : null}
      </StepRow>
      {(cfg.projects ?? []).length > 0 ? (
        <StepRow k="git" action={git?.installed ? (gitPath === false || git.missingProjects?.length ? applyGit : testGit) : loadGit} label={git?.installed ? (gitPath === false ? 'Apply to all runs' : 'Test git access') : 'Check again'}>
          {git && !git.installed ? (
            <div className="field"><span className="hint">Run this once on the Paperclip host. It installs a root-owned git wrapper and credential helper and changes nothing else:</span><div className="mono" role="textbox" aria-readonly="true">{git.installCommand}</div></div>) : null}
          {git?.installed && git.missingProjects?.length ? <div className="field"><span className="hint">Run again to cover all selected projects:</span><div className="mono">{git.installCommand}</div></div> : null}
          {git?.installed ? <div className="row"><Btn disabled={!!busy} onClick={() => run('gitpath', applyGit)}>Apply to all runs</Btn><Btn disabled={!!busy} onClick={() => run('gittest', testGit)}>Test git access</Btn><span className="hint">{git.issuedLast24h} credential(s) issued and {git.deniedLast24h} refused in the last 24 hours</span></div> : null}
          {gitTest ? <div className="hint">Test on {gitTest.repository}: author {gitTest.author?.ok ? 'ok' : gitTest.author?.detail}; reviewer {gitTest.reviewer?.ok ? 'ok' : gitTest.reviewer?.detail}</div> : null}
        </StepRow>) : null}
      <StepRow k="chips" action={turnOnChips} label="Turn on" />
      <StepRow k="webhook" action={prepareWebhook} label="Prepare webhook">
        {overview?.webhook && row('webhook').status === 'done' ? (
          <details open={!!shownHook}><summary>Service hook settings for Azure DevOps</summary>
            <div className="mono">URL {overview.webhook.url}<br />Basic auth user {overview.webhook.basicAuthUser}, password: secret azure-devops/webhook-password<br />Header {overview.webhook.header}: secret azure-devops/webhook-token<br />Events: {overview.webhook.events.join(', ')}<br />Resource details: {overview.webhook.resourceDetailsToSend}</div>
            {shownHook ? <div className="mono" role="alert">Shown once. Copy now.{shownHook.password ? <><br />Password: {shownHook.password}</> : null}{shownHook.token ? <><br />Header value: {shownHook.token}</> : null}</div> : <p className="hint">The values were shown once when created. To rotate them, delete the two azure-devops/webhook-* secrets and prepare again.</p>}
          </details>) : null}
      </StepRow>
    </fieldset>
  );
}
