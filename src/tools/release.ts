import type { DeployApprovalConfig } from '../config.ts';
import { requireDeployApproval } from '../platform-admin.ts';
import { neutralize } from '../sanitize.ts';
import type { Service } from '../service.ts';
import type { ReleaseTuple, ReleaseVerdictRow } from '../store.ts';
import { audit, ToolError, type RunCtx, type ToolOut } from './common.ts';

const functions = ['techlead', 'qa', 'security'] as const;
type ReleaseFunction = typeof functions[number];
export interface ReleaseAttestationConfig extends ReleaseTuple {
  releaseVerdictFunctions: DeployApprovalConfig['releaseVerdictFunctions'];
  approverAgentIds: string[];
  requesterAgentId?: string;
}
const includes = (ids: string[], agentId: string) => ids.some(id => id.toLowerCase() === agentId.toLowerCase());
const assigned = (cfg: Pick<DeployApprovalConfig, 'releaseVerdictFunctions'>, agentId: string) => functions.filter(fn => includes(cfg.releaseVerdictFunctions[fn], agentId));

export function releaseAttestation(rows: ReleaseVerdictRow[], cfg: ReleaseAttestationConfig): Record<ReleaseFunction, { satisfied: boolean; verdictIds: string[] }> {
  const latest = new Map<string, ReleaseVerdictRow>();
  for (const row of rows) {
    if (row.companyId !== cfg.companyId || row.releaseIssueId !== cfg.releaseIssueId || row.sourceCommit !== cfg.sourceCommit || row.imageDigest !== cfg.imageDigest || row.buildId !== cfg.buildId) continue;
    const key = row.agentId.toLowerCase();
    const prev = latest.get(key);
    if (!prev || row.createdAt > prev.createdAt || (row.createdAt === prev.createdAt && (row.vote < prev.vote || (row.vote === prev.vote && row.id > prev.id)))) latest.set(key, row);
  }
  return Object.fromEntries(functions.map(fn => {
    const verdictIds = [...latest.values()].filter(row => row.fn === fn && row.vote >= 5 && assigned(cfg, row.agentId).length === 1 && includes(cfg.releaseVerdictFunctions[fn], row.agentId) && !includes(cfg.approverAgentIds, row.agentId) && row.agentId.toLowerCase() !== cfg.requesterAgentId?.toLowerCase()).map(row => row.id).sort();
    return [fn, { satisfied: verdictIds.length > 0, verdictIds }];
  })) as Record<ReleaseFunction, { satisfied: boolean; verdictIds: string[] }>;
}

export function makeReleaseTools(svc: Service) {
  return { ado_release_verdict_post: async (a: Record<string, unknown>, run: RunCtx): Promise<ToolOut> => {
    const { host } = svc;
    const cfg = await svc.cfg(run.companyId);
    const deploy = cfg.platformAdmin.deployApproval;
    let issueId: string | undefined;
    try {
      requireDeployApproval(cfg);
      if (includes(deploy.approverAgentIds, run.agentId)) throw new ToolError('requester_forbidden', 'The deploy approver cannot attest a release');
      const fns = assigned(deploy, run.agentId);
      if (fns.length !== 1) throw new ToolError('role_denied', 'The agent must hold exactly one release verdict function');
      if (Object.keys(a).some(key => !['releaseIssue', 'sourceCommit', 'imageReference', 'buildId', 'vote', 'summary'].includes(key)) ||
          typeof a.releaseIssue !== 'string' || !/^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/.test(a.releaseIssue) ||
          typeof a.sourceCommit !== 'string' || !/^[0-9a-fA-F]{40}$/.test(a.sourceCommit) ||
          typeof a.imageReference !== 'string' || !a.imageReference.startsWith(`${deploy.imageRepository}@`) || !/^sha256:[0-9a-fA-F]{64}$/.test(a.imageReference.slice(deploy.imageRepository.length + 1)) ||
          typeof a.buildId !== 'number' || !Number.isSafeInteger(a.buildId) || a.buildId < 1 ||
          typeof a.vote !== 'number' || ![10, 5, 0, -5, -10].includes(a.vote) ||
          typeof a.summary !== 'string' || a.summary.trim().length < 1 || a.summary.length > 2000 || a.summary.includes('\u0000')) throw new ToolError('bad_request', 'Give a release identifier, exact commit, repository digest, positive build id, vote and summary (1..2000 characters)');
      const issue = await host.issues.findByIdentifier(run.companyId, a.releaseIssue);
      if (!issue) throw new ToolError('release_not_found', 'The release issue was not found');
      issueId = issue.id;
      const row: ReleaseVerdictRow = { id: host.uuid(), companyId: run.companyId, releaseIssueId: issue.id, sourceCommit: a.sourceCommit.toLowerCase(), imageDigest: a.imageReference.slice(deploy.imageRepository.length + 1).toLowerCase(), buildId: a.buildId, fn: fns[0]!, agentId: run.agentId, vote: a.vote, summaryRedacted: neutralize(a.summary), runId: run.runId, createdAt: new Date(host.now()).toISOString() };
      await svc.store.addReleaseVerdict(row);
      await audit(svc, host, run, 'ado_release_verdict_post', { verdictId: row.id, sourceCommit: row.sourceCommit, imageDigest: row.imageDigest, buildId: row.buildId }, 'ok', issue.id, { function: row.fn, vote: row.vote });
      await host.issues.comment(run.companyId, issue.id, `Release verdict: ${row.fn} vote ${row.vote}; commit ${row.sourceCommit.slice(0, 7)}; digest ${row.imageDigest.slice(0, 19)}; build ${row.buildId}.`);
      return { content: `Release verdict recorded: ${row.fn} vote ${row.vote}.`, data: { verdictId: row.id, releaseIssueId: issue.id, sourceCommit: row.sourceCommit, imageDigest: row.imageDigest, buildId: row.buildId, function: row.fn, vote: row.vote } };
    } catch (e) {
      await audit(svc, host, run, 'ado_release_verdict_post', {}, e instanceof ToolError ? `refused:${e.code}` : 'failed', issueId);
      throw e;
    }
  } };
}
