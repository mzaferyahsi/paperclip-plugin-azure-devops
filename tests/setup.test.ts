import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { detectOrg, parseOrgInput } from '../src/orgdetect.ts';

test('organization input: URLs, bare names and rejects', () => {
  assert.deepEqual(parseOrgInput('https://dev.azure.com/acme/'), { org: 'acme', hostForm: 'dev.azure.com' });
  assert.deepEqual(parseOrgInput('dev.azure.com/acme/proj/_git/x'), { org: 'acme', hostForm: 'dev.azure.com' });
  assert.deepEqual(parseOrgInput('https://acme.visualstudio.com/DefaultCollection'), { org: 'acme', hostForm: 'visualstudio.com' });
  assert.deepEqual(parseOrgInput(' acme '), { org: 'acme', hostForm: 'dev.azure.com' });
  for (const bad of ['', 'https://evil.example/acme', 'https://dev.azure.com/', 'https://dev.azure.com/-x', 'a b', 'https://a.b.visualstudio.com']) assert.equal(parseOrgInput(bad), null, bad);
});

test('tenant detection reads the organization response header and never leaks an invalid one', async () => {
  let tenant: string | undefined = '00000000-1111-2222-3333-444444444444'.toUpperCase(); let status = 405;
  const srv = http.createServer((req, res) => { res.statusCode = status; if (tenant) res.setHeader('x-vss-resourcetenant', tenant); res.end(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  const viaFake = (url: string, init?: RequestInit) => fetch(url.replace(/^https:\/\/[^/]+(\/[^/]+)?/, `http://127.0.0.1:${port}`), init);
  try {
    const ok = await detectOrg(viaFake, { org: 'acme', hostForm: 'dev.azure.com' });
    assert.equal(ok.tenantId, '00000000-1111-2222-3333-444444444444');
    tenant = 'not-a-guid';
    assert.equal((await detectOrg(viaFake, { org: 'acme', hostForm: 'dev.azure.com' })).tenantId, null);
    tenant = undefined; status = 404;
    assert.match((await detectOrg(viaFake, { org: 'nope', hostForm: 'dev.azure.com' })).note ?? '', /does not know/);
  } finally { srv.close(); }
  const down = await detectOrg(async () => { throw new Error('x'); }, { org: 'acme', hostForm: 'dev.azure.com' });
  assert.equal(down.reachable, false);
});

import { computeSteps, matchSecrets, progress, suggestRoles, toolsForRole } from '../src/ui/setup.ts';
import { TOOLS } from '../src/tools/catalog.ts';

test('secrets are matched by their obvious names, ambiguity is left blank', () => {
  const s = (name: string, i: number) => ({ id: `id${i}`, name, key: name.replace(/\//g, '-') });
  const g = matchSecrets([s('azure-devops/author-client-id', 1), s('azure-devops/author-client-secret', 2), s('azure-devops/reviewer-client-id', 3), s('azure-devops/reviewer-client-secret', 4), s('azure-devops/webhook-token', 5), s('azure-devops/webhook-password', 6), s('azure-pat', 7)]);
  assert.deepEqual([g.authorClientId, g.authorClientSecret, g.reviewerClientId, g.reviewerClientSecret, g.webhookToken, g.webhookPassword], ['id1', 'id2', 'id3', 'id4', 'id5', 'id6']);
  assert.equal(matchSecrets([s('ado author client id', 1), s('azure author client id', 2)]).authorClientId, undefined);
  assert.equal(matchSecrets([]).authorClientId, undefined);
});

test('role suggestions follow roles and names and never make an agent both author and reviewer', () => {
  const a = (id: string, name: string, role: string) => ({ id, name, role });
  const r = suggestRoles([a('1', 'CEO', 'general'), a('2', 'QA', 'qa'), a('3', 'DevClaude', 'engineer'), a('4', 'PlatformEng', 'devops'), a('5', 'TechLead', 'engineer'), a('6', 'ProductUX', 'pm')]);
  assert.deepEqual(r.author.sort(), ['3', '4']); assert.deepEqual(r.reviewer.sort(), ['2', '5']); assert.deepEqual(r.operator.sort(), ['4', '5']);
  assert.equal(r.author.filter((x) => r.reviewer.includes(x)).length, 0);
});

test('tool lists per role: reads for all, writes only for the matching role, gated only for operators', () => {
  const tools = TOOLS.map((t) => ({ name: t.name, cls: t.cls, role: t.role }));
  const author = toolsForRole(tools, 'author'), reviewer = toolsForRole(tools, 'reviewer'), operator = toolsForRole(tools, 'operator');
  const n = (x: string) => `mzaferyahsi.azure-devops:${x}`;
  assert.ok(author.includes(n('ado_pr_create')) && !author.includes(n('ado_pr_review_post')) && !author.includes(n('ado_pr_complete_apply')));
  assert.ok(reviewer.includes(n('ado_pr_review_post')) && reviewer.includes(n('ado_pr_comment_post')) && !reviewer.includes(n('ado_pr_create')));
  assert.ok(operator.includes(n('ado_pr_complete_apply')) && !operator.includes(n('ado_pr_create')));
  for (const l of [author, reviewer, operator]) assert.ok(l.includes(n('ado_pr_get')) && l.includes(n('ado_health')));
  // deploy approval exposure: the two approval tools are visible to no profile role (deploy_approver is configured separately);
  // the release verdict tool is visible to reviewers only.
  for (const l of [author, reviewer, operator]) {
    assert.ok(!l.includes(n('ado_environment_approval_get')), 'approval get must not be in profile lists');
    assert.ok(!l.includes(n('ado_environment_approval_post')), 'approval post must not be in profile lists');
  }
  assert.ok(reviewer.includes(n('ado_release_verdict_post')));
  assert.ok(!author.includes(n('ado_release_verdict_post')) && !operator.includes(n('ado_release_verdict_post')));
});

test('the checklist reports progress and the right next step', () => {
  const base = { orgName: '', tenantId: '', identitiesConfigured: false, identitiesOk: false, projects: 0, authors: 0, reviewers: 0, roleOverlap: false, toolsApplied: false, chipsOn: false, permissionReport: null, webhookConfigured: false };
  let steps = computeSteps(base); assert.deepEqual(progress(steps), { done: 0, total: 7 }); assert.equal(steps[0]!.status, 'todo');
  steps = computeSteps({ ...base, orgName: 'a', tenantId: 't', identitiesConfigured: true, identitiesOk: true, projects: 1, authors: 2, reviewers: 1, toolsApplied: true, chipsOn: true, permissionReport: { missing: [], excessive: [] } });
  assert.deepEqual(progress(steps), { done: 7, total: 7 });
  steps = computeSteps({ ...base, orgName: 'a', tenantId: 't', identitiesConfigured: true, identitiesOk: false, identityError: 'ado_auth', roleOverlap: true, permissionReport: { missing: ['contribute to pull requests'], excessive: ['push'] } });
  assert.equal(steps.find((s) => s.key === 'identities')!.status, 'warn'); assert.equal(steps.find((s) => s.key === 'roles')!.status, 'warn');
  assert.match(steps.find((s) => s.key === 'permissions')!.detail, /missing: contribute.*too much: push/);
});

import { applyToolProfiles, ensureSecret, toolAccessApplied } from '../src/ui/setupApi.ts';

/** A tiny in-memory Paperclip: profiles, bindings, secrets. Mirrors the behaviours measured on a real instance (409 on re-bind, PATCH replaces entries). */
function fakeApi() {
  const profiles: any[] = []; const secrets: any[] = []; let n = 0; const log: string[] = [];
  const envs: any[] = [{ id: 'e1', name: 'Local', status: 'active', envVars: {}, metadata: { defaultForInstance: true } }];
  const projects: any[] = [{ id: 'pr1', name: 'P1', env: { PATH: { type: 'plain', value: '/opt/paperclip-ado/bin:/usr/bin' }, KEEP: { type: 'plain', value: '1' } } }, { id: 'pr2', name: 'P2', env: null }];
  const call = async (method: string, path: string, body?: any): Promise<unknown> => {
    log.push(`${method} ${path}`);
    let m: RegExpExecArray | null;
    if (method === 'GET' && /\/tools\/profiles$/.test(path)) return { profiles: structuredClone(profiles) };
    if (method === 'POST' && /\/tools\/profiles$/.test(path)) { const p = { id: `p${++n}`, profileKey: body.profileKey, entries: body.entries, bindings: [] as any[] }; profiles.push(p); return p; }
    if (method === 'PATCH' && (m = /\/tool-profiles\/(.+)$/.exec(path))) { profiles.find((p) => p.id === m![1]).entries = body.entries; return {}; }
    if (method === 'POST' && (m = /\/tools\/profiles\/(.+)\/bind$/.exec(path))) { const p = profiles.find((x) => x.id === m![1]); if (p.bindings.some((b: any) => b.targetId === body.targetId)) throw new Error('http_409'); p.bindings.push(body); return {}; }
    if (method === 'POST' && (m = /\/tools\/profiles\/(.+)\/unbind$/.exec(path))) { const p = profiles.find((x) => x.id === m![1]); p.bindings = p.bindings.filter((b: any) => b.targetId !== body.targetId); return {}; }
    if (method === 'GET' && /\/environments$/.test(path)) return structuredClone(envs);
    if (method === 'PATCH' && (m = /\/environments\/([^?]+)\?companyId=(.+)$/.exec(path))) { envs.find((e) => e.id === m![1]).envVars = body.envVars; return {}; }
    if (method === 'GET' && /\/projects$/.test(path)) return structuredClone(projects);
    if (method === 'PATCH' && (m = /\/projects\/(.+)$/.exec(path))) { projects.find((p) => p.id === m![1]).env = body.env; return {}; }
    if (method === 'POST' && /\/secrets$/.test(path)) { const s = { id: `s${++n}`, ...body }; secrets.push(s); return s; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, profiles, secrets, log, envs, projects };
}

test('applying tool profiles creates one per role, binds agents, is idempotent and unbinds agents that lost a role', async () => {
  const api = fakeApi(); const tools = TOOLS.map((t) => ({ name: t.name, cls: t.cls, role: t.role }));
  const r1 = await applyToolProfiles(api.call, 'c', { author: ['a1', 'a2'], reviewer: ['r1'], operator: ['r1'] }, tools, 'roles');
  assert.deepEqual(r1.created.length, 3); assert.equal(r1.bound, 4);
  const r2 = await applyToolProfiles(api.call, 'c', { author: ['a1', 'a2'], reviewer: ['r1'], operator: ['r1'] }, tools, 'roles');
  assert.equal(r2.created.length, 0); assert.equal(r2.bound, 0); assert.equal(r2.unbound, 0, 'second run changes nothing');
  assert.equal(await toolAccessApplied(api.call, 'c', { author: ['a1', 'a2'], reviewer: ['r1'], operator: ['r1'] }, 'roles'), true);
  assert.equal(await toolAccessApplied(api.call, 'c', { author: ['a1', 'a9'], reviewer: ['r1'], operator: [] }, 'roles'), false);
  const r3 = await applyToolProfiles(api.call, 'c', { author: ['a1'], reviewer: ['r1'], operator: [] }, tools, 'roles');
  assert.equal(r3.unbound, 2, 'a2 lost author, r1 lost operator');
  const author = api.profiles.find((p) => p.profileKey === 'azure-devops-author');
  assert.ok(author.entries.some((e: any) => e.toolName === 'mzaferyahsi.azure-devops:ado_pr_create') && !author.entries.some((e: any) => e.toolName.endsWith('ado_pr_complete_apply')));
});

test('secrets are created once by key and never duplicated', async () => {
  const api = fakeApi();
  const id1 = await ensureSecret(api.call, 'c', [], 'azure-devops/webhook-token', 'azure-devops-webhook-token', 'v', 'd');
  const id2 = await ensureSecret(api.call, 'c', [{ id: id1, key: 'azure-devops-webhook-token', name: 'x' }], 'azure-devops/webhook-token', 'azure-devops-webhook-token', 'v', 'd');
  assert.equal(id1, id2); assert.equal(api.secrets.length, 1);
});

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstall } from '../src/gitaccess.ts';

test('git access install is recognised only when the files exist, are not group or world writable, and (in production) are root owned', () => {
  const root = mkdtempSync(join(tmpdir(), 'ado-inst-'));
  try {
    assert.equal(readInstall(root, false).installed, false);
    mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'etc'));
    for (const f of ['git', 'git-credential-paperclip-ado']) { writeFileSync(join(root, 'bin', f), '#!/bin/sh\n'); chmodSync(join(root, 'bin', f), 0o755); }
    writeFileSync(join(root, 'etc/git-access.conf'), '# c\nacme/Platform\nacme/Other\n'); writeFileSync(join(root, 'etc/installed-at'), '2026-10-26T00:00:00Z\n');
    const r = readInstall(root, false); assert.equal(r.installed, true); assert.deepEqual(r.covered, ['acme/Platform', 'acme/Other']); assert.equal(r.installedAt, '2026-10-26T00:00:00Z');
    assert.equal(readInstall(root, true).installed, false, 'owned by the test user, not root: not trusted');
    chmodSync(join(root, 'bin/git'), 0o775); assert.equal(readInstall(root, false).installed, false, 'group-writable wrapper is a credential interception risk');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the git step in the checklist: install, coverage, project PATH, in use', () => {
  const base = { orgName: 'a', tenantId: 't', identitiesConfigured: true, identitiesOk: true, projects: 1, authors: 1, reviewers: 1, roleOverlap: false, toolsApplied: true, chipsOn: true, permissionReport: { missing: [], excessive: [] }, webhookConfigured: false };
  const step = (git: any) => computeSteps({ ...base, git }).find((s) => s.key === 'git')!;
  assert.equal(computeSteps(base).some((s) => s.key === 'git'), false, 'hidden until projects are chosen');
  assert.match(step(null).detail, /Checking/);
  assert.match(step({ installed: false, missingProjects: [], pathApplied: null, lastIssuedAt: null }).detail, /Install the host wrapper/);
  assert.equal(step({ installed: true, missingProjects: ['a/P'], pathApplied: true, lastIssuedAt: null }).status, 'warn');
  assert.match(step({ installed: true, missingProjects: [], pathApplied: false, lastIssuedAt: null }).detail, /Apply the wrapper/);
  assert.equal(step({ installed: true, missingProjects: [], pathApplied: true, lastIssuedAt: '2026-10-26T08:00:00Z' }).status, 'done');
});

import { applyGitPath, gitPathApplied } from '../src/ui/setupApi.ts';
import { roleAllowed, isAuthorAgent } from '../src/tools/common.ts';
import { parseConfig } from '../src/config.ts';

test('company-wide tool access: one profile with every tool bound to the company, role profiles are unbound; switching back works', async () => {
  const api = fakeApi(); const tools = TOOLS.map((t) => ({ name: t.name, cls: t.cls, role: t.role }));
  await applyToolProfiles(api.call, 'c', { author: ['a1'], reviewer: ['r1'], operator: [] }, tools, 'roles');
  assert.equal(await toolAccessApplied(api.call, 'c', { author: ['a1'], reviewer: ['r1'], operator: [] }, 'company'), false);
  const r = await applyToolProfiles(api.call, 'c', { author: ['a1'], reviewer: ['r1'], operator: [] }, tools, 'company');
  assert.equal(r.created.length, 1); assert.equal(r.unbound, 2, 'agent bindings of the role profiles are removed');
  const all = api.profiles.find((p) => p.profileKey === 'azure-devops-all');
  assert.equal(all.entries.length, TOOLS.length); assert.deepEqual(all.bindings.map((b: any) => [b.targetType, b.targetId]), [['company', 'c']]);
  assert.equal(await toolAccessApplied(api.call, 'c', { author: [], reviewer: [], operator: [] }, 'company'), true, 'no per-agent role needed');
  const again = await applyToolProfiles(api.call, 'c', { author: [], reviewer: [], operator: [] }, tools, 'company'); assert.equal(again.bound + again.unbound, 0);
  await applyToolProfiles(api.call, 'c', { author: ['a1'], reviewer: ['r1'], operator: [] }, tools, 'roles');
  assert.equal(api.profiles.find((p) => p.profileKey === 'azure-devops-all').bindings.length, 0, 'company binding removed in roles mode');
});

test('git PATH goes into the default environment once, keeps other variables, and cleans project overrides it made earlier', async () => {
  const api = fakeApi(); const bin = '/opt/paperclip-ado/bin';
  assert.equal(await gitPathApplied(api.call, 'c', bin), false);
  const r = await applyGitPath(api.call, 'c', bin, '/usr/bin:/home/x/.local/bin');
  assert.equal(api.envs[0].envVars.PATH.value, '/opt/paperclip-ado/bin:/usr/bin:/home/x/.local/bin');
  assert.deepEqual(Object.keys(api.projects[0].env), ['KEEP'], 'the project override is removed, other variables stay');
  assert.ok(r.changed >= 2);
  assert.equal(await gitPathApplied(api.call, 'c', bin), true);
  assert.equal((await applyGitPath(api.call, 'c', bin, '/usr/bin')).changed, 0, 'idempotent');
  api.projects[1].env = { PATH: { type: 'plain', value: '/usr/bin' } };
  assert.equal(await gitPathApplied(api.call, 'c', bin), false, 'a project with its own PATH without the wrapper defeats it');
});

test('everyone-is-author makes any agent that is not a reviewer an author, including agents that do not exist yet', () => {
  const A = 'a0000000-0000-4000-8000-0000000000a1', R = 'a0000000-0000-4000-8000-0000000000b1', NEW = 'a0000000-0000-4000-8000-0000000000c1';
  const base = { organization: { name: 'acme' }, projects: [{ projectId: '11111111-1111-4111-8111-111111111111', name: 'P' }], roles: { authorAgentIds: [A], reviewerAgentIds: [R] } };
  const strict = parseConfig(base), open = parseConfig({ ...base, roles: { ...base.roles, everyoneIsAuthor: true } });
  assert.equal(isAuthorAgent(strict, NEW), false); assert.equal(roleAllowed(strict, NEW, 'author'), false);
  assert.equal(isAuthorAgent(open, NEW), true); assert.equal(roleAllowed(open, NEW, 'author'), true);
  assert.equal(isAuthorAgent(open, R), false, 'reviewers stay reviewers'); assert.equal(roleAllowed(open, R, 'reviewer'), true); assert.equal(roleAllowed(open, NEW, 'reviewer'), false);
  assert.equal(roleAllowed(open, NEW, 'operator'), false, 'operators are never implicit');
});

test('PAT mode: the organization step is done without a tenant', () => {
  const base = { orgName: 'acme', tenantId: 'pat', identitiesConfigured: false, identitiesOk: false, projects: 0, authors: 0, reviewers: 0, roleOverlap: false, toolsApplied: null, chipsOn: null, permissionReport: null, webhookConfigured: false, git: undefined } as Parameters<typeof computeSteps>[0];
  const org = computeSteps(base).find((x) => x.key === 'org')!;
  assert.equal(org.status, 'done');
  assert.match(org.detail, /personal access tokens/);
});

test('webhook secrets: only newly created values are revealed, existing ones are never invented', async () => {
  const { webhookReveal, reusedSecretKeys, reuseNotice } = await import('../src/ui/setup.ts');
  const key = (k: string) => ({ id: k, key: k, name: k });
  assert.deepEqual(webhookReveal([], 't', 'p').reveal, { token: 't', password: 'p' });
  assert.deepEqual(webhookReveal([key('azure-devops-webhook-token')], 't', 'p').reveal, { password: 'p' });
  assert.deepEqual(webhookReveal([key('azure-devops-webhook-password')], 't', 'p').reveal, { token: 't' });
  const both = webhookReveal([key('azure-devops-webhook-token'), key('azure-devops-webhook-password')], 't', 'p');
  assert.equal(both.reveal, null); assert.match(both.message, /not shown again/);
  assert.deepEqual(reusedSecretKeys([key('a'), key('b')], ['b', 'c']), ['b']);
  assert.match(reuseNotice(['author-pat']), /OLD values.*author-pat/);
});

import { dutyOn, dutyWarnings, setDuty } from '../src/ui/matrix.ts';
test('agents table: author and reviewer exclude each other', () => {
  let c: any = setDuty({}, 'author', 'a1', true);
  assert.equal(dutyOn(c, 'author', 'a1'), true);
  c = setDuty(c, 'reviewer', 'a1', true);
  assert.equal(dutyOn(c, 'author', 'a1'), false);
  assert.equal(dutyOn(c, 'reviewer', 'a1'), true);
});
test('agents table: a verdict makes the agent a reviewer, and removing the reviewer removes the verdict', () => {
  let c: any = setDuty({ roles: { authorAgentIds: ['a1'] } }, 'qa', 'a1', true);
  assert.equal(dutyOn(c, 'reviewer', 'a1'), true);
  assert.equal(dutyOn(c, 'author', 'a1'), false);
  assert.deepEqual(c.approval.requiredVerdictFunctions, ['qa', 'security']);
  c = setDuty(c, 'reviewer', 'a1', false);
  assert.equal(dutyOn(c, 'qa', 'a1'), false);
});
test('agents table: setting a duty twice does not duplicate and turning it off keeps the rest', () => {
  let c: any = setDuty({}, 'operator', 'a1', true);
  c = setDuty(c, 'operator', 'a1', true);
  assert.deepEqual(c.roles.operatorAgentIds, ['a1']);
  c = setDuty(c, 'operator', 'a1', false);
  assert.deepEqual(c.roles.operatorAgentIds, []);
});
test('agents table: warns about an incomplete approver set and an approver who also gives a verdict', () => {
  assert.match(dutyWarnings({ approval: { mode: 'approvers' } }, {}).join(' '), /at least one approver/);
  const c: any = setDuty(setDuty({ approval: { mode: 'approvers' } }, 'approver', 'x', true), 'qa', 'x', true);
  assert.match(dutyWarnings(c, { x: 'Xena' }).join(' '), /Xena is an approver and also gives a verdict/);
  assert.deepEqual(dutyWarnings({ approval: { mode: 'board' } }, {}), []);
});

test('config keeps more than 20 allowed pipeline queues', () => {
  const ids = Array.from({ length: 30 }, (_, i) => i + 1);
  const cfg = parseConfig({ organization: { name: 'x' }, pipelines: { allowedQueueIds: ids } });
  assert.deepEqual(cfg.pipelines.allowedQueueIds, ids);
});
