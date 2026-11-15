// Shared guards for the platform administration tools (environment checks, Secure File pipeline permissions). Default deny:
// nothing is allowed unless the master switch is on AND the name or id is listed in the settings.
import type { Config } from './config.ts';
import { ToolError } from './tools/common.ts';

export function requirePlatformAdmin(cfg: Config): void {
  if (cfg.platformAdmin?.enabled !== true) throw new ToolError('not_enabled', 'Platform administration is switched off (platformAdmin.enabled in the plugin settings)');
}
export function requireDeployApproval(cfg: Config): void {
  requirePlatformAdmin(cfg);
  if (!cfg.platformAdmin.deployApproval.enabled || !cfg.identities.admin) throw new ToolError('not_enabled', 'Deploy approval requires platformAdmin.deployApproval.enabled and identities.admin');
}
const deployEnabled = (cfg: Config): boolean => cfg.platformAdmin.enabled && cfg.platformAdmin.deployApproval.enabled && !!cfg.identities.admin;
export function allowDeployPipeline(cfg: Config, id: number): boolean { return deployEnabled(cfg) && Number.isSafeInteger(id) && id > 0 && cfg.platformAdmin.deployApproval.deployPipelineIds.includes(id); }
export function allowBuildPipeline(cfg: Config, id: number): boolean { return deployEnabled(cfg) && Number.isSafeInteger(id) && id > 0 && cfg.platformAdmin.deployApproval.buildPipelineIds.includes(id); }
export function allowDeployEnvironment(cfg: Config, name: string): boolean { return deployEnabled(cfg) && !/prod/i.test(name) && listed(cfg.platformAdmin.environments, name) && listed(cfg.platformAdmin.deployApproval.environments, name); }
const listed = (list: string[], name: string): boolean => typeof name === 'string' && name.length > 0 && list.includes(name);
/** Exact, case-sensitive name match. An empty list allows nothing. */
export function allowEnvironment(cfg: Config, name: string): boolean { return listed(cfg.platformAdmin.environments, name); }
export function allowSecureFile(cfg: Config, name: string): boolean { return listed(cfg.platformAdmin.secureFiles, name); }
export function allowPipeline(cfg: Config, id: number): boolean { return Number.isInteger(id) && id > 0 && cfg.platformAdmin.pipelineIds.includes(id); }
export function variableGroupOf(cfg: Config, name: string) { return cfg.platformAdmin.enabled ? cfg.platformAdmin.variableGroups.find((g) => g.name === name) : undefined; }
