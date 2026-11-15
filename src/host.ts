// The slice of the Paperclip plugin context the core logic needs, as a port. worker.ts adapts ctx to it; tests supply a fake.
import type { Config, SecretRef } from './config.ts';
import type { FetchPort } from './ado/client.ts';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}
export interface IssueRef { id: string; identifier: string; status: string; assigneeAgentId: string | null; title?: string }
export interface InteractionState { id: string; status: string; outcome: string | null; resolvedByUserId: string | null; resolvedByAgentId: string | null }
export interface Logger { info(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void; error(m: string, meta?: Record<string, unknown>): void }

export interface Host {
  db: Db;
  now(): number;
  uuid(): string;
  log: Logger;
  fetch: FetchPort;
  /** Parsed config of one company, or null when the company has none. */
  config(companyId: string): Promise<Config | null>;
  /** Companies that have a saved configuration. */
  configuredCompanies(): Promise<string[]>;
  resolveSecret(companyId: string, ref: SecretRef, configPath: string): Promise<string>;
  issues: {
    findByIdentifier(companyId: string, key: string): Promise<IssueRef | null>;
    get(companyId: string, issueId: string): Promise<IssueRef | null>;
    /** Issues that block this issue (blocked-by relations). Throws when they cannot be read: callers must fail closed. Needs the issue.relations.read capability. */
    blockers(companyId: string, issueId: string): Promise<Array<{ id: string; identifier: string; status: string }>>;
    inProgressFor(companyId: string, agentId: string): Promise<IssueRef[]>;
    /** The issue this heartbeat run has checked out (an in-progress issue of the agent), if any. */
    checkedOutBy(companyId: string, agentId: string, runId: string): Promise<IssueRef | null>;
    comment(companyId: string, issueId: string, body: string): Promise<void>;
    setStatus(companyId: string, issueId: string, status: string): Promise<void>;
    wake(companyId: string, issueId: string, reason: string, idempotencyKey: string): Promise<void>;
    requestConfirmation(companyId: string, issueId: string, c: { prompt: string; detailsMarkdown: string; acceptLabel: string; rejectLabel: string; idempotencyKey: string; /** Only a person may resolve the card. */ humanOnly?: boolean }): Promise<{ id: string }>;
    interaction(companyId: string, issueId: string, interactionId: string): Promise<InteractionState | null>;
    /** A new issue under `parentId` for one agent. Needs the issues.create capability; callers fall back to a comment when it throws. */
    createChild(companyId: string, parentId: string, c: { title: string; description: string; assigneeAgentId: string }): Promise<IssueRef>;
  };
  metric(name: string, value: number, tags?: Record<string, string>): void;
  /** Test hook / loop override. */
  clientDeps?: { apiBase?: (cfg: Config) => string; loginBase?: string; sleep?: (ms: number) => Promise<void> };
}
