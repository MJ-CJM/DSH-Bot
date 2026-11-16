// Read-only daily verification. Never starts/stops DSH or writes daily data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { signatureDetails, treeManifest } from './deploy-official-desktop.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/dsh-bot/package.json'));
const yaml = require('js-yaml');
const { entryListSchema } = require('@deepseek-ai/cordis-plugin-include');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);
const historyPath = path => /\.jsonl(?:\.zstd|\.gz|\.gzip)?$/.test(path);
const stableEvent = type => ['approval/policy', 'permission/preset', 'sandbox/mode', 'model/selection', 'session/model-selection', 'request/header'].includes(type);
function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, 'Read-only operating-system verification failed');
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
function decode(bytes) {
  if (!bytes.length) return [];
  let text;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) text = gunzipSync(bytes).toString();
  else if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528) {
    const frames = []; let rest = bytes;
    while (rest.length) {
      const { buffer, engine } = zstdDecompressSync(rest, { info: true });
      assert.ok(engine.bytesWritten > 0 && engine.bytesWritten <= rest.length, 'Invalid compressed history frame');
      frames.push(buffer); rest = rest.subarray(engine.bytesWritten);
    }
    text = Buffer.concat(frames).toString();
  } else text = bytes.toString();
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function histories(folder, prefix = '') {
  const rows = [];
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...await histories(folder, path));
    else if (entry.isFile() && historyPath(path)) rows.push(path);
  }
  return rows;
}

/** Allow only the one complete startup index rebuild observed in this run.
 * Messaging.start calls store.reconcile; index increments a thread once for
 * every existing envelope in that thread (service.ts:37; store.ts:297,335).
 */
export function verifyMessagingIndexRecovery(before, live) {
  assert.deepEqual(Object.keys(live).sort(), Object.keys(before).sort(), 'Messaging document keys changed');
  assert.deepEqual(Object.keys(live.tables).sort(), Object.keys(before.tables).sort(), 'Messaging table keys changed');
  assert.deepEqual(Object.keys(live.tables.threads).sort(), Object.keys(before.tables.threads).sort(), 'Messaging thread keys changed');
  assert.deepEqual(live.tables.messages, before.tables.messages, 'Messaging records changed');
  const normalized = structuredClone(live), changes = [];
  const messages = Object.values(before.tables.messages);
  for (const [id, previous] of Object.entries(before.tables.threads)) {
    const current = live.tables.threads[id];
    assert.deepEqual(Object.keys(current).sort(), Object.keys(previous).sort(), 'Messaging thread fields changed');
    const messageCount = messages.filter(row => row.envelope.threadId === id).length;
    assert.ok(Number.isSafeInteger(previous.revision) && Number.isSafeInteger(current.revision), 'Invalid thread revision');
    if (current.revision === previous.revision) {
      assert.equal(messageCount, 0, 'Only part of the startup thread index was rebuilt');
      continue;
    }
    assert.ok(current.revision > previous.revision && messageCount > 0, 'Thread revision did not increase through an existing-message rebuild');
    assert.equal(previous.count, messageCount); assert.equal(current.count, messageCount);
    const delta = current.revision - previous.revision;
    assert.equal(delta % messageCount, 0, 'Thread revision growth is not a complete index pass');
    const rebuildPasses = delta / messageCount;
    assert.equal(rebuildPasses, 1, 'This deployment permits only its observed single startup reconciliation');
    normalized.tables.threads[id].revision = previous.revision;
    changes.push({ threadKeySha256: hash(id), beforeRevision: previous.revision, afterRevision: current.revision,
      delta, messageCount, rebuildPasses });
  }
  assert.ok(changes.length > 0, 'Messaging difference has no explained thread-index revision change');
  assert.deepEqual(normalized, before, 'Messaging content other than rebuildable thread revisions changed');
  return { changedThreads: changes.length, messageCount: messages.length, changes,
    messagesDedupeRateLimitsAndAllOtherFieldsUnchanged: true,
    explanation: 'One native cold-start Messaging.start -> store.reconcile index pass; Client mode switches need no additional pass' };
}

export async function verifyLive(runDir, migrationRunDir) {
  assert.equal(process.cwd(), root, 'Run from the repository root');
  runDir = await realpath(resolve(runDir));
  assert.ok(runDir.startsWith(`${root}/.dsh-dev/`), 'Only repository-owned run directories are permitted');
  const newerMigration = join(runDir, 'profile-migration-v2');
  const useNewer = await lstat(join(newerMigration, 'installed.json')).then(() => true, error => {
    if (error.code === 'ENOENT') return false; throw error;
  });
  const deploy = join(runDir, 'deploy');
  const migration = await realpath(migrationRunDir ? resolve(migrationRunDir)
    : useNewer ? newerMigration : join(runDir, 'profile-migration'));
  assert.ok(migration.startsWith(`${runDir}/`), 'Migration receipts must belong to this repository run');
  const [prepared, backup, installed, verified, before, migrated] = await Promise.all([
    json(join(deploy, 'prepared.json')), json(join(deploy, 'backup.json')), json(join(deploy, 'installed.json')),
    json(join(deploy, 'verified.json')), json(join(migration, 'before.json')), json(join(migration, 'installed.json')),
  ]);
  for (const row of [prepared, backup, installed, verified, before, migrated]) assert.equal(row.status, 'PASS', 'Current-run prerequisite receipt has not passed');
  for (const row of [prepared, backup, installed, verified]) assert.equal(row.paths.runDir, deploy, 'Deployment receipt belongs to another run');
  for (const row of [before, migrated]) assert.equal(row.paths.runDir, migration, 'Migration receipt belongs to another run');
  assert.equal(installed.candidateSha256, prepared.candidate.manifest.sha256);
  const { app, home, userData } = prepared.paths;
  for (const row of [backup, installed, verified, before, migrated]) {
    for (const key of ['app', 'home', 'userData']) assert.equal(row.paths[key], prepared.paths[key], 'Current-run receipts target different daily paths');
  }
  assert.equal(before.deployRunDir, deploy); assert.equal(migrated.deployRunDir, deploy);
  const coldHome = join(deploy, 'backup/home'), profile = join(home, 'profiles/desktop');
  assert.equal((await treeManifest(coldHome)).sha256, backup.manifests.home.sha256, 'Current full home backup changed');
  for (const key of ['app', 'userData']) assert.equal((await treeManifest(join(deploy, 'backup', key))).sha256,
    backup.manifests[key].sha256, 'A complete current-run cold backup changed');
  assert.equal((await treeManifest(join(migration, 'profile-backup'))).sha256, before.profile.sha256, 'The complete migration profile backup changed');

  // Use this run's official identity and inventory, never the old ad-hoc ASAR.
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const signature = signatureDetails(command('/usr/bin/codesign', ['--display', '--verbose=4', app]));
  assert.deepEqual(signature, prepared.candidate.identity.signature, 'Official publisher/signature changed');
  const requirement = `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ${JSON.stringify(signature.teamId)} and identifier ${JSON.stringify(signature.identifier)}`;
  command('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', requirement, app]);
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
  assert.equal((await treeManifest(app)).sha256, prepared.candidate.manifest.sha256, 'Official application files changed after installation');
  const asarSha = hash(await readFile(join(app, 'Contents/Resources/app.asar')));
  assert.equal(asarSha, migrated.officialAsarSha256, 'Official ASAR differs from this migration receipt');
  const appInventory = prepared.candidate.manifest.entries.find(row => row.path === 'Contents/Resources/app.asar');
  assert.equal(asarSha, appInventory.sha256);

  const coldPatch = await readFile(join(migration, 'profile-backup/cordis.patch.yml'), 'utf8');
  assert.equal(hash(coldPatch), before.patchSha256);
  const livePatch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');
  assert.ok(livePatch.startsWith(coldPatch), 'Existing profile patch bytes changed');
  const effectiveBefore = yaml.load(await readFile(join(migration, 'effective-before.yml'), 'utf8'), { schema: entryListSchema });
  const oldChat = effectiveBefore.filter(row => row.id === 'ui-chat' && !row.disabled);
  assert.equal(oldChat.length, 1); assert.equal(oldChat[0].name, '@deepseek-ai/dsh-client-ui-chat');
  const appended = yaml.load(livePatch.slice(coldPatch.length), { schema: entryListSchema });
  assert.deepEqual(appended, [{ id: 'ui-chat', config: oldChat[0].config ?? {} }],
    'Profile append exceeds the approved complete Chat-config migration');
  const manifest = await json(join(profile, 'package.json')), expectedManifest = structuredClone(before.package);
  expectedManifest.dependencies ??= {};
  expectedManifest.dependencies['dsh-bot-web-app'] = `file:${join(migration, 'compat-input.tgz')}`;
  expectedManifest.dsh.profile.bundles = before.package.dsh.profile.bundles.map(name => name === '@deepseek-ai/dsh-web-app' ? 'dsh-bot-web-app' : name);
  assert.deepEqual(manifest, expectedManifest, 'Live profile manifest changed beyond the approved compatibility dependency/selection');
  assert.deepEqual(manifest.dsh.profile.bundles, migrated.bundles);
  let originalProfileFilesVerified = 0;
  for (const row of before.profile.entries.filter(row => row.type === 'file' && !row.path.startsWith('node_modules/')
    && !['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'].includes(row.path))) {
    assert.equal(hash(await readFile(join(profile, row.path))), row.sha256, 'An unrelated original profile file changed');
    originalProfileFilesVerified++;
  }
  const parsed = yaml.load(livePatch, { schema: entryListSchema });
  const botConfig = parsed.findLast(row => row.id === 'dsh-bot' && row.config)?.config;
  assert.equal(botConfig?.supergroup?.enabled, false, 'Supergroup must remain explicitly disabled');
  assert.equal(await realpath(join(profile, 'node_modules/dsh-bot')), before.productPath);
  assert.equal((await treeManifest(before.productPath)).sha256, before.product.sha256, 'Existing product package bytes changed');
  assert.equal(hash(await readFile(migrated.paths.compat)), migrated.artifactSha256, 'Frozen compatibility artifact changed');
  assert.equal(hash(await readFile(join(migration, 'compat-input.tgz'))), migrated.artifactSha256);
  const compat = await realpath(join(profile, 'node_modules/dsh-bot-web-app'));
  assert.ok(compat.startsWith(`${profile}/`), 'Compatibility must remain profile-owned');
  const compatibility = await json(join(compat, 'compatibility.json'));
  assert.equal(compatibility.archiveSha256, asarSha);
  assert.equal(compatibility.version, prepared.candidate.identity.version);
  let compatFiles = 0;
  for (const row of (await treeManifest(join(migration, 'unpacked/package'))).entries.filter(row => row.type === 'file')) {
    assert.equal(hash(await readFile(join(compat, row.path))), row.sha256, 'Installed compatibility package differs from the frozen artifact'); compatFiles++;
  }

  // Bot identities, bindings, memories/labels and group state come from this
  // run's complete cold backup. Values and private identifiers never leave it.
  const domainFiles = backup.manifests.home.entries.filter(row => row.type === 'file' && /^storages\/dsh_bot(?:[._/]|$)/.test(row.path));
  assert.ok(domainFiles.length > 0, 'No Bot domain baseline was found');
  let messagingRecovery, botDomainByteIdenticalFiles = 0;
  for (const row of domainFiles) {
    const bytes = await readFile(join(home, row.path));
    if (hash(bytes) === row.sha256) { botDomainByteIdenticalFiles++; continue; }
    assert.equal(row.path, 'storages/dsh_bot_messaging.json', 'A Bot, binding, memory/label or group-state document changed');
    const previous = await readFile(join(coldHome, row.path)); assert.equal(hash(previous), row.sha256);
    messagingRecovery = verifyMessagingIndexRecovery(JSON.parse(previous), JSON.parse(bytes));
  }
  for (const path of ['storages/dsh_bot.json', 'storages/dsh_bot_main_session.json', 'storages/dsh_bot_groups.json', 'storages/dsh_bot_supergroup.json']) {
    assert.ok(domainFiles.some(row => row.path === path), 'A required Bot domain baseline is missing');
  }
  const oldHistories = backup.manifests.home.entries.filter(row => row.type === 'file' && row.path.startsWith('sessions/') && historyPath(row.path));
  assert.ok(oldHistories.length > 0, 'No session history baseline was found');
  const oldPaths = new Set(oldHistories.map(row => row.path.slice('sessions/'.length)));
  let addedModelSteps = 0, addedHumanMessages = 0, addedAssistantMessages = 0, addedControlTurns = 0, policiesChecked = 0;
  const added = events => {
    addedModelSteps += events.filter(event => event.type === 'step/start').length;
    addedHumanMessages += events.filter(event => event.type === 'user/message' && (!event.data?.source?.kind || event.data.source.kind === 'user')).length;
    addedAssistantMessages += events.filter(event => event.type === 'assistant/message').length;
    addedControlTurns += events.filter(event => event.type === 'turn/start').length;
  };
  for (const row of oldHistories) {
    const oldBytes = await readFile(join(coldHome, row.path)), liveBytes = await readFile(join(home, row.path));
    assert.equal(hash(oldBytes), row.sha256); assert.ok(liveBytes.length >= oldBytes.length, 'An old session history was truncated');
    assert.equal(hash(liveBytes.subarray(0, oldBytes.length)), row.sha256, 'An old compressed session history prefix changed');
    const oldEvents = decode(oldBytes), liveEvents = decode(liveBytes);
    for (const type of new Set([...oldEvents, ...liveEvents].map(event => event.type).filter(stableEvent))) {
      assert.deepEqual(liveEvents.findLast(event => event.type === type)?.data, oldEvents.findLast(event => event.type === type)?.data,
        'An existing session policy, model selection or request header changed'); policiesChecked++;
    }
    added(liveEvents.slice(oldEvents.length));
  }
  const currentHistories = await histories(join(home, 'sessions'));
  let newHistories = 0;
  for (const path of currentHistories.filter(path => !oldPaths.has(path))) { added(decode(await readFile(join(home, 'sessions', path)))); newHistories++; }
  assert.equal(addedModelSteps, 0, 'Verification must not start new model steps');
  assert.equal(addedHumanMessages, 0, 'Verification must not add human messages');
  assert.equal(addedAssistantMessages, 0, 'Verification must not add assistant messages');

  const processRows = command('/bin/ps', ['-axo', 'pid=,command=']).split('\n').flatMap(line => {
    const found = line.match(/^\s*(\d+)\s+(.+)$/); return found ? [{ pid: Number(found[1]), command: found[2] }] : [];
  });
  const executable = join(app, 'Contents/MacOS/DeepSeek Harness');
  const main = processRows.filter(row => row.command === executable);
  assert.equal(main.length, 1, 'Expected one normal daily desktop main process');
  const related = processRows.filter(row => row.command.startsWith(`${app}/`) || row.command.includes('dsh-desktop-host/lib/index.js') && row.command.includes(profile));
  assert.ok(related.some(row => row.command.includes('dsh-desktop-host/lib/index.js') && row.command.includes(profile)), 'Expected the actual daily desktop Host');
  assert.ok(related.every(row => !/--(?:remote-debugging|inspect(?:-brk)?|dsh-bot-desktop)/.test(row.command)), 'Daily launch must have no debug or isolated-test flags');
  assert.ok((await lstat(userData)).isDirectory());
  return { status: 'PASS', createdAt: new Date().toISOString(), runDir, migrationRunDir: migration, version: prepared.candidate.identity.version,
    officialSignaturePreserved: true, developerIdTeam: signature.teamId, officialApplicationUnchanged: true, officialAsarSha256: asarSha,
    compatibilityArtifactSha256: migrated.artifactSha256, compatibilityFilesVerified: compatFiles,
    originalProductUnchanged: true, approvedProfileMigrationOnly: true, originalPatchPrefixPreserved: true, originalProfileFilesVerified,
    botRegistryAndBindingsPreserved: true, memoryLabelsAndGroupStatePreserved: true, botDomainFilesVerified: domainFiles.length,
    botDomainByteIdenticalFiles, messagingRecovery,
    oldHistoryPrefixesPreserved: oldHistories.length, allExistingPoliciesModelHeadersPreserved: true, policiesChecked,
    newHistoryFiles: newHistories, addedModelSteps, addedHumanMessages, addedAssistantMessages, addedControlTurns,
    normalDesktopPid: main[0].pid, normalDesktopHostRunning: true, debugFlagsAbsent: true, supergroupEnabled: false,
    scope: 'live data/signature/process verification only; no model, Host launch, UI manipulation or HTTP factory audit' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let runDir;
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(['--run-dir', '--migration-run-dir'].includes(args[i]) && args[i + 1]
        && !args[i + 1].startsWith('--') && options[args[i]] === undefined, 'Use unique --run-dir and optional --migration-run-dir values');
      options[args[i]] = args[i + 1];
    }
    assert.ok(options['--run-dir'], 'Explicit --run-dir is required');
    runDir = await realpath(resolve(options['--run-dir']));
    const result = await verifyLive(runDir, options['--migration-run-dir']);
    const handle = await open(join(runDir, 'live-receipt.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(result, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    console.log(JSON.stringify({ status: 'PASS', version: result.version, botDomainFilesVerified: result.botDomainFilesVerified,
      oldHistoryPrefixesPreserved: result.oldHistoryPrefixesPreserved, addedModelSteps: 0, addedHumanMessages: 0, addedAssistantMessages: 0,
      signaturePreserved: true, approvedProfileMigrationOnly: true, normalLaunch: true, supergroupEnabled: false }));
  } catch (error) {
    if (runDir?.startsWith(`${root}/.dsh-dev/`)) {
      try {
        const handle = await open(join(runDir, `live-failure-${Date.now()}.json`), 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ status: 'FAIL', error: error.message }, null, 2)); } finally { await handle.close(); }
      } catch { /* Never overwrite another receipt or expose private diagnostics. */ }
    }
    // Private data and assertion operands are deliberately never printed.
    console.error(JSON.stringify({ status: 'FAIL', message: 'Live verification did not pass; no daily data was written.' }));
    process.exitCode = 1;
  }
}
