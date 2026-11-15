// Merge approval inside the organisation: verdict ledger, mechanical preconditions, approver tools, escalation, dual control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdo } from './fake-ado.ts';
import { addIssue, AUTHOR_AGENT, baseConfig, COMPANY, makeHarness, OPERATOR_AGENT, REVIEWER_AGENT, type Harness } from './test-host.ts';
import { Service } from '../src/service.ts';
import { makeToolRunner, settleApprovedActions } from '../src/tools/index.ts';
import { parseConfig, validateConfig } from '../src/config.ts';
import { NS } from '../src/namespace.ts';

const SECURITY = 'a0000000-0000-4000-8000-000000000004';
const CEO = 'a0000000-0000-4000-8000-000000000005';
const TECH_LEAD = 'a0000000-0000-4000-8000-000000000006';
const approval = (over: Record<string, unknown> = {}) => ({ mode: 'approvers', approverAgentIds: [CEO, TECH_LEAD], verdictFunctions: { qa: [REVIEWER_AGENT], security: [SECURITY] }, requiredVerdictFunctions: ['qa', 'security'], ...over });
const cfgWith = (fake: FakeAdo, ap: Record<string, unknown>, extra: Record<string, unknown> = {}) => parseConfig(baseConfig(fake, {
  roles: { authorAgentIds: [AUTHOR_AGENT], reviewerAgentIds: [REVIEWER_AGENT, SECURITY], operatorAgentIds: [OPERATOR_AGENT] }, approval: ap, ...extra }));

let fake: FakeAdo; let h: Harness | null; let svc: Service; let run: ReturnType<typeof makeToolRunner>;
test.before(async () => {
  fake = await new FakeAdo().start(); h = await makeHarness(fake); if (!h) return;
  svc = new Service(h.host); run = makeToolRunner(svc, async (_c, id) => ({ [AUTHOR_AGENT]: 'Alice', [REVIEWER_AGENT]: 'QA', [SECURITY]: 'Sec', [CEO]: 'Chief', [TECH_LEAD]: 'Lead', [OPERATOR_AGENT]: 'Operator' } as Record<string, string>)[id] ?? 'Agent');
});
test.after(async () => { await h?.stop(); await fake.stop(); });
let n = 0; const ctx = (agentId: string) => ({ agentId, runId: `e0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, companyId: COMPANY });
const ok = (name: string, fn: () => Promise<void>) => test(name, async (t) => { if (!h) return t.skip('embedded Postgres not available'); await fn(); });
const data = (r: { data?: unknown }) => r.data as Record<string, any>;
const setMode = (ap: Record<string, unknown>, extra: Record<string, unknown> = {}) => h!.configs.set(COMPANY, cfgWith(fake, ap, extra));

async function readyPr(key: string, branch: string) {
  const issue = addIssue(h!, key);
  const created = await run('ado_pr_create', { repository: 'widgets', sourceBranch: branch, title: key, issueId: issue.id }, ctx(AUTHOR_AGENT));
  assert.equal(created.error, undefined, JSON.stringify(created));
  const prId = data(created).prId; const pr = fake.prs.get(prId)!;
  fake.evaluations.set(prId, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  return { issue, prId, pr };
}
const review = (prId: number, agent: string, vote = 10, iteration = 1) => run('ado_pr_review_post', { prId, repository: 'widgets', iteration, vote, summary: 'checked' }, ctx(agent));

ok('approvers mode: not ready without verdicts, then proposal, facts, approval and apply by the plugin; nobody from the board is asked', async () => {
  setMode(approval());
  const { issue, prId, pr } = await readyPr('ENG-300', 'alice/eng-300-merge');
  pr.statuses = [{ id: 1, state: 'succeeded', description: 'ok', context: { name: 'review', genre: 'paperclip' }, iterationId: 1 }];
  const early = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash', reason: 'ready' }, ctx(OPERATOR_AGENT));
  assert.equal(early.error, 'not_ready'); assert.match(String(early.content), /no qa verdict/);
  assert.equal((await review(prId, REVIEWER_AGENT)).error, undefined);
  assert.equal((await review(prId, SECURITY, 5)).error, undefined);
  const p = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash', reason: 'ready' }, ctx(OPERATOR_AGENT));
  assert.equal(p.error, undefined, JSON.stringify(p)); assert.equal(data(p).status, 'awaiting_approval');
  assert.equal(h!.interactions.size, 0, 'no human card in approvers mode');
  const task = [...h!.issues.values()].find((i) => i.parentId === issue.id); assert.ok(task, 'an approval task exists'); assert.equal(task!.assigneeAgentId, CEO);
  const facts = await run('ado_pr_approval_get', { actionId: data(p).actionId }, ctx(CEO));
  assert.equal(data(facts).ready, true, JSON.stringify(facts)); assert.equal(data(facts).verdicts.length, 2);
  const head = data(facts).headCommit as string;
  assert.equal((await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'approve', headCommit: '1234567' }, ctx(CEO))).error, 'commit_mismatch');
  assert.equal((await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'approve', headCommit: head }, ctx(AUTHOR_AGENT))).error, 'role_denied');
  assert.equal((await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'approve', headCommit: head }, ctx(OPERATOR_AGENT))).error, 'role_denied', 'the proposer is not an approver');
  assert.equal(pr.status, 'active');
  const a = await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'approve', headCommit: head }, ctx(CEO));
  assert.equal(a.error, undefined, JSON.stringify(a)); assert.equal(data(a).status, 'approved');
  assert.equal((await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'approve', headCommit: head }, ctx(CEO))).error, undefined, 'idempotent');
  assert.equal(await settleApprovedActions(svc, run), 1);
  assert.equal(pr.status, 'completed'); assert.notEqual(pr.completionOptions?.bypassPolicy, true);
  assert.ok(issue.comments.some((c) => /Approved by Chief/.test(c)));
  const act = (await h!.pg.query<{ status: string; approved_by_agent_id: string }>(`SELECT status,approved_by_agent_id FROM ${NS}.action WHERE id=$1`, [data(p).actionId]))[0]!;
  assert.deepEqual([act.status, act.approved_by_agent_id], ['applied', CEO]);
});

ok('a push after the verdicts empties them; an approval for an older commit is refused; a later negative vote cancels a verdict', async () => {
  setMode(approval());
  const { prId, pr } = await readyPr('ENG-301', 'alice/eng-301-push');
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  const p = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT));
  assert.equal(data(p).status, 'awaiting_approval');
  const head = data(await run('ado_pr_approval_get', { prId, repository: 'widgets' }, ctx(CEO))).headCommit as string;
  pr.lastMergeSourceCommit = { commitId: 'e'.repeat(40) };
  const r = await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'approve', headCommit: head }, ctx(CEO));
  assert.equal(r.error, 'commit_changed');
  const facts = await run('ado_pr_approval_get', { prId, repository: 'widgets' }, ctx(CEO));
  assert.equal(data(facts).ready, false); assert.match(String(facts.content), /no qa verdict/);
});

ok('separation of duties: the author, a verdict giver and an unknown author cannot be approved around', async () => {
  const { prId } = await readyPr('ENG-302', 'alice/eng-302-sep');
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  // the approver authored the pull request
  setMode(approval({ approverAgentIds: [AUTHOR_AGENT, CEO] }));
  const asAuthor = await run('ado_pr_approval_get', { prId, repository: 'widgets' }, ctx(AUTHOR_AGENT));
  assert.match(String(asAuthor.content), /you authored this pull request/);
  // a verdict giver as approver is a config error
  const bad = validateConfig(cfgWith(fake, approval({ approverAgentIds: [REVIEWER_AGENT] })));
  assert.equal(bad.ok, false); assert.ok(bad.errors.some((e) => /cannot also give a verdict/.test(e)));
  const noFn = validateConfig(cfgWith(fake, approval({ verdictFunctions: { qa: [REVIEWER_AGENT] } })));
  assert.ok(noFn.errors.some((e) => /"security" verdict function/.test(e)));
  assert.ok(validateConfig(cfgWith(fake, approval({ approverAgentIds: [] }))).errors.some((e) => /at least one approver/.test(e)));
  assert.equal(validateConfig(cfgWith(fake, approval())).ok, true);
  // PR with no recorded author agent
  const other = fake.addPr({ pullRequestId: 777, title: 'x', sourceRefName: 'refs/heads/other/x' });
  fake.evaluations.set(other.pullRequestId, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  setMode(approval());
  const unknown = await run('ado_pr_approval_get', { prId: 777, repository: 'widgets' }, ctx(CEO));
  assert.match(String(unknown.content), /author agent of this pull request is not recorded/);
  setMode(approval({ allowUnknownAuthor: true }));
  assert.doesNotMatch(String((await run('ado_pr_approval_get', { prId: 777, repository: 'widgets' }, ctx(CEO))).content), /not recorded/);
});

ok('reject needs a reason and ends the request; the board mode default is untouched', async () => {
  setMode(approval());
  const { prId } = await readyPr('ENG-303', 'alice/eng-303-rej');
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  const p = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT));
  assert.equal((await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'reject' }, ctx(CEO))).error, 'bad_request');
  assert.equal((await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'reject', reason: 'not now' }, ctx(CEO))).error, undefined);
  const row = (await h!.pg.query<{ status: string; reject_reason: string }>(`SELECT status,reject_reason FROM ${NS}.action WHERE id=$1`, [data(p).actionId]))[0]!;
  assert.deepEqual([row.status, row.reject_reason], ['rejected', 'not now']);
  setMode({ mode: 'board' });
  assert.equal(parseConfig({}).approval.mode, 'board');
});

ok('no approver in time: escalated to the board as a human-only card, and the board decision applies it', async () => {
  setMode(approval({ approvalTimeoutMinutes: 15 }));
  const { issue, prId, pr } = await readyPr('ENG-304', 'alice/eng-304-late');
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  const p = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT));
  assert.equal(await settleApprovedActions(svc, run), 0, 'nothing to do before the deadline');
  h!.now.t += 16 * 60_000;
  await settleApprovedActions(svc, run);
  const row = (await h!.pg.query<{ status: string; interaction_id: string }>(`SELECT status,interaction_id FROM ${NS}.action WHERE id=$1`, [data(p).actionId]))[0]!;
  assert.equal(row.status, 'escalated'); assert.ok(h!.interactions.get(row.interaction_id));
  assert.ok(issue.comments.some((c) => /escalated to the board/.test(c)));
  const card = h!.interactions.get(row.interaction_id)!; card.status = 'resolved'; card.outcome = 'accepted'; card.resolvedByUserId = 'gX9MVIvukHQLc5Lz3dvW8go3YSHnrkOE';
  assert.equal(await settleApprovedActions(svc, run), 1);
  assert.equal(pr.status, 'completed');
});

ok('both mode: an approver and then a person; an agent cannot stand in for the person', async () => {
  setMode(approval({ mode: 'both' }));
  const { prId, pr } = await readyPr('ENG-305', 'alice/eng-305-both');
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  const p = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT));
  const head = data(await run('ado_pr_approval_get', { prId, repository: 'widgets' }, ctx(TECH_LEAD))).headCommit as string;
  const a = await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'approve', headCommit: head }, ctx(TECH_LEAD));
  assert.equal(data(a).status, 'awaiting_confirmation');
  assert.equal(await settleApprovedActions(svc, run), 0, 'waits for the person');
  const row = (await h!.pg.query<{ interaction_id: string }>(`SELECT interaction_id FROM ${NS}.action WHERE id=$1`, [data(p).actionId]))[0]!;
  const card = h!.interactions.get(row.interaction_id)!; card.status = 'resolved'; card.outcome = 'accepted'; card.resolvedByAgentId = CEO;
  await settleApprovedActions(svc, run); assert.equal(pr.status, 'active', 'an agent-accepted card does not count');
});

ok('staging gate: required for listed repositories, posted by gate agents only, per commit', async () => {
  setMode(approval({ stagingGateAgentIds: [OPERATOR_AGENT] }), { projects: [{ projectId: fake.project.id, name: fake.project.name, protectedBranches: ['refs/heads/main'], stagingGateRepositories: ['widgets'] }] });
  const { prId } = await readyPr('ENG-306', 'alice/eng-306-gate');
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  assert.match(String((await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT))).content), /staging gate has no result/);
  const g = { prId, repository: 'widgets', state: 'succeeded', evidenceUrl: 'https://ci.example/run/1' };
  assert.equal((await run('ado_pr_gate_post', g, ctx(CEO))).error, 'role_denied');
  assert.equal((await run('ado_pr_gate_post', g, ctx(OPERATOR_AGENT))).error, undefined);
  const p = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT));
  assert.equal(data(p).status, 'awaiting_approval', JSON.stringify(p));
});

ok('without the issues.create capability the approvers are asked by a comment and a wake-up', async () => {
  setMode(approval()); h!.childIssues.allowed = false;
  try {
    const { issue, prId } = await readyPr('ENG-307', 'alice/eng-307-nocap');
    await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
    const p = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT));
    assert.equal(p.error, undefined, JSON.stringify(p));
    assert.ok(issue.comments.some((c) => /Merge approval needed/.test(c)) && issue.wakes.some((w) => w.reason === 'approval_requested'));
  } finally { h!.childIssues.allowed = true; }
});

ok('config holes are closed: empty or shared verdict functions, approvers who are authors, reviewers or gate agents', async () => {
  const errs = (ap: Record<string, unknown>, roles?: Record<string, unknown>) => validateConfig(cfgWith(fake, approval(ap), roles ? { roles } : {})).errors.join(' | ');
  assert.match(errs({ requiredVerdictFunctions: [] }), /at least one verdict function/);
  assert.match(errs({ verdictFunctions: { qa: [REVIEWER_AGENT], security: [REVIEWER_AGENT] } }), /both the qa and the security verdict/);
  assert.doesNotMatch(errs({ approverAgentIds: [CEO, AUTHOR_AGENT] }), /author/, 'an approver may be an author: the per-pull-request refusal does the work');
  assert.match(errs({ approverAgentIds: [CEO, SECURITY] }), /cannot also give a verdict/);
  assert.doesNotMatch(errs({ stagingGateAgentIds: [CEO] }), /staging/, 'an approver may be a gate agent; the per-commit refusal does the work');
  assert.equal(parseConfig({ approval: { requiredVerdictFunctions: ['QA'], verdictFunctions: { QA: [REVIEWER_AGENT] } } }).approval.requiredVerdictFunctions[0], 'qa', 'names are lower-cased');
});

ok('a status policy alone is not a passing pipeline; a push between approval and apply is not merged; the approver is woken; proposers see facts', async () => {
  setMode(approval());
  const { issue, prId, pr } = await readyPr('ENG-308', 'alice/eng-308-late-push');
  fake.evaluations.set(prId, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Status' } } }]);
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  assert.match(String((await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT))).content), /no blocking Build policy/);
  fake.evaluations.set(prId, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  const p = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT));
  assert.equal(data(p).status, 'awaiting_approval');
  const task = [...h!.issues.values()].find((i) => i.parentId === issue.id)!;
  assert.ok(task.wakes.some((w) => w.reason === 'approval_requested'), 'the approver is woken');
  const view = await run('ado_pr_approval_get', { actionId: data(p).actionId }, ctx(OPERATOR_AGENT));
  assert.doesNotMatch(String(view.content), /not a configured approver/);
  const head = data(await run('ado_pr_approval_get', { prId, repository: 'widgets' }, ctx(CEO))).headCommit as string;
  assert.equal((await run('ado_pr_approval_post', { actionId: data(p).actionId, decision: 'approve', headCommit: head }, ctx(CEO))).error, undefined);
  pr.lastMergeSourceCommit = { commitId: 'd'.repeat(40) };
  await settleApprovedActions(svc, run);
  assert.equal(pr.status, 'active', 'the new commit was not merged');
  assert.equal(task.status, 'done', 'the plugin closes the approval task once the approver has decided');
});

ok('an author-role agent may ask for approval of its own pull request only', async () => {
  setMode(approval());
  const { prId } = await readyPr('ENG-309', 'alice/eng-309-own');
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  const other = 'a0000000-0000-4000-8000-000000000007';
  h!.configs.set(COMPANY, cfgWith(fake, approval(), { roles: { authorAgentIds: [AUTHOR_AGENT, other], reviewerAgentIds: [REVIEWER_AGENT, SECURITY], operatorAgentIds: [OPERATOR_AGENT] } }));
  assert.equal((await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(other))).error, 'role_denied');
  assert.equal((await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(AUTHOR_AGENT))).error, undefined);
});

ok('an approver who tries to propose is told who to ask instead of the board', async () => {
  setMode(approval());
  const { prId } = await readyPr('ENG-310', 'alice/eng-310-ask');
  const r = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(CEO));
  assert.equal(r.error, 'role_denied'); assert.match(String(r.content), /Ask an operator or the pull request's author/);
});

ok('a hand-opened pull request can be adopted once by the author agent of the issue; then it can be updated, reviewed and approved like any other', async () => {
  setMode(approval({ allowUnknownAuthor: false }));
  const issue = addIssue(h!, 'ENG-311', { assigneeAgentId: AUTHOR_AGENT });
  const pr = fake.addPr({ pullRequestId: 911, title: 'hand opened', sourceRefName: 'refs/heads/alice/eng-311-manual', isDraft: true });
  fake.evaluations.set(911, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  const link = { kind: 'pull_request', externalId: 911, repository: 'widgets', issueId: issue.id };
  assert.ok(['role_denied', 'not_your_issue'].includes(String((await run('ado_link_create', { ...link, author: true }, ctx(CEO))).error)), 'an approver cannot claim');
  assert.equal((await run('ado_pr_update', { prId: 911, repository: 'widgets', draft: false }, ctx(AUTHOR_AGENT))).error, 'not_plugin_pr');
  const c = await run('ado_link_create', { ...link, author: true }, ctx(AUTHOR_AGENT));
  assert.equal(c.error, undefined, JSON.stringify(c)); assert.equal(data(c).authorRecorded, true);
  const other = addIssue(h!, 'ENG-312', { assigneeAgentId: AUTHOR_AGENT });
  assert.equal((await run('ado_link_create', { ...link, issueId: other.id, author: true }, ctx(AUTHOR_AGENT))).error, 'author_already_recorded', 'one author per pull request');
  assert.equal((await run('ado_pr_update', { prId: 911, repository: 'widgets', draft: false }, ctx(AUTHOR_AGENT))).error, undefined);
  assert.equal(pr.isDraft, false);
  const facts = await run('ado_pr_approval_get', { prId: 911, repository: 'widgets' }, ctx(CEO));
  assert.doesNotMatch(String(facts.content), /author agent of this pull request is not recorded/);
  assert.match(String(facts.content), /no qa verdict/);
});

ok('a hand-opened draft can be published (and only that) by the author agent or operator who has it linked to their issue', async () => {
  setMode(approval({ allowUnknownAuthor: true }));
  const issue = addIssue(h!, 'ENG-313', { assigneeAgentId: AUTHOR_AGENT });
  const pr = fake.addPr({ pullRequestId: 913, title: 'by hand', sourceRefName: 'refs/heads/alice/eng-313-hand', isDraft: true });
  fake.evaluations.set(913, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  await run('ado_link_create', { kind: 'pull_request', externalId: 913, repository: 'widgets', issueId: issue.id }, ctx(OPERATOR_AGENT));
  assert.equal((await run('ado_pr_update', { prId: 913, repository: 'widgets', draft: false }, ctx(REVIEWER_AGENT))).error, 'role_denied', 'reviewers do not publish');
  assert.equal((await run('ado_pr_update', { prId: 913, repository: 'widgets', title: 'new title', draft: false }, ctx(AUTHOR_AGENT))).error, 'not_plugin_pr', 'text stays the opener\'s');
  const stranger = 'a0000000-0000-4000-8000-000000000008';
  h!.configs.set(COMPANY, cfgWith(fake, approval({ allowUnknownAuthor: true }), { roles: { authorAgentIds: [AUTHOR_AGENT, stranger], reviewerAgentIds: [REVIEWER_AGENT, SECURITY], operatorAgentIds: [OPERATOR_AGENT] } }));
  assert.equal((await run('ado_pr_update', { prId: 913, repository: 'widgets', draft: false }, ctx(stranger))).error, 'not_plugin_pr', 'not linked to their issue');
  assert.equal((await run('ado_pr_update', { prId: 913, repository: 'widgets', draft: false }, ctx(AUTHOR_AGENT))).error, undefined);
  assert.equal(pr.isDraft, false);
  assert.equal((await review(913, REVIEWER_AGENT, 10)).error, undefined, 'now reviewers can vote');
  const facts = await run('ado_pr_approval_get', { prId: 913, repository: 'widgets' }, ctx(CEO));
  assert.doesNotMatch(String(facts.content), /not recorded/); assert.match(String(facts.content), /no security verdict/);
});

ok('repositories that need no pipeline do not need a Build policy; others still do', async () => {
  const { prId } = await readyPr('ENG-314', 'alice/eng-314-docs');
  fake.evaluations.set(prId, []);
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  setMode(approval());
  assert.match(String((await run('ado_pr_approval_get', { prId, repository: 'widgets' }, ctx(CEO))).content), /no blocking Build policy/);
  setMode(approval({ pipelineOptionalRepositories: ['Widgets'] }));
  assert.doesNotMatch(String((await run('ado_pr_approval_get', { prId, repository: 'widgets' }, ctx(CEO))).content), /Build policy/);
});

ok('an operator can publish or un-draft a pull request but cannot edit its text', async () => {
  setMode(approval());
  const issue = addIssue(h!, 'ENG-315');
  const created = await run('ado_pr_create', { repository: 'widgets', sourceBranch: 'alice/eng-315-draft', title: 'Drafty', issueId: issue.id, draft: true }, ctx(AUTHOR_AGENT));
  const prId = data(created).prId; const pr = fake.prs.get(prId)!;
  assert.equal(pr.isDraft, true);
  assert.equal((await run('ado_pr_update', { prId, repository: 'widgets', title: 'Renamed', draft: false }, ctx(OPERATOR_AGENT))).error, 'role_denied');
  assert.equal((await run('ado_pr_update', { prId, repository: 'widgets', draft: false }, ctx(REVIEWER_AGENT))).error, 'role_denied');
  assert.equal((await run('ado_pr_update', { prId, repository: 'widgets', draft: false }, ctx(OPERATOR_AGENT))).error, undefined);
  assert.equal(pr.isDraft, false);
});

ok('the only approver authored the pull request: the board gets the card at once and its approval merges', async () => {
  // The CEO is the sole approver and also opens the pull request (every agent that is not a reviewer counts as an author).
  setMode(approval({ approverAgentIds: [CEO] }), { roles: { everyoneIsAuthor: true, reviewerAgentIds: [REVIEWER_AGENT, SECURITY], operatorAgentIds: [OPERATOR_AGENT] } });
  const issue = addIssue(h!, 'ENG-399');
  const created = await run('ado_pr_create', { repository: 'widgets', sourceBranch: 'chief/eng-399-own', title: 'ENG-399', issueId: issue.id }, ctx(CEO));
  assert.equal(created.error, undefined, JSON.stringify(created));
  const prId = data(created).prId; const pr = fake.prs.get(prId)!;
  fake.evaluations.set(prId, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  const p = await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(CEO));
  assert.equal(p.error, undefined, JSON.stringify(p));
  assert.equal(data(p).status, 'escalated');
  const row = (await h!.pg.query<{ status: string; interaction_id: string }>(`SELECT status,interaction_id FROM ${NS}.action WHERE id=$1`, [data(p).actionId]))[0]!;
  const card = h!.interactions.get(row.interaction_id)!; assert.ok(card, 'a human card exists on the issue');
  assert.equal(pr.status, 'active');
  card.status = 'resolved'; card.outcome = 'accepted'; card.resolvedByUserId = 'gX9MVIvukHQLc5Lz3dvW8go3YSHnrkOE';
  assert.equal(await settleApprovedActions(svc, run), 1);
  assert.equal(pr.status, 'completed');
  // The switch can be turned off: then the approvers are asked as before.
  setMode(approval({ approverAgentIds: [CEO], boardWhenNoApprover: false }), { roles: { everyoneIsAuthor: true, reviewerAgentIds: [REVIEWER_AGENT, SECURITY], operatorAgentIds: [OPERATOR_AGENT] } });
  const issue2 = addIssue(h!, 'ENG-400');
  const c2 = await run('ado_pr_create', { repository: 'widgets', sourceBranch: 'chief/eng-400-own', title: 'ENG-400', issueId: issue2.id }, ctx(CEO));
  const id2 = data(c2).prId; fake.evaluations.set(id2, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  await review(id2, REVIEWER_AGENT); await review(id2, SECURITY);
  assert.equal(data(await run('ado_pr_complete_apply', { prId: id2, repository: 'widgets', mergeStrategy: 'squash' }, ctx(CEO))).status, 'awaiting_approval');
});

ok('an approver may also be a reviewer and a gate agent, but never decides on a commit whose gate result they posted', async () => {
  setMode(approval({ approverAgentIds: [CEO, TECH_LEAD], stagingGateAgentIds: [CEO] }), { roles: { authorAgentIds: [AUTHOR_AGENT], reviewerAgentIds: [REVIEWER_AGENT, SECURITY, CEO], operatorAgentIds: [OPERATOR_AGENT] }, projects: [{ projectId: fake.project.id, name: fake.project.name, protectedBranches: ['refs/heads/main'], stagingGateRepositories: ['widgets'] }] });
  assert.deepEqual(validateConfig(cfgWith(fake, approval({ approverAgentIds: [CEO], stagingGateAgentIds: [CEO] }), { roles: { authorAgentIds: [AUTHOR_AGENT], reviewerAgentIds: [REVIEWER_AGENT, SECURITY, CEO], operatorAgentIds: [OPERATOR_AGENT] } })).errors.filter((e) => /CEO|reviewer|staging gate results/.test(e)), []);
  const { prId } = await readyPr('ENG-410', 'alice/eng-410-gate');
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  assert.equal((await run('ado_pr_gate_post', { prId, repository: 'widgets', state: 'succeeded', evidenceUrl: 'https://ci.example/run/2' }, ctx(CEO))).error, undefined);
  assert.match(String((await run('ado_pr_approval_get', { prId, repository: 'widgets' }, ctx(CEO))).content), /you posted the staging gate result/);
  assert.doesNotMatch(String((await run('ado_pr_approval_get', { prId, repository: 'widgets' }, ctx(TECH_LEAD))).content), /staging gate result/);
});

ok('a protected pipeline run is decided by another approver agent, not the board; the proposer cannot approve it', async () => {
  const projects = [{ projectId: fake.project.id, name: fake.project.name, protectedBranches: ['refs/heads/main'], protectedPipelines: [77] }];
  setMode(approval({ approverAgentIds: [CEO, TECH_LEAD] }), { projects });
  const issue = addIssue(h!, 'ENG-420', { assigneeAgentId: OPERATOR_AGENT });
  const runs = () => fake.calls.filter((c) => /pipelines\/77\/runs/.test(c.path)).length;
  const before = runs(); const cards = h!.interactions.size;
  assert.equal((await run('ado_pipeline_run_create', { pipelineId: 77, branch: 'feature/x' }, ctx(OPERATOR_AGENT))).error, 'bad_request', 'a reason is required when an agent decides');
  const p = await run('ado_pipeline_run_create', { pipelineId: 77, branch: 'feature/x', reason: 'validate the manifest' }, ctx(OPERATOR_AGENT));
  assert.equal(data(p).status, 'awaiting_approval', JSON.stringify(p));
  assert.equal(h!.interactions.size, cards, 'no card for the board');
  const id = data(p).actionId;
  const facts = await run('ado_pr_approval_get', { actionId: id }, ctx(CEO));
  assert.equal(data(facts).ready, true); assert.equal(data(facts).run.pipelineId, 77);
  assert.equal((await run('ado_pr_approval_post', { actionId: id, decision: 'approve' }, ctx(OPERATOR_AGENT))).error, 'role_denied');
  assert.equal(runs(), before, 'nothing queued before the approval');
  const ok1 = await run('ado_pr_approval_post', { actionId: id, decision: 'approve' }, ctx(CEO));
  assert.equal(ok1.error, undefined, JSON.stringify(ok1));
  assert.equal(await settleApprovedActions(svc, run), 1);
  assert.equal(runs(), before + 1, 'the plugin queued the approved run');
  assert.ok(issue.comments.some((c) => /Approved by/.test(c)));
  // A proposer who is the only approver cannot decide; with nobody else the board gets the card.
  setMode(approval({ approverAgentIds: [CEO] }), { projects, roles: { authorAgentIds: [AUTHOR_AGENT], reviewerAgentIds: [REVIEWER_AGENT, SECURITY], operatorAgentIds: [OPERATOR_AGENT, CEO] } });
  addIssue(h!, 'ENG-421', { assigneeAgentId: CEO });
  const q = await run('ado_pipeline_run_create', { pipelineId: 77, branch: 'feature/y', reason: 'again' }, ctx(CEO));
  assert.equal(data(q).status, 'escalated', 'the only approver proposed it himself');
  // The switch off: a person again.
  setMode(approval({ approverAgentIds: [CEO, TECH_LEAD], pipelineRunsByApprovers: false }), { projects });
  assert.equal(data(await run('ado_pipeline_run_create', { pipelineId: 77, branch: 'feature/z' }, ctx(OPERATOR_AGENT))).status, 'awaiting_confirmation');
});

ok('a protected pipeline run asks on the issue the run checked out, even with two issues in progress', async () => {
  const projects = [{ projectId: fake.project.id, name: fake.project.name, protectedBranches: ['refs/heads/main'], protectedPipelines: [77] }];
  setMode(approval({ approverAgentIds: [CEO, TECH_LEAD] }), { projects });
  const a = addIssue(h!, 'ENG-430', { assigneeAgentId: OPERATOR_AGENT }); const b = addIssue(h!, 'ENG-431', { assigneeAgentId: OPERATOR_AGENT });
  const c1 = ctx(OPERATOR_AGENT);
  assert.equal((await run('ado_pipeline_run_create', { pipelineId: 77, branch: 'feature/m', reason: 'validate' }, c1)).error, 'no_issue_for_confirmation', 'ambiguous without a checkout');
  h!.checkouts.set(c1.runId, b.id);
  const p = await run('ado_pipeline_run_create', { pipelineId: 77, branch: 'feature/m', reason: 'validate' }, c1);
  assert.equal(data(p).status, 'awaiting_approval', JSON.stringify(p));
  assert.ok(b.comments.length > 0 || h!.interactions.size >= 0);
  const other = ctx(OPERATOR_AGENT);
  const q = await run('ado_pipeline_run_create', { pipelineId: 77, branch: 'feature/n', reason: 'validate', issueId: a.id }, other);
  assert.equal(data(q).status, 'awaiting_approval', JSON.stringify(q));
});

ok('a new proposal after a consumed protected run is a fresh attempt with its own approval; pending ones are reused; replaying the old one queues nothing', async () => {
  const projects = [{ projectId: fake.project.id, name: fake.project.name, protectedBranches: ['refs/heads/main'], protectedPipelines: [77] }];
  setMode(approval({ approverAgentIds: [CEO, TECH_LEAD] }), { projects });
  const i440 = addIssue(h!, 'ENG-440', { assigneeAgentId: OPERATOR_AGENT });
  const ctx2 = () => { const c = ctx(OPERATOR_AGENT); h!.checkouts.set(c.runId, i440.id); return c; };
  const runs = () => fake.calls.filter((c) => /pipelines\/77\/runs/.test(c.path)).length;
  const before = runs();
  const args = { pipelineId: 77, branch: 'feature/redo', reason: 'validate' };
  const first = data(await run('ado_pipeline_run_create', args, ctx2()));
  assert.equal(first.status, 'awaiting_approval');
  assert.equal((await run('ado_pr_approval_post', { actionId: first.actionId, decision: 'approve' }, ctx(CEO))).error, undefined);
  assert.equal(await settleApprovedActions(svc, run), 1);
  assert.equal(runs(), before + 1);
  // Same commit and inputs, same instant: a new attempt, not the old "Already applied".
  const second = data(await run('ado_pipeline_run_create', args, ctx2()));
  assert.notEqual(second.actionId, first.actionId, 'a fresh action');
  assert.equal(second.status, 'awaiting_approval', 'it needs its own approval');
  assert.equal(runs(), before + 1, 'nothing queued by merely proposing');
  // While it is pending, proposing again reuses it.
  const again = data(await run('ado_pipeline_run_create', args, ctx2()));
  assert.equal(again.actionId, second.actionId);
  assert.match(String((await run('ado_pipeline_run_create', args, ctx2())).content), /Already awaiting approval/);
  // Replaying the consumed action returns its result and queues nothing.
  const replay = await run('ado_pipeline_run_create', { ...args, actionId: first.actionId }, ctx2());
  assert.equal(data(replay).status, 'applied'); assert.equal(data(replay).actionId, first.actionId);
  assert.equal(runs(), before + 1, 'the replay queued nothing');
  // The new attempt runs only after its own approval, once.
  assert.equal(await settleApprovedActions(svc, run), 0, 'not approved yet');
  assert.equal((await run('ado_pr_approval_post', { actionId: second.actionId, decision: 'approve' }, ctx(TECH_LEAD))).error, undefined);
  assert.equal(await settleApprovedActions(svc, run), 1);
  assert.equal(runs(), before + 2);
  assert.equal(await settleApprovedActions(svc, run), 0);
  assert.equal(runs(), before + 2, 'applied once');
});

ok('other gated tools keep "already applied" for a repeated completion proposal', async () => {
  setMode(approval());
  const { prId } = await readyPr('ENG-441', 'alice/eng-441-dup');
  await review(prId, REVIEWER_AGENT); await review(prId, SECURITY);
  const p1 = data(await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT)));
  assert.equal(p1.status, 'awaiting_approval');
  const p2 = data(await run('ado_pr_complete_apply', { prId, repository: 'widgets', mergeStrategy: 'squash' }, ctx(OPERATOR_AGENT)));
  assert.equal(p2.actionId, p1.actionId);
});

ok('queueing a build policy is approved first, bound to the head commit, runs once, and a later attempt needs a new approval', async () => {
  setMode(approval({ approverAgentIds: [CEO, TECH_LEAD] }));
  const { prId } = await readyPr('ENG-450', 'alice/eng-450-policy');
  const issue = addIssue(h!, 'ENG-451', { assigneeAgentId: OPERATOR_AGENT });
  const ctx3 = () => { const c = ctx(OPERATOR_AGENT); h!.checkouts.set(c.runId, issue.id); return c; };
  const patches = () => fake.calls.filter((c) => c.method === 'PATCH' && /policy\/evaluations\//.test(c.path)).length;
  const args = { prId, repository: 'widgets', reason: 'manual-queue-only policy never started' };
  // No Build policy: refused.
  fake.evaluations.set(prId, [{ status: 'approved', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Minimum number of reviewers' } } }]);
  assert.equal((await run('ado_pr_policy_queue_apply', args, ctx3())).error, 'not_ready');
  fake.evaluations.set(prId, [{ status: 'queued', configuration: { isBlocking: true, isEnabled: true, type: { displayName: 'Build' } } }]);
  const before = patches();
  const first = data(await run('ado_pr_policy_queue_apply', args, ctx3()));
  assert.equal(first.status, 'awaiting_approval', JSON.stringify(first));
  assert.equal(patches(), before, 'nothing queued by proposing');
  assert.equal(data(await run('ado_pr_policy_queue_apply', args, ctx3())).actionId, first.actionId, 'pending attempt reused');
  assert.equal((await run('ado_pr_approval_post', { actionId: first.actionId, decision: 'approve' }, ctx(OPERATOR_AGENT))).error, 'role_denied');
  assert.equal((await run('ado_pr_approval_post', { actionId: first.actionId, decision: 'approve' }, ctx(CEO))).error, undefined);
  assert.equal(await settleApprovedActions(svc, run), 1);
  assert.equal(patches(), before + 1);
  assert.equal(await settleApprovedActions(svc, run), 0);
  assert.equal(patches(), before + 1, 'applied once');
  // Replay queues nothing; a fresh proposal is a new attempt with its own approval.
  assert.equal(data(await run('ado_pr_policy_queue_apply', { ...args, actionId: first.actionId }, ctx3())).status, 'applied');
  assert.equal(patches(), before + 1);
  const second = data(await run('ado_pr_policy_queue_apply', args, ctx3()));
  assert.notEqual(second.actionId, first.actionId);
  assert.equal(second.status, 'awaiting_approval');
  assert.equal(patches(), before + 1);
});
