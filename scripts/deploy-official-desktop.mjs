// Orchestrator-only. Never quits processes, signs binaries, launches DSH, installs
// plugins, or rewrites user data. Each mutating step requires a cold application.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const swapCode = 'import ctypes,sys; libc=ctypes.CDLL(None,use_errno=True); f=libc.renamex_np; f.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint]; f.restype=ctypes.c_int; r=f(sys.argv[1].encode(),sys.argv[2].encode(),2); e=ctypes.get_errno(); sys.exit(0 if r==0 else (print("renamex_np failed errno="+str(e),file=sys.stderr) or 1))';
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => child !== parent && !relative(parent, child).startsWith(`..${sep}`) && relative(parent, child) !== '..' && !isAbsolute(relative(parent, child));
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  // Diagnostics can include environment/configuration. Never print raw output.
  if (result.error || result.status !== 0) throw new Error(`${basename(file)} failed (exit ${result.status ?? 'unavailable'})`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Complete regular-file hashes, directory modes and symlink targets; no profile,
// log, credential, hidden-file or node_modules exclusions. Links are not followed.
export async function treeManifest(folder) {
  const rows = [];
  async function walk(path, name) {
    const stat = await lstat(path);
    const row = { path: name, mode: stat.mode & 0o7777 };
    if (stat.isSymbolicLink()) rows.push({ ...row, type: 'symlink', target: await readlink(path) });
    else if (stat.isDirectory()) {
      rows.push({ ...row, type: 'directory' });
      for (const child of (await readdir(path)).sort()) await walk(join(path, child), name === '.' ? child : `${name}/${child}`);
    } else if (stat.isFile()) rows.push({ ...row, type: 'file', bytes: stat.size, sha256: await fileHash(path) });
    else throw new Error(`Cannot cold-back up special file: ${name}`);
  }
  await walk(folder, '.');
  return { sha256: sha(JSON.stringify(rows)), entries: rows };
}

export function stoppedProcessPids(output, { app, home, userData }, ownPid = process.pid) {
  return output.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === ownPid) return [];
    const text = match[2];
    // Match executables rooted in the app, orphan desktop Hosts referencing its
    // runtime, and any native DSH Host/profile rooted in the supplied home.
    const nativeHost = /(?:dsh-desktop-host|dsh-app-boot|(?:^|\/)dsh(?:\s|$)|\/dsh\/(?:lib|bin)\/)/.test(text);
    const isApp = text.startsWith(`${app}/`) || text.startsWith(`"${app}/`);
    const isHost = nativeHost && [app, home, userData].some(path => text.includes(path));
    return isApp || isHost ? [Number(match[1])] : [];
  });
}

export function signatureDetails(output) {
  const value = key => output.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
  const authorities = [...output.matchAll(/^Authority=(.*)$/gm)].map(row => row[1].trim());
  const teamId = value('TeamIdentifier');
  assert.ok(!/^Signature=adhoc$/m.test(output), 'Ad-hoc candidates are forbidden');
  assert.ok(authorities.some(row => row.startsWith('Developer ID Application: ')), 'Candidate requires Developer ID Application authority');
  assert.ok(teamId && /^[A-Z0-9]{10}$/.test(teamId), 'Candidate requires a valid TeamIdentifier');
  return { authorities, teamId, identifier: value('Identifier'), cdHash: value('CDHash') };
}

export async function createDeployment(options, dependencies = {}) {
  const run = dependencies.command ?? command;
  const root = await realpath(options.root ?? repoRoot);
  const paths = {
    candidate: resolve(options.candidate), runDir: resolve(options.runDir),
    app: resolve(options.app ?? '/Applications/DeepSeek Harness.app'),
    home: resolve(options.home ?? join(homedir(), '.dsh')),
    userData: resolve(options.userData ?? join(homedir(), 'Library/Application Support/@deepseek-ai/dsh-desktop')),
  };
  assert.ok(inside(root, paths.runDir), 'runDir must be inside this repository');
  // Reject symlink ancestors, including a runDir that redirects writes outside.
  for (let path = paths.runDir; path !== root; path = dirname(path)) {
    if (await exists(path)) assert.ok(!(await lstat(path)).isSymbolicLink(), 'runDir must have no symlink ancestors');
  }
  const resources = ['candidate', 'app', 'home', 'userData'];
  for (let i = 0; i < resources.length; i++) {
    const a = paths[resources[i]];
    assert.ok(a !== root && !inside(a, root), 'Protected source cannot contain the repository');
    assert.ok(a !== paths.runDir && !inside(a, paths.runDir), 'Receipts cannot be inside a protected source');
    for (const key of resources.slice(i + 1)) {
      const b = paths[key];
      assert.ok(a !== b && !inside(a, b) && !inside(b, a), 'Candidate, app, home and userData must be disjoint');
    }
  }
  await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
  await chmod(paths.runDir, 0o700);
  assert.equal(await realpath(paths.runDir), paths.runDir, 'runDir must be canonical');
  const receiptPath = name => join(paths.runDir, `${name}.json`);
  const write = async (name, data) => {
    const path = receiptPath(name);
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  };
  const read = async name => {
    const data = JSON.parse(await readFile(receiptPath(name), 'utf8'));
    assert.deepEqual(data.paths, paths, 'CLI paths differ from the recorded preparation');
    return data;
  };
  const record = data => ({ schema: 1, createdAt: new Date().toISOString(), paths, ...data });
  async function directory(path) {
    const stat = await lstat(path);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Source must be a real directory');
    assert.equal(await realpath(path), path, 'Source path must be canonical');
  }
  async function cold() {
    const pids = stoppedProcessPids(run('/bin/ps', ['-axo', 'pid=,command=']), paths);
    assert.equal(pids.length, 0, `Quit application and Host gracefully first; active PIDs: ${pids.join(',')}`);
    // Catch open SQLite/WAL files, lock holders and orphan Hosts even when the
    // executable name or native boot entry differs. No process is terminated.
    for (const folder of [paths.app, paths.home, paths.userData]) {
      const result = dependencies.lsof ? dependencies.lsof(folder) : spawnSync('/usr/sbin/lsof', ['-nP', '-t', '+D', folder], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      assert.ok(!result.error && [0, 1].includes(result.status), 'Unable to inspect open application/data files');
      assert.equal((result.stderr ?? '').trim(), '', 'Open-file inspection was incomplete');
      const holders = (result.stdout ?? '').trim().split(/\s+/).filter(Boolean);
      assert.equal(holders.length, 0, `Application/data files are still open; PIDs: ${holders.join(',')}`);
    }
  }
  async function candidate(path) {
    await directory(path);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]);
    const signature = signatureDetails(run('/usr/bin/codesign', ['--display', '--verbose=4', path]));
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', path]);
    const plist = join(path, 'Contents/Info.plist');
    const get = name => run('/usr/libexec/PlistBuddy', ['-c', `Print :${name}`, plist]).trim();
    const identity = { bundleId: get('CFBundleIdentifier'), version: get('CFBundleShortVersionString'), build: get('CFBundleVersion'), signature };
    assert.equal(identity.bundleId, options.expectedBundleId ?? 'com.deepseek.dsh', 'Unexpected candidate bundle identifier');
    assert.equal(signature.identifier, identity.bundleId, 'Signing/plist identifiers differ');
    if (options.expectedTeamId) assert.equal(signature.teamId, options.expectedTeamId, 'Unexpected publisher Team ID');
    // Impose an external Apple/Developer-ID requirement; accepting a candidate's
    // own designated requirement or parsing Authority text alone is insufficient.
    const requirement = `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ${JSON.stringify(signature.teamId)} and identifier ${JSON.stringify(identity.bundleId)}`;
    run('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', requirement, path]);
    return { identity, manifest: await treeManifest(path) };
  }
  async function sameTree(path, expected, label) {
    assert.equal((await treeManifest(path)).sha256, expected.sha256, `${label} changed`);
  }
  function sameCandidate(actual, expected, label) {
    assert.equal(actual.manifest.sha256, expected.manifest.sha256, `${label} changed`);
    assert.deepEqual(actual.identity, expected.identity, `${label} identity/signature changed`);
  }
  async function originalData(backup) {
    for (const key of ['home', 'userData']) await sameTree(paths[key], backup.manifests[key], `Cold ${key}`);
  }
  async function backupIntegrity(backup) {
    for (const key of ['app', 'home', 'userData']) await sameTree(join(paths.runDir, 'backup', key), backup.manifests[key], `Backup ${key}`);
  }
  const swap = (a, b) => run('/usr/bin/python3', ['-c', swapCode, a, b]);
  async function verifyInstalled(prepared, backup, transaction) {
    await cold();
    await originalData(backup);
    await backupIntegrity(backup);
    await sameTree(transaction.rollback, backup.manifests.app, 'Original rollback application');
    const installed = await candidate(paths.app);
    sameCandidate(installed, prepared.candidate, 'Installed application');
    await cold();
  }
  async function prepare() {
    assert.equal(dependencies.platform ?? process.platform, 'darwin', 'This CLI requires macOS');
    for (const key of resources) await directory(paths[key]);
    // Check the atomic exchange syscall is exported without modifying files.
    run('/usr/bin/python3', ['-c', 'import ctypes; assert ctypes.CDLL(None).renamex_np']);
    const value = await candidate(paths.candidate);
    const originalBundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(paths.app, 'Contents/Info.plist')]).trim();
    assert.equal(originalBundleId, value.identity.bundleId, 'Current and candidate application IDs differ');
    await write('prepared', record({ status: 'PASS', candidate: value, backupExclusions: [], origin: 'Local Developer ID/Gatekeeper checks only; orchestrator must verify official release provenance' }));
    return { status: 'PASS', action: 'prepare', identity: value.identity, candidateSha256: value.manifest.sha256 };
  }
  async function backup() {
    const prepared = await read('prepared');
    sameCandidate(await candidate(paths.candidate), prepared.candidate, 'Prepared candidate');
    assert.ok(!(await exists(join(paths.runDir, 'backup'))), 'Backup already exists; use a new runDir');
    await cold();
    await mkdir(join(paths.runDir, 'backup'), { mode: 0o700 });
    const manifests = {};
    for (const key of ['app', 'home', 'userData']) {
      manifests[key] = await treeManifest(paths[key]);
      run('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', paths[key], join(paths.runDir, 'backup', key)]);
      await sameTree(join(paths.runDir, 'backup', key), manifests[key], `Copied ${key}`);
      await sameTree(paths[key], manifests[key], `Source ${key} during backup`);
    }
    await cold();
    for (const key of ['app', 'home', 'userData']) await sameTree(paths[key], manifests[key], `Final source ${key}`);
    await write('backup', record({ status: 'PASS', manifests, exclusions: [] }));
    return { status: 'PASS', action: 'backup', files: Object.fromEntries(Object.entries(manifests).map(([key, value]) => [key, value.entries.length])) };
  }
  async function install() {
    const prepared = await read('prepared'), backup = await read('backup');
    assert.ok(!(await exists(receiptPath('transaction'))), 'Install already attempted; inspect receipts or use rollback');
    await cold();
    await backupIntegrity(backup);
    await originalData(backup);
    await sameTree(paths.app, backup.manifests.app, 'Original application');
    sameCandidate(await candidate(paths.candidate), prepared.candidate, 'Prepared candidate');
    // Both slots share the app filesystem. renamex_np(RENAME_SWAP) exchanges them
    // atomically: the target app path is never absent, including on a crash.
    const id = sha(paths.runDir).slice(0, 16);
    const stage = join(dirname(paths.app), `.${basename(paths.app)}.official-stage-${id}.app`);
    const rollback = join(dirname(paths.app), `.${basename(paths.app)}.official-rollback-${id}.app`);
    assert.ok(!(await exists(stage)) && !(await exists(rollback)), 'Staging/rollback slot already exists');
    const transaction = record({ status: 'PREPARED', stage, rollback });
    await write('transaction', transaction);
    let swapped = false, oldSlot = stage;
    try {
      run('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', paths.candidate, stage]);
      sameCandidate(await candidate(stage), prepared.candidate, 'Staged application');
      await cold();
      await originalData(backup);
      await sameTree(paths.app, backup.manifests.app, 'Original application before swap');
      swap(paths.app, stage); swapped = true;
      await rename(stage, rollback); oldSlot = rollback;
      await verifyInstalled(prepared, backup, transaction);
      await write('installed', record({ status: 'PASS', candidateSha256: prepared.candidate.manifest.sha256, rollback, coldDataPreserved: true, backupVerified: true }));
      return { status: 'PASS', action: 'install', rollback, coldDataPreserved: true };
    } catch (error) {
      let restored = false;
      if (swapped) {
        try {
          // Do not exchange a running app or an altered original. All data and
          // the failed candidate are retained for diagnosis.
          await cold();
          await sameTree(oldSlot, backup.manifests.app, 'Rollback application');
          swap(paths.app, oldSlot);
          await sameTree(paths.app, backup.manifests.app, 'Restored original application');
          restored = true;
        } catch { /* Leave both app slots and the full cold backup intact. */ }
      }
      await write('install-failure', record({ status: 'FAIL', appSwapOccurred: swapped, originalAppRestored: restored, dataNeverRewritten: true }));
      throw new Error(`Installation failed; original app ${restored ? 'restored' : swapped ? 'requires explicit rollback (see transaction receipt)' : 'unchanged'}; data retained`, { cause: error });
    }
  }
  async function verify() {
    const prepared = await read('prepared'), backup = await read('backup'), transaction = await read('transaction');
    await read('installed');
    try { await verifyInstalled(prepared, backup, transaction); }
    catch (error) {
      let restored = false;
      try { await rollback(); restored = true; } catch { /* Preserve all slots if safe cold rollback is unavailable. */ }
      if (!(await exists(receiptPath('verification-failure')))) await write('verification-failure', record({ status: 'FAIL', originalAppRestored: restored, dataNeverRewritten: true }));
      throw new Error(`Cold verification failed; original app ${restored ? 'restored' : 'requires explicit rollback (see transaction receipt)'}; data retained`, { cause: error });
    }
    if (!(await exists(receiptPath('verified')))) await write('verified', record({ status: 'PASS', coldDataPreserved: true, signaturePreserved: true, rollbackPreserved: true }));
    return { status: 'PASS', action: 'verify', coldDataPreserved: true, signaturePreserved: true, rollbackPreserved: true };
  }
  async function rollback() {
    const backup = await read('backup'), transaction = await read('transaction');
    await cold();
    // Recovery depends on the original app's digest and retained app slot. A
    // damaged data-backup copy must not prevent restoration of a sound app.
    if ((await treeManifest(paths.app)).sha256 === backup.manifests.app.sha256) return { status: 'PASS', action: 'rollback', alreadyOriginal: true };
    const slot = await exists(transaction.rollback) ? transaction.rollback : transaction.stage;
    await sameTree(slot, backup.manifests.app, 'Rollback application');
    swap(paths.app, slot);
    await sameTree(paths.app, backup.manifests.app, 'Restored original application');
    await write('rolled-back', record({ status: 'PASS', retainedCandidate: slot, dataNeverRewritten: true }));
    return { status: 'PASS', action: 'rollback', dataNeverRewritten: true };
  }
  return {
    async execute(action) {
      const actions = { prepare, backup, install, verify, rollback };
      assert.ok(actions[action], 'Unknown action');
      const lockPath = join(paths.runDir, '.deployment.lock');
      const lock = await open(lockPath, 'wx', 0o600);
      try { await lock.writeFile(String(process.pid)); return await actions[action](); }
      finally { await lock.close(); await unlink(lockPath); }
    },
  };
}

const usage = `Orchestrator-only macOS desktop replacement; no app/process/data/config changes beyond app swap.
Usage: node scripts/deploy-official-desktop.mjs prepare|backup|install|verify|rollback
  --candidate /absolute/path/DeepSeek\\ Harness.app --run-dir /repo/.dsh-dev/official-upgrade/run-id
  [--app /Applications/DeepSeek\\ Harness.app] [--home ~/.dsh] [--user-data /path/to/userData]
  [--expected-team-id PUBLISHER_ID] [--expected-bundle-id com.deepseek.dsh]
Use the same explicit paths for every step. Verify runs BEFORE launch while data is cold.
Backup includes ALL profiles/logs/credentials; runDir is private and must never be published.
Release download/provenance, graceful shutdown, post-launch Bot validation and cleanup belong to the orchestrator.
Interrupted install: inspect transaction.json; rollback atomically restores the original app without restoring/deleting user data.`;
export function parseArguments(args) {
  const [action, ...rest] = args;
  if (action === '--help' || action === '-h') return { help: true };
  assert.ok(['prepare', 'backup', 'install', 'verify', 'rollback'].includes(action), usage);
  const names = { '--candidate': 'candidate', '--run-dir': 'runDir', '--app': 'app', '--home': 'home', '--user-data': 'userData', '--expected-team-id': 'expectedTeamId', '--expected-bundle-id': 'expectedBundleId' };
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]], value = rest[i + 1];
    assert.ok(key && value && !value.startsWith('--') && options[key] === undefined, 'Unknown, repeated or missing CLI option');
    options[key] = value;
  }
  assert.ok(options.candidate && options.runDir, 'Explicit --candidate and --run-dir are required');
  for (const key of ['candidate', 'runDir', 'app', 'home', 'userData']) if (options[key]) assert.ok(isAbsolute(options[key]), `${key} must be absolute (expand ~ in your shell)`);
  return { action, options };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) console.log(usage);
    else console.log(JSON.stringify(await (await createDeployment(parsed.options)).execute(parsed.action)));
  } catch (error) {
    // Paths, identities and hashes are safe; raw subprocess output/configs are not.
    console.error(JSON.stringify({ status: 'FAIL', message: error.message }));
    process.exitCode = 1;
  }
}
