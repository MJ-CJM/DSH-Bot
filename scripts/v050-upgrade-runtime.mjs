import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
import { command, sha256 } from './p34-artifact.mjs';
const root = process.cwd(), home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const args = process.argv.slice(2); assert.equal(args.length, 5); assert.equal(args[0], '--artifact'); assert.equal(args[2], '--sha256'); assert.equal(args[4], '--mock-only');
const archive = resolve(args[1]), expectedSha = args[3], previous = resolve(root, 'dist/dsh-bot-0.4.1.tgz');
assert.ok(relative(root, archive) && !relative(root, archive).startsWith('..')); assert.match(expectedSha, /^[a-f0-9]{64}$/);
assert.equal(sha256(await readFile(archive)), expectedSha, 'Final package identity changed');
const dir = resolve(home, 'v050-upgrade', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'V050_UPGRADE', { timeoutMs: 120000 }); run.env.DSH_HOME = home;
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
async function leafFiles(directory, base = directory) {
  let result = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const path = resolve(directory, entry.name); assert.ok(!entry.isSymbolicLink());
    if (entry.isDirectory()) result = result.concat(await leafFiles(path, base));
    else { assert.ok(entry.isFile()); result.push({ file: relative(base, path), hash: sha256(await readFile(path)) }); }
  }
  return result.sort((a,b) => a.file.localeCompare(b.file));
}
async function unpack(file, version) {
  const listing = await command('/usr/bin/tar', ['-tzf', file]); assert.equal(listing.code, 0);
  for (const path of listing.output.trim().split('\n')) assert.ok(path.startsWith('package/') && !path.split('/').includes('..'));
  const target = resolve(dir, `archive-${version}`); await mkdir(target);
  const extracted = await command('/usr/bin/tar', ['-xzf', file, '-C', target]); assert.equal(extracted.code, 0);
  const pkg = resolve(target, 'package'), manifest = JSON.parse(await readFile(resolve(pkg,'package.json')));
  assert.equal(manifest.name, 'dsh-bot'); assert.equal(manifest.version, version);
  return { version, sha256: sha256(await readFile(file)), files: await leafFiles(pkg) };
}
let phase = 'artifacts';
try {
  const oldAudit = await unpack(previous, '0.4.1'), newAudit = await unpack(archive, '0.5.0');
  await save('archives', { old: oldAudit, final: newAudit });
  const cliVersion = (await run.command(['--version'], 'version')).trim(), profile = `v050-upgrade-${Date.now()}-${process.pid}`;
  phase = 'initialize'; await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  const installedRoot = resolve(home, 'profiles', profile, 'node_modules/dsh-bot');
  const dataState = async () => Object.fromEntries(await Promise.all(['storage', 'sessions', 'bots'].map(async name => [name, await leafFiles(resolve(dir, name))])));
  const results = [];
  for (const step of ['old', 'new', 'reinstalled']) {
    const audit = step === 'old' ? oldAudit : newAudit;
    if (step === 'reinstalled') {
      phase = 'remove'; const before = await dataState(); await save('before-remove', before);
      await run.command(['plugin', '--profile', profile, 'remove', 'dsh-bot'], 'remove');
      await assert.rejects(() => lstat(installedRoot), error => error.code === 'ENOENT');
      const removedManifest = JSON.parse(await readFile(resolve(home, 'profiles', profile, 'package.json')));
      assert.equal(removedManifest.dependencies?.['dsh-bot'], undefined);
      assert.deepEqual(await dataState(), before, 'Remove changed retained data');
      await save('removed', { status: 'PASS', retainedDataBytesUnchanged: true });
      await run.command(['plugin', '--profile', profile, 'add', archive], 'reinstall');
      assert.deepEqual(await dataState(), before, 'Reinstall changed retained data before Host startup');
    } else { phase = `${step}-install`; await run.command(['plugin', '--profile', profile, 'add', step === 'old' ? previous : archive], phase); }
    for (const file of audit.files) assert.equal(sha256(await readFile(resolve(installedRoot, file.file))), file.hash, `Installed ${audit.version} mismatch ${file.file}`);
    await save(`${step}-installed`, { status: 'PASS', version: audit.version, sha256: audit.sha256, matchedFiles: audit.files.length });
    await writeFile(resolve(home,'profiles',profile,'cordis.patch.yml'), mockProfilePatch(dir, 'packages/dsh-bot/tests/v050-upgrade-profile.mjs', { outputDir: dir, phase: step, installedVersion: audit.version, installedRoot }));
    phase = `${step}-host`; await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], phase, true);
    const result = JSON.parse(await readFile(resolve(dir, `${step}-result.json`))); assert.equal(result.status, 'PASS'); results.push(result);
  }
  const denials = await readFile(resolve(dir, 'network-denials.jsonl'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  assert.equal(denials, '', 'Disabled connector or provider attempted network traffic');
  await save('summary', { status: 'PASS', blockedNetworkAttempts: 0, previousVersion: oldAudit.version, finalVersion: newAudit.version, oldSha256: oldAudit.sha256, finalSha256: newAudit.sha256,
    cliVersion, results, removeReinstallDataBytesRetained: true, modelRequests: 0, realModelRequests: 0, dir });
  console.log(JSON.stringify({ status: 'PASS', dir }));
} catch (error) { await save('summary', { status: 'FAIL', phase, error: String(error), realModelRequests: 0 }); console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: String(error) })); process.exitCode = 1; }
finally { run.stop(); await save('commands', run.commands); }
