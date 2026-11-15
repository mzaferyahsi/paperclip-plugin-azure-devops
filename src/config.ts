// Per-company configuration (spec §4). Secrets appear only as { type: 'secret_ref', secretId } objects and are resolved at call time.
import { DEFAULT_PATTERNS, type LinkPatterns } from './links.ts';

export interface SecretRef { type: 'secret_ref'; secretId: string; version?: string | number }
export interface IdentityConfig {
  kind: 'entra' | 'pat';
  tenantId?: string; clientId?: string; clientIdRef?: SecretRef; clientSecretRef?: SecretRef; patRef?: SecretRef;
  tokenScope?: string; expectedDisplayName?: string;
}
export interface ProjectConfig {
  projectId: string; name: string; repositories: string[]; protectedBranches: string[]; protectedPipelines: number[]; paperclipProjectId?: string;
  /** Repositories where a merge needs a staging gate verdict (posted with ado_pr_gate_post) before approval. */
  stagingGateRepositories: string[];
}
/** Who approves completing a pull request. `board`: a person on the issue (today's behaviour). `approvers`: agents listed here, after the plugin has checked the facts. `both`: an approver first, then a person. */
export interface ApprovalConfig {
  mode: 'board' | 'approvers' | 'both';
  approverAgentIds: string[];
  requiredVerdictFunctions: string[];
  verdictFunctions: Record<string, string[]>;
  stagingGateAgentIds: string[];
  minVerdictVote: 5 | 10;
  requirePipelinePolicy: boolean;
  /** Repositories with no pipeline to wait for (documentation, handbook): an approved Build policy is not required there. */
  pipelineOptionalRepositories: string[];
  requireNoActiveThreads: boolean;
  allowUnknownAuthor: boolean;
  approvalTimeoutMinutes: number;
  escalateToBoardOnTimeout: boolean;
  /** When no configured approver may decide a given pull request (each is its author, its proposer or a verdict giver), the board decides at once. */
  boardWhenNoApprover: boolean;
  /** Runs of protected pipelines (or on protected branches) are decided by approver agents instead of a person; abandoning a pull request stays with a person. */
  pipelineRunsByApprovers: boolean;
}
export interface DeployApprovalConfig {
  enabled: boolean; approverAgentIds: string[]; environments: string[]; deployPipelineIds: number[]; buildPipelineIds: number[];
  imageRepository: string; sourceBranch: string; releaseVerdictFunctions: { techlead: string[]; qa: string[]; security: string[] };
  /** One human approval for the staging build (140) and deploy (138) pair. Off by default. */
  releaseBundle: ReleaseBundleConfig;
}
export interface ReleaseBundleConfig {
  enabled: boolean; projectId: string; buildPipelineId: number; deployPipelineId: number; proposerAgentIds: string[]; approverUserIds: string[];
  ttlMinutes: number; proposalTtlMinutes: number; maxBuildAttempts: number; maxCommitsBehind: number; maxProposalsPerAgentPerDay: number;
}
/** One Library variable group an agent may ask to create or change. `secrets` binds each allowed secret variable name to a Paperclip secret; agents never choose the secret. */
export interface VariableGroupAdmin { name: string; secrets: Record<string, SecretRef> }
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;
export const PLATFORM_ADMIN_MAX_GROUPS = 20;
export const PLATFORM_ADMIN_MAX_SECRETS_PER_GROUP = 30;
export interface PlatformAdminConfig { enabled: boolean; environments: string[]; secureFiles: string[]; pipelineIds: number[]; variableGroups: VariableGroupAdmin[]; deployApproval: DeployApprovalConfig }
export const PLATFORM_ADMIN_MAX_NAMES = 20;
export const PLATFORM_ADMIN_MAX_PIPELINES = 50;
/** Name shape for environments and secure files (same as NAME in tools/explore.ts, without the wildcard use). */
export const ADMIN_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._*-]{0,99}$/;
export interface Config {
  organization: { name: string; hostForm: 'dev.azure.com' | 'visualstudio.com' };
  projects: ProjectConfig[];
  identities: { author: IdentityConfig; reviewer: IdentityConfig; /** Optional, separate, least-privilege identity used only by the platform administration tools. */ admin?: IdentityConfig };
  /** Governed environment-check and Secure File permission tools. Everything is denied unless `enabled` and the name or id is listed. */
  platformAdmin: PlatformAdminConfig;
  webhook: { hookTokenRef?: SecretRef; basicAuthUser: string; basicAuthPasswordRef?: SecretRef; publicBaseUrl?: string };
  roles: { authorAgentIds: string[]; reviewerAgentIds: string[]; operatorAgentIds: string[]; everyoneIsAuthor: boolean };
  review: { publishStatus: boolean; statusGenre: string; statusName: string; requireIndependentReviewer: boolean; maxThreadsPerReview: number };
  links: LinkPatterns & { autoLinkFromBranch: boolean; autoLinkFromTitle: boolean };
  limits: { maxToolCallsPerRun: number };
  /** Agents may ask to create or change pipeline definitions / repositories (always confirmed by a person). Off by default. */
  pipelines: { allowCreate: boolean; allowedQueueIds: number[] };
  repos: { allowCreate: boolean };
  /** Install the Azure DevOps tools natively for agents on the opencode adapter, which the host gives no plugin tools. */
  agentTools: { opencodeNative: boolean };
  approval: ApprovalConfig;
  reconcile: { activeIntervalMinutes: number; dormantIntervalMinutes: number; maxCallsPerTickPerIdentity: number; paused: boolean };
}
/** Roles stored in connection_state (DB CHECK allows only these two). The admin identity is deliberately not a Role. */
export type Role = 'author' | 'reviewer';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const int = (v: unknown, d: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : d);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const secret = (v: unknown): SecretRef | undefined => {
  const r = rec(v);
  return r.type === 'secret_ref' && typeof r.secretId === 'string' ? { type: 'secret_ref', secretId: r.secretId, version: r.version as string | number | undefined } : undefined;
};
const identity = (v: unknown): IdentityConfig => {
  const r = rec(v);
  return {
    kind: r.kind === 'pat' ? 'pat' : 'entra', tenantId: str(r.tenantId) || undefined, clientId: str(r.clientId) || undefined, clientIdRef: secret(r.clientIdRef),
    clientSecretRef: secret(r.clientSecretRef), patRef: secret(r.patRef), tokenScope: str(r.tokenScope) || undefined,
    expectedDisplayName: str(r.expectedDisplayName) || undefined,
  };
};

function parseDeployApproval(v: unknown): DeployApprovalConfig {
  const bad = () => { throw new Error('Invalid platformAdmin.deployApproval configuration'); };
  if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v))) bad();
  const d = rec(v);
  const keys = ['enabled', 'approverAgentIds', 'environments', 'deployPipelineIds', 'buildPipelineIds', 'imageRepository', 'sourceBranch', 'releaseVerdictFunctions', 'releaseBundle'];
  if (Object.keys(d).some(k => !keys.includes(k))) bad();
  if (d.enabled !== undefined && typeof d.enabled !== 'boolean') bad();
  for (const key of ['imageRepository', 'sourceBranch']) if (d[key] !== undefined && (typeof d[key] !== 'string' || (d[key] as string).length > 200)) bad();
  const array = <T>(value: unknown, max: number, kind: 'string' | 'number'): T[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== kind)) { bad(); return []; }
    return value as T[];
  };
  const vf = rec(d.releaseVerdictFunctions);
  if (d.releaseVerdictFunctions !== undefined && (!d.releaseVerdictFunctions || typeof d.releaseVerdictFunctions !== 'object' || Array.isArray(d.releaseVerdictFunctions))) bad();
  if (Object.keys(vf).some(k => !['techlead', 'qa', 'security'].includes(k))) bad();
  return {
    enabled: d.enabled === true, approverAgentIds: array<string>(d.approverAgentIds, 1, 'string'), environments: array<string>(d.environments, 20, 'string'),
    deployPipelineIds: array<number>(d.deployPipelineIds, 3, 'number'), buildPipelineIds: array<number>(d.buildPipelineIds, 3, 'number'),
    imageRepository: str(d.imageRepository), sourceBranch: str(d.sourceBranch),
    releaseVerdictFunctions: { techlead: array<string>(vf.techlead, 20, 'string'), qa: array<string>(vf.qa, 20, 'string'), security: array<string>(vf.security, 20, 'string') },
    releaseBundle: parseReleaseBundle(d.releaseBundle),
  };
}

export const RELEASE_BUNDLE_DEFAULTS = { ttlMinutes: 120, proposalTtlMinutes: 30, maxBuildAttempts: 2, maxCommitsBehind: 5, maxProposalsPerAgentPerDay: 5 } as const;
/** Strict parser: unknown keys and wrong types throw. Range and cross-field violations are returned by validateConfig; nothing is clamped. */
function parseReleaseBundle(v: unknown): ReleaseBundleConfig {
  const bad = () => { throw new Error('Invalid platformAdmin.deployApproval.releaseBundle configuration'); };
  if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v))) bad();
  const r = rec(v);
  const keys = ['enabled', 'projectId', 'buildPipelineId', 'deployPipelineId', 'proposerAgentIds', 'approverUserIds', 'ttlMinutes', 'proposalTtlMinutes', 'maxBuildAttempts', 'maxCommitsBehind', 'maxProposalsPerAgentPerDay'];
  if (Object.keys(r).some(k => !keys.includes(k))) bad();
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') bad();
  if (r.projectId !== undefined && (typeof r.projectId !== 'string' || r.projectId.length > 100)) bad();
  const num = (key: string, d: number): number => { const x = r[key]; if (x === undefined) return d; if (typeof x !== 'number' || !Number.isSafeInteger(x)) { bad(); return d; } return x; };
  const list = (key: string, max: number): string[] => { const x = r[key]; if (x === undefined) return []; if (!Array.isArray(x) || x.length > max || x.some(y => typeof y !== 'string' || y.length > 200)) { bad(); return []; } return x as string[]; };
  return {
    enabled: r.enabled === true, projectId: str(r.projectId), buildPipelineId: num('buildPipelineId', 0), deployPipelineId: num('deployPipelineId', 0),
    proposerAgentIds: list('proposerAgentIds', 5), approverUserIds: list('approverUserIds', 10),
    ttlMinutes: num('ttlMinutes', RELEASE_BUNDLE_DEFAULTS.ttlMinutes), proposalTtlMinutes: num('proposalTtlMinutes', RELEASE_BUNDLE_DEFAULTS.proposalTtlMinutes),
    maxBuildAttempts: num('maxBuildAttempts', RELEASE_BUNDLE_DEFAULTS.maxBuildAttempts), maxCommitsBehind: num('maxCommitsBehind', RELEASE_BUNDLE_DEFAULTS.maxCommitsBehind),
    maxProposalsPerAgentPerDay: num('maxProposalsPerAgentPerDay', RELEASE_BUNDLE_DEFAULTS.maxProposalsPerAgentPerDay),
  };
}

function parsePlatformAdmin(v: unknown): PlatformAdminConfig {
  const p = rec(v);
  return {
    enabled: p.enabled === true, deployApproval: parseDeployApproval(p.deployApproval),
    environments: strs(p.environments).slice(0, 200), secureFiles: strs(p.secureFiles).slice(0, 200),
    pipelineIds: Array.isArray(p.pipelineIds) ? (p.pipelineIds as unknown[]).slice(0, 200).filter((x): x is number => typeof x === 'number') : [],
    variableGroups: Array.isArray(p.variableGroups) ? (p.variableGroups as unknown[]).slice(0, 100).map((g) => {
      const r = rec(g); const secrets: Record<string, SecretRef> = {};
      for (const [k, v] of Object.entries(rec(r.secrets))) { const s = secret(v); if (s) secrets[k] = s; else secrets[k] = { type: 'secret_ref', secretId: '' }; }
      return { name: str(r.name), secrets };
    }) : [],
  };
}

const FN = /^[a-z][a-z0-9_-]{0,30}$/;
function parseApproval(v: unknown): ApprovalConfig {
  const a = rec(v); const vf = rec(a.verdictFunctions);
  const verdictFunctions: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(vf)) if (FN.test(k.toLowerCase())) verdictFunctions[k.toLowerCase()] = strs(ids);
  const fns = strs(a.requiredVerdictFunctions).map((x) => x.toLowerCase()).filter((x) => FN.test(x));
  return {
    mode: a.mode === 'approvers' || a.mode === 'both' ? a.mode : 'board',
    approverAgentIds: strs(a.approverAgentIds), requiredVerdictFunctions: Array.isArray(a.requiredVerdictFunctions) ? fns : ['qa', 'security'], verdictFunctions,
    stagingGateAgentIds: strs(a.stagingGateAgentIds), minVerdictVote: a.minVerdictVote === 10 ? 10 : 5,
    requirePipelinePolicy: bool(a.requirePipelinePolicy, true), pipelineOptionalRepositories: strs(a.pipelineOptionalRepositories).filter((x) => x.length <= 100), requireNoActiveThreads: bool(a.requireNoActiveThreads, true), allowUnknownAuthor: bool(a.allowUnknownAuthor, false),
    approvalTimeoutMinutes: int(a.approvalTimeoutMinutes, 240, 15, 10080), escalateToBoardOnTimeout: bool(a.escalateToBoardOnTimeout, true), boardWhenNoApprover: bool(a.boardWhenNoApprover, true), pipelineRunsByApprovers: bool(a.pipelineRunsByApprovers, true),
  };
}

export function parseConfig(raw: unknown): Config {
  const c = rec(raw);
  const org = rec(c.organization), wh = rec(c.webhook), roles = rec(c.roles), rev = rec(c.review), links = rec(c.links), rec_ = rec(c.reconcile), ids = rec(c.identities);
  return {
    organization: { name: str(org.name), hostForm: org.hostForm === 'visualstudio.com' ? 'visualstudio.com' : 'dev.azure.com' },
    projects: (Array.isArray(c.projects) ? c.projects : []).map((p) => {
      const r = rec(p);
      return {
        projectId: str(r.projectId), name: str(r.name), repositories: strs(r.repositories),
        protectedBranches: Array.isArray(r.protectedBranches) ? strs(r.protectedBranches) : ['refs/heads/main'],
        protectedPipelines: Array.isArray(r.protectedPipelines) ? r.protectedPipelines.filter((x): x is number => Number.isInteger(x)) : [],
        stagingGateRepositories: strs(r.stagingGateRepositories),
        paperclipProjectId: str(r.paperclipProjectId) || undefined,
      };
    }),
    identities: { author: identity(ids.author), reviewer: identity(ids.reviewer), ...(ids.admin && typeof ids.admin === 'object' && !Array.isArray(ids.admin) ? { admin: identity(ids.admin) } : {}) },
    platformAdmin: parsePlatformAdmin(c.platformAdmin),
    webhook: { hookTokenRef: secret(wh.hookTokenRef), basicAuthUser: str(wh.basicAuthUser, 'paperclip'), basicAuthPasswordRef: secret(wh.basicAuthPasswordRef), publicBaseUrl: str(wh.publicBaseUrl) || undefined },
    roles: { authorAgentIds: strs(roles.authorAgentIds), reviewerAgentIds: strs(roles.reviewerAgentIds), operatorAgentIds: strs(roles.operatorAgentIds), everyoneIsAuthor: roles.everyoneIsAuthor === true },
    review: { publishStatus: bool(rev.publishStatus, true), statusGenre: str(rev.statusGenre, 'paperclip'), statusName: str(rev.statusName, 'review'), requireIndependentReviewer: bool(rev.requireIndependentReviewer, true), maxThreadsPerReview: int(rev.maxThreadsPerReview, 40, 1, 200) },
    links: { branchPattern: str(links.branchPattern, DEFAULT_PATTERNS.branchPattern), titleTokenPattern: str(links.titleTokenPattern, DEFAULT_PATTERNS.titleTokenPattern), autoLinkFromBranch: bool(links.autoLinkFromBranch, true), autoLinkFromTitle: bool(links.autoLinkFromTitle, true) },
    pipelines: { allowCreate: rec(c.pipelines).allowCreate === true, allowedQueueIds: Array.isArray(rec(c.pipelines).allowedQueueIds) ? (rec(c.pipelines).allowedQueueIds as unknown[]).filter((x): x is number => Number.isInteger(x) && (x as number) > 0).slice(0, 200) : [] },
    repos: { allowCreate: rec(c.repos).allowCreate === true },
    agentTools: { opencodeNative: rec(c.agentTools).opencodeNative === true },
    approval: parseApproval(c.approval),
    limits: { maxToolCallsPerRun: int(rec(c.limits).maxToolCallsPerRun, 60, 5, 1000) },
    reconcile: { activeIntervalMinutes: int(rec_.activeIntervalMinutes, 10, 5, 1440), dormantIntervalMinutes: int(rec_.dormantIntervalMinutes, 360, 60, 10080), maxCallsPerTickPerIdentity: int(rec_.maxCallsPerTickPerIdentity, 60, 5, 150), paused: bool(rec_.paused, false) },
  };
}

/** Semantic checks beyond the JSON schema. Returns errors (block save) and warnings. */
export function validateConfig(cfg: Config): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(cfg.organization.name)) errors.push('organization.name is required (letters, digits, hyphen)');
  // Saving without projects is how discovery starts (the identities must be saved before projects can be listed): a warning, not an error.
  if (cfg.projects.length === 0) warnings.push('No project is selected yet: nothing is in scope until you discover and tick projects');
  const seen = new Set<string>();
  for (const p of cfg.projects) {
    if (!UUID.test(p.projectId)) errors.push(`project "${p.name || p.projectId}" has an invalid project id`);
    if (seen.has(p.projectId.toLowerCase())) errors.push(`project ${p.projectId} is listed twice`);
    seen.add(p.projectId.toLowerCase());
  }
  const check = (role: Role | 'admin') => {
    const i = cfg.identities[role]!;
    if (i.kind === 'entra') {
      if (!i.tenantId || !UUID.test(i.tenantId)) errors.push(`${role}: tenantId is required for entra`);
      if (i.clientId ? !UUID.test(i.clientId) : !i.clientIdRef) errors.push(`${role}: a client id (or a secret holding it) is required for entra`);
      if (!i.clientSecretRef) errors.push(`${role}: clientSecretRef is required for entra`);
    } else if (!i.patRef) errors.push(`${role}: patRef is required for pat`);
  };
  check('author'); check('reviewer');
  const a = cfg.identities.author, r = cfg.identities.reviewer;
  const same = (a.kind === 'entra' && r.kind === 'entra' && ((a.clientId && a.clientId === r.clientId) || (a.clientIdRef && r.clientIdRef && a.clientIdRef.secretId === r.clientIdRef.secretId))) || (a.patRef && r.patRef && a.patRef.secretId === r.patRef.secretId);
  if (same) errors.push('author and reviewer must be different identities');
  const bound = new Map<string, string>();
  const bind = (name: string, ref?: SecretRef) => { if (!ref) return; const prev = bound.get(ref.secretId); if (prev) errors.push(`${name} reuses the secret of ${prev}; use a dedicated secret`); else bound.set(ref.secretId, name); };
  bind('webhook.hookTokenRef', cfg.webhook.hookTokenRef); bind('webhook.basicAuthPasswordRef', cfg.webhook.basicAuthPasswordRef);
  const pa = cfg.platformAdmin;
  if (cfg.identities.admin) check('admin');
  else if (pa.enabled) errors.push('platformAdmin is enabled but identities.admin is not configured');
  const nameList = (label: string, list: string[]) => {
    if (list.length > PLATFORM_ADMIN_MAX_NAMES) errors.push(`platformAdmin.${label} may hold at most ${PLATFORM_ADMIN_MAX_NAMES} names`);
    const lower = new Set<string>();
    for (const n of list) {
      if (!ADMIN_NAME.test(n) || n.includes('*')) errors.push(`platformAdmin.${label} holds an invalid name`);
      else if (lower.has(n.toLowerCase())) errors.push(`platformAdmin.${label} lists a name twice`);
      lower.add(n.toLowerCase());
    }
  };
  nameList('environments', pa.environments); nameList('secureFiles', pa.secureFiles);
  nameList('variableGroups', pa.variableGroups.map((g) => g.name));
  if (pa.pipelineIds.length > PLATFORM_ADMIN_MAX_PIPELINES) errors.push(`platformAdmin.pipelineIds may hold at most ${PLATFORM_ADMIN_MAX_PIPELINES} ids`);
  if (pa.pipelineIds.some((x) => !Number.isInteger(x) || x <= 0)) errors.push('platformAdmin.pipelineIds must be positive integers');
  if (new Set(pa.pipelineIds).size !== pa.pipelineIds.length) errors.push('platformAdmin.pipelineIds lists an id twice');
  if (pa.enabled && !pa.environments.length && !pa.secureFiles.length) warnings.push('platformAdmin is enabled but no environment or secure file is listed: nothing is allowed');
  for (const role of ['author', 'reviewer', 'admin'] as const) { if (!cfg.identities[role]) continue; const id = cfg.identities[role]!; bind(`${role}.clientSecretRef`, id.clientSecretRef); bind(`${role}.clientIdRef`, id.clientIdRef); bind(`${role}.patRef`, id.patRef); }
  for (const g of pa.variableGroups) {
    const keys = Object.keys(g.secrets);
    if (keys.length > PLATFORM_ADMIN_MAX_SECRETS_PER_GROUP) errors.push(`platformAdmin.variableGroups: a group may bind at most ${PLATFORM_ADMIN_MAX_SECRETS_PER_GROUP} secret variables`);
    for (const k of keys) {
      if (!VARIABLE_NAME.test(k)) errors.push('platformAdmin.variableGroups holds an invalid secret variable name');
      else if (!g.secrets[k]!.secretId) errors.push(`platformAdmin.variableGroups: secret variable ${k} needs a valid secret reference`);
      else if (bound.has(g.secrets[k]!.secretId)) errors.push(`platformAdmin.variableGroups: secret variable ${k} reuses the secret of ${bound.get(g.secrets[k]!.secretId)}; the plugin's own credentials may not be pushed into Azure DevOps`);
    }
  }
  if (!cfg.webhook.hookTokenRef) warnings.push('No webhook token configured: events are ignored, the reconciler is the only source (latency up to the active interval)');
  for (const id of [...cfg.roles.authorAgentIds, ...cfg.roles.reviewerAgentIds, ...cfg.roles.operatorAgentIds]) if (!UUID.test(id)) errors.push(`role list holds an invalid agent id: ${id}`);
  const both = cfg.roles.authorAgentIds.filter((x) => cfg.roles.reviewerAgentIds.includes(x));
  if (both.length && cfg.review.requireIndependentReviewer) errors.push('an agent cannot be both author and reviewer while independent review is required');
  const ap = cfg.approval;
  for (const id of [...ap.approverAgentIds, ...ap.stagingGateAgentIds, ...Object.values(ap.verdictFunctions).flat()]) if (!UUID.test(id)) errors.push(`approval lists an invalid agent id: ${id}`);
  if (ap.mode !== 'board') {
    if (!ap.approverAgentIds.length) errors.push('approval: choose at least one approver agent, or set the mode back to board');
    for (const f of ap.requiredVerdictFunctions) if (!(ap.verdictFunctions[f] ?? []).length) errors.push(`approval: no agent is assigned to the "${f}" verdict function`);
    if (!ap.requiredVerdictFunctions.length) errors.push('approval: at least one verdict function (for example qa) must be required');
    const verdictAgents = new Set(Object.values(ap.verdictFunctions).flat().map((x) => x.toLowerCase()));
    const seenIn = new Map<string, string>();
    for (const [fn, ids] of Object.entries(ap.verdictFunctions)) for (const id of ids) { const k = id.toLowerCase(); const prev = seenIn.get(k); if (prev && prev !== fn) errors.push(`approval: one agent cannot give both the ${prev} and the ${fn} verdict`); seenIn.set(k, fn); }
    for (const id of ap.approverAgentIds) if (verdictAgents.has(id.toLowerCase())) errors.push('approval: an approver cannot also give a verdict (separation of duties)');
    for (const id of verdictAgents) if (!cfg.roles.reviewerAgentIds.some((x) => x.toLowerCase() === id)) errors.push('approval: every verdict agent must be a reviewer');
    if (cfg.projects.some((p) => p.stagingGateRepositories.length) && !ap.stagingGateAgentIds.length) errors.push('approval: a staging gate is set for a repository but no agent may post the gate result');
  }
  const da = pa.deployApproval;
  const deployError = (message: string) => errors.push(`platformAdmin.deployApproval: ${message}`);
  const sameAgent = (ids: string[], id: string) => ids.some(x => x.toLowerCase() === id.toLowerCase());
  if (da.enabled && (!pa.enabled || !cfg.identities.admin)) deployError('enabled requires platformAdmin.enabled and identities.admin');
  if (da.approverAgentIds.length > 1 || (da.enabled && da.approverAgentIds.length !== 1)) deployError('choose exactly one approver when enabled');
  nameList('deployApproval.environments', da.environments);
  if (da.environments.some(n => /prod/i.test(n) || !pa.environments.includes(n))) deployError('environments must be non-production exact members of platformAdmin.environments');
  const assigned = new Set<string>();
  for (const [fn, ids] of Object.entries(da.releaseVerdictFunctions)) {
    if (ids.length > 20 || (da.enabled && !ids.length)) deployError(`invalid ${fn} agent count`);
    for (const id of ids) {
      if (!UUID.test(id)) deployError('invalid verdict agent id');
      if (assigned.has(id.toLowerCase())) deployError('each agent may hold only one release function, without duplicates');
      assigned.add(id.toLowerCase());
      if (!sameAgent(cfg.roles.reviewerAgentIds, id)) deployError('every verdict agent must be a reviewer');
    }
  }
  for (const id of da.approverAgentIds) {
    if (!UUID.test(id)) deployError('invalid approver agent id');
    if (cfg.roles.everyoneIsAuthor || sameAgent(cfg.roles.authorAgentIds, id) || sameAgent(cfg.roles.reviewerAgentIds, id) || assigned.has(id.toLowerCase()) || Object.values(ap.verdictFunctions).some(ids => sameAgent(ids, id))) deployError('approver must not be an author, reviewer or verdict agent');
  }
  for (const ids of [da.deployPipelineIds, da.buildPipelineIds]) if (ids.length > 3 || (da.enabled && !ids.length) || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) deployError('pipeline lists require 1..3 distinct positive integers when enabled');
  if (da.enabled && !da.environments.length) deployError('at least one environment is required');
  if ((da.enabled || da.imageRepository) && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(da.imageRepository)) deployError('imageRepository must be an exact registry/repository, without tags, digests or wildcards');
  if ((da.enabled || da.sourceBranch) && (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(da.sourceBranch) || da.sourceBranch.includes('..') || da.sourceBranch.endsWith('/'))) deployError('sourceBranch must be an exact refs/heads branch');
  validateReleaseBundle(cfg, errors);
  return { ok: errors.length === 0, errors, warnings };
}

function validateReleaseBundle(cfg: Config, errors: string[]): void {
  const rb = cfg.platformAdmin.deployApproval.releaseBundle, da = cfg.platformAdmin.deployApproval;
  const e = (m: string) => errors.push(`platformAdmin.deployApproval.releaseBundle: ${m}`);
  const within = (name: string, x: number, min: number, max: number) => { if (!Number.isInteger(x) || x < min || x > max) e(`${name} must be between ${min} and ${max}`); };
  within('ttlMinutes', rb.ttlMinutes, 1, 120); within('proposalTtlMinutes', rb.proposalTtlMinutes, 1, 60); within('maxBuildAttempts', rb.maxBuildAttempts, 1, 2);
  within('maxCommitsBehind', rb.maxCommitsBehind, 0, 20); within('maxProposalsPerAgentPerDay', rb.maxProposalsPerAgentPerDay, 1, 20);
  if (!rb.enabled) return;
  if (!cfg.platformAdmin.enabled || !da.enabled || !cfg.identities.admin) e('enabled requires platformAdmin.enabled, deployApproval.enabled and identities.admin');
  if (!cfg.identities.author) e('enabled requires identities.author');
  const project = cfg.projects.find(p => p.projectId.toLowerCase() === rb.projectId.toLowerCase());
  if (!rb.projectId || !project) e('projectId must be one of projects[]');
  for (const [name, id, list] of [['buildPipelineId', rb.buildPipelineId, da.buildPipelineIds], ['deployPipelineId', rb.deployPipelineId, da.deployPipelineIds]] as const) {
    if (!Number.isSafeInteger(id) || id <= 0) e(`${name} is required`);
    else {
      if (!list.includes(id)) e(`${name} must be in deployApproval.${name === 'buildPipelineId' ? 'buildPipelineIds' : 'deployPipelineIds'}`);
      if (cfg.projects.some(p => p.protectedPipelines.includes(id))) e(`${name} is a protected pipeline; a bundle never lifts a protected pipeline`);
    }
  }
  if (rb.buildPipelineId === rb.deployPipelineId) e('buildPipelineId and deployPipelineId must differ');
  if (da.sourceBranch !== 'refs/heads/main') e('deployApproval.sourceBranch must be refs/heads/main');
  if (!rb.proposerAgentIds.length || rb.proposerAgentIds.length > 5) e('proposerAgentIds needs 1 to 5 agents');
  if (new Set(rb.proposerAgentIds.map(x => x.toLowerCase())).size !== rb.proposerAgentIds.length) e('proposerAgentIds lists an agent twice');
  const releaseAgents = Object.values(da.releaseVerdictFunctions).flat();
  for (const id of rb.proposerAgentIds) {
    const is = (ids: string[]) => ids.some(x => x.toLowerCase() === id.toLowerCase());
    if (!UUID.test(id)) e('proposerAgentIds holds an invalid agent id');
    if (!is(cfg.roles.authorAgentIds)) e('every proposer must be in roles.authorAgentIds');
    if (is(cfg.roles.reviewerAgentIds) || is(releaseAgents) || is(da.approverAgentIds)) e('a proposer cannot be a reviewer, a release attestation agent or the deploy approver');
  }
  if (!rb.approverUserIds.length || rb.approverUserIds.some(x => !x.trim())) e('approverUserIds is required and non-empty (the host does not expose the board role of a person who accepts a card)');
}
