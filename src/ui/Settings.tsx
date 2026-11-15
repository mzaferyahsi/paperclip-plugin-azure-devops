import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ErrorBoundary, usePluginAction, usePluginData } from '@paperclipai/plugin-sdk/ui';
import type { PluginCompanySettingsPageProps } from '@paperclipai/plugin-sdk/ui';
import { Banner, Btn, Chip, Styles, ago } from './kit.tsx';
import { Wizard, friendly } from './Wizard.tsx';
import { getConfig, listAgents, listSecrets, saveConfig, errText, type AgentMeta, type SecretMeta } from './api.ts';
import { dutyOn, dutyWarnings, setDuty, type Duty } from './matrix.ts';

type Cfg = Record<string, any>;
const ref = (secretId: string) => (secretId ? { type: 'secret_ref', secretId } : undefined);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function Card({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  return <section className="card"><header><h3>{title}</h3>{help ? <p className="hint">{help}</p> : null}</header>{children}</section>;
}

function Check({ id, checked, onChange, children, hint, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: string; disabled?: boolean }) {
  return (
    <div className="opt"><input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{children}{hint ? <span className="hint" style={{ display: 'block', fontWeight: 400 }}>{hint}</span> : null}</label></div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return <div className="seg" role="group" aria-label={label}>{options.map((o) => <button type="button" key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

function SecretSelect({ label, value, secrets, onChange, hint }: { label: string; value?: { secretId?: string }; secrets: SecretMeta[]; onChange: (id: string) => void; hint?: string }) {
  const id = `s-${label.replace(/\W+/g, '-')}`;
  return (
    <div className="field"><label htmlFor={id}>{label}</label>
      <select id={id} value={value?.secretId ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">Not set</option>{secrets.map((s) => <option key={s.id} value={s.id}>{s.name || s.key}</option>)}</select>
      {hint ? <span className="hint">{hint}</span> : null}</div>
  );
}


/** Staging release bundle (0.17.0): one human approval for the build (140) and deploy (138) pair. Off by default; every value is validated by the plugin when saved. */
function ReleaseBundleCard({ cfg, set }: { cfg: Cfg; set: (patch: Cfg) => void }) {
  const pa: Cfg = cfg.platformAdmin ?? {};
  const da: Cfg = pa.deployApproval ?? {};
  const rb: Cfg = da.releaseBundle ?? {};
  const save = (p: Cfg) => set({ platformAdmin: { ...pa, deployApproval: { ...da, releaseBundle: { ...rb, ...p } } } });
  const list = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : '');
  const split = (t: string): string[] => t.split(',').map((x) => x.trim()).filter(Boolean);
  const int = (t: string): number | undefined => (/^[0-9]{1,6}$/.test(t.trim()) ? Number(t) : undefined);
  const NUM: Array<[string, string, string]> = [['buildPipelineId', 'Build pipeline id (140)', 'Must be in the deploy approval build pipeline ids.'], ['deployPipelineId', 'Deploy pipeline id (138)', 'Must be in the deploy approval deploy pipeline ids.'], ['ttlMinutes', 'Window after approval, minutes (1 to 120)', 'Above 120 is refused.'], ['proposalTtlMinutes', 'Time to decide the card, minutes (1 to 60)', ''], ['maxBuildAttempts', 'Builds per approval (1 to 2)', ''], ['maxCommitsBehind', 'Commits behind main allowed (0 to 20)', ''], ['maxProposalsPerAgentPerDay', 'Proposals per agent per day (1 to 20)', '']];
  return (
    <Card title="Staging release bundle" help="One person approves a card; the plugin then builds pipeline 140 on main at the pinned commit and deploys pipeline 138 with the digest it published. Staging only, never production. The environment approval and the three attestations still apply. Off by default.">
      <Check id="rbon" checked={rb.enabled === true} onChange={(v) => save({ enabled: v })} hint="Turning this off stops open bundles at their next step; a deploy run still waiting at the environment approval is cancelled.">Allow staging release bundles</Check>
      {rb.enabled === true && (!pa.enabled || !da.enabled || !cfg.identities?.admin) ? <Banner tone="warn">Needs platform administration, deploy approval and the admin identity (identities.admin) to be on.</Banner> : null}
      <div className="field"><label htmlFor="rbproj">Project id (one of the selected projects)</label>
        <input id="rbproj" type="text" value={rb.projectId ?? ''} onChange={(e) => save({ projectId: e.target.value.trim() })} /></div>
      {NUM.map(([k, label, hint]) => (
        <div className="field" key={k}><label htmlFor={`rb${k}`}>{label}</label>
          <input id={`rb${k}`} type="text" inputMode="numeric" value={rb[k] ?? ''} onChange={(e) => { const n = int(e.target.value); const next = { ...rb }; if (n === undefined) delete next[k]; else next[k] = n; save(next); }} />
          {hint ? <span className="hint">{hint}</span> : null}</div>))}
      <div className="field"><label htmlFor="rbprop">Proposer agent ids (1 to 5, comma separated)</label>
        <input id="rbprop" type="text" value={list(rb.proposerAgentIds)} onChange={(e) => save({ proposerAgentIds: split(e.target.value) })} />
        <span className="hint">Author-role agents only. A reviewer, an attestation agent or the deploy approver cannot propose.</span></div>
      <div className="field"><label htmlFor="rbappr">Approver user ids (required, comma separated)</label>
        <input id="rbappr" type="text" value={list(rb.approverUserIds)} onChange={(e) => save({ approverUserIds: split(e.target.value) })} />
        <span className="hint">Only these people can accept the card. The host does not tell the plugin who has the board role.</span></div>
    </Card>
  );
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
/** Allowlist of Library variable groups agents may ask to create or change, and the Paperclip secret behind each secret variable. */
function VariableGroupsCard({ cfg, secrets, set }: { cfg: Cfg; secrets: SecretMeta[]; set: (patch: Cfg) => void }) {
  const pa: Cfg = cfg.platformAdmin ?? {};
  const groups: Array<{ name: string; secrets?: Record<string, any> }> = Array.isArray(pa.variableGroups) ? pa.variableGroups : [];
  const hasAdmin = !!cfg.identities?.admin;
  const save = (next: typeof groups) => set({ platformAdmin: { ...pa, variableGroups: next } });
  const patch = (i: number, g: Partial<(typeof groups)[number]>) => save(groups.map((x, j) => (j === i ? { ...x, ...g } : x)));
  const bad = groups.some((g, i) => !GROUP_NAME.test(g.name) || groups.findIndex((x) => x.name.toLowerCase() === g.name.toLowerCase()) !== i);
  return (
    <Card title="Library variable groups" help="Agents may ask to create or change only the groups listed here, and a person approves every change. Plain values are shown on the approval card. A secret variable is bound to a Paperclip secret here, so agents never see or choose a secret value. Nothing is ever deleted.">
      <Check id="vgon" checked={pa.enabled === true} onChange={(v) => set({ platformAdmin: { ...pa, enabled: v } })} hint="This is the shared platform administration switch. It also covers the environment and Secure File tools.">Allow platform administration</Check>
      {pa.enabled === true && !hasAdmin ? <Banner tone="warn">The admin identity is not set (identities.admin), so nothing here can run. It needs the Library Administrator role on the listed groups.</Banner> : null}
      {groups.length === 0 ? <p className="hint">No groups listed: agents cannot touch any variable group.</p> : null}
      {groups.map((g, i) => {
        const sec = Object.entries(g.secrets ?? {});
        const nameBad = !GROUP_NAME.test(g.name) || groups.findIndex((x) => x.name.toLowerCase() === g.name.toLowerCase()) !== i;
        return (
          <div key={i} className="field" style={{ borderTop: '1px solid var(--line, #8884)', paddingTop: 8 }}>
            <label htmlFor={`vgn${i}`}>Group name (exact, as in Library)</label>
            <input id={`vgn${i}`} type="text" value={g.name} aria-invalid={nameBad} onChange={(e) => patch(i, { name: e.target.value })} />
            {nameBad ? <span className="hint">Use letters, digits, space, dot, dash or underscore, up to 100 characters, and list each group once.</span> : null}
            {sec.map(([vn, r], k) => (
              <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className="field"><label htmlFor={`vgv${i}-${k}`}>Secret variable name</label>
                  <input id={`vgv${i}-${k}`} type="text" value={vn} aria-invalid={!VAR_NAME.test(vn)} onChange={(e) => patch(i, { secrets: Object.fromEntries(sec.map(([a, b], m) => [m === k ? e.target.value : a, b])) })} /></div>
                <SecretSelect label={`Paperclip secret for ${vn || 'this variable'}`} value={r} secrets={secrets} onChange={(id) => patch(i, { secrets: Object.fromEntries(sec.map(([a, b], m) => [a, m === k ? ref(id) ?? { type: 'secret_ref', secretId: '' } : b])) })} />
                <Btn onClick={() => patch(i, { secrets: Object.fromEntries(sec.filter((_, m) => m !== k)) })}>Remove variable</Btn>
              </div>))}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <Btn onClick={() => { let n = 'NEW_SECRET'; let c = 1; while (n in (g.secrets ?? {})) n = `NEW_SECRET_${++c}`; patch(i, { secrets: { ...(g.secrets ?? {}), [n]: { type: 'secret_ref', secretId: '' } } }); }}>Add secret variable</Btn>
              <Btn onClick={() => save(groups.filter((_, j) => j !== i))}>Remove group</Btn>
            </div>
          </div>);
      })}
      <div style={{ marginTop: 8 }}><Btn onClick={() => save([...groups, { name: '', secrets: {} }])}>Add group</Btn></div>
      {bad ? <Banner tone="warn">A group name is empty, malformed or listed twice. Fix it before saving.</Banner> : null}
    </Card>
  );
}

function IdentityCard({ role, value, secrets, onChange, status }: { role: 'author' | 'reviewer'; value: Cfg; secrets: SecretMeta[]; onChange: (v: Cfg) => void; status?: any }) {
  const v = value ?? { kind: 'entra' };
  const set = (patch: Cfg) => onChange({ ...v, ...patch });
  const chip = status ? <Chip label={status.lastErrorCode ? status.lastErrorCode : status.lastOkAt ? `connected ${ago(status.lastOkAt)}` : 'not tested'} t={status.lastErrorCode ? 'danger' : status.lastOkAt ? 'success' : ''} /> : null;
  return (
    <Card title={`${role === 'author' ? 'Author' : 'Reviewer'} bot`} help={role === 'author' ? 'Opens pull requests, comments and pushes code.' : 'Votes on pull requests and posts the review status. It must be a different account from the author.'}>
      <div className="stat">{chip}{status?.displayName ? <span className="muted">{status.displayName}</span> : null}</div>
      <div className="field"><label htmlFor={`k-${role}`}>Credential type</label>
        <select id={`k-${role}`} value={v.kind ?? 'entra'} onChange={(e) => set({ kind: e.target.value })}><option value="entra">Microsoft Entra service principal</option><option value="pat">Personal access token</option></select></div>
      {v.kind === 'pat'
        ? <SecretSelect label="PAT secret" value={v.patRef} secrets={secrets} onChange={(id) => set({ patRef: ref(id) })} hint="Scope it to this organization only. A PAT belongs to a person and expires, so prefer a service principal." />
        : <>
          <div className="field"><label htmlFor={`t-${role}`}>Tenant id</label><input id={`t-${role}`} type="text" value={v.tenantId ?? ''} onChange={(e) => set({ tenantId: e.target.value.trim() })} /></div>
          <SecretSelect label="Client id secret" value={v.clientIdRef} secrets={secrets} onChange={(id) => set({ clientIdRef: ref(id) })} hint="The secret that holds the application (client) id." />
          <div className="field"><label htmlFor={`c-${role}`}>Or type the client id</label><input id={`c-${role}`} type="text" value={v.clientId ?? ''} onChange={(e) => set({ clientId: e.target.value.trim() })} /></div>
          <SecretSelect label="Client secret" value={v.clientSecretRef} secrets={secrets} onChange={(id) => set({ clientSecretRef: ref(id) })} hint="The bot needs an organization seat with Basic access." />
        </>}
    </Card>
  );
}

function PickList({ label, hint, options, selected, onChange, empty }: { label: string; hint: string; options: Array<{ value: string; label: string }>; selected: string[]; onChange: (vals: string[]) => void; empty: string }) {
  const set = new Set(selected);
  // A value that is saved but no longer offered stays visible, so it can be unticked.
  const extra = selected.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: `${v} (not found)` }));
  const all = [...options, ...extra];
  return (
    <div className="field"><span className="field-label" style={{ fontWeight: 600 }}>{label}</span><span className="hint">{hint}</span>
      <div className="scroll" role="group" aria-label={label}>
        {all.length === 0 ? <p className="muted">{empty}</p> : all.map((o) => (
          <Check key={o.value} id={`${label}-${o.value}`} checked={set.has(o.value)} onChange={(on) => { const n = new Set(set); if (on) n.add(o.value); else n.delete(o.value); onChange([...n]); }}>{o.label}</Check>))}
      </div>
    </div>
  );
}

/** One row per agent, one column per duty. */
function AgentTable({ agents, cfg, columns, onChange, everyoneIsAuthor }: { agents: AgentMeta[]; cfg: Cfg; columns: Array<{ duty: Duty; label: string; hint: string }>; onChange: (c: Cfg) => void; everyoneIsAuthor?: boolean }) {
  const [q, setQ] = useState('');
  const shown = agents.filter((a) => !q.trim() || `${a.name} ${a.role}`.toLowerCase().includes(q.trim().toLowerCase()));
  const names = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.name])), [agents]);
  const warn = dutyWarnings(cfg, names);
  return (
    <div className="field">
      {agents.length > 8 ? <input type="search" aria-label="Find an agent" placeholder="Find an agent" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} /> : null}
      <div className="matrix">
        <table>
          <thead><tr><th scope="col">Agent</th>{columns.map((c) => <th className="c" scope="col" key={c.duty} title={c.hint}>{c.label}</th>)}</tr></thead>
          <tbody>
            {shown.length === 0 ? <tr><td colSpan={columns.length + 1} className="muted">{agents.length ? 'No agent matches.' : 'No agents found.'}</td></tr> : shown.map((a) => (
              <tr key={a.id}>
                <th scope="row" style={{ fontWeight: 500 }}>{a.name || a.id.slice(0, 8)} <span className="muted">{a.role}</span></th>
                {columns.map((c) => {
                  const locked = c.duty === 'author' && everyoneIsAuthor && !dutyOn(cfg, 'reviewer', a.id);
                  return <td className="c" key={c.duty}><input type="checkbox" aria-label={`${a.name || a.id} ${c.label}`} title={locked ? 'Every agent is an author (see the switch above)' : c.hint} checked={dutyOn(cfg, c.duty, a.id)} disabled={locked} onChange={(e) => onChange(setDuty(cfg, c.duty, a.id, e.target.checked))} /></td>;
                })}
              </tr>))}
          </tbody>
        </table>
      </div>
      <p className="hint">{columns.map((c) => `${c.label}: ${c.hint}`).join(' ')}</p>
      {warn.length ? <Banner tone="warn"><ul>{warn.map((w) => <li key={w}>{w}</li>)}</ul></Banner> : null}
    </div>
  );
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'connection', label: 'Connection' },
  { key: 'access', label: 'Agents and access' },
  { key: 'merge', label: 'Merge approval' },
  { key: 'pipelines', label: 'Pipelines' },
  { key: 'integrations', label: 'Webhooks and limits' },
  { key: 'tools', label: 'Tools' },
] as const;
type TabKey = typeof TABS[number]['key'];
const TAB_STORE = 'ado-settings-tab';
const readTab = (): TabKey => { try { const v = window.localStorage.getItem(TAB_STORE); if (TABS.some((t) => t.key === v)) return v as TabKey; } catch { /* storage may be blocked */ } return 'overview'; };

const MODES = [
  { value: 'board', label: 'A person', text: 'A person confirms on the issue. The default.' },
  { value: 'approvers', label: 'Approver agents', text: 'Chosen agents approve after the plugin has checked the QA and Security verdicts, the build policy and the staging gate on the exact commit.' },
  { value: 'both', label: 'Agent, then a person', text: 'An approver agent first, then a person confirms.' },
] as const;

function SettingsInner({ companyId }: { companyId: string }) {
  const overview = usePluginData<any>('overview', { companyId });
  const test = usePluginAction('test-connection');
  const discover = usePluginAction('discover');
  const discoverRepos = usePluginAction('discover-repos');
  const discoverQueues = usePluginAction('discover-queues');
  const syncNow = usePluginAction('sync-now');
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [saved, setSaved] = useState('');
  const cfgRef = useRef<Cfg | null>(null);
  cfgRef.current = cfg;
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [report, setReport] = useState<any>(null);
  const [found, setFound] = useState<Array<{ projectId: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTabState] = useState<TabKey>(readTab);
  const setTab = (t: TabKey) => { setTabState(t); try { window.localStorage.setItem(TAB_STORE, t); } catch { /* ignore */ } };

  useEffect(() => {
    let live = true;
    Promise.all([getConfig(companyId), listSecrets(companyId).catch(() => []), listAgents(companyId).catch(() => [])])
      .then(([c, s, a]) => { if (live) { setCfg(c); setSaved(JSON.stringify(c)); setSecrets(s); setAgents(a); } })
      .catch((e) => live && setMsg({ tone: 'error', text: errText(e) }));
    return () => { live = false; };
  }, [companyId]);

  const dirty = cfg !== null && JSON.stringify(cfg) !== saved;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Pick-box lists: agent queues and repository names of the chosen projects, loaded once the projects are known.
  const [queues, setQueues] = useState<Array<{ id: number; name: string; pool: string; hosted: boolean; project: string }> | null>(null);
  const [repoNames, setRepoNames] = useState<Record<string, string[]>>({});
  const projectKey = Array.isArray(cfg?.projects) ? cfg!.projects.map((p: Cfg) => p.projectId).join(',') : '';
  useEffect(() => {
    if (!projectKey) return;
    let live = true;
    (async () => {
      try { const r = (await discoverQueues({})) as any; if (live) setQueues(r.queues ?? []); } catch { if (live) setQueues([]); }
      for (const pid of projectKey.split(',')) {
        try { const r = (await discoverRepos({ projectId: pid })) as any; if (live) setRepoNames((x) => ({ ...x, [pid]: (r.repositories ?? []).map((q: any) => q.name as string) })); } catch { /* the list stays empty; the box says so */ }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);

  const set = useCallback((patch: Cfg) => setCfg((c) => ({ ...(c ?? {}), ...patch })), []);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ tone: 'error', text: friendly(e) }); } finally { setBusy(false); } };
  const persist = async (c: Cfg) => { await saveConfig(companyId, c); setSaved(JSON.stringify(c)); };

  if (!cfg) return <div className="ado"><Styles />{msg ? <Banner tone="error">{msg.text}</Banner> : <p className="muted">Loading</p>}</div>;

  const o = overview.data;
  const projects: Cfg[] = Array.isArray(cfg.projects) ? cfg.projects : [];
  const chosen = new Set(projects.map((p) => String(p.projectId).toLowerCase()));
  const toggleProject = (p: { projectId: string; name: string }, on: boolean) =>
    set({ projects: on ? [...projects, { projectId: p.projectId, name: p.name, repositories: [], protectedBranches: ['refs/heads/main'], protectedPipelines: [] }] : projects.filter((x) => !same(String(x.projectId), p.projectId)) });
  const updProject = (pid: string, patch: Cfg) => set({ projects: projects.map((x) => (same(String(x.projectId), pid) ? { ...x, ...patch } : x)) });
  const roles = cfg.roles ?? {};
  const ap: Cfg = cfg.approval ?? {};
  const wh = cfg.webhook ?? {};
  const rv = cfg.review ?? {};
  const mode = (ap.mode ?? 'board') as 'board' | 'approvers' | 'both';
  const names = Object.fromEntries(agents.map((a) => [a.id, a.name]));
  const warnings = dutyWarnings(cfg, names);
  const idStatus = (role: string) => (o?.identities ?? []).find((i: any) => i.role === role);
  const errs: string[] = o?.validation?.errors ?? [];
  const warns: string[] = o?.validation?.warnings ?? [];
  const dots: Partial<Record<TabKey, 'bad' | 'warn'>> = {
    overview: errs.length ? 'bad' : warns.length ? 'warn' : undefined,
    access: warnings.some((w) => /both author and reviewer/.test(w)) ? 'warn' : undefined,
    merge: mode !== 'board' && warnings.some((w) => !/both author and reviewer/.test(w)) ? 'warn' : undefined,
  };

  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.key === tab);
    const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault(); const t = TABS[(n + TABS.length) % TABS.length]!.key; setTab(t);
    requestAnimationFrame(() => document.getElementById(`ado-tab-${t}`)?.focus());
  };

  const repoPick = (pr: Cfg, i: number) => (
    <PickList key={pr.projectId} label={`Repositories with a staging gate in ${pr.name}`} hint="A merge there also needs a staging gate result from the gate agents." empty="No repositories found yet."
      options={(repoNames[pr.projectId] ?? []).slice().sort().map((n) => ({ value: n, label: n }))} selected={pr.stagingGateRepositories ?? []}
      onChange={(vals) => { const next = [...projects]; next[i] = { ...pr, stagingGateRepositories: vals }; set({ projects: next }); }} />
  );

  const panel = (k: TabKey, children: ReactNode) => <div role="tabpanel" id={`ado-panel-${k}`} aria-labelledby={`ado-tab-${k}`} hidden={tab !== k} style={{ display: tab === k ? 'grid' : 'none', gap: 16 }}>{tab === k ? children : null}</div>;

  return (
    <div className="ado">
      <Styles />
      <h2>Azure DevOps</h2>
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}

      <div className="tabs" role="tablist" aria-label="Azure DevOps settings" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button type="button" key={t.key} role="tab" id={`ado-tab-${t.key}`} className="tab" aria-selected={tab === t.key} aria-controls={`ado-panel-${t.key}`} tabIndex={tab === t.key ? 0 : -1} onClick={() => setTab(t.key)}>
            {t.label}{dots[t.key] ? <span className={`dot${dots[t.key] === 'bad' ? ' bad' : ''}`} aria-label={dots[t.key] === 'bad' ? 'needs attention' : 'check this'} /> : null}
          </button>))}
      </div>

      {panel('overview', <>
        {o?.configured === false ? <Banner tone="info">Not set up yet. Use "Set up everything I can" below, or work through the checklist from the top.</Banner> : null}
        {errs.length ? <Banner tone="error"><ul>{errs.map((e) => <li key={e}>{e}</li>)}</ul></Banner> : null}
        {warns.length ? <Banner tone="warn"><ul>{warns.map((e) => <li key={e}>{e}</li>)}</ul></Banner> : null}
        {o?.configured ? (
          <div className="tiles" aria-label="Status">
            {(['author', 'reviewer'] as const).map((r) => { const i = idStatus(r); return (
              <div className="tile" key={r}><span className="muted">{r === 'author' ? 'Author bot' : 'Reviewer bot'}</span>
                <span className="big">{i?.lastErrorCode ? 'Problem' : i?.lastOkAt ? 'Connected' : 'Not tested'}</span>
                <span className="muted">{i?.lastErrorCode ?? (i?.displayName ? `${i.displayName}, ${ago(i.lastOkAt)}` : '')}</span></div>); })}
            <div className="tile"><span className="muted">Projects in scope</span><span className="big">{projects.length}</span><span className="muted">{projects.map((p) => p.name).join(', ') || 'none chosen'}</span></div>
            <div className="tile"><span className="muted">Merge approval</span><span className="big">{MODES.find((m) => m.value === mode)?.label}</span><span className="muted">{(roles.authorAgentIds ?? []).length} authors, {(roles.reviewerAgentIds ?? []).length} reviewers</span></div>
            <div className="tile"><span className="muted">Webhook inbox</span><span className="big">{Object.entries(o.inbox ?? {}).map(([k, n]) => `${n} ${k}`).join(', ') || 'empty'}</span>
              <span><Btn disabled={busy} onClick={() => run(async () => { const r = (await syncNow({})) as any; setMsg({ tone: 'ok', text: `Synced ${r.prs} pull request(s), ${r.discovered} new.${r.errors?.length ? ' Errors: ' + r.errors.join(', ') : ''}` }); overview.refresh?.(); })}>Sync now</Btn></span></div>
          </div>) : null}
        <Wizard companyId={companyId} cfg={cfg} setCfg={(p) => setCfg((c) => ({ ...(c ?? {}), ...p }))} getCfg={() => cfgRef.current ?? cfg} save={async (c) => { await persist(c); }} secrets={secrets} reloadSecrets={async () => { const s = await listSecrets(companyId); setSecrets(s); return s; }} agents={agents} overview={o} refresh={() => overview.refresh?.()} />
      </>)}

      {panel('connection', <>
        <Card title="Organization">
          <div className="two">
            <div className="field"><label htmlFor="org">Organization name</label><input id="org" type="text" value={cfg.organization?.name ?? ''} onChange={(e) => set({ organization: { ...(cfg.organization ?? {}), name: e.target.value.trim() } })} /><span className="hint">The part after dev.azure.com/</span></div>
            <div className="field"><label htmlFor="hf">URL form</label><select id="hf" value={cfg.organization?.hostForm ?? 'dev.azure.com'} onChange={(e) => set({ organization: { ...(cfg.organization ?? {}), hostForm: e.target.value } })}><option value="dev.azure.com">dev.azure.com</option><option value="visualstudio.com">name.visualstudio.com</option></select></div>
          </div>
        </Card>
        <div className="cols">
          <IdentityCard role="author" value={cfg.identities?.author} secrets={secrets} status={idStatus('author')} onChange={(v) => set({ identities: { ...(cfg.identities ?? {}), author: v } })} />
          <IdentityCard role="reviewer" value={cfg.identities?.reviewer} secrets={secrets} status={idStatus('reviewer')} onChange={(v) => set({ identities: { ...(cfg.identities ?? {}), reviewer: v } })} />
        </div>
        <div className="row">
          <Btn disabled={busy} onClick={() => run(async () => { await persist(cfg); setReport(await test({})); overview.refresh?.(); })}>Save and test connection</Btn>
          <span className="hint">Checks both bots and what each may do in every chosen project.</span>
        </div>
        {report ? (
          <table aria-label="Connection test"><thead><tr><th>Bot</th><th>Result</th><th>Projects</th></tr></thead><tbody>
            {report.results.map((r: any) => <tr key={r.role}><td>{r.role}{r.identity ? ` (${r.identity})` : ''}</td><td>{r.ok ? <Chip label="ok" t="success" /> : <Chip label={r.code} t="danger" />}{r.matchesExpected === false ? ' name differs from the expected one' : ''}</td><td>{(r.projects ?? []).map((p: any) => `${p.project}: ${p.ok ? p.repositories + ' repos' : p.code}${p.warnings?.length ? ' (' + p.warnings.join('; ') + ')' : p.permissions ? ' (permissions as expected)' : ''}`).join('; ')}</td></tr>)}
          </tbody></table>) : null}
        <Card title="Projects and repositories" help="Tools, webhooks and the reconciler act only inside the ticked set.">
          <div className="row"><Btn disabled={busy} onClick={() => run(async () => { await persist(cfg); const r = (await discover({})) as any; setFound(r.projects ?? []); setMsg({ tone: 'info', text: `${(r.projects ?? []).length} project(s) found.` }); overview.refresh?.(); })}>Save and find projects</Btn></div>
          {(found.length ? found : projects.map((p) => ({ projectId: p.projectId, name: p.name }))).length === 0 ? <p className="muted">No projects yet. Save the organization and bots, then press "Save and find projects".</p> : null}
          {(found.length ? found : projects.map((p) => ({ projectId: p.projectId, name: p.name }))).map((p) => {
            const on = chosen.has(p.projectId.toLowerCase());
            const proj = projects.find((x) => same(String(x.projectId), p.projectId));
            const cur: string[] = proj?.repositories ?? [];
            const list = (repoNames[p.projectId] ?? []).slice().sort();
            return (
              <div key={p.projectId} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <Check id={`p-${p.projectId}`} checked={on} onChange={(v) => toggleProject(p, v)}>{p.name}</Check>
                {on ? (
                  <details className="sub" style={{ marginLeft: 24 }}>
                    <summary>Repositories: {cur.length === 0 ? 'all' : `${cur.length} chosen`}</summary>
                    <p className="hint">Leave all unticked to allow every repository in the project.</p>
                    <div className="scroll">{list.length === 0 ? <p className="muted">No repositories listed yet.</p> : list.map((n) => (
                      <Check key={n} id={`r-${p.projectId}-${n}`} checked={cur.includes(n)} onChange={(v) => updProject(p.projectId, { repositories: v ? [...cur, n] : cur.filter((x) => x !== n) })}>{n}</Check>))}</div>
                  </details>) : null}
              </div>);
          })}
        </Card>
      </>)}

      {panel('access', <>
        <Card title="Who does what" help="Authors push code and open pull requests. Reviewers vote and post reviews; an agent cannot be both. Operators may propose completing or abandoning a pull request and running protected pipelines. Abandoning and protected pipeline runs are always confirmed by a person on the issue.">
          <Check id="everyone" checked={roles.everyoneIsAuthor === true} onChange={(v) => set({ roles: { ...roles, everyoneIsAuthor: v } })} hint="Includes agents added later. Reviewers stay reviewers.">Every agent is an author</Check>
          <AgentTable agents={agents} cfg={cfg} onChange={setCfg} everyoneIsAuthor={roles.everyoneIsAuthor === true}
            columns={[{ duty: 'author', label: 'Author', hint: 'May open and update pull requests and work items.' }, { duty: 'reviewer', label: 'Reviewer', hint: 'May vote and post reviews.' }, { duty: 'operator', label: 'Operator', hint: 'May propose completing or abandoning a pull request and running protected pipelines.' }]} />
        </Card>
        <Card title="Tool access" help='After changing this, press "Give agents their tools" on the Overview tab.'>
          <Segmented label="Tool access" value={cfg.access?.tools === 'roles' ? 'roles' : 'company'} onChange={(v) => set({ access: { ...(cfg.access ?? {}), tools: v } })} options={[{ value: 'company', label: 'All agents (recommended)' }, { value: 'roles', label: 'Only agents with a role' }]} />
          <p className="hint">{cfg.access?.tools === 'roles' ? 'Agents without a role cannot see the tools at all.' : 'Every agent can see the tools. The plugin still checks the role on every call.'}</p>
        </Card>
      </>)}

      {panel('merge', <>
        <Card title="Who approves completing a pull request">
          <Segmented label="Approval mode" value={mode} onChange={(v) => set({ approval: { ...ap, mode: v } })} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
          <p className="hint">{MODES.find((m) => m.value === mode)?.text}</p>
        </Card>
        {mode !== 'board' ? <>
          <Card title="Approvers and verdicts" help="Approvers approve the facts the plugin verified; they do not re-review code. An approver may also be an author, but never approves a pull request they opened or proposed, and cannot give a verdict or post the staging gate result of the same commit. Verdict agents must be reviewers.">
            <AgentTable agents={agents} cfg={cfg} onChange={setCfg}
              columns={[{ duty: 'approver', label: 'Approver', hint: 'May approve or reject.' }, { duty: 'qa', label: 'QA verdict', hint: 'Their review votes count as the QA verdict.' }, { duty: 'security', label: 'Security verdict', hint: 'Their review votes count as the Security verdict.' }, { duty: 'staging', label: 'Staging gate', hint: 'May post a staging gate result.' }]} />
          </Card>
          <Card title="Rules">
            <Check id="reqsec" checked={(ap.requiredVerdictFunctions ?? ['qa', 'security']).includes('security')} onChange={(v) => set({ approval: { ...ap, requiredVerdictFunctions: v ? ['qa', 'security'] : ['qa'] } })} hint="A QA verdict is always required.">Require a Security verdict</Check>
            <Check id="appipe" checked={ap.pipelineRunsByApprovers !== false} onChange={(v) => set({ approval: { ...ap, pipelineRunsByApprovers: v } })} hint="Runs of protected pipelines or on protected branches. The proposer gives a reason; another approver agent decides; if none is allowed to, the board gets the card. Abandoning a pull request always needs a person.">Approver agents decide protected pipeline runs</Check>
            <Check id="apthr" checked={ap.requireNoActiveThreads !== false} onChange={(v) => set({ approval: { ...ap, requireNoActiveThreads: v } })}>Refuse while review threads are still active</Check>
            <Check id="appol" checked={ap.requirePipelinePolicy !== false} onChange={(v) => set({ approval: { ...ap, requirePipelinePolicy: v } })}>Refuse when the target branch has no blocking build or status policy</Check>
            <Check id="apunk" checked={ap.allowUnknownAuthor === true} onChange={(v) => set({ approval: { ...ap, allowUnknownAuthor: v } })} hint="The opener is not an agent. Verdicts and the approver rules still apply.">Allow pull requests opened by hand with no recorded author agent</Check>
            <div className="two">
              <div className="field"><label htmlFor="apmin">Minimum vote that counts</label><select id="apmin" value={ap.minVerdictVote ?? 5} onChange={(e) => set({ approval: { ...ap, minVerdictVote: Number(e.target.value) } })}><option value={5}>Approved with suggestions (5) or better</option><option value={10}>Approved (10) only</option></select></div>
              <div className="field"><label htmlFor="aptmo">Minutes before it goes to the board</label><input id="aptmo" type="number" min={15} max={10080} value={ap.approvalTimeoutMinutes ?? 240} onChange={(e) => set({ approval: { ...ap, approvalTimeoutMinutes: Math.min(10080, Math.max(15, Number(e.target.value) || 240)) } })} /></div>
            </div>
            <Check id="apnoap" checked={ap.boardWhenNoApprover !== false} onChange={(v) => set({ approval: { ...ap, boardWhenNoApprover: v } })} hint="For example the CEO opens the pull request and is the only approver. The card appears on the issue; approving it merges the pull request. Verdicts, build policy and staging gate are still checked first.">When no approver agent is allowed to decide, ask the board right away</Check>
            <Check id="apesc" checked={ap.escalateToBoardOnTimeout !== false} onChange={(v) => set({ approval: { ...ap, escalateToBoardOnTimeout: v } })}>If no approver decides in time, ask the board (otherwise the request lapses)</Check>
          </Card>
          <Card title="Repositories with special rules">
            <PickList label="Repositories that need no pipeline" hint="For example a handbook. The check does not ask for an approved Build policy there." empty="No repositories found yet."
              options={[...new Set(Object.values(repoNames).flat())].sort().map((n) => ({ value: n, label: n }))} selected={ap.pipelineOptionalRepositories ?? []} onChange={(vals) => set({ approval: { ...ap, pipelineOptionalRepositories: vals } })} />
            {projects.map(repoPick)}
          </Card>
          <p className="hint">Approvers need tool access company-wide. Creating the approval task needs the plugin to hold the issues.create capability; without it the approvers are asked by a comment instead.</p>
        </> : null}
      </>)}

      {panel('pipelines', <>
        <Card title="Pipelines" help="Off by default. When on, operator agents may ask to create or change pipeline definitions. A person always confirms on the issue and new pipelines start disabled. The author bot needs Create and Edit build definition rights in Azure DevOps.">
          <Check id="pipc" checked={(cfg.pipelines ?? {}).allowCreate === true} onChange={(v) => set({ pipelines: { ...(cfg.pipelines ?? {}), allowCreate: v } })}>Agents may ask to create and change pipelines</Check>
          {(cfg.pipelines ?? {}).allowCreate === true ? (
            <PickList label="Allowed agent queues" hint="Pipelines may only run on the queues ticked here. Each project has its own queue ids, so a pool appears once per project." empty={queues === null ? 'Loading queues' : 'No queues found. Save the projects and bots first.'}
              options={(queues ?? []).map((q) => ({ value: String(q.id), label: `${q.project}: ${q.name}${q.hosted ? ' (Microsoft-hosted)' : ''}${q.pool && q.pool !== q.name ? ` - pool ${q.pool}` : ''}` }))}
              selected={((cfg.pipelines ?? {}).allowedQueueIds ?? []).map(String)} onChange={(vals) => set({ pipelines: { ...(cfg.pipelines ?? {}), allowedQueueIds: vals.map(Number).filter((n) => Number.isInteger(n) && n > 0) } })} />) : null}
        </Card>
        <Card title="Agent tools" help="Paperclip gives plugin tools only to some adapters. Agents on the opencode adapter get none, so they cannot open pull requests or post reviews. When this is on, the plugin installs a small tool server (MCP server azdo) into the opencode configuration of every agent that holds a role here, and removes it again when you turn this off. The tools appear as azdo_ado_pr_get and so on, with the same roles and approvals.">
          <Check id="agtoc" checked={(cfg.agentTools ?? {}).opencodeNative === true} onChange={(v) => set({ agentTools: { ...(cfg.agentTools ?? {}), opencodeNative: v } })} hint="Applies within a minute and takes effect on the agent's next run. Only agents with an explicit OPENCODE_CONFIG path are changed; a backup opencode.json.bak-azdo is kept.">Install the Azure DevOps tools for opencode agents</Check>
        </Card>
        <VariableGroupsCard cfg={cfg} secrets={secrets} set={set} />
        <ReleaseBundleCard cfg={cfg} set={set} />
        <Card title="Repositories" help="The author bot also needs the Create repository right.">
          <Check id="repc" checked={(cfg.repos ?? {}).allowCreate === true} onChange={(v) => set({ repos: { ...(cfg.repos ?? {}), allowCreate: v } })}>Agents may ask to create repositories</Check>
        </Card>
      </>)}

      {panel('integrations', <>
        <Card title="Webhook" help="Optional. Without it the reconciler still keeps everything current, with a delay.">
          <SecretSelect label="Hook token secret" value={wh.hookTokenRef} secrets={secrets} onChange={(id) => set({ webhook: { ...wh, hookTokenRef: ref(id) } })} hint="Use a dedicated secret. It is shown in Azure DevOps, so do not reuse it anywhere." />
          <SecretSelect label="Basic auth password secret" value={wh.basicAuthPasswordRef} secrets={secrets} onChange={(id) => set({ webhook: { ...wh, basicAuthPasswordRef: ref(id) } })} />
          <div className="field"><label htmlFor="pub">Public base URL</label><input id="pub" type="text" value={wh.publicBaseUrl ?? ''} onChange={(e) => set({ webhook: { ...wh, publicBaseUrl: e.target.value.trim() } })} /></div>
          {o?.webhook ? <div className="mono">POST {o.webhook.url}<br />Header {o.webhook.header}: (the hook token)<br />Basic auth user {o.webhook.basicAuthUser}<br />Events: {o.webhook.events.join(', ')}<br />Resource details: {o.webhook.resourceDetailsToSend}</div> : null}
        </Card>
        <Card title="Review status" help="Make it a required Status policy on protected branches. The plugin never bypasses branch policy. A required status also blocks pull requests nobody linked to a Paperclip issue, so scope the policy to the branches agents use.">
          <Check id="ps" checked={rv.publishStatus !== false} onChange={(v) => set({ review: { ...rv, publishStatus: v } })}>Publish the {rv.statusGenre ?? 'paperclip'}/{rv.statusName ?? 'review'} status on pull requests</Check>
        </Card>
        <Card title="Limits">
          <div className="field"><label htmlFor="mtc">Tool calls per run</label><input id="mtc" type="number" min={5} max={1000} value={cfg.limits?.maxToolCallsPerRun ?? 60} onChange={(e) => set({ limits: { ...(cfg.limits ?? {}), maxToolCallsPerRun: Math.min(1000, Math.max(5, Number(e.target.value) || 60)) } })} style={{ maxWidth: 120 }} /><span className="hint">How many Azure DevOps tool calls one agent run may make. Default 60.</span></div>
        </Card>
      </>)}

      {panel('tools', <Card title={`Agent tools (${o?.tools?.length ?? 0})`} help="Paperclip denies tools by default. The Overview checklist gives agents these tools through a tool profile.">
        <table><thead><tr><th>Tool</th><th>Class</th><th>Role</th></tr></thead><tbody>{(o?.tools ?? []).map((t: any) => <tr key={t.name}><td className="mono">{t.name}</td><td>{t.cls === 'R' ? 'read' : t.cls === 'W' ? 'write' : 'gated'}</td><td>{String(t.role).replace(/_/g, ' ')}</td></tr>)}</tbody></table>
      </Card>)}

      <div className={`savebar${dirty ? ' dirty' : ''}`} role="region" aria-label="Save settings">
        <span className="grow" role="status">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
        <Btn disabled={busy || !dirty} onClick={() => setCfg(JSON.parse(saved))}>Discard changes</Btn>
        <Btn primary disabled={busy || !dirty} onClick={() => run(async () => { await persist(cfg); setMsg({ tone: 'ok', text: 'Saved.' }); overview.refresh?.(); })}>Save</Btn>
      </div>
    </div>
  );
}

export function SettingsPage({ context }: PluginCompanySettingsPageProps) {
  return <ErrorBoundary><SettingsInner companyId={String(context.companyId ?? '')} /></ErrorBoundary>;
}
