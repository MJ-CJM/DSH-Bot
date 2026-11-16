import assert from 'node:assert/strict';
import { cpSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDeployment, parseArguments, signatureDetails, stoppedProcessPids, treeManifest } from './deploy-official-desktop.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const signature = 'Identifier=com.deepseek.dsh\nAuthority=Developer ID Application: Test Publisher (TESTTEAM01)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=TESTTEAM01\nCDHash=1234abcd\n';
async function fixture(t, flags = {}) {
  await mkdir(join(root, '.dsh-dev'), { recursive: true });
  const folder = await mkdtemp(join(root, '.dsh-dev/official-deployment-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const options = { root: folder, candidate: join(folder, 'Candidate.app'), runDir: join(folder, 'receipts'), app: join(folder, 'Daily.app'), home: join(folder, 'home'), userData: join(folder, 'userData'), expectedTeamId: 'TESTTEAM01' };
  for (const path of [options.app, options.candidate]) {
    await mkdir(join(path, 'Contents'), { recursive: true });
    await writeFile(join(path, 'Contents/Info.plist'), 'fixture plist');
    await writeFile(join(path, 'app-bytes'), path === options.app ? 'original-ad-hoc' : 'official-candidate');
    await symlink('app-bytes', join(path, 'symbolic-link'));
  }
  await mkdir(join(options.home, 'profiles/desktop'), { recursive: true });
  await mkdir(join(options.home, 'logs'), { recursive: true });
  await mkdir(options.userData);
  await writeFile(join(options.home, 'profiles/desktop/config.yml'), 'SECRET_PROFILE_TOKEN');
  await writeFile(join(options.home, 'logs/host.log'), 'all logs retained');
  await writeFile(join(options.userData, 'Preferences'), 'SECRET_PREFERENCES');
  const calls = [];
  const run = (file, args) => {
    calls.push({ file, args });
    if (file === '/bin/ps') return flags.running ? ` 931 ${options.app}/Contents/MacOS/DeepSeek Harness` : '';
    if (file.endsWith('PlistBuddy')) return args[1].endsWith('CFBundleIdentifier') ? 'com.deepseek.dsh\n' : '0.2.3\n';
    if (file.endsWith('codesign')) {
      if (flags.failInstalled && args.includes('--verify') && args.at(-1) === options.app && readFileSync(join(options.app, 'app-bytes'), 'utf8') === 'official-candidate') throw new Error('injected installed signature failure');
      return args.includes('--display') ? signature : '';
    }
    if (file.endsWith('spctl')) return 'accepted\n';
    if (file.endsWith('ditto')) { cpSync(args.at(-2), args.at(-1), { recursive: true, verbatimSymlinks: true }); return ''; }
    if (file.endsWith('python3')) {
      if (args.length === 2) return '';
      const a = args.at(-2), b = args.at(-1), temp = `${a}.test-swap`;
      renameSync(a, temp); renameSync(b, a); renameSync(temp, b);
      return '';
    }
    throw new Error(`Unexpected fixture command: ${file}`);
  };
  const controller = await createDeployment(options, { command: run, lsof: () => ({ status: 1, stdout: '', stderr: '' }), platform: 'darwin' });
  return { options, controller, calls, folder };
}

test('CLI requires explicit absolute candidate/runDir and rejects unknown flags', () => {
  assert.throws(() => parseArguments(['prepare']), /Explicit/);
  assert.throws(() => parseArguments(['prepare', '--candidate', './candidate', '--run-dir', '/tmp/run']), /absolute/);
  assert.throws(() => parseArguments(['install', '--candidate', '/candidate', '--run-dir', '/run', '--sign', '-']), /Unknown/);
  assert.equal(parseArguments(['--help']).help, true);
});
test('publisher verification rejects ad-hoc or missing Developer ID/Team ID', () => {
  assert.equal(signatureDetails(signature).teamId, 'TESTTEAM01');
  assert.throws(() => signatureDetails('Signature=adhoc\nTeamIdentifier=not set\n'), /Ad-hoc/);
  assert.throws(() => signatureDetails('Authority=Apple Development: Test\nTeamIdentifier=TESTTEAM01\n'), /Developer ID/);
  assert.throws(() => signatureDetails('Authority=Developer ID Application: Test\nTeamIdentifier=not set\n'), /TeamIdentifier/);
});
test('process guard catches app, helper and orphan Host but ignores its own CLI', () => {
  const paths = { app: '/Applications/DeepSeek Harness.app', home: '/Users/test/.dsh', userData: '/Users/test/data' };
  const output = ` 1 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness\n 2 /Applications/DeepSeek Harness.app/Contents/Frameworks/Helper\n 3 /usr/bin/node /external/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js /Users/test/.dsh/profiles/desktop\n 4 /usr/bin/node scripts/deploy-official-desktop.mjs --app /Applications/DeepSeek Harness.app\n 5 /usr/bin/node /isolated/dsh-desktop-host/lib/index.js /isolated/home\n`;
  assert.deepEqual(stoppedProcessPids(output, paths, 4), [1, 2, 3]);
});
test('complete cold backup, atomic install, verify and app-only rollback preserve data', async t => {
  const { options, controller, calls } = await fixture(t);
  const before = await treeManifest(options.home);
  await controller.execute('prepare');
  await controller.execute('backup');
  const backed = JSON.parse(await readFile(join(options.runDir, 'backup.json'), 'utf8'));
  assert.equal(backed.exclusions.length, 0);
  assert.ok(backed.manifests.home.entries.some(row => row.path === 'profiles/desktop/config.yml'));
  assert.ok(backed.manifests.home.entries.some(row => row.path === 'logs/host.log'));
  assert.equal(JSON.stringify(backed).includes('SECRET_'), false);
  await controller.execute('install');
  assert.equal(await readFile(join(options.app, 'app-bytes'), 'utf8'), 'official-candidate');
  assert.equal((await controller.execute('verify')).signaturePreserved, true);
  // Runtime data changes after verification must survive an app-only rollback.
  await writeFile(join(options.home, 'new-conversation.json'), 'new user message');
  await controller.execute('rollback');
  assert.equal(await readFile(join(options.app, 'app-bytes'), 'utf8'), 'original-ad-hoc');
  assert.equal(await readFile(join(options.home, 'new-conversation.json'), 'utf8'), 'new user message');
  assert.equal(await readFile(join(options.home, 'profiles/desktop/config.yml'), 'utf8'), 'SECRET_PROFILE_TOKEN');
  assert.notEqual((await treeManifest(options.home)).sha256, before.sha256);
  assert.ok(calls.some(row => row.file.endsWith('python3') && row.args.length === 4));
  assert.ok(!calls.some(row => row.file.endsWith('codesign') && row.args.includes('--sign')));
  assert.ok(calls.some(row => row.file.endsWith('codesign') && row.args.includes('--test-requirement') && row.args.some(value => value.startsWith('=anchor apple generic'))));
});
test('mutated candidate is blocked before backup', async t => {
  const { options, controller } = await fixture(t);
  await controller.execute('prepare');
  await writeFile(join(options.candidate, 'app-bytes'), 'tampered');
  await assert.rejects(controller.execute('backup'), /Prepared candidate changed/);
  assert.equal(await readFile(join(options.app, 'app-bytes'), 'utf8'), 'original-ad-hoc');
});
test('mutated profile is blocked before installation without replacing app or data', async t => {
  const { options, controller } = await fixture(t);
  await controller.execute('prepare'); await controller.execute('backup');
  await writeFile(join(options.home, 'profiles/desktop/config.yml'), 'changed profile');
  await assert.rejects(controller.execute('install'), /Cold home changed/);
  assert.equal(await readFile(join(options.app, 'app-bytes'), 'utf8'), 'original-ad-hoc');
  assert.equal(await readFile(join(options.home, 'profiles/desktop/config.yml'), 'utf8'), 'changed profile');
});
test('post-swap signature failure restores original app and retains every data file', async t => {
  const { options, controller } = await fixture(t, { failInstalled: true });
  await controller.execute('prepare'); await controller.execute('backup');
  const before = await treeManifest(options.home);
  await assert.rejects(controller.execute('install'), /original app restored/);
  assert.equal(await readFile(join(options.app, 'app-bytes'), 'utf8'), 'original-ad-hoc');
  assert.equal((await treeManifest(options.home)).sha256, before.sha256);
  const result = JSON.parse(await readFile(join(options.runDir, 'install-failure.json'), 'utf8'));
  assert.equal(result.originalAppRestored, true);
});
test('running app blocks cold backup and keeps data untouched', async t => {
  const { options, controller } = await fixture(t, { running: true });
  await controller.execute('prepare');
  await assert.rejects(controller.execute('backup'), /Quit application and Host gracefully/);
  assert.equal(await readFile(join(options.home, 'profiles/desktop/config.yml'), 'utf8'), 'SECRET_PROFILE_TOKEN');
});
test('changed backup prevents app replacement', async t => {
  const { options, controller } = await fixture(t);
  await controller.execute('prepare'); await controller.execute('backup');
  await writeFile(join(options.runDir, 'backup/home/profiles/desktop/config.yml'), 'damaged backup');
  await assert.rejects(controller.execute('install'), /Backup home changed/);
  assert.equal(await readFile(join(options.app, 'app-bytes'), 'utf8'), 'original-ad-hoc');
});
test('cold verification failure restores original app while preserving changed data', async t => {
  const { options, controller } = await fixture(t);
  await controller.execute('prepare'); await controller.execute('backup'); await controller.execute('install');
  await writeFile(join(options.userData, 'Preferences'), 'new preferences');
  await assert.rejects(controller.execute('verify'), /original app restored/);
  assert.equal(await readFile(join(options.app, 'app-bytes'), 'utf8'), 'original-ad-hoc');
  assert.equal(await readFile(join(options.userData, 'Preferences'), 'utf8'), 'new preferences');
});
test('receipt path cannot escape repository through a symlink', async t => {
  const { options, folder } = await fixture(t);
  await symlink(options.home, join(folder, 'redirect'));
  await assert.rejects(createDeployment({ ...options, runDir: join(folder, 'redirect/receipts') }), /symlink ancestors/);
});
