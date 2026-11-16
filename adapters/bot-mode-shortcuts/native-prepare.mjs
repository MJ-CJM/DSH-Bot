import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = process.cwd(), base = resolve(root, '.dsh-dev/bot-mode-native');
const original = '/Applications/DeepSeek Harness.app';
const copied = resolve(base, 'DSH Bot Mode Isolated.app');
const instance = resolve(base, 'instance');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(base, { recursive: true });
if (!existsSync(copied)) execFileSync('/bin/cp', ['-cR', original, copied]);
assert.ok(copied.startsWith(`${root}/.dsh-dev/`));
const originalArchive = await readFile(resolve(original, 'Contents/Resources/app.asar'));
const headerSize = originalArchive.readUInt32LE(4), jsonSize = originalArchive.readUInt32LE(12);
const table = JSON.parse(originalArchive.subarray(16, 16 + jsonSize));
const files = [];
function walk(node, prefix = '') { for (const [name, row] of Object.entries(node.files ?? {})) {
  const path = prefix ? `${prefix}/${name}` : name;
  if (row.files) walk(row, path); else if (row.offset !== undefined) files.push({ path, row, oldOffset: Number(row.offset), oldSize: row.size });
} }
walk(table); files.sort((a, b) => a.oldOffset - b.oldOffset);
const mainEntry = files.find(row => row.path === 'lib/main.js'); assert.ok(mainEntry);
const main = originalArchive.subarray(8 + headerSize + mainEntry.oldOffset, 8 + headerSize + mainEntry.oldOffset + mainEntry.oldSize).toString();
const flag = `--dsh-bot-isolated-test-root=${instance}`;
let patched = main;
const replace = (from, to) => { assert.equal(patched.split(from).length, 2, `Expected one anchor: ${from}`); patched = patched.replace(from, to); };
replace('app.setAppLogsPath();', `
// DSH Bot isolated copy only: require an explicit test instance before any profile or lock.
const dshBotIsolation = process.argv.includes(${JSON.stringify(flag)});
if (!dshBotIsolation) throw new Error('This repository-only desktop copy requires its explicit isolated test switch');
const dshBotTestRoot = ${JSON.stringify(instance)};
for (const name of ['userData', 'logs', 'home', 'tmp', 'environment-home']) mkdirSync(join(dshBotTestRoot, name), { recursive: true });
process.env.DSH_HOME = join(dshBotTestRoot, 'home');
process.env.HOME = join(dshBotTestRoot, 'environment-home');
process.env.TMPDIR = join(dshBotTestRoot, 'tmp');
app.setName('DSH Bot Mode Isolated');
app.setPath('userData', join(dshBotTestRoot, 'userData'));
app.setAppLogsPath(join(dshBotTestRoot, 'logs'));
console.log('DSH_BOT_ISOLATED_DESKTOP', JSON.stringify({ userData: app.getPath('userData'), dshHome: process.env.DSH_HOME, protocolRegistration: false }));
`);
replace('if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1") app.setAsDefaultProtocolClient("dsh");', 'if (!dshBotIsolation && (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1")) app.setAsDefaultProtocolClient("dsh");');
replace('function needsWelcome(authentication) {', 'function needsWelcome(authentication) {\n  if (dshBotIsolation) return false; // Test-only synthetic model profile, no account or API key.');
replace('const automaticCheck = () => {', 'const automaticCheck = () => {\n    if (dshBotIsolation) return; // No automatic updater network or installer in the test copy.');
replace('const policyConfig = resolveDesktopPolicyConfig(', 'const policyConfig = dshBotIsolation ? void 0 : resolveDesktopPolicyConfig(');
replace('\treturn window;\n}\nasync function main() {', `
  if (dshBotIsolation) window.webContents.on('console-message', (...args) => {
    const message = typeof args[0]?.message === 'string' ? args[0].message : args[2];
    if (typeof message === 'string' && message.startsWith('DSH_BOT_NATIVE_PROBE ')) appendFileSync(join(dshBotTestRoot, 'renderer-probe.jsonl'), message.slice('DSH_BOT_NATIVE_PROBE '.length) + '\\n');
  });
  return window;
}
async function main() {`);
const adapterPath = 'dsh/node_modules/@deepseek-ai/dsh-client-shortcuts/lib/client.js';
const descriptorPath = 'dsh/desktop-runtime.json';
const adapter = await readFile(resolve(root, '.dsh-dev/bot-mode-adapter/package/lib/client.js'));
const originalContents = item => originalArchive.subarray(8 + headerSize + item.oldOffset, 8 + headerSize + item.oldOffset + item.oldSize);
const originalAdapterEntry = files.find(item => item.path === adapterPath); assert.ok(originalAdapterEntry);
const originalNativeAdapterHash = sha(originalContents(originalAdapterEntry));
const descriptorEntry = files.find(item => item.path === descriptorPath); assert.ok(descriptorEntry);
const descriptor = JSON.parse(originalContents(descriptorEntry));
assert.equal(descriptor.release.version, '0.2.2-rc.2', 'Native test copy must use the inspected application version');
const adapterFileRecord = descriptor.files.find(item => item.path === adapterPath.slice('dsh/'.length)); assert.ok(adapterFileRecord);
assert.equal(adapterFileRecord.sha256, originalNativeAdapterHash);
adapterFileRecord.sha256 = sha(adapter); adapterFileRecord.bytes = adapter.length;
const overrides = new Map([['lib/main.js', Buffer.from(patched)], [adapterPath, adapter], [descriptorPath, Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)]]);
const payload = []; let offset = 0;
for (const item of files) {
  const bytes = overrides.get(item.path) ?? originalContents(item);
  item.row.offset = String(offset); item.row.size = bytes.length;
  if (overrides.has(item.path) && item.row.integrity) {
    const blockSize = item.row.integrity.blockSize;
    const blocks = []; for (let p = 0; p < bytes.length; p += blockSize) blocks.push(sha(bytes.subarray(p, p + blockSize)));
    item.row.integrity = { algorithm: 'SHA256', hash: sha(bytes), blockSize, blocks };
  }
  payload.push(bytes); offset += bytes.length;
}
const json = Buffer.from(JSON.stringify(table));
const picklePayload = Math.ceil((4 + json.length) / 4) * 4;
const header = Buffer.alloc(4 + picklePayload); header.writeUInt32LE(picklePayload, 0); header.writeUInt32LE(json.length, 4); json.copy(header, 8);
const prefix = Buffer.alloc(8); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(header.length, 4);
const archive = Buffer.concat([prefix, header, ...payload]);
await writeFile(resolve(copied, 'Contents/Resources/app.asar'), archive);
const plist = resolve(copied, 'Contents/Info.plist');
const pb = command => execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { stdio: 'pipe' });
pb('Set :CFBundleIdentifier com.deepseek.dsh.botmode.isolated');
pb('Set :CFBundleName DeepSeek Harness'); // Electron resolves its existing Helper app names from this field.
try { pb('Set :CFBundleDisplayName DSH Bot Mode Isolated'); } catch { pb('Add :CFBundleDisplayName string DSH Bot Mode Isolated'); }
try { pb('Delete :CFBundleURLTypes'); } catch {}
pb(`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${sha(json)}`);
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', copied], { stdio: 'pipe' });
const executable = resolve(copied, 'Contents/MacOS/DeepSeek Harness');
const launcher = resolve(base, 'launch-isolated');
await writeFile(launcher, `#!/bin/sh\nset -eu\nexec ${JSON.stringify(executable)} ${JSON.stringify(flag)} ${JSON.stringify(`--user-data-dir=${resolve(instance,"userData")}`)} "$@"\n`); await chmod(launcher, 0o755);
const receipt = { copied, executable, launcher, flag, instance, version: '0.2.2-rc.2', originalArchiveSha256: sha(originalArchive), adaptedArchiveSha256: sha(archive),
 originalMainSha256: sha(main), adaptedMainSha256: sha(patched), headerSha256: sha(json), protocolRegistration: false, userData: resolve(instance, 'userData'), home: resolve(instance, 'home'),
 adapterClientPath: resolve(copied, 'Contents/Resources/app.asar', adapterPath), originalNativeClientSha256: originalNativeAdapterHash, adapterClientSha256: sha(adapter), adapterSourceBaseline: '0.2.1-rc.2',
 changes: ['early isolated userData/DSH_HOME/logs', 'explicit required test switch', 'skip system protocol registration and remove URLTypes', 'skip welcome only for synthetic test profile', 'disable automatic updater and mandatory update network', 'local shortcuts client adaptation with matching runtime inventory'], launched: false };
await writeFile(resolve(base, 'prepare.json'), JSON.stringify(receipt, null, 2));
assert.equal(sha(await readFile(resolve(original, 'Contents/Resources/app.asar'))), receipt.originalArchiveSha256, 'Original application must remain unchanged');
console.log(JSON.stringify(receipt, null, 2));
