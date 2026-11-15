import { allowEnvironment, allowSecureFile, requirePlatformAdmin } from '../platform-admin.ts';
import { neutralize } from '../sanitize.ts';
import type { Service } from '../service.ts';
import { ToolError, type RunCtx, type ToolOut } from './common.ts';

const short = (s: string, n = 120): string => neutralize(s.replace(/\s+/g, ' ').slice(0, n));
type Args = Record<string, unknown>;

export function makePlatformTools(svc: Service) {
  async function scope(a: Args, run: RunCtx, environment: boolean) {
    const cfg = await svc.cfg(run.companyId);
    requirePlatformAdmin(cfg);
    const names = environment ? cfg.platformAdmin.environments : cfg.platformAdmin.secureFiles;
    const allowed = environment ? allowEnvironment : allowSecureFile;
    if (!names.length || (a.name !== undefined && (typeof a.name !== 'string' || !allowed(cfg, a.name)))) throw new ToolError('resource_not_allowed', 'Resource name is not allowed by platformAdmin');
    const project = svc.projectOf(cfg, typeof a.project === 'string' ? a.project : undefined).projectId;
    const api = svc.admin(run.companyId, cfg).api;
    return { api, project, names: typeof a.name === 'string' ? [a.name] : names, cfg };
  }
  async function environments(a: Args, run: RunCtx) {
    const s = await scope(a, run, true);
    const rows = (await Promise.all(s.names.map((n) => s.api.environments(s.project, n)))).flat().filter((r) => s.names.includes(r.name));
    return { ...s, rows };
  }
  async function secureFiles(a: Args, run: RunCtx) {
    const s = await scope(a, run, false);
    const rows = (await Promise.all(s.names.map((n) => s.api.secureFiles(s.project, n)))).flat().filter((r) => s.names.includes(r.name));
    return { ...s, rows };
  }
  async function resolveSecureFile(a: Args, run: RunCtx) {
    const s = await secureFiles(a, run);
    if (a.secureFileId !== undefined && (typeof a.secureFileId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(a.secureFileId))) throw new ToolError('bad_request', 'Invalid secureFileId');
    if (a.secureFileId === undefined && a.name === undefined) throw new ToolError('bad_request', 'secureFileId or name is required');
    const hits = s.rows.filter((r) => a.secureFileId === undefined || r.id === a.secureFileId);
    if (hits.length !== 1) throw new ToolError('resource_not_allowed', 'Secure file id does not resolve to one allowed name');
    const row = await s.api.secureFile(s.project, hits[0]!.id);
    if (row.id !== hits[0]!.id || row.name !== hits[0]!.name || !allowSecureFile(s.cfg, row.name)) throw new ToolError('resource_not_allowed', 'Secure file is not allowed');
    return { ...s, row };
  }
  const metadata = (r: { id: string; name: string; createdOn?: string; modifiedOn?: string; createdBy?: string }) => ({ id: short(r.id), name: short(r.name), createdOn: r.createdOn ? short(r.createdOn) : null, modifiedOn: r.modifiedOn ? short(r.modifiedOn) : null, createdBy: r.createdBy ? short(r.createdBy) : null });
  const permissions = (p: { allPipelines?: { authorized?: boolean }; pipelines?: Array<{ id?: number; authorized?: boolean }> }) => ({ allPipelines: p.allPipelines?.authorized === true, pipelines: (p.pipelines ?? []).map((p) => ({ id: p.id, authorized: p.authorized === true })) });

  async function environmentFind(a: Args, run: RunCtx): Promise<ToolOut> {
    const { rows } = await environments(a, run);
    return { content: `${rows.length} allowed environment(s).`, data: { environments: rows.map((r) => ({ id: r.id, name: short(r.name) })) } };
  }
  async function environmentGet(a: Args, run: RunCtx): Promise<ToolOut> {
    const s = await environments(a, run);
    if (a.environmentId !== undefined && (typeof a.environmentId !== 'number' || !Number.isInteger(a.environmentId) || a.environmentId < 1)) throw new ToolError('bad_request', 'Invalid environmentId');
    if (a.environmentId === undefined && a.name === undefined) throw new ToolError('bad_request', 'environmentId or name is required');
    const hits = s.rows.filter((r) => a.environmentId === undefined || r.id === a.environmentId);
    if (hits.length !== 1) throw new ToolError('resource_not_allowed', 'Environment id does not resolve to one allowed name');
    const row = await s.api.environment(s.project, hits[0]!.id);
    if (row.id !== hits[0]!.id || row.name !== hits[0]!.name || !allowEnvironment(s.cfg, row.name)) throw new ToolError('resource_not_allowed', 'Environment is not allowed');
    const checks = await s.api.pipelineChecks(s.project, 'environment', String(row.id));
    const perm = await s.api.pipelinePermissions(s.project, 'environment', String(row.id));
    return { content: 'Allowed environment checks and pipeline authorization.', data: { id: row.id, name: short(row.name), checks: checks.map((c) => ({ id: c.id, type: { id: short(c.type.id ?? ''), name: short(c.type.name ?? '') }, disabled: c.isDisabled === true, timeout: c.timeout,
      ...(c.settings ? { settings: { approvers: c.settings.approvers.map((p) => ({ id: short(p.id ?? ''), displayName: short(p.displayName ?? '') })), executionOrder: short(c.settings.executionOrder ?? ''), minRequiredApprovers: c.settings.minRequiredApprovers, requesterCannotBeApprover: c.settings.requesterCannotBeApprover } } : {}) })), ...permissions(perm) } };
  }
  async function secureFileFind(a: Args, run: RunCtx): Promise<ToolOut> {
    const { rows } = await secureFiles(a, run);
    return { content: `${rows.length} allowed secure file(s). Metadata only.`, data: { secureFiles: rows.map(metadata) } };
  }
  async function secureFileGet(a: Args, run: RunCtx): Promise<ToolOut> {
    const { row } = await resolveSecureFile(a, run);
    return { content: 'Secure file metadata only.', data: metadata(row) };
  }
  async function secureFilePipelinePermissionGet(a: Args, run: RunCtx): Promise<ToolOut> {
    const s = await resolveSecureFile(a, run);
    return { content: 'Secure file pipeline authorization.', data: permissions(await s.api.pipelinePermissions(s.project, 'securefile', s.row.id)) };
  }
  return { ado_environment_find: environmentFind, ado_environment_get: environmentGet, ado_securefile_find: secureFileFind, ado_securefile_get: secureFileGet, ado_securefile_pipeline_permission_get: secureFilePipelinePermissionGet };
}
