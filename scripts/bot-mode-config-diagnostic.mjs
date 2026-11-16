import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
const service = JSON.parse(await readFile(resolve('.dsh-dev/bot-mode-validation-a/service.json'), 'utf8'));
const dir = resolve('.dsh-dev/bot-mode-config-diagnostic', `${Date.now()}-${process.pid}`); await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'B03_CONFIG', { timeoutMs: 60000 }); run.env.DSH_BOT_DSH_BIN = service.executable;
const profile = 'b03-config';
try {
  await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await run.command(['plugin', '--profile', profile, 'add', service.artifact], 'install');
    await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), mockProfilePatch(dir, 'scripts/bot-mode-config-diagnostic-profile.mjs', { outputDir: dir }, [
    '- id: dsh-bot', '  config:', '    supergroup:', '      enabled: true', '      maxRequests: 24', '      timeoutMs: 300000',
  ]));
  await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
  const hot = JSON.parse(await readFile(resolve(dir, 'result.json'), 'utf8'));
  await writeFile(resolve(dir, 'hot-result.json'), JSON.stringify(hot, null, 2));
  await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'cold-host', true);
  const cold = JSON.parse(await readFile(resolve(dir, 'result.json'), 'utf8'));
  const result = { dir, hot, cold, coldEnabled: cold.initial?.enabled === true };
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) { console.error(String(error).replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]')); process.exitCode = 1; } finally { run.stop(); }
