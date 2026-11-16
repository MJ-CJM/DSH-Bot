// Existing native group profiles, same frozen artifact, two supported Host versions.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
import { auditArtifact, auditInstalled, sha256 } from './p34-artifact.mjs';

const [mode, artifactArg, ...args] = process.argv.slice(2);
assert.equal(mode, '--mock-only', 'usage: --mock-only frozen.tgz [--only rc2|desktop022] [--suite runtime|admission|input]');
assert.ok(artifactArg && !artifactArg.startsWith('--'));
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--only', '--suite'].includes(args[index]) && args[index + 1]); options.set(args[index], args[index + 1]);
}
const root = process.cwd(), isolated = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, isolated);
const artifact = resolve(artifactArg), artifactSha256 = sha256(await readFile(artifact));
const out = resolve(isolated, 'supergroup-group-collaboration', `${Date.now()}-${process.pid}`);
await mkdir(out, { recursive: true }); console.log(out);
const variants = [
  { id: 'rc2', version: '0.2.1-rc.2', cli: process.env.DSH_BOT_RC2_DSH_BIN ?? resolve(isolated, 'proactive-bot/host-runtime/node_modules/.bin/dsh') },
  { id: 'desktop022', version: '0.2.2-rc.2', cli: process.env.DSH_BOT_DESKTOP022_DSH_BIN ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' },
].filter(variant => !options.get('--only') || options.get('--only') === variant.id);
const suites = [
  { id: 'runtime', marker: 'SG_RUNTIME', fixture: 'supergroup-runtime-profile.mjs', config: { phase: 'promotion' }, bots: ['sg-alpha', 'sg-beta', 'sg-gamma'] },
  { id: 'admission', marker: 'SG_GROUPS', fixture: 'supergroup-groups-profile.mjs', config: {}, bots: [] },
  { id: 'input', marker: 'B03_INPUT', fixture: 'bot-mode-supergroup-input-profile.mjs', config: {}, bots: ['b03-a', 'b03-b', 'b03-c'] },
].filter(suite => !options.get('--suite') || options.get('--suite') === suite.id);
assert.ok(variants.length && suites.length, 'unknown runtime or suite');
const results = [];
async function auditNativeApprovals(dir) {
  const files = (await readdir(resolve(dir, 'sessions'), { recursive: true })).filter(file => file.endsWith('session.v4.jsonl.zstd'));
  assert.ok(files.length, 'the native session journals exist');
  const rows = [];
  for (const file of files) {
    let rest = await readFile(resolve(dir, 'sessions', file)); const frames = [];
    while (rest.length) {
      const { buffer, engine } = zstdDecompressSync(rest, { info: true });
      assert.ok(engine.bytesWritten, 'a native journal frame was decoded'); frames.push(buffer); rest = rest.subarray(engine.bytesWritten);
    }
    for (const line of Buffer.concat(frames).toString().split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === 'approval/asked' || event.type === 'approval/decided') rows.push({ file, type: event.type, toolName: event.data?.toolName, outcome: event.data?.outcome });
    }
  }
  const receipt = { status: 'PASS', journals: files.length, nativeAsks: rows.filter(row => row.type === 'approval/asked').length, rows };
  await writeFile(resolve(dir, 'native-approval-audit.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
try {
  const audit = await auditArtifact(root, artifact, out);
  for (const variant of variants) for (const suite of suites) {
    const dir = resolve(out, variant.id, suite.id); await mkdir(dir, { recursive: true });
    const run = await runner(dir, 0, suite.marker, { timeoutMs: 150000 });
    run.env.DSH_BOT_DSH_BIN = resolve(variant.cli);
    try {
      const version = (await run.command(['--version'], 'version')).trim();
      assert.ok(version.split(/\r?\n/).includes(variant.version), `expected ${variant.version}, received ${version}`);
      assert.equal(sha256(await readFile(artifact)), artifactSha256);
      const profile = 'group-collaboration';
      await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
      await run.command(['plugin', '--profile', profile, 'add', artifact], 'install');
      await auditInstalled(run.env.DSH_HOME, profile, audit);
      const extra = ['- id: dsh-bot', '  config:', '    proactiveEnabled: false', '    proactiveExecutionEnabled: false',
        '    supergroup:', '      enabled: true', '      maxRequests: 24', '      timeoutMs: 90000',
        `      allowedBotIds: ${JSON.stringify(suite.bots)}`];
      await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), mockProfilePatch(dir,
        resolve(root, 'packages/dsh-bot/tests', suite.fixture), { outputDir: dir, ...suite.config }, extra));
      await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
      const result = JSON.parse(await readFile(resolve(dir, 'result.json'), 'utf8')); assert.equal(result.status, 'PASS');
      const nativeApproval = await auditNativeApprovals(dir);
      if (suite.id !== 'admission') assert.equal(nativeApproval.nativeAsks, 0, 'automatic production collaboration never requests native approval');
      const denied = await readFile(resolve(dir, 'network-denials.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      assert.equal(denied, '', 'no outbound model or network attempt');
      results.push({ runtime: variant.id, version: variant.version, suite: suite.id, artifactSha256, result, dir,
        actualInstalledBytesAudited: true, nativeApproval, realModelRequests: 0, networkAttempts: 0, browser: 'NOT_RUN' });
    } finally { run.stop(); }
  }
  await writeFile(resolve(out, 'summary.json'), `${JSON.stringify({ status: 'PASS', artifact, artifactSha256, results }, null, 2)}\n`);
  console.log('SUPERGROUP_GROUP_COLLABORATION_PASS');
} catch (error) {
  await writeFile(resolve(out, 'summary.json'), `${JSON.stringify({ status: 'FAIL', artifact, artifactSha256, results, error: String(error.stack) }, null, 2)}\n`);
  throw error;
}
