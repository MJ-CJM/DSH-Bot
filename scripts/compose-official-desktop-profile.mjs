// Read configuration using the installed carrier's PUBLIC package roots. Run
// under that carrier's Electron with ELECTRON_RUN_AS_NODE=1; never boots a Host.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function composeWithPublicBoot({ boot, profileDir, home, installAnchor }) {
  for (const key of ['loadProfileDirectory', 'readProfilePatches', 'renderConfigDump']) assert.equal(typeof boot[key], 'function', `Official public API missing: ${key}`);
  const profile = boot.loadProfileDirectory('dsh-profile-audit', profileDir, installAnchor);
  assert.equal(profile.skippedBundles.length, 0, 'Official composition skipped a selected bundle; inspect private diagnostics');
  const patches = boot.readProfilePatches('dsh-profile-audit', {
    profile: 'desktop', dir: profileDir, patchPath: profile.patchPath, home, installAnchor,
    cwd: profileDir, overlays: [], telemetryDisabledEnv: undefined,
  }, profile);
  // renderConfigDump is the public configured-entry composer in rc.3. Its base
  // cordis.yml + flattened layers use the native include patch algorithm and
  // preserve root groups, expressions, profile overrides and home overrides.
  const warnings = [];
  const text = boot.renderConfigDump('dsh-profile-audit', join(profileDir, 'cordis.yml'), [{ label: 'official profile and home layers', patches }], line => warnings.push(line));
  return { text, warnings, layers: profile.layers.length };
}

export async function composeOfficialProfile({ app, profileDir, home, output }) {
  for (const value of [app, profileDir, home, output]) assert.ok(value && isAbsolute(value), 'Explicit absolute composition paths required');
  const target = resolve(output), rel = relative(root, target);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Composition output must remain in repository');
  assert.equal(await realpath(dirname(target)), dirname(target), 'Composition output parent must be canonical');
  const installAnchor = join(app, 'Contents/Resources/app.asar/dsh/package.json');
  const native = createRequire(installAnchor);
  // resolve(root package name) honors the public exports map; no internal file
  // import, extracted substitute runtime or local rc.2 framework instance.
  const boot = await import(pathToFileURL(native.resolve('@deepseek-ai/dsh-app-boot')).href);
  const result = composeWithPublicBoot({ boot, profileDir, home, installAnchor });
  await writeFile(target, result.text, { flag: 'wx', mode: 0o600 });
  return { status: 'PASS', output: target, layers: result.layers, warnings: result.warnings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = { '--app': 'app', '--profile-dir': 'profileDir', '--home': 'home', '--output': 'output' }, options = {};
    for (let i = 2; i < process.argv.length; i += 2) { const key = names[process.argv[i]]; assert.ok(key && process.argv[i + 1], 'Invalid composition option'); options[key] = process.argv[i + 1]; }
    const result = await composeOfficialProfile(options);
    // Native warnings may include configuration; keep the full details private.
    if (result.warnings.length) await writeFile(`${options.output}.warnings.log`, result.warnings.join('\n'), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: result.status, output: result.output, layers: result.layers, warnings: result.warnings.length }));
  } catch (error) {
    // Parent captures this only into a private log; no configuration on stdout.
    console.error(error.stack ?? error.message); process.exitCode = 1;
  }
}
