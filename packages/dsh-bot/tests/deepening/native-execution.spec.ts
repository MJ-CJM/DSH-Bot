import { describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { protectDataFlow } from '../../src/host/data-flow/tool-guard.js';
import { nativePolicy } from '../../src/host/data-flow/native-policy.js';
import { Config } from '../../src/host/registry-config.js';
import { withIntegrations } from '../integration-support.js';
import { flowFixture, alpha, beta } from './managed-flow-fixture.js';

const tool = (name: string, run: () => Promise<string> = async () => 'RESULT') => defineTool({
  name, description: 'Native provider double', parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: run,
});
const execute = (agent: Agent, name: string, args: unknown = {}) => agent.ctx.tools.execute({ agent, name, arguments: args,
  callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });

async function fixture(test: (x: Awaited<ReturnType<typeof flowFixture>>,
  f: Parameters<Parameters<typeof withIntegrations>[0]>[0]) => Promise<void>) {
  const x = await flowFixture();
  try { await withIntegrations(async f => {
    Object.assign(f.registry, x.registry(), { config: Config({}) });
    await test(x, f);
  }); } finally { await x.close(); }
}

describe('native execution: real ToolRuntime + native provider doubles + real JSON/files/process', () => {
  it('executes read/write/command/search in a child without adding data approval and keeps owner audience', async () => fixture(async (x, f) => {
    const { agent } = f.createAgent('child');
    await x.flow.inherit('child', { ...x.flow.label('private'), readers: [alpha] });
    const path = join(f.root, 'artifact.txt'), approvals = vi.fn(async () => 'rejected' as const);
    f.ctx.on('approval/request', approvals);
    agent.ctx.tools.register(tool('write', async () => { await writeFile(path, 'NATIVE_ARTIFACT'); return path; }));
    agent.ctx.tools.register(tool('read', () => readFile(path, 'utf8')));
    agent.ctx.tools.register(tool('bash', async () => (await promisify(execFile)(process.execPath,
      ['-e', 'process.stdout.write("COMMAND_EXECUTED")'])).stdout));
    agent.ctx.tools.register(tool('web_search', async () => 'MOCK_SEARCH_RESULT'));
    protectDataFlow(agent, alpha, f.registry);
    for (const name of ['write', 'read', 'bash', 'web_search']) expect((await execute(agent, name)).isError).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('NATIVE_ARTIFACT'); expect(approvals).not.toHaveBeenCalled();
    expect(x.flow.label('child').readers).toEqual([alpha]);
    // The actual managed result checker accepts self-return, while cross-Bot remains denied.
    const own = x.flow.draft('delegate-result', alpha, 'child', 'self', { kind: 'bot', bot: alpha }, 'RESULT');
    await expect(x.flow.admit(own)).resolves.toBeTypeOf('string');
    const other = x.flow.draft('delegate-result', alpha, 'child', 'other', { kind: 'bot', bot: beta }, 'RESULT');
    await expect(x.flow.admit(other)).rejects.toThrow();
  }));

  it('retains explicit group audience and never promotes private/unknown ingress to shared', async () => fixture(async (x, f) => {
    for (const [id, readers] of [['group-child', [alpha, beta]], ['unknown-child', []]] as const) {
      const { agent } = f.createAgent(id);
      await x.flow.inherit(id, { readers: [...readers], originTrust: 'user_confirmed', sourceVersions: [], restrictions: [], grants: [] });
      agent.ctx.tools.register(tool('read')); protectDataFlow(agent, alpha, f.registry);
      expect((await execute(agent, 'read')).isError).toBe(false);
      expect(x.flow.label(id).readers).toEqual(readers); expect(x.flow.label(id).originTrust).toBe('candidate');
      if (id === 'group-child') await expect(x.flow.admit(x.flow.draft('group-result', alpha, id, 'group',
        { kind: 'group', groupId: 'g', groupCreatedAt: 1, members: [alpha, beta] }, 'RESULT'))).resolves.toBeTypeOf('string');
    }
    const { agent } = f.createAgent('clean'); agent.ctx.tools.register(tool('read')); protectDataFlow(agent, alpha, f.registry);
    expect((await execute(agent, 'read')).isError).toBe(false); expect(x.flow.label('clean').readers).toEqual([alpha]);
  }));

  it.each(['deny', 'ask'] as const)('preserves native %s before tool dispatch', async decision => fixture(async (_x, f) => {
    const { agent } = f.createAgent('clean'), run = vi.fn(async () => 'EXECUTED'), approval = vi.fn(async () => 'rejected' as const);
    agent.ctx.tools.register(tool('bash', run)); protectDataFlow(agent, alpha, f.registry);
    agent.ctx.on('tools/pre-execute', async () => ({ kind: decision, reason: 'native restriction' }));
    f.ctx.on('approval/request', approval);
    expect((await execute(agent, 'bash')).isError).toBe(true); expect(run).not.toHaveBeenCalled();
    expect(approval).toHaveBeenCalledTimes(decision === 'ask' ? 1 : 0);
  }));

  it('allows approved native asks and blocks restricted mode, unknown names, PTC, MCP and replacement definitions', async () => fixture(async (_x, f) => {
    const { agent } = f.createAgent('clean'), run = vi.fn(async () => 'EXECUTED');
    const off = agent.ctx.tools.register(tool('read', run)); agent.ctx.tools.register(tool('rogue_tool', run));
    agent.ctx.tools.register(tool('mcp__rogue__read', run)); protectDataFlow(agent, alpha, f.registry);
    agent.ctx.on('tools/pre-execute', async (_exec, next) => { const result = await next();
      return result.kind === 'allow' ? { kind: 'ask', reason: 'native ask' } : result; });
    f.ctx.on('approval/request', async () => 'allowed-once');
    expect((await execute(agent, 'read')).isError).toBe(false);
    for (const name of ['rogue_tool', 'mcp__rogue__read', 'run_code']) expect((await execute(agent, name)).isError).toBe(true);
    off(); agent.ctx.tools.register(tool('read', run)); expect((await execute(agent, 'read')).isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    f.registry.config.nativeToolPolicy = 'restricted'; expect((await execute(agent, 'read')).isError).toBe(true);
  }));

  it.each(['secret', 'revoked', 'pending-cleanup'] as const)('does not execute with %s source', async restriction => fixture(async (x, f) => {
    const { agent } = f.createAgent('clean'), run = vi.fn(async () => 'EXECUTED');
    await x.flow.inherit('clean', { ...x.flow.label('clean'), restrictions: [restriction] });
    agent.ctx.tools.register(tool('read', run)); protectDataFlow(agent, alpha, f.registry);
    expect((await execute(agent, 'read')).isError).toBe(true); expect(run).not.toHaveBeenCalled();
  }));

  it('propagates lineage before native messages and rejects wider or unregistered targets', async () => fixture(async (x, f) => {
    const { agent } = f.createAgent('private'), run = vi.fn(async () => 'SENT');
    await x.flow.inherit('own-target', { readers: [alpha], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
    await x.flow.inherit('other-target', { readers: [beta], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
    agent.ctx.tools.register(tool('send_message', run)); protectDataFlow(agent, alpha, f.registry);
    expect((await execute(agent, 'send_message', { agent_id: 'own-target', message: 'PRIVATE' })).isError).toBe(false);
    expect(x.flow.label('own-target').sourceVersions).toEqual(x.flow.label('private').sourceVersions);
    for (const id of ['other-target', 'not-registered', 'clean'])
      expect((await execute(agent, 'send_message', { agent_id: id, message: 'PRIVATE' })).isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  }));

  it('rechecks identity inside dispatch after a different execute wrapper replaces it', async () => fixture(async (_x, f) => {
    const { agent } = f.createAgent('clean'), run = vi.fn(async () => 'REPLACED');
    const off = agent.ctx.tools.register(tool('read')); protectDataFlow(agent, alpha, f.registry);
    agent.ctx.on('tools/execute', async (_exec, next) => { off(); agent.ctx.tools.register(tool('read', run)); return next(); }, { prepend: true });
    expect((await execute(agent, 'read')).isError).toBe(true); expect(run).not.toHaveBeenCalled();
  }));

  it('rejects substituted definitions between guard and dispatch and validates policy config', async () => fixture(async (x, f) => {
    const { agent } = f.createAgent('clean'); const off = agent.ctx.tools.register(tool('read'));
    const policy = nativePolicy(agent, alpha, f.registry, x.flow); policy.capture(); off(); agent.ctx.tools.register(tool('read'));
    expect(policy.owns('read')).toBe(false);
    expect(Config({}).nativeToolPolicy).toBe('native');
    expect(Config({ nativeToolPolicy: 'restricted' }).nativeToolPolicy).toBe('restricted');
    expect(() => Config({ nativeToolPolicy: 'all' as 'native' })).toThrow();
    expect(Config({}).groupMaxContinuations).toBe(8);
    expect(() => Config({ groupMaxContinuations: 1.5 })).toThrow();
  }));

  it('can restrict an unchanged native definition without affecting managed tools', async () => fixture(async (_x, f) => {
    const { agent } = f.createAgent('clean'), run = vi.fn(async () => 'OK');
    agent.ctx.tools.register(tool('read', run)); agent.ctx.tools.register(tool('bot_memory_list', run));
    protectDataFlow(agent, alpha, f.registry);
    expect((await execute(agent, 'read')).isError).toBe(false);
    f.registry.config.nativeToolPolicy = 'restricted';
    expect((await execute(agent, 'read')).isError).toBe(true);
    expect((await execute(agent, 'bot_memory_list')).isError).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  }));
});
