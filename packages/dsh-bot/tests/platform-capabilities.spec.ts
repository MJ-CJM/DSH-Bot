import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { platformCapabilities } from '../src/host/capabilities/platform.js';
import { platformSchema } from '../src/shared/capabilities-contract.js';
import { nativePolicy } from '../src/host/data-flow/native-policy.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DshBotRegistry } from '../src/host/registry.js';
import type { ManagedOutlets } from '../src/host/data-flow/outlets.js';

describe('optional platform capability observations', () => {
  it('degrades without browser/voice services and accepts old inspect payloads', async () => {
    const ctx = new Context(); try {
      expect(platformCapabilities(ctx)).toEqual({ browser: { toolBridge: false }, voice: { available: false, providers: [] } });
      expect(platformSchema.parse(undefined)).toEqual(platformCapabilities(ctx));
    } finally { await ctx.fiber.dispose(); }
  });
  it('reports voice selected-provider readiness without downloading, preparing or transcribing', async () => {
    const ctx = new Context(); try {
      let phase = 'unprepared'; const prepare = vi.fn(), transcribe = vi.fn();
      ctx.provide('speechToText', { snapshot: () => ({ selection: { providerId: 'local' }, providers: [{ id: 'local', name: 'Local recognizer', preparation: { phase } }] }), prepare, transcribe } as never);
      expect(platformCapabilities(ctx).voice.providers[0]?.phase).toBe('unprepared');
      phase = 'ready'; expect(platformCapabilities(ctx).voice).toMatchObject({ available: true, selectedProvider: 'local', providers: [{ phase: 'ready' }] });
      expect(prepare).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled();
    } finally { await ctx.fiber.dispose(); }
  });
  it('a registered browser name grants no spoofed MCP authority; ordinary native definitions still work', async () => {
    const ctx = new Context(); try {
      ctx.provide('browserUse', { providerName: 'playwright-mcp' } as never);
      expect(platformCapabilities(ctx).browser).toEqual({ provider: 'playwright-mcp', toolBridge: false });
      const definitions = new Map([['read', {}], ['mcp__playwright-mcp__browser_click', {}]]);
      const agent = { ctx: { tools: { get: (name: string) => definitions.get(name) } } } as unknown as Agent;
      const policy = nativePolicy(agent, { botId: 'alpha', botCreatedAt: 1 }, { config: { nativeToolPolicy: 'native' } } as unknown as DshBotRegistry, {} as ManagedOutlets);
      expect(policy.owns('read')).toBe(true);
      expect(policy.candidate('mcp__playwright-mcp__browser_click')).toBe(false);
      expect(policy.owns('mcp__playwright-mcp__browser_click')).toBe(false);
      definitions.set('read', {}); expect(policy.owns('read')).toBe(false);
    } finally { await ctx.fiber.dispose(); }
  });
});
describe('isolated foreground Host launcher (no Host started)', () => {
  const script = resolve(process.cwd(), '../../scripts/grok-dev-host.sh');
  it('help and check are read-only, hide auth tokens, and explain the isolated profile prerequisite', async () => {
    const help = await promisify(execFile)('bash', [script, '--help']); expect(help.stdout).toContain('--check');
    const check = await promisify(execFile)('bash', [script, '--check'], { env: { ...process.env, DSH_HOME: '/ignored/foreign-home' } });
    expect(check.stdout).toContain('default bind is 127.0.0.1'); expect(check.stdout).not.toContain('?token=');
  });
  it('rejects invalid ports and unknown deployment flags before invoking DSH', async () => {
    await expect(promisify(execFile)('bash', [script, '--port', '65536'])).rejects.toMatchObject({ code: 2 });
    await expect(promisify(execFile)('bash', [script, '--host', '0.0.0.0'])).rejects.toMatchObject({ code: 2 });
  });
});
