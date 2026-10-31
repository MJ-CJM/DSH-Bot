import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const supportPath = './b6a-support.mjs';
const { submittedPrompt, bounded } = await import(supportPath);
const content = [{ type: 'text', text: 'I live in Shanghai.' }];
const event = (kind: string, rpcId?: string) => ({ type: 'user/message', data: { content, source: { kind, rpcId } } });
describe('B6a fixture regressions (UNIT, not real Web/Host proof)', () => {
  it('selects the submitted input when a runtime context follows it, without accepting runtime as user', () => {
    const submitted = event('user', 'direct-input');
    expect(submittedPrompt([submitted, event('runtime-context')], 'direct-input', content)).toBe(submitted);
    expect(() => submittedPrompt([event('runtime-context', 'direct-input')], 'direct-input', content)).toThrow('prompt.source');
    expect(() => submittedPrompt([event('runtime-context')], 'direct-input', content)).toThrow('prompt.rpcId');
    expect(() => submittedPrompt([submitted, submitted], 'direct-input', content)).toThrow('prompt.rpcId');
    expect(() => submittedPrompt([submitted], 'direct-input', [])).toThrow('prompt.content');
  });
  it('bounds a stuck await with cancellation so the probe can write a terminal receipt', async () => {
    const controller = new AbortController();
    const work = bounded(() => new Promise(() => {}), controller.signal);
    controller.abort(new Error('probe deadline during approval-request'));
    await expect(work).rejects.toThrow('probe deadline during approval-request');
  });
  // Includes two cold Node starts and a deliberate 5s deadline; this is a process-lifecycle test.
  it.each(['deadline', 'killed', 'failed', 'done'] as const)('persists the CLI child outcome: %s', async mode => {
    const base = resolve('../../.dsh-dev/deepening'); await mkdir(base, { recursive: true });
    const dir = await mkdtemp(resolve(base, 'b6a-runner-unit-'));
    try {
      await mkdir(resolve(dir, 'scripts')); await mkdir(resolve(dir, 'receipts'));
      await writeFile(resolve(dir, 'scripts/dsh'), `#!${process.execPath}
const { writeSync } = await import('node:fs');
process.on('SIGTERM', () => process.exit(0));
// SIGKILL cannot flush asynchronous console pipe writes. Commit the phase bytes first.
writeSync(1, 'DP_B6A_PHASE approval-request\\nhttp://127.0.0.1/?token=UNIT_SECRET\\n');
${mode === 'killed' ? "process.kill(process.pid, 'SIGKILL');" : ''}
${mode === 'done' || mode === 'failed' ? `console.log('DP_B6A_${mode.toUpperCase()}');` : ''}
setInterval(() => {}, 1000);
`, { mode: 0o755 });
      const runnerUrl = new URL('../../../../scripts/deepening/b3-runner.mjs', import.meta.url).href;
      const code = `
        const {runner} = await import(${JSON.stringify(runnerUrl)});
        const run = await runner(${JSON.stringify(dir)}, 0, 'DP_B6A', {timeoutMs: 5000, shutdownMs: 1000});
        try { await run.command([], 'host', true); } catch (error) { console.log(String(error)); } finally { run.stop(); }
      `;
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, timeout: 12000 });
      const [receipt] = JSON.parse(await readFile(resolve(dir, 'commands.json'), 'utf8'));
      expect(receipt.pid).toBeGreaterThan(0); expect(receipt.lastPhase).toBe('approval-request');
      expect(receipt.durationMs).toBeGreaterThan(0);
      expect(receipt.termination).toBe(mode === 'deadline' ? 'deadline' : mode === 'killed' ? 'exit' : 'fixture-marker');
      expect(receipt.timedOut).toBe(mode === 'deadline');
      expect(receipt.signal).toBe(mode === 'deadline' || mode === 'killed' ? 'SIGKILL' : null);
      expect(receipt.code).toBe(mode === 'deadline' || mode === 'killed' ? null : 0);
      const log = await readFile(resolve(dir, 'host.log'), 'utf8');
      expect(log).toContain('token=[redacted]'); expect(log).not.toContain('UNIT_SECRET');
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 15000);
});
