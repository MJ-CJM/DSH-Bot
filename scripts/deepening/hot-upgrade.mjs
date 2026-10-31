import assert from 'node:assert/strict';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runner } from './b3-runner.mjs';
import { mockProfilePatch } from './mock-profile.mjs';
/** Keep the CLI Host and its ESM cache alive across pnpm's real in-profile installation. */
export async function hotUpgrade(dir) {
  const root = process.cwd(), profile = 'v041-hot';
  await mkdir(dir, { recursive: true });
  const run = await runner(dir, 9, 'DP_V041', { timeoutMs: 180000 });
  const installed = resolve(run.env.DSH_HOME, 'profiles', profile, 'node_modules/dsh-bot');
  const installations = [];
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
    assert.equal(JSON.parse(await readFile(resolve(installed, 'package.json'))).version, version);
    installations.push({ version, artifact, installed, realpath: await realpath(installed) });
    await writeFile(resolve(dir, 'installations.json'), JSON.stringify(installations, null, 2));
  };
  const patch = phase => writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'),
    mockProfilePatch(dir, 'packages/dsh-bot/tests/deepening/v041-hot-profile.mjs', { outputDir: dir, installed, phase },
      ['- id: dsh-bot', '  disabled: true', '- id: hmr', '  disabled: true']));
  const launch = name => {
    failure = undefined;
    host = run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], name, true)
      .catch(error => { failure = error; });
  };
  try {
    await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'hot-initialize');
    await install('0.3.2'); await patch('hot'); launch('hot-host');
    const ready = await wait('hot-ready.json');
    assert.equal(ready.installed, installed); assert.equal(ready.realpath, installations[0].realpath);
    await install('0.4.1');
    // Default CLI/Desktop profiles use hoisted pnpm installs. Refuse a different-realpath simulation.
    assert.equal(installations[1].realpath, installations[0].realpath, 'Upgrade must replace the actual installed directory');
    await writeFile(resolve(dir, 'installed-041.json'), '{}');
    await host; if (failure) throw failure;
    const hot = await wait('hot-result.json'); assert.equal(hot.pid, ready.pid); assert.equal(hot.status, 'PASS');
    await patch('cold'); launch('cold-host');
    await host; if (failure) throw failure;
    const cold = await wait('cold-result.json'); assert.equal(cold.status, 'PASS'); assert.notEqual(cold.pid, hot.pid);
    return { status: 'PASS', hot, cold, installations, installation: 'CLI pnpm add in the same profile node_modules; no deployment copy' };
  } catch (error) {
    run.stop(); await host;
    const logs = await Promise.all(['hot-host', 'cold-host'].map(name => readFile(resolve(dir, `${name}.log`), 'utf8').catch(() => '')));
    if (logs.some(log => /listen EPERM|listen EACCES/.test(log)))
      throw new Error('Host listen EPERM/EACCES: operation not permitted; see hot-host.log/cold-host.log');
    throw error;
  } finally { run.stop(); await host; }
}
