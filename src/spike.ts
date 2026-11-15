// DEV SPIKE (phase 0): does Azure DevOps accept an Entra access token as the Basic password of a git request, or only as a bearer header?
// Runs git INSIDE the worker; only success flags and a scrubbed first line of stderr leave it. Used by the board-only git-access-test action.
import { execFile } from 'node:child_process';

export interface ProbeOutcome { ok: boolean; exit: number | null; head: string }
const run = (args: string[], env: Record<string, string>): Promise<ProbeOutcome & { out: string }> => new Promise((resolve) => {
  execFile('git', args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env }, timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    const secret = env.ADO_TOK ?? '';
    const scrub = (s: string) => (secret ? s.split(secret).join('[token]') : s);
    resolve({ ok: !err, exit: err ? ((err as { code?: number }).code ?? null) : 0, head: scrub(String(stderr).split('\n').find((l) => l.trim()) ?? '').slice(0, 200), out: scrub(String(stdout)).slice(0, 200) });
  });
});

export async function probeGitAuth(token: string, url: string): Promise<{ basicPassword: ProbeOutcome; bearerHeader: ProbeOutcome; version: string }> {
  const version = (await run(['--version'], {})).out.trim();
  const helper = '!f() { echo username=paperclip; echo "password=$ADO_TOK"; }; f';
  const a = await run(['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, '-c', 'credential.useHttpPath=true', 'ls-remote', '--heads', url], { ADO_TOK: token });
  const b = await run(['-c', 'credential.helper=', 'ls-remote', '--heads', url], { ADO_TOK: token, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}` });
  return { basicPassword: { ok: a.ok, exit: a.exit, head: a.head }, bearerHeader: { ok: b.ok, exit: b.exit, head: b.head }, version };
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Writes one throwaway branch with one empty commit using the author token, then deletes the branch. Proves push rights without an agent. */
export async function probePush(token: string, url: string): Promise<{ push: ProbeOutcome; cleanup: ProbeOutcome }> {
  const dir = mkdtempSync(join(tmpdir(), 'ado-push-probe-'));
  const branch = `plugin-spike/push-probe-${Date.now()}`;
  const helper = '!f() { echo username=paperclip; echo "password=$ADO_TOK"; }; f';
  const base = ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, '-c', 'credential.useHttpPath=true'];
  const ident = ['-c', 'user.name=paperclip-plugin', '-c', 'user.email=plugin@paperclip.invalid'];
  try {
    await run(['init', '-q', '-b', 'main', dir], {});
    await run(['-C', dir, ...ident, 'commit', '-q', '--allow-empty', '-m', 'plugin push probe'], {});
    const push = await run(['-C', dir, ...base, 'push', '-q', url, `HEAD:refs/heads/${branch}`], { ADO_TOK: token });
    const cleanup = push.ok ? await run(['-C', dir, ...base, 'push', '-q', url, '--delete', `refs/heads/${branch}`], { ADO_TOK: token }) : { ok: false, exit: null, head: 'skipped', out: '' };
    return { push: { ok: push.ok, exit: push.exit, head: push.head }, cleanup: { ok: cleanup.ok, exit: cleanup.exit, head: cleanup.head } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
