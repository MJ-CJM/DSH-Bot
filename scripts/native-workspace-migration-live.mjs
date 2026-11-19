// Replays a synthetic legacy profile migration; it never starts the copied Host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createNativeWorkspaceMigration } from './native-workspace-profile.mjs';
import { treeManifest } from './deploy-official-desktop.mjs';

const root = resolve('.'), isolated = join(root, '.dsh-dev');
const args = process.argv.slice(2), flags = {};
const allowed = new Set(['--seed-home', '--seed-profile', '--app', '--source-app', '--artifact', '--expected-sha', '--fallback-artifact', '--fallback-sha', '--expected-version', '--expected-asar', '--composition-review']);
for (let i = 0; i < args.length; i += 2) { assert.ok(allowed.has(args[i]) && args[i + 1] && !flags[args[i]], 'Unique key/value flags required'); flags[args[i]] = args[i + 1]; }
for (const key of ['--seed-home', '--app', '--source-app', '--artifact', '--expected-sha', '--expected-asar']) assert.ok(flags[key], `Required ${key}`);
const seed = resolve(flags['--seed-home']), seedProfile = flags['--seed-profile'] ?? 'b4-browser';
const rel = relative(isolated, seed); assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Use a repository-isolated synthetic seed'); assert.match(seedProfile, /^[a-z0-9-]+$/);
assert.equal(await realpath(seed), seed, 'Synthetic seed must not redirect through symlinks');
const dir = await mkdtemp(join(isolated, 'native-workspace-live-')); console.log(dir);
await cp(seed, join(dir, 'home'), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
if (seedProfile !== 'desktop') await rename(join(dir, 'home/profiles', seedProfile), join(dir, 'home/profiles/desktop'));
await mkdir(join(dir, 'userData'));
const options = { app: resolve(flags['--app']), sourceApp: resolve(flags['--source-app']), home: join(dir, 'home'), userData: join(dir, 'userData'),
  artifact: resolve(flags['--artifact']), expectedSha: flags['--expected-sha'], fallbackArtifact: resolve(flags['--fallback-artifact'] ?? flags['--artifact']), fallbackSha: flags['--fallback-sha'] ?? flags['--expected-sha'],
  expectedVersion: flags['--expected-version'] ?? '0.2.2-rc.5', expectedAsar: flags['--expected-asar'], runDir: join(dir, 'migration'),
  compositionReview: flags['--composition-review'] ? resolve(flags['--composition-review']) : undefined };
await writeFile(join(dir, 'options.json'), JSON.stringify(options, null, 2), { mode: 0o600 });
try {
  const migration = await createNativeWorkspaceMigration(options); await migration.execute();
  const beforeRollback = await treeManifest(join(options.home, 'profiles/desktop'));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const clientPath = join(options.home, 'profiles/desktop/node_modules/dsh-botgroup/lib/client.js');
  const candidateClientSha256 = digest(await readFile(clientPath));
  const history = join(options.home, 'migration-new-history.json'), patch = join(options.home, 'profiles/desktop/cordis.patch.yml');
  await writeFile(history, JSON.stringify({ synthetic: true, content: 'new sample history after migration' }));
  await appendFile(patch, '\n# Synthetic owner setting after migration\n- id: ui-chat\n  config:\n    performanceUsage: compact\n');
  const latestPatch = await readFile(patch);
  await assert.rejects(migration.rollback(), /newer settings/);
  await migration.rollback({ targeted: true });
  const archivedFallbackClient = execFileSync('/usr/bin/tar', ['-xOf', join(options.runDir, 'fallback.tgz'), 'package/lib/client.js'], { maxBuffer: 32 * 1024 * 1024 });
  const fallbackClientSha256 = digest(archivedFallbackClient), installedClientSha256 = digest(await readFile(clientPath));
  assert.equal(installedClientSha256, fallbackClientSha256, 'Rollback Client differs from the exact archived fallback artifact');
  assert.deepEqual(await readFile(patch), latestPatch); assert.equal(JSON.parse(await readFile(history)).content, 'new sample history after migration');
  const final = JSON.parse(await readFile(join(options.home, 'profiles/desktop/package.json')));
  assert.ok(final.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app')); assert.ok(!final.dsh.profile.bundles.includes('dsh-bot-web-app'));
  await writeFile(join(dir, 'result.json'), JSON.stringify({ status: 'PASS', artifactSha256: options.expectedSha, fallbackArtifactSha256: options.fallbackSha,
    candidateClientSha256, fallbackClientSha256, installedClientSha256, rollbackChangedClientBytes: candidateClientSha256 !== installedClientSha256, targetVersion: options.expectedVersion,
    nativePackageInstallation: true, publicComposition: true, atomicProfileExchange: true, strictRollbackRejectsNewSettings: true,
    targetedRollbackPreservesNewSettingsAndHistory: true, officialSelection: true, installedProfileSha256: beforeRollback.sha256,
    realModelRequests: 0, dailyMutations: 0, hostExecution: 'NOT_RUN' }, null, 2));
  console.log('NATIVE_WORKSPACE_MIGRATION_LIVE_PASS');
} catch (error) {
  await writeFile(join(dir, 'failure.txt'), error.stack ?? String(error), { mode: 0o600 });
  console.error(error.message); process.exitCode = 1;
}
