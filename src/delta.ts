// Pure change detection between two PR snapshots (spec 6.5: one function serves webhook and reconciler, so both produce the same effects).
import type { PrSnapshot } from './ado/model.ts';

export type PrEvent =
  | { type: 'iteration'; iteration: number; first: boolean }
  | { type: 'build_failed'; policy: string }
  | { type: 'conflicts' }
  | { type: 'changes_requested'; reviewer: string }
  | { type: 'completed' }
  | { type: 'abandoned' };

export const prKey = (s: { projectId: string; repoId: string; prId: number }): string => `${s.projectId}/${s.repoId}/${s.prId}`;

const rejectedBlocking = (s: PrSnapshot): Set<string> =>
  new Set(s.policies.filter((p) => p.blocking && (p.status === 'rejected' || p.status === 'broken')).map((p) => p.name));
const rejectedVotes = (s: PrSnapshot): Map<string, number> =>
  new Map(s.reviewers.filter((r) => r.vote <= -5).map((r) => [r.id, r.vote]));

export function deltaEvents(prev: PrSnapshot | null, next: PrSnapshot): PrEvent[] {
  const out: PrEvent[] = [];
  if (next.status === 'completed' && prev?.status !== 'completed') out.push({ type: 'completed' });
  if (next.status === 'abandoned' && prev?.status !== 'abandoned') out.push({ type: 'abandoned' });
  if (next.terminal) return out;
  if (!prev || next.iterationCount > prev.iterationCount || next.lastMergeSourceCommit !== prev.lastMergeSourceCommit) out.push({ type: 'iteration', iteration: Math.max(1, next.iterationCount), first: !prev });
  if (next.mergeStatus === 'conflicts' && prev?.mergeStatus !== 'conflicts') out.push({ type: 'conflicts' });
  const before = prev ? rejectedBlocking(prev) : new Set<string>();
  for (const name of rejectedBlocking(next)) if (!before.has(name)) out.push({ type: 'build_failed', policy: name });
  const oldVotes = prev ? rejectedVotes(prev) : new Map<string, number>();
  for (const [id] of rejectedVotes(next)) if (!oldVotes.has(id)) out.push({ type: 'changes_requested', reviewer: next.reviewers.find((r) => r.id === id)?.name ?? id });
  return out;
}

/** True when anything a person would care about differs (drives changed_at). */
export function snapshotChanged(prev: PrSnapshot | null, next: PrSnapshot): boolean {
  if (!prev) return true;
  return prev.status !== next.status || prev.mergeStatus !== next.mergeStatus || prev.isDraft !== next.isDraft || prev.title !== next.title || prev.iterationCount !== next.iterationCount ||
    prev.lastMergeSourceCommit !== next.lastMergeSourceCommit || JSON.stringify(prev.reviewers) !== JSON.stringify(next.reviewers) || JSON.stringify(prev.policies) !== JSON.stringify(next.policies) || prev.reviewStatus !== next.reviewStatus;
}
