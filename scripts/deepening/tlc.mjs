import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd(), dir = resolve('.dsh-dev/deepening', `b7-tlc-${Date.now()}`);
assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
await mkdir(dir, { recursive: true });
const results = [], tool = '.dsh-dev/tools/tla2tools.jar';
async function execute(args, name) {
  const child = spawn('java', args, { cwd: root, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
  let spawnError;
  child.on('error', error => { spawnError = String(error); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
  const result = await new Promise(accept => child.once('close', (code, signal) => accept({ code, signal })));
  clearTimeout(timeout); await writeFile(resolve(dir, `${name}.log`), output);
  return { ...result, spawnError, output, args };
}
try {
  const manifest = await readFile('formal/TOOLS.sha256', 'utf8');
  const entry = manifest.split('\n').find(line => /^[a-f0-9]{64}\s+/.test(line));
  assert.ok(entry, 'NOT_RUN: no independently supplied tool hash in formal/TOOLS.sha256');
  const [expected, path] = entry.trim().split(/\s+/);
  assert.equal(path, tool, 'Only the repository-local supplied tool is allowed');
  const actual = createHash('sha256').update(await readFile(tool)).digest('hex');
  assert.equal(actual, expected, 'TLC tool digest mismatch');
  const java = await execute(['-version'], 'java'); assert.equal(java.code, 0, 'NOT_RUN: Java unavailable');
  for (const config of ['bot_message', 'memory_forget', 'stale_grant_negative']) {
    const result = await execute(['-Xmx1g', '-cp', resolve(tool), 'tlc2.TLC', '-workers', '1', '-metadir',
      resolve(dir, config), '-config', `formal/${config}.cfg`, 'formal/bot_message.tla'], config);
    const negative = config.endsWith('negative'), counterexample = /Invariant NoStaleGrant is violated/.test(result.output);
    const pass = negative ? result.code !== 0 && counterexample && /State \d+:/.test(result.output)
      : result.code === 0 && /Model checking completed. No error has been found/.test(result.output);
    results.push({ config, negative, status: pass ? 'PASS' : 'FAIL', code: result.code, signal: result.signal,
      args: result.args, counterexample, states: result.output.match(/[\d,]+ states generated[^\n]*/)?.[0] });
  }
  const status = results.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL';
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status, tool, actual, results }, null, 2));
  if (status !== 'PASS') process.exitCode = 1;
  console.log(JSON.stringify({ status, dir, results }));
} catch (error) {
  const status = /NOT_RUN|ENOENT/.test(String(error)) ? 'FAIL (NOT_RUN)' : 'FAIL';
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status, error: String(error), results }, null, 2));
  console.error(JSON.stringify({ status, dir, error: String(error) })); process.exitCode = 1;
}
