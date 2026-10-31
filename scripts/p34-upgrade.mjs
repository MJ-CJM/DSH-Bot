import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { auditInstalled, command, sha256 } from './p34-artifact.mjs';

/** Reopen synthetic data written by the actual retained previous package, never user data. */
export async function checkUpgrade(root, runDir, env, artifact, audit, oldVersion = '0.2.2') {
  await mkdir(runDir, { recursive: true });
  assert.ok(['0.2.2', '0.3.0', '0.3.1'].includes(oldVersion));
  const oldArtifact = resolve(root, `dist/dsh-bot-${oldVersion}.tgz`);
  const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
  const { startMockLlmServer } = await import(require.resolve('@deepseek-ai/dsh-llm-mock-server'));
  const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['success'] });
  const profile = `p34-upgrade-${Date.now()}-${process.pid}`;
  const childEnv = { ...env, DSH_AGENTS_HOME: resolve(runDir, 'agents-home'), UPGRADE_MOCK_KEY: 'synthetic-only' };
  const cli = async (args, label) => {
    const result = await command(resolve(root, 'scripts/dsh'), args, { cwd: root, env: childEnv });
    await writeFile(resolve(runDir, `${label}.log`), result.output.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]'));
    assert.equal(result.code, 0, `See ${label}.log`);
  };
  try {
    const old = await command('/usr/bin/tar', ['-xOf', oldArtifact, 'package/package.json']);
    assert.equal(old.code, 0); assert.equal(JSON.parse(old.output).version, oldVersion);
    await cli(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
    for (const phase of ['old', 'new']) {
      await cli(['plugin', '--profile', profile, 'add', phase === 'old' ? oldArtifact : artifact], `${phase}-install`);
      if (phase === 'new') await auditInstalled(env.DSH_HOME, profile, audit);
      const patch = [
        '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
        '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
        '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(runDir, 'synthetic-credentials.yaml'))}`, '    watch: false',
        '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(resolve(runDir, 'bots-data'))}`,
        '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash', '    reasoningEffort: off',
        '- id: llm-deepseek', '  config:', '    apiKeyEnv: UPGRADE_MOCK_KEY', `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`, '    thinking: disabled', '    reasoningEffort: off',
        ...['llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
        '- insert:', '    - id: release-upgrade-probe', `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/release-upgrade-host.mjs'))}`,
        '      config:', `        outputDir: ${JSON.stringify(runDir)}`, `        phase: ${phase}`, `        oldVersion: ${oldVersion}`,
      ];
      await writeFile(resolve(env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), `${patch.join('\n')}\n`);
      const child = spawn(resolve(root, 'scripts/dsh'), ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'],
        { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', closed = false;
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
      const done = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => { closed = true; accept(code); }); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      try {
        const until = Date.now() + 90000;
        while (!closed && Date.now() < until && !/P34_UPGRADE_(READY|FAILED)/.test(output)) await delay(100);
        assert.ok(output.includes('P34_UPGRADE_READY'), `See ${phase}-host.log`);
      } finally {
        child.kill('SIGTERM'); const shutdown = setTimeout(() => child.kill('SIGKILL'), 10000);
        const code = await done; clearTimeout(shutdown); clearTimeout(timer);
        await writeFile(resolve(runDir, `${phase}-host.log`), output.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]'));
        assert.equal(code, 0);
      }
    }
    assert.equal(mock.requests.length, 0);
    const result = { status: 'PASS', profile, oldVersion, newVersion: audit.version,
      oldArtifactSha256: sha256(await readFile(oldArtifact)), artifactSha256: audit.sha256,
      botMemoryAndMainSessionUnchanged: true, modelRequests: 0, realModelRequests: 0 };
    await writeFile(resolve(runDir, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally { await mock.close(); }
}
