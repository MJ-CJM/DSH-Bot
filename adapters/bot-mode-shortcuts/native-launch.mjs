import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const base = resolve(process.cwd(), '.dsh-dev/bot-mode-native');
const prepared = JSON.parse(await readFile(resolve(base, 'prepare.json')));
assert.ok(prepared.executable.startsWith(`${base}/`));
if (process.argv.includes('--stop')) {
  const record = JSON.parse(await readFile(resolve(base, 'native-service.json')));
  const command = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' });
  assert.ok(command.includes(prepared.executable) && command.includes(prepared.flag), 'PID must belong to this isolated copy');
  process.kill(record.pid, 'SIGTERM'); console.log(JSON.stringify({ stopped: record.pid }));
} else {
  const env = JSON.parse(await readFile(resolve(base, 'launch-environment.json')));
  assert.equal(env.DSH_HOME, prepared.home); assert.ok(env.HOME.startsWith(`${prepared.instance}/`));
  const log = await open(resolve(base, 'native-main.log'), 'a', 0o600);
  const child = spawn(prepared.launcher, [], { cwd: process.cwd(), env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref(); await log.close();
  const record = { pid: child.pid, executable: prepared.executable, instance: prepared.instance, userData: prepared.userData,
    home: prepared.home, protocolRegistration: false, copiedVersion: prepared.version, launchedAt: new Date().toISOString() };
  await writeFile(resolve(base, 'native-service.json'), JSON.stringify(record, null, 2)); console.log(JSON.stringify(record, null, 2));
}
