import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openArchive, sha256 } from '../adapters/bot-mode-desktop022/archive.mjs';
import { patchShortcuts } from '../adapters/bot-mode-desktop022/shortcuts.mjs';
import { patchChat } from '../adapters/bot-mode-desktop022/chat.mjs';
import { patchWorkspace } from '../adapters/bot-mode-desktop022/workspace.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['shortcuts', 'ui-chat', 'ui-workspace'];
const packageName = name => `@deepseek-ai/dsh-client-${name}`;
const keys = { shortcuts: 'patchShortcuts', 'ui-chat': 'patchChat', 'ui-workspace': 'patchWorkspace' };
const builtin = { VERSION: '0.2.2-rc.2', patchShortcuts, patchChat, patchWorkspace };

function insideRepository(path) {
  assert.ok(path.startsWith(`${root}${sep}`), `Output must remain in this repository: ${path}`);
}

/** Reads the unmodified candidate and reports source identity before any build. */
export async function inspectCandidate(app) {
  const archivePath = resolve(app, 'Contents/Resources/app.asar');
  const bytes = await readFile(archivePath), archive = openArchive(bytes);
  const runtime = JSON.parse(archive.read('dsh/desktop-runtime.json'));
  const packages = Object.fromEntries(names.map(name => {
    const prefix = `dsh/node_modules/${packageName(name)}/`;
    let node = archive.table;
    for (const part of prefix.slice(0, -1).split('/')) node = node.files?.[part];
    assert.ok(node?.files, `Native package is not a packed directory: ${prefix}`);
    const validate = (row, path) => {
      if (row.files) for (const [child, value] of Object.entries(row.files)) validate(value, `${path}/${child}`);
      else assert.ok(row.offset !== undefined && !row.unpacked && !row.link,
        `Review linked or unpacked native package files before copying: ${path}`);
    };
    validate(node, prefix.slice(0, -1));
    const manifest = JSON.parse(archive.read(`${prefix}package.json`));
    assert.equal(manifest.name, packageName(name));
    const client = archive.read(`${prefix}lib/client.js`);
    const host = archive.read(`${prefix}lib/index.js`);
    return [name, { packageName: manifest.name, version: manifest.version, clientSha256: sha256(client), hostSha256: sha256(host), prefix }];
  }));
  return { archive, archivePath, identity: { app: resolve(app), archiveSha256: sha256(bytes), version: runtime.release.version, packages } };
}

/** Creates a separate bundle; never writes to the application or reference tree. */
export async function buildProfileCompatibility({ app, output, entryConfig = {}, patchModule, portable = false } = {}) {
  assert.ok(app && output, 'Supply app and output');
  output = resolve(output); insideRepository(output);
  assert.equal(await stat(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false,
    'Use a fresh output directory; existing files are never overwritten');
  const candidate = await inspectCandidate(app);
  const patchPath = patchModule ? await realpath(resolve(patchModule)) : undefined;
  if (patchPath) insideRepository(patchPath);
  const transforms = patchPath ? await import(pathToFileURL(patchPath)) : builtin;
  assert.equal(transforms.VERSION, candidate.identity.version, 'Candidate release has no reviewed patch module; inspect it and review all baselines first');
  for (const key of Object.keys(entryConfig)) assert.ok(names.includes(key), `Unknown entry configuration: ${key}`);
  // Validate all exact-baseline pure transformations before creating output.
  const clients = new Map();
  for (const name of names) {
    assert.equal(typeof transforms[keys[name]], 'function', `Missing ${keys[name]}`);
    const original = candidate.archive.read(`${candidate.identity.packages[name].prefix}lib/client.js`);
    const patched = Buffer.from(transforms[keys[name]](original.toString()));
    assert.notEqual(sha256(patched), sha256(original), `No adapter change: ${name}`);
    clients.set(name, patched);
  }
  await mkdir(output, { recursive: true });
  const inventory = [];
  for (const name of names) {
    const { prefix } = candidate.identity.packages[name];
    for (const item of candidate.archive.files.filter(item => item.path.startsWith(prefix))) {
      const local = item.path.slice(prefix.length);
      assert.ok(local && !local.split('/').includes('..'));
      const target = resolve(output, 'adapters', name, local);
      insideRepository(target);
      const bytes = local === 'lib/client.js' ? clients.get(name) : candidate.archive.read(item.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      inventory.push({ path: relative(output, target), sha256: sha256(bytes), bytes: bytes.length, changed: local === 'lib/client.js' });
    }
    const native = JSON.parse(candidate.archive.read(`${prefix}package.json`));
    assert.equal(native.main, 'lib/index.js', 'Review changed Host package entry before building');
    assert.ok(native.dsh?.client && native.exports?.['./client']);
    // Host, canonical manifest identity and public exports are copied byte for byte.
    assert.equal(sha256(await readFile(resolve(output, 'adapters', name, 'lib/index.js'))), candidate.identity.packages[name].hostSha256);
  }
  const patch = [
    ...names.flatMap(name => [`- id: ${name}`, '  disabled: true']),
    '- insert:',
    ...names.flatMap(name => [
      `    - id: dsh-bot-compat-${name}`,
      `      name: ./adapters/${name}/lib/index.js`,
      ...(Object.hasOwn(entryConfig, name) ? [`      config: ${JSON.stringify(entryConfig[name])}`] : []),
    ]),
  ].join('\n') + '\n';
  const manifest = { name: 'dsh-bot-native-compat', version: '0.1.0', private: true, type: 'module',
    description: 'Profile-owned Bot mode compatibility; leaves the official application unchanged',
    license: 'MIT', engines: { dsh: candidate.identity.version },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.5', '@deepseek-ai/schemastery': '^3.18.5' },
    devDependencies: { '@deepseek-ai/cordis': '4.0.5', '@deepseek-ai/schemastery': '3.18.5' },
    files: ['adapters', 'locale', 'cordis.patch.yml', 'compatibility.json', 'README.md', 'LICENSE'] };
  await writeFile(resolve(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(resolve(output, 'cordis.patch.yml'), patch);
  await mkdir(resolve(output, 'locale'), { recursive: true });
  for (const [language, title, description] of [
    ['en', 'DSH-Bot native compatibility', 'Keeps Bot mode in profile-owned plugins while preserving the official application.'],
    ['zh', 'DSH-Bot 原生兼容', '通过独立 profile 插件保留 Bot 模式及官方应用签名。'],
  ]) await writeFile(resolve(output, 'locale', `${language}.json`), JSON.stringify({ meta: { title, description } }, null, 2) + '\n');
  for (const file of ['README.md', 'LICENSE']) await writeFile(resolve(output, file), await readFile(resolve(root, 'adapters/bot-mode-profile-compat', file)));
  const receipt = { ...candidate.identity, output, patchModule: patchModule ? resolve(patchModule) : 'reviewed-desktop022-rc2',
    loaderIds: names.map(name => `dsh-bot-compat-${name}`), configuredEntries: Object.keys(entryConfig), inventory,
    applicationUnchanged: sha256(await readFile(candidate.archivePath)) === candidate.identity.archiveSha256 };
  assert.ok(receipt.applicationUnchanged);
  await writeFile(resolve(output, 'compatibility.json'), JSON.stringify(packageReceipt(receipt, portable), null, 2) + '\n');
  return receipt;
}

/** Replace the selected web-app declaration bundle, preserving unique native row ids. */
export async function buildWebApplicationCompatibility(options = {}) {
  assert.equal(Object.keys(options.entryConfig ?? {}).length, 0, 'Apply user configs in the profile on original ids; do not bake them into this replacement bundle');
  const receipt = await buildProfileCompatibility(options);
  const output = receipt.output, candidate = await inspectCandidate(options.app);
  const prefix = 'dsh/node_modules/@deepseek-ai/dsh-web-app/';
  const officialManifest = JSON.parse(candidate.archive.read(`${prefix}package.json`));
  const patchPaths = officialManifest.dsh?.bundle?.patch;
  assert.ok(Array.isArray(patchPaths) && patchPaths.every(path => typeof path === 'string' && path.startsWith('./') && !path.split('/').includes('..')),
    'Review the official web-app bundle declaration before copying');
  const officialInventory = [];
  for (const item of candidate.archive.files.filter(item => item.path.startsWith(prefix))) {
    const local = item.path.slice(prefix.length);
    assert.ok(local && !local.split('/').includes('..'));
    const target = resolve(output, 'official-web-app', local);
    insideRepository(target);
    let bytes = candidate.archive.read(item.path);
    const before = sha256(bytes);
    if (local === 'cordis.patch.yml') {
      let text = bytes.toString();
      for (const name of names) {
        const anchor = `name: '${packageName(name)}'`;
        assert.equal(text.split(anchor).length, 2, `Official declaration anchor must be unique: ${name}`);
        text = text.replace(anchor, `name: ../adapters/${name}/lib/index.js`);
      }
      bytes = Buffer.from(text);
    }
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
    officialInventory.push({ path: relative(output, target), originalSha256: before, sha256: sha256(bytes), bytes: bytes.length,
      changed: local === 'cordis.patch.yml' });
  }
  const manifestPath = resolve(output, 'package.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.name = 'dsh-bot-web-app';
  manifest.description = 'Reviewed official web-app composition with profile-owned Bot mode Client adapters';
  manifest.dsh.bundle.patch = patchPaths.map(path => `./official-web-app/${path.slice(2)}`);
  manifest.files = manifest.files.filter(path => path !== 'cordis.patch.yml').concat('official-web-app');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  // This root file is not referenced by this mode. Keep it inert so a reviewer
  // cannot mistake the earlier disabled+insert recipe for the active layer.
  await writeFile(resolve(output, 'cordis.patch.yml'), '[]\n');
  const final = { ...receipt, mode: 'web-app-replacement', packageName: manifest.name,
    replacesBundle: '@deepseek-ai/dsh-web-app', loaderIds: names,
    configuredEntries: [], entryConfigNote: 'Preserve profile configs on original ids; name assertions require explicit migration',
    officialWebAppVersion: officialManifest.version, officialPatchPaths: patchPaths,
    officialInventory, applicationUnchanged: sha256(await readFile(candidate.archivePath)) === receipt.archiveSha256 };
  assert.ok(final.applicationUnchanged);
  await writeFile(resolve(output, 'compatibility.json'), JSON.stringify(packageReceipt(final, options.portable), null, 2) + '\n');
  return final;
}

// Machine paths belong in the local build log, not in a distributable archive.
// Preserve the exact official hashes and complete file inventory used by checks.
function packageReceipt(receipt, portable) {
  if (!portable) return receipt;
  const { app, output, patchModule, ...identity } = receipt;
  return { ...identity, patchModule: patchModule.startsWith(root) ? relative(root, patchModule) : patchModule };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--inspect') { options.inspect = true; continue; }
    if (key === '--portable') { options.portable = true; continue; }
    assert.ok(['--app', '--output', '--entry-config', '--patch-module', '--mode'].includes(key), `Unknown option ${key}`);
    assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value for ${key}`);
    options[key.slice(2)] = args[++i];
  }
  assert.ok(options.app, 'Required: --app /path/to/official.app');
  if (options.inspect) console.log(JSON.stringify((await inspectCandidate(options.app)).identity, null, 2));
  else {
    assert.ok(options.output, 'Required: --output /repository/.dsh-dev/.../package');
    const entryConfig = options['entry-config'] ? JSON.parse(await readFile(resolve(options['entry-config']), 'utf8')) : {};
    const mode = options.mode ?? 'profile-compat';
    assert.ok(['profile-compat', 'web-app-replacement'].includes(mode), 'Unknown build mode');
    const build = mode === 'web-app-replacement' ? buildWebApplicationCompatibility : buildProfileCompatibility;
    const receipt = await build({ app: options.app, output: options.output, entryConfig, patchModule: options['patch-module'], portable: options.portable });
    console.log(JSON.stringify({ status: 'PASS', version: receipt.version, output: receipt.output, archiveSha256: receipt.archiveSha256, applicationUnchanged: receipt.applicationUnchanged }, null, 2));
  }
}
