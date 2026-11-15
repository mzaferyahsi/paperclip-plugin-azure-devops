// Issue discovery from branch names and PR titles (spec D11). Patterns come from config and are length-limited and compiled safely.
export interface LinkPatterns { branchPattern: string; titleTokenPattern: string }
export const DEFAULT_PATTERNS: LinkPatterns = {
  branchPattern: '^(?<agent>[a-z0-9-]+)/(?<key>[a-z][a-z0-9]{1,9}-\\d+)(?:-|$)',
  titleTokenPattern: '\\[(?<key>[A-Z][A-Z0-9]{1,9}-\\d+)\\]',
};
const BRANCH_OK = /^[A-Za-z0-9._/-]{1,200}$/;

function compile(src: string): RegExp | null {
  if (src.length > 300) return null;
  // Nested quantifiers like (a+)+ can hang the worker; board-supplied patterns with them are refused.
  if (/\([^)]*[+*}][^)]*\)[+*{]/.test(src)) return null;
  try { return new RegExp(src, 'i'); } catch { return null; }
}

export function stripHeads(ref: string): string { return ref.replace(/^refs\/heads\//, ''); }

export function issueKeyFromBranch(ref: string, patterns: LinkPatterns = DEFAULT_PATTERNS): { key: string; agent?: string } | null {
  const branch = stripHeads(ref);
  if (!BRANCH_OK.test(branch)) return null;
  const re = compile(patterns.branchPattern);
  const m = re?.exec(branch);
  const key = m?.groups?.key;
  return key ? { key: key.toUpperCase(), agent: m?.groups?.agent } : null;
}

export function issueKeyFromTitle(title: string, patterns: LinkPatterns = DEFAULT_PATTERNS): string | null {
  const re = compile(patterns.titleTokenPattern);
  const key = re?.exec(title.slice(0, 500))?.groups?.key;
  return key ? key.toUpperCase() : null;
}

/** Marker embedded in PR descriptions the plugin writes. Never trusted on its own: it only names a candidate, the link store decides. */
export const PROVENANCE_RE = /<!-- paperclip:v1 issue=([0-9a-f-]{36}) agent=([0-9a-f-]{36}) run=([0-9a-f-]{36}) -->/;
export const provenanceMarker = (issue: string, agent: string, run: string): string => `<!-- paperclip:v1 issue=${issue} agent=${agent} run=${run} -->`;
