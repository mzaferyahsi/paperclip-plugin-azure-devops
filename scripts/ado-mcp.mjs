#!/usr/bin/env node
// Minimal stdio MCP server exposing the Azure DevOps plugin tools to agents whose adapter
// (for example opencode_local) gets no native plugin tools. It forwards every call to
// Paperclip's REST API with the run's own credentials (PAPERCLIP_* env). No extra rights.
import { createInterface } from 'node:readline';
const PLUGIN = 'mzaferyahsi.azure-devops';
const e = process.env;
const base = (e.PAPERCLIP_API_URL || '').replace(/\/$/, '');
const api = base.endsWith('/api') ? base : base + '/api';
const h = () => ({ authorization: 'Bearer ' + e.PAPERCLIP_API_KEY, 'content-type': 'application/json' });
let cache = null;
async function listTools() {
  if (cache) return cache;
  const r = await fetch(`${api}/plugins/tools?pluginId=${encodeURIComponent(PLUGIN)}`, { headers: h() });
  if (!r.ok) throw new Error(`tool list failed: HTTP ${r.status}`);
  const j = await r.json();
  const arr = Array.isArray(j) ? j : j.tools || [];
  cache = arr.map((t) => {
    const full = String(t.name || '');
    const short = full.includes(':') ? full.split(':').pop() : full;
    return { full, tool: { name: short, description: t.description || t.displayName || short,
      inputSchema: t.parametersSchema || t.inputSchema || { type: 'object', properties: {} } } };
  }).filter((t) => t.tool.name.startsWith('ado_'));
  return cache;
}
// The host only needs a project of the company for the run context. Timer wakes set no task, so fall back step by step.
async function getJson(p) { try { const r = await fetch(`${api}${p}`, { headers: h() }); return r.ok ? await r.json() : null; } catch { return null; } }
async function projectId() {
  if (e.PAPERCLIP_PROJECT_ID) return e.PAPERCLIP_PROJECT_ID;
  if (e.PAPERCLIP_TASK_ID) { const i = await getJson(`/issues/${e.PAPERCLIP_TASK_ID}`); if (i?.projectId) return i.projectId; }
  const cid = e.PAPERCLIP_COMPANY_ID, aid = e.PAPERCLIP_AGENT_ID;
  for (const st of ['in_progress', 'todo', 'blocked']) {
    const l = await getJson(`/companies/${cid}/issues?assigneeAgentId=${aid}&status=${st}&limit=20`);
    const arr = Array.isArray(l) ? l : l?.issues || [];
    const hit = arr.find((i) => i.projectId); if (hit) return hit.projectId;
  }
  const ps = await getJson(`/companies/${cid}/projects`);
  const parr = Array.isArray(ps) ? ps : ps?.projects || [];
  return parr[0]?.id;
}
async function call(name, args) {
  const tools = await listTools();
  const t = tools.find((x) => x.tool.name === name);
  if (!t) return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  const pid = await projectId();
  if (!pid) return { isError: true, content: [{ type: 'text', text: 'no project found for this company' }] };
  const r = await fetch(`${api}/plugins/tools/execute`, { method: 'POST', headers: h(), body: JSON.stringify({
    tool: t.full, parameters: args || {},
    runContext: { agentId: e.PAPERCLIP_AGENT_ID, runId: e.PAPERCLIP_RUN_ID, companyId: e.PAPERCLIP_COMPANY_ID, projectId: pid } }) });
  const text = await r.text();
  let out = text;
  try { const j = JSON.parse(text); out = j.content ?? j.result?.content ?? j.error ?? text; if (typeof out !== 'string') out = JSON.stringify(j.data ?? j, null, 1); } catch {}
  return { isError: !r.ok, content: [{ type: 'text', text: out }] };
}
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
createInterface({ input: process.stdin }).on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const id = m.id;
  try {
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ado', version: '1' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: (await listTools()).map((t) => t.tool) } });
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id, result: await call(m.params.name, m.params.arguments) });
    else if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
  } catch (err) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(err.message || err) } });
  }
});
