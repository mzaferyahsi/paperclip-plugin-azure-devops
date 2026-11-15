import { useState } from 'react';
import { ErrorBoundary, usePluginAction, usePluginData } from '@paperclipai/plugin-sdk/ui';
import type { PluginDetailTabProps, PluginWidgetProps } from '@paperclipai/plugin-sdk/ui';
import { Banner, Btn, Chip, Styles, ago } from './kit.tsx';

export { SettingsPage } from './Settings.tsx';

export function IssueTab({ context }: PluginDetailTabProps) {
  const { data, error, refresh } = usePluginData<any>('issue-links', { companyId: context.companyId, issueId: context.entityId });
  const link = usePluginAction('link-url');
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <ErrorBoundary>
      <div className="ado"><Styles />
        {error ? <Banner tone="error">Could not load Azure DevOps links.</Banner> : null}
        {!data ? <p className="muted">Loading</p> : data.links.length === 0 ? <p className="muted">No Azure DevOps pull request, work item or build is linked to this issue yet. A branch named like <span className="mono">agent/key-123-topic</span> links automatically.</p> : (
          <table><thead><tr><th>Object</th><th>State</th><th>Details</th></tr></thead><tbody>
            {data.links.map((l: any, i: number) => (
              <tr key={i}>
                <td>{l.kind === 'pull_request' ? <a href={l.url} target="_blank" rel="noreferrer noopener">{l.repository ? `${l.repository}!${l.prId}` : `!${l.prId}`}</a> : l.kind === 'build' ? (l.web_url ? <a href={l.web_url} target="_blank" rel="noreferrer noopener">Build {l.build_id}</a> : `Build ${l.build_id}`) : `Work item ${l.id}`}{l.confidence === 'likely' ? ' (likely)' : ''}</td>
                <td>{l.kind === 'pull_request' ? (l.state ? <Chip label={l.state.statusLabel} t={l.state.statusTone} /> : <span className="muted">not synced</span>) : l.kind === 'build' ? <Chip label={`${l.status ?? ''}${l.result ? ' / ' + l.result : ''}`} t={l.result === 'succeeded' ? 'success' : l.result === 'failed' ? 'danger' : ''} /> : <span>{l.state ?? 'not synced'}</span>}</td>
                <td className="muted">{l.kind === 'pull_request' && l.sourceBranch ? `${l.sourceBranch} to ${l.targetBranch}. Reviews: ${(l.reviewers ?? []).map((r: any) => `${r.vote}`).join(', ') || 'none'}. Checks: ${(l.policies ?? []).map((p: any) => `${p.name} ${p.status}`).join(', ') || 'none'}. Review status ${l.reviewStatus}.` : ''}</td>
              </tr>))}
          </tbody></table>)}
        {data?.canLink ? (
          <div className="row"><label htmlFor="lk" className="sr">Pull request or work item URL</label><input id="lk" type="text" placeholder="Paste a pull request or work item URL" value={url} onChange={(e) => setUrl(e.target.value)} style={{ minWidth: 320 }} />
            <Btn disabled={!url} onClick={async () => { try { await link({ issueId: context.entityId, url }); setUrl(''); setMsg('Linked.'); refresh?.(); } catch { setMsg('Could not link: check the URL belongs to the configured organization and scope.'); } }}>Link</Btn></div>) : null}
        {msg ? <p className="muted" role="status">{msg}</p> : null}
      </div>
    </ErrorBoundary>
  );
}

export function HealthWidget({ context }: PluginWidgetProps) {
  const prs = usePluginData<any>('pending-prs', { companyId: context.companyId });
  const ov = usePluginData<any>('overview', { companyId: context.companyId });
  if (ov.data && ov.data.configured === false) return null;
  const bad = (ov.data?.identities ?? []).filter((i: any) => i.lastErrorCode);
  return (
    <ErrorBoundary>
      <div className="ado"><Styles />
        <h3>Azure DevOps</h3>
        {bad.length ? <Banner tone="error">{bad.map((i: any) => `${i.role}: ${i.lastErrorCode}`).join(', ')}. Open Azure DevOps settings.</Banner> : null}
        {!prs.data ? <p className="muted">Loading</p> : prs.data.prs.length === 0 ? <p className="muted">No open pull requests.</p> : (
          <table><thead><tr><th>Pull request</th><th>State</th><th>Updated</th></tr></thead><tbody>
            {prs.data.prs.slice(0, 8).map((p: any) => <tr key={p.url}><td><a href={p.url} target="_blank" rel="noreferrer noopener">{p.repository}!{p.prId}</a> <span className="muted">{p.title}</span></td><td><Chip label={p.state.statusLabel} t={p.state.statusTone} /></td><td className="muted">{ago(p.changedAt)}</td></tr>)}
          </tbody></table>)}
      </div>
    </ErrorBoundary>
  );
}
