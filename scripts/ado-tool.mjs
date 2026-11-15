#!/usr/bin/env node
// Call an Azure DevOps plugin tool over Paperclip's REST API.
// For agents whose adapter (for example opencode_local) gets no native ado_* tools.
// Usage: ado-tool.mjs <tool_name> '<json params>'     e.g. ado-tool.mjs ado_pr_get '{"repository":"KippiOwl","prId":104}'
const [, , name, raw = '{}'] = process.argv;
if (!name) { console.error('usage: ado-tool.mjs <tool_name> [json-params]'); process.exit(2); }
const e = process.env;
const base = (e.PAPERCLIP_API_URL || '').replace(/\/$/, '');
const key = e.PAPERCLIP_API_KEY;
if (!base || !key || !e.PAPERCLIP_AGENT_ID || !e.PAPERCLIP_COMPANY_ID || !e.PAPERCLIP_RUN_ID) {
  console.error('Missing PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID or PAPERCLIP_RUN_ID.'); process.exit(2);
}
const api = base.endsWith('/api') ? base : base + '/api';
const h = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
let params; try { params = JSON.parse(raw); } catch { console.error('params must be JSON'); process.exit(2); }
const getJson = async (p) => { try { const x = await fetch(api + p, { headers: h }); return x.ok ? await x.json() : null; } catch { return null; } };
let projectId = e.PAPERCLIP_PROJECT_ID;
if (!projectId && e.PAPERCLIP_TASK_ID) projectId = (await getJson('/issues/' + e.PAPERCLIP_TASK_ID))?.projectId;
for (const st of ['in_progress', 'todo', 'blocked']) {
  if (projectId) break;
  const l = await getJson(`/companies/${e.PAPERCLIP_COMPANY_ID}/issues?assigneeAgentId=${e.PAPERCLIP_AGENT_ID}&status=${st}&limit=20`);
  projectId = (Array.isArray(l) ? l : l?.issues || []).find((i) => i.projectId)?.projectId;
}
if (!projectId) { const ps = await getJson(`/companies/${e.PAPERCLIP_COMPANY_ID}/projects`); projectId = (Array.isArray(ps) ? ps : ps?.projects || [])[0]?.id; }
if (!projectId) { console.error('No project found for this company.'); process.exit(2); }
const r = await fetch(`${api}/plugins/tools/execute`, {
  method: 'POST', headers: h,
  body: JSON.stringify({ tool: name.includes(':') ? name : `mzaferyahsi.azure-devops:${name}`, parameters: params,
    runContext: { agentId: e.PAPERCLIP_AGENT_ID, runId: e.PAPERCLIP_RUN_ID, companyId: e.PAPERCLIP_COMPANY_ID, projectId } }),
});
const t = await r.text();
console.log(t);
process.exit(r.ok ? 0 : 1);
