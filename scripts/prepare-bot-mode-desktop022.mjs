import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openArchive, rewriteArchive, sha256 } from '../adapters/bot-mode-desktop022/archive.mjs';
import { patchShortcuts } from '../adapters/bot-mode-desktop022/shortcuts.mjs';
import { patchChat } from '../adapters/bot-mode-desktop022/chat.mjs';
import { patchWorkspace } from '../adapters/bot-mode-desktop022/workspace.mjs';

const root = process.cwd(), base = resolve(root, '.dsh-dev/bot-mode-desktop022');
const original = '/Applications/DeepSeek Harness.app';
const originalBytes = await readFile(resolve(original, 'Contents/Resources/app.asar'));
const baseline = JSON.parse(await readFile(resolve(base, 'baseline/original.json')));
assert.equal(sha256(originalBytes), baseline.asarSha256, 'Installed app changed since native baseline review');
const archive = openArchive(originalBytes);
const descriptor = JSON.parse(archive.read('dsh/desktop-runtime.json'));
assert.equal(descriptor.release.version, '0.2.2-rc.2');
const overrides = new Map(), adapted = {};
for (const [id, patch] of [['dsh-client-shortcuts', patchShortcuts], ['dsh-client-ui-chat', patchChat], ['dsh-client-ui-workspace', patchWorkspace]]) {
  const path = `dsh/node_modules/@deepseek-ai/${id}/lib/client.js`, before = archive.read(path);
  const after = Buffer.from(patch(before.toString()));
  const record = descriptor.files.find(item => item.path === path.slice(4)); assert.ok(record);
  assert.equal(record.sha256, sha256(before));
  record.sha256 = sha256(after); record.bytes = after.length;
  overrides.set(path, after);
  const output = resolve(base, 'clients', `${id}.js`); await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, after);
  adapted[`@deepseek-ai/${id}`] = { path: output, originalSha256: sha256(before), sha256: sha256(after), bytes: after.length, archivePath: path };
}
overrides.set('dsh/desktop-runtime.json', Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`));
const production = resolve(base, 'DeepSeek Harness.app');
const applyCopy = async (target, patched, isolated) => {
  if (!existsSync(target)) execFileSync('/bin/cp', ['-cR', original, target]);
  await writeFile(resolve(target, 'Contents/Resources/app.asar'), patched.bytes);
  const plist = resolve(target, 'Contents/Info.plist');
  const pb = command => execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { stdio: 'pipe' });
  pb(`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${patched.headerSha256}`);
  if (isolated) {
    pb('Set :CFBundleIdentifier com.deepseek.dsh.botmode.desktop022test');
    try { pb('Set :CFBundleDisplayName DSH Bot Desktop Validation'); } catch { pb('Add :CFBundleDisplayName string DSH Bot Desktop Validation'); }
    try { pb('Delete :CFBundleURLTypes'); } catch { /* Already absent in an isolated rebuild. */ }
  }
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', target], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { stdio: 'pipe' });
};
const packed = rewriteArchive(originalBytes, overrides);
await applyCopy(production, packed, false);
const instance = resolve(process.env.DSH_BOT_DESKTOP_TEST_INSTANCE ?? resolve(base, 'instance'));
assert.ok(instance.startsWith(`${base}/`));
const flag = `--dsh-bot-desktop022-test-root=${instance}`;
const isolated = resolve(base, 'DSH Bot Desktop Validation.app');
let main = archive.read('lib/main.js').toString();
const replace = (from, to) => { assert.equal(main.split(from).length, 2, `Native main anchor changed: ${from}`); main = main.replace(from, to); };
replace('app.setAppLogsPath();', `
const dshBotIsolation = process.argv.includes(${JSON.stringify(flag)});
if (!dshBotIsolation) throw new Error('Explicit isolated desktop test root required');
const dshBotTestRoot = ${JSON.stringify(instance)};
for (const name of ['userData','logs','home','tmp']) mkdirSync(join(dshBotTestRoot,name),{recursive:true});
process.env.DSH_HOME=join(dshBotTestRoot,'home'); process.env.TMPDIR=join(dshBotTestRoot,'tmp');
app.setName('DSH Bot Desktop Validation'); app.setPath('userData',join(dshBotTestRoot,'userData')); app.setAppLogsPath(join(dshBotTestRoot,'logs'));
`);
replace('if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1") app.setAsDefaultProtocolClient("dsh");', 'if (!dshBotIsolation && (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1")) app.setAsDefaultProtocolClient("dsh");');
replace('function needsWelcome(authentication) {', 'function needsWelcome(authentication) { if (dshBotIsolation) return false;');
replace('const automaticCheck = () => {', 'const automaticCheck = () => { if (dshBotIsolation) return;');
replace('const policyConfig = resolveDesktopPolicyConfig(', 'const policyConfig = dshBotIsolation ? void 0 : resolveDesktopPolicyConfig(');
const testOverrides = new Map([...overrides, ['lib/main.js', Buffer.from(main)]]);
const testPacked = rewriteArchive(originalBytes, testOverrides);
await applyCopy(isolated, testPacked, true);
const receipt = { version: '0.2.2-rc.2', production, isolated, instance, flag,
  originalArchiveSha256: sha256(originalBytes), productionArchiveSha256: sha256(packed.bytes), testArchiveSha256: sha256(testPacked.bytes),
  productionMainUnchanged: openArchive(packed.bytes).read('lib/main.js').equals(archive.read('lib/main.js')),
  productionChanges: packed.changed, testOnlyChanges: ['isolated paths, explicit flag, no protocol registration, synthetic welcome, no updater'], adapted,
  originalRenderer: { archivePath: 'dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js', sha256: sha256(archive.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js')) } };
assert.ok(receipt.productionMainUnchanged);
assert.equal(sha256(await readFile(resolve(original, 'Contents/Resources/app.asar'))), baseline.asarSha256, 'Original app touched during preparation');
await writeFile(resolve(base, 'prepare.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ status: 'PASS', ...receipt }, null, 2));
