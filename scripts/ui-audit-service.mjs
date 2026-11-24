// Keep the explicitly synthetic review profile available for local user inspection.
// The profile, credentials, agent data and logs remain inside this repository.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd(), [action, argument] = process.argv.slice(2), dir = resolve(argument ?? '');
assert.ok(['start', 'stop', 'open', 'status'].includes(action), 'Use start|stop|open|status and the isolated review directory');
assert.ok(dir.startsWith(resolve(root, '.dsh-dev/official-desktop-rc3/validation') + '/') && dir.endsWith('/review'), 'Only an isolated review profile is accepted');
const path = resolve(dir, 'service.json'), state = JSON.parse(await readFile(path, 'utf8'));
const fixture = JSON.parse(await readFile(resolve(dir, 'fixture.json'), 'utf8'));
assert.equal(fixture.synthetic, true); assert.equal(fixture.realModelRequests, 0);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (action === 'status') console.log(JSON.stringify({ directory: dir, running: alive(state.pid), pid: state.pid, authenticatedUrlFile: path, realModelRequests: 0 }));
if (action === 'open') {
  assert.ok(alive(state.pid), 'Start this isolated service first');
  const url = new URL(state.url); assert.equal(url.hostname, '127.0.0.1');
  spawn('/usr/bin/open', [url.href], { stdio: 'ignore' }).unref();
  console.log('Opened the isolated local service in the default browser. The authentication token stays in the private service file.');
}
if (action === 'stop') {
  if (alive(state.pid)) process.kill(state.pid, 'SIGTERM');
  for (let n = 0; n < 100 && alive(state.pid); n++) await delay(100);
  assert.ok(!alive(state.pid), 'Service did not stop gracefully');
  console.log('Stopped the isolated service. Its data is retained.');
}
if (action === 'start') {
  assert.ok(!alive(state.pid), 'A service already owns this review profile; stop it first');
  const env = { PATH: process.env.PATH, SHELL: process.env.SHELL, USER: 'synthetic',
    HOME: resolve(dir, 'environment-home'), DSH_HOME: resolve(dir, 'home'),
    DSH_BOT_DSH_BIN: resolve(state.app, 'Contents/Resources/runtime/cli/bin/dsh'),
    DSH_AGENTS_HOME: resolve(dir, 'agents'), XDG_STATE_HOME: resolve(dir, 'state'),
    XDG_DATA_HOME: resolve(dir, 'data'), XDG_CONFIG_HOME: resolve(dir, 'config'), XDG_CACHE_HOME: resolve(dir, 'cache'),
    TMPDIR: resolve(dir, 'tmp'), NODE_COMPILE_CACHE: resolve(dir, 'node-cache'), DSH_TELEMETRY_DISABLED: '1',
    DP_MOCK_PORT: '0', DP_NETWORK_RECEIPT: resolve(dir, 'network-denials.jsonl') };
  const logfile = resolve(dir, 'local-review-service.log'), log = await open(logfile, 'w', 0o600);
  const child = spawn(resolve(root, 'scripts/dsh'), ['--profile', 'official-compat', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref(); await log.close();
  try {
    const deadline = Date.now() + 90000;
    let url, ready = false;
    while (Date.now() < deadline && alive(child.pid)) {
      const output = await readFile(logfile, 'utf8');
      assert.ok(!output.includes('BOT_MODE_APPROVAL_FAILED'), 'Synthetic fixture failed; inspect the private log');
      url = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
      if (url && output.includes('BOT_MODE_APPROVAL_READY')) { ready = true; break; }
      await delay(100);
    }
    assert.ok(ready && url && alive(child.pid), 'Isolated review service did not start');
    await writeFile(path, JSON.stringify({ ...state, status: 'READY', pid: child.pid, url, persistentReview: true }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: 'READY', pid: child.pid, directory: dir, authenticatedUrlFile: path, realModelRequests: 0 }));
  } catch (error) { if (alive(child.pid)) process.kill(child.pid, 'SIGTERM'); throw error; }
}
