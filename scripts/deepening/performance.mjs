import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, platform, arch } from 'node:os';
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const dir = resolve(root, '.dsh-dev/deepening', `b5-performance-${Date.now()}`); await mkdir(dir, { recursive: true });
const commands = [], datasets = [];
async function run(mode, dataDir, outputDir, logMode) {
  const args = ['--max-old-space-size=512', 'packages/dsh-bot/tests/deepening/performance.mjs', mode, dataDir, outputDir, logMode];
  const child = spawn(process.execPath, args, {
    cwd: root, env: { PATH: process.env.PATH, DSH_HOME: process.env.DSH_HOME }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => {
    output += b; if (mode === 'seed') process.stdout.write(b);
  });
  const { code, signal } = await new Promise((accept, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal }));
  });
  commands.push({ mode, logMode, code, signal }); await writeFile(resolve(outputDir, `${mode}-${child.pid}.log`), output);
  await writeFile(resolve(dir, 'commands.json'), JSON.stringify(commands, null, 2));
  assert.equal(code, 0, `Performance ${mode}/${logMode} failed; ${outputDir}`);
}
const p95 = values => values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (const logMode of ['bootstrap', 'independent']) {
    const outputDir = resolve(dir, logMode); await mkdir(outputDir);
    const dataDir = (logMode === 'bootstrap' ? process.env.DSH_BOT_PERF_DATA : process.env.DSH_BOT_PERF_INDEPENDENT_DATA) ?? outputDir;
    assert.ok(dataDir.startsWith(`${root}/.dsh-dev/deepening/b5-performance-`));
    const completeSeed = await access(resolve(dataDir, 'seed.json')).then(() => true, () => false);
    if (!completeSeed && (logMode === 'independent' || dataDir === outputDir)) await run('seed', dataDir, outputDir, logMode);
    else commands.push({ mode: 'reuse-seed', logMode, dataDir });
    await run('measure', dataDir, outputDir, logMode);
    for (let i = 0; i < 30; i++) await run('cold', dataDir, outputDir, logMode);
    const files = (await readdir(outputDir)).filter(n => /^(measure|cold)-\d+\.json$/.test(n));
    const receipts = await Promise.all(files.map(n => readFile(resolve(outputDir, n), 'utf8').then(JSON.parse)));
    const measured = receipts.find(r => r.mode === 'measure'), cold = receipts.filter(r => r.mode === 'cold');
    assert.equal(cold.length, 30); assert.ok(receipts.every(r => r.replayEquivalent));
    const seed = JSON.parse(await readFile(resolve(dataDir, 'seed.json'), 'utf8'));
    const writeP95ms = logMode === 'independent' && seed.writes?.length === 10000 ? p95(seed.writes) : undefined;
    const writeRatio = writeP95ms === undefined ? undefined : median(seed.writes.slice(5000, 5100)) / median(seed.writes.slice(500, 600));
    const summary = { mode: 'synthetic / npm rc.2 runtime / actual JSON per-record', seed: 'B5-rework-2', logMode,
      memories: 10000, bots: 10, logOps: measured.ops, dataDir,
      maxOldSpaceMiB: 512, machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
      warmups: 200, hits: measured.hits.length, recomputes: measured.recomputes.length, coldProcesses: cold.length,
      hitP95ms: p95(measured.hits), recomputeP95ms: p95(measured.recomputes), coldP95ms: p95(cold.map(r => r.recovered)),
      rebuildP95ms: p95(cold.map(r => r.rebuildMs)), replayEquivalent: true,
      writeP95ms, writeRatio5000to500: writeRatio, writeSegments: seed.segments, independentWriteSamples: seed.writes?.length,
      npmRuntimeReadyP95ms: p95(cold.map(r => r.runtimeReady)), fullCliHostStartup: 'NOT_RUN', realModelRequests: 0 };
    const pass = summary.hitP95ms <= 5 && summary.recomputeP95ms <= 50 && summary.coldP95ms <= 2000 && summary.rebuildP95ms <= 2000 &&
      (logMode !== 'independent' || writeP95ms !== undefined && writeP95ms <= 20 && writeRatio <= 2);
    datasets.push({ status: pass ? 'PASS' : 'FAIL', ...summary });
    await writeFile(resolve(outputDir, 'summary.json'), JSON.stringify(datasets.at(-1), null, 2));
    console.log(JSON.stringify({ dir: outputDir, ...datasets.at(-1) }));
  }
  const status = datasets.every(d => d.status === 'PASS') ? 'PASS' : 'FAIL';
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status, datasets }, null, 2));
  if (status === 'FAIL') process.exitCode = 1;
} catch (error) {
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', error: String(error), datasets }, null, 2));
  throw error;
} finally { await writeFile(resolve(dir, 'commands.json'), JSON.stringify(commands, null, 2)); }
