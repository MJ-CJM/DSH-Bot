import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runner } from './b3-runner.mjs';
import { mockProfilePatch } from './mock-profile.mjs';
const exec = promisify(execFile);
/** A real CLI Host stays alive while actual tarballs are installed, then deployed at one canonical path. */
export async function hotUpgrade(dir) {
  const root = process.cwd(), hot = resolve(dir, 'canonical-deployment'), profile = 'v041-hot';
  await mkdir(hot, { recursive: true });
  const run = await runner(dir, 9, 'DP_V041', { timeoutMs: 180000 });
  // Use installed runtime dependencies and the Host resolver, never a second dev Cordis instance.
  await symlink(resolve(run.env.DSH_HOME, 'profiles', profile, 'node_modules'), resolve(hot, 'node_modules'), 'dir');
  let host, failure;
  const wait = async file => {
    const deadline = Date.now() + 85000;
    while (await access(resolve(dir, file)).then(() => false, () => true)) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, `Missing ${file}`); await delay(25);
    }
    return JSON.parse(await readFile(resolve(dir, file)));
  };
  const install = async version => {
    const artifact = resolve(root, `dist/dsh-bot-${version}.tgz`);
    await run.command(['plugin', '--profile', profile, 'add', artifact], `hot-install-${version}`);
    const installed = resolve(run.env.DSH_HOME, 'profiles', profile, 'node_modules/dsh-bot');
    assert.equal(JSON.parse(await readFile(resolve(installed, 'package.json'))).version, version);
    // pnpm may change realpaths between versions, so model the reported in-place deployment explicitly.
    await exec('/usr/bin/tar', ['-xzf', artifact, '-C', hot]);
  };
  try {
    await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'hot-initialize');
    await install('0.3.2');
    await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'),
      mockProfilePatch(dir, 'packages/dsh-bot/tests/deepening/v041-hot-profile.mjs', { outputDir: dir, hot },
        ['- id: dsh-bot', '  disabled: true', '- id: hmr', '  disabled: true']));
    host = run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'hot-host', true)
      .catch(error => { failure = error; });
    const ready = await wait('hot-ready.json');
    await install('0.4.0'); await writeFile(resolve(dir, 'installed-040.json'), '{}');
    const reproduced = await wait('reproduced.json'); assert.equal(reproduced.pid, ready.pid);
    await install('0.4.1'); await writeFile(resolve(dir, 'installed-041.json'), '{}');
    await host; if (failure) throw failure;
    const result = await wait('hot-result.json'); assert.equal(result.pid, ready.pid); return result;
  } catch (error) {
    const log = await readFile(resolve(dir, 'hot-host.log'), 'utf8').catch(() => '');
    if (/listen EPERM|listen EACCES/.test(log)) throw new Error('Host listen EPERM: operation not permitted; see hot-host.log');
    throw error;
  } finally { run.stop(); await host; }
}
