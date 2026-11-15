// The host-side pieces (wrapper, credential helper) against the REAL git, a real smart-HTTP git server that demands the broker's token,
// and a fake Paperclip API. Environment mimics a managed agent run: system and user git config off, temp HOME, no prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const HTTP_BACKEND = '/usr/lib/git-core/git-http-backend';
const TOKEN = 'tok-' + 'x'.repeat(40);
const have = existsSync(HTTP_BACKEND);
let dir = '', gitSrv: http.Server, apiSrv: http.Server, gitPort = 0, apiPort = 0; const apiCalls: Array<{ auth: string; runId: string; body: any }> = [];

function cgi(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const auth = req.headers.authorization ?? '';
  if (auth !== 'Basic ' + Buffer.from(`paperclip:${TOKEN}`).toString('base64')) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic realm="fake"'); return void res.end('auth required'); }
  const child = spawn(HTTP_BACKEND, [], { env: { PATH: '/usr/bin:/bin', GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method ?? 'GET', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: String(req.headers['content-type'] ?? ''), REMOTE_USER: 'paperclip', REMOTE_ADDR: '127.0.0.1', GIT_HTTP_MAX_REQUEST_BUFFER: '100M', HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? '') } });
  req.pipe(child.stdin);
  let buf = Buffer.alloc(0); let sent = false;
  child.stdout.on('data', (d: Buffer) => {
    if (sent) return void res.write(d);
    buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    for (const line of buf.slice(0, i).toString().split('\r\n')) { const [k, ...v] = line.split(': '); if (k.toLowerCase() === 'status') res.statusCode = Number(v.join(': ').split(' ')[0]); else res.setHeader(k, v.join(': ')); }
    sent = true; res.write(buf.slice(i + 4));
  });
  child.on('close', () => res.end());
}

test.before(async () => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), 'ado-host-')); mkdirSync(join(dir, 'tmp-home'));
  const bare = join(dir, 'srv', 'acme', 'Platform', '_git', 'widgets'); mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]); execFileSync('git', ['-C', bare, 'config', 'http.receivepack', 'true']);
  const seed = join(dir, 'seed'); execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  const g = (...a: string[]) => execFileSync('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  g('add', '.'); g('commit', '-q', '-m', 'init'); g('push', '-q', bare, 'main');
  gitSrv = http.createServer((req, res) => cgi(req, res, join(dir, 'srv'))); await new Promise<void>((r) => gitSrv.listen(0, '127.0.0.1', r)); gitPort = (gitSrv.address() as AddressInfo).port;
  apiSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)).on('end', () => {
      const body = b ? JSON.parse(b) : {}; apiCalls.push({ auth: String(req.headers.authorization ?? ''), runId: String(req.headers['x-paperclip-run-id'] ?? ''), body });
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/api/plugins/mzaferyahsi.azure-devops/api/git/credentials' || req.headers.authorization !== 'Bearer run-jwt') { res.statusCode = 401; return void res.end('{}'); }
      if (/forbidden/.test(body.path)) { res.statusCode = 403; return void res.end(JSON.stringify({ error: 'out_of_scope', message: 'This repository is outside the projects selected in the plugin settings' })); }
      res.end(JSON.stringify({ username: 'paperclip', password: TOKEN, expiresAt: Math.floor(Date.now() / 1000) + 3000, identity: 'author' }));
    });
  });
  await new Promise<void>((r) => apiSrv.listen(0, '127.0.0.1', r)); apiPort = (apiSrv.address() as AddressInfo).port;
  // an "installed" root: the real scripts, a rewrite config
  const root = join(dir, 'opt'); mkdirSync(join(root, 'bin'), { recursive: true }); mkdirSync(join(root, 'etc'));
  symlinkSync(join(REPO_ROOT, 'host/git-credential-paperclip-ado'), join(root, 'bin/git-credential-paperclip-ado'));
  writeFileSync(join(root, 'etc/git-access.conf'), 'acme/Platform\n');
});
test.after(() => { gitSrv?.close(); apiSrv?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const env = (over: Record<string, string> = {}) => ({
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, 'tmp-home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'false',
  PAPERCLIP_ADO_ROOT: join(dir, 'opt'), PAPERCLIP_ADO_BASE_URL: `http://127.0.0.1:${gitPort}`, PAPERCLIP_API_URL: `http://127.0.0.1:${apiPort}/api`, PAPERCLIP_API_KEY: 'run-jwt', PAPERCLIP_RUN_ID: 'run-1', ...over,
});
const wrapper = () => join(REPO_ROOT, 'host/git');
// Async on purpose: the servers live in this process, a synchronous spawn would block them.
const exec = (cmd: string, args: string[], e: Record<string, string>, cwd: string, input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> => new Promise((resolve) => {
  const c = spawn(cmd, args, { env: e, cwd }); let stdout = '', stderr = '';
  const timer = setTimeout(() => c.kill('SIGKILL'), 60_000);
  c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
  c.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  if (input !== undefined) c.stdin.write(input); c.stdin.end();
});
const run = (args: string[], over: Record<string, string> = {}, cwd?: string) => exec(wrapper(), args, env(over), cwd ?? dir, undefined);
const ok = (name: string, fn: () => void | Promise<void>) => test(name, async (t) => { if (!have) return t.skip('git-http-backend not installed'); await fn(); });
const url = (repo = 'widgets') => `http://127.0.0.1:${gitPort}/acme/Platform/_git/${repo}`;

ok('clone, commit and push a branch with stock git commands: no SSH, no stored credential', async () => {
  const r = await run(['clone', '-q', url(), 'work']); assert.equal(r.status, 0, r.stderr);
  const w = join(dir, 'work');
  assert.equal(readFileSync(join(w, 'README.md'), 'utf8'), 'hello\n');
  writeFileSync(join(w, 'change.txt'), 'x\n');
  const g = (...a: string[]) => run(['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {}, w);
  assert.equal((await g('add', '.')).status, 0); assert.equal((await g('commit', '-q', '-m', 'feat')).status, 0);
  const p = await g('push', '-q', 'origin', 'HEAD:refs/heads/alice/eng-1-x'); assert.equal(p.status, 0, p.stderr);
  assert.match(execFileSync('git', ['-C', join(dir, 'srv/acme/Platform/_git/widgets'), 'branch', '--list', 'alice/eng-1-x'], { encoding: 'utf8' }), /alice\/eng-1-x/);
  const cfg = readFileSync(join(w, '.git/config'), 'utf8');
  assert.ok(!cfg.includes(TOKEN) && !/password|extraheader/i.test(cfg), 'nothing credential-like is written into the repository');
  assert.deepEqual(readdirSync(join(dir, 'tmp-home')).filter(() => true), [], 'nothing is written to HOME');
  assert.ok(apiCalls.every((c) => c.auth === 'Bearer run-jwt' && c.runId === 'run-1' && c.body.protocol === 'http'));
});

ok('without a run identity, or for a repository the plugin refuses, git fails with a sentence a person can act on', async () => {
  const a = await run(['clone', '-q', url(), 'w2'], { PAPERCLIP_API_KEY: '' }); assert.notEqual(a.status, 0); assert.match(a.stderr, /no Paperclip run identity/);
  const b = await run(['clone', '-q', url('forbidden'), 'w3']); assert.notEqual(b.status, 0); assert.match(b.stderr, /outside the projects selected/);
  assert.ok(!(a.stderr + b.stderr).includes(TOKEN));
});

ok('old SSH remotes are rewritten to HTTPS for the configured organization and project only', async () => {
  const rewritten = async (u: string) => (await run(['ls-remote', '--get-url', u])).stdout.trim();
  assert.equal(await rewritten('git@ssh.dev.azure.com:v3/acme/Platform/widgets'), 'https://dev.azure.com/acme/Platform/_git/widgets');
  assert.equal(await rewritten('ssh://git@ssh.dev.azure.com/v3/acme/Platform/widgets'), 'https://dev.azure.com/acme/Platform/_git/widgets');
  assert.equal(await rewritten('git@ssh.dev.azure.com:v3/acme/Other/widgets'), 'git@ssh.dev.azure.com:v3/acme/Other/widgets', 'other projects are left alone');
  assert.equal(await rewritten('git@github.com:org/repo.git'), 'git@github.com:org/repo.git');
});

ok('other hosts keep their own credential helpers; only dev.azure.com is brokered', async () => {
  const cfgFile = join(dir, 'global-gitconfig'); writeFileSync(cfgFile, '[credential]\n\thelper = store-elsewhere\n');
  const get = async (key: string) => (await run(['-c', `include.path=${cfgFile}`, 'config', '--get-all', key])).stdout.split('\n');
  assert.ok((await get('credential.helper')).includes('store-elsewhere'), 'the global helper is still configured for other hosts');
  const lines = (await run(['-c', `include.path=${cfgFile}`, 'config', '--get-regexp', '^credential\\..*\\.helper$'])).stdout.split('\n').filter((l) => l && !l.includes('visualstudio'));
  assert.equal(lines.length, 2, 'one reset and one helper, both scoped to the Azure DevOps URL');
  assert.match(lines[0]!, /^credential\.\S+\.helper\s*$/, 'the first scoped entry is the empty reset');
  assert.match(lines[1]!, /git-credential-paperclip-ado/);
});

ok('store and erase never write anything', async () => {
  for (const action of ['store', 'erase']) { const r = await exec(join(REPO_ROOT, 'host/git-credential-paperclip-ado'), [action], env(), dir, 'protocol=https\nhost=x\npassword=secret\n\n'); assert.equal(r.status, 0); assert.equal(r.stdout, ''); }
  assert.deepEqual(readdirSync(join(dir, 'tmp-home')), []);
});

ok('the installer refuses bad input and a non-root run', () => {
  const bad = spawnSync('bash', [join(REPO_ROOT, 'host/install-git-access.sh'), '--org', 'x y', '--projects', 'p'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  const noRoot = spawnSync('bash', [join(REPO_ROOT, 'host/install-git-access.sh'), '--org', 'acme', '--projects', 'Platform'], { encoding: 'utf8' });
  assert.notEqual(noRoot.status, 0); assert.match(noRoot.stderr, /sudo/);
});

ok('the installer installs into a temp root, pins git and node, rewrites the helper shebang, is idempotent and uninstalls only its own directory', () => {
  const root = join(dir, 'inst-root');
  const inst = (...a: string[]) => spawnSync('bash', [join(REPO_ROOT, 'host/install-git-access.sh'), ...a], { encoding: 'utf8', env: { ...process.env, PAPERCLIP_ADO_TEST_NONROOT: '1' } });
  for (let i = 0; i < 2; i++) { const r = inst('--root', root, '--org', 'acme', '--projects', 'Platform, Other'); assert.equal(r.status, 0, r.stderr); }
  assert.deepEqual(readFileSync(join(root, 'etc/git-access.conf'), 'utf8').trim().split('\n'), ['acme/Platform', 'acme/Other']);
  const real = readFileSync(join(root, 'etc/real-git'), 'utf8').trim();
  assert.ok(existsSync(real) && !real.startsWith(root), 'a real git binary, not the wrapper');
  assert.match(readFileSync(join(root, 'bin/git-credential-paperclip-ado'), 'utf8').split('\n')[0]!, /^#!\/.*node$/);
  // the installed wrapper uses the pinned git and rewrites visualstudio.com hosts too
  const w = spawnSync(join(root, 'bin/git'), ['config', '--get-all', 'credential.https://acme.visualstudio.com.helper'], { encoding: 'utf8', env: { ...process.env, PAPERCLIP_ADO_ROOT: root } });
  assert.match(w.stdout, /git-credential-paperclip-ado/);
  const bogus = spawnSync('bash', [join(REPO_ROOT, 'host/install-git-access.sh'), '--root', dir, '--uninstall'], { encoding: 'utf8', env: { ...process.env, PAPERCLIP_ADO_TEST_NONROOT: '1' } });
  assert.notEqual(bogus.status, 0); assert.match(bogus.stderr, /refusing/);
  const un = inst('--root', root, '--uninstall'); assert.equal(un.status, 0, un.stderr); assert.ok(!existsSync(root));
});
