import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const [profile, restartLimit = '3'] = process.argv.slice(2);
if (profile === '--help') {
  console.log('Usage: DSH_HOME="$PWD/.dsh-dev" node scripts/proactive-bot-supervisor.mjs <profile> [max-restarts]');
  process.exit(0);
}
assert.equal(process.cwd(), root, 'Run from the repository root');
assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
assert.match(profile ?? '', /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/);
assert.match(restartLimit, /^(?:[0-9]|10)$/);
assert.ok(process.argv.length <= 4);
assert.ok(process.env.DSH_BOT_DSH_BIN, 'Select the isolated rc.2 CLI with DSH_BOT_DSH_BIN');
const runDir = resolve(root, '.dsh-dev/proactive-bot/supervised', profile);
const dshHome = resolve(runDir, 'home');
const profilePath = resolve(dshHome, 'profiles', profile);
const realRoot = await realpath(root);
for (const location of [runDir, profilePath]) {
  const actual = await realpath(location);
  assert.equal(actual, resolve(realRoot, location.slice(root.length + 1)));
  assert.ok(actual.startsWith(resolve(realRoot, '.dsh-dev') + sep));
}
const env = {
  PATH: process.env.PATH,
  LANG: 'C',
  USER: 'synthetic',
  DSH_BOT_DSH_BIN: process.env.DSH_BOT_DSH_BIN,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_HOME: dshHome,
  HOME: resolve(runDir, 'user'),
  TMPDIR: resolve(runDir, 'tmp'),
  XDG_STATE_HOME: resolve(runDir, 'state'),
  DSH_AGENTS_HOME: resolve(runDir, 'agents'),
};
for (const dir of [env.HOME, env.TMPDIR, env.XDG_STATE_HOME, env.DSH_AGENTS_HOME]) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(dir), resolve(realRoot, dir.slice(root.length + 1)));
}
const wrapper = resolve(root, 'scripts/dsh');
assert.equal(execFileSync(wrapper, ['--version'], { cwd: root, env, encoding: 'utf8' }).trim(), '0.2.1-rc.2');
const lock = resolve(runDir, 'supervisor.lock');
const lease = await open(lock, 'wx', 0o600);
const stop = new AbortController();
const requestStop = () => stop.abort();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, requestStop);
async function status(state, detail) {
  const temporary = resolve(runDir, `supervisor-${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({
    state, profile, at: new Date().toISOString(), supervisorPid: process.pid, ...detail,
  }, null, 2), { mode: 0o600 });
  await rename(temporary, resolve(runDir, 'supervisor.json'));
}
async function runHost(attempt) {
  const child = spawn(wrapper, ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise(resolveExit => {
    child.once('error', () => resolveExit({ code: null, signal: null, spawnError: true }));
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  let forced;
  const webUrl = resolve(runDir, `web-url-${child.pid}.txt`);
  let connectionWrite;
  const shutdown = () => {
    child.kill('SIGTERM');
    forced = setTimeout(() => child.kill('SIGKILL'), 10000);
  };
  for (const input of [child.stdout, child.stderr]) {
    createInterface({ input }).on('line', line => {
      const connection = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(line)?.[1];
      if (connection && !connectionWrite) {
        connectionWrite = writeFile(webUrl, `${connection}\n`, { mode: 0o600, flag: 'wx' })
          .then(() => { console.log(`Open the isolated Web UI using ${webUrl}`); return true; })
          .catch(() => { console.error('Could not save the isolated Web URL'); return false; });
      }
      console.log(line.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'));
    });
  }
  stop.signal.addEventListener('abort', shutdown, { once: true });
  try {
    if (stop.signal.aborted) shutdown();
    await status('running', { attempt, hostPid: child.pid });
    return await done;
  } finally {
    stop.signal.removeEventListener('abort', shutdown);
    clearTimeout(forced);
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      child.kill('SIGKILL');
      await done;
    }
    if (await connectionWrite) {
      await unlink(webUrl).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
try {
  await lease.writeFile(`${process.pid}\n`);
  for (let attempt = 0; !stop.signal.aborted; attempt++) {
    const result = await runHost(attempt);
    if (stop.signal.aborted || result.code === 0) break;
    if (attempt >= Number(restartLimit)) {
      await status('failed', { attempt, ...result });
      process.exitCode = 1;
      break;
    }
    const waitMs = Math.min(30000, 1000 * 2 ** attempt);
    await status('backoff', { attempt, waitMs, ...result });
    await delay(waitMs, undefined, { signal: stop.signal }).catch(error => {
      if (!stop.signal.aborted) throw error;
    });
  }
  if (process.exitCode !== 1) await status('stopped');
} finally {
  await lease.close();
  await unlink(lock);
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, requestStop);
}
