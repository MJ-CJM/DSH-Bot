import { canReadLabel } from '../data-flow/labels.js';
import { platformCapabilities } from './platform.js';
import { readdir, writeFile, unlink, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { capabilityRequest, capabilityResult, skillName, type dataFlowDiagnosticSchema } from '../../shared/capabilities-contract.js';
import type { z } from 'zod';
import type { DshBotRegistry } from '../registry.js';
import { getBotBinding } from '../bot-context.js';
import { botSkillsDirectory } from '../composer.js';
import { checkedFile, contained, safeDirectory } from '../reference-memory/files.js';
import { digest, OperationError, parse, Serial } from '../common/operations.js';
interface NativeSkills { list(options: { scope: Agent; cwd?: string }): Promise<{ name: string; description: string; provider: string }[]> }
/** Thin native read bridge and bounded own-directory editor; never starts an Agent or model turn. */
export class Capabilities {
  private queue = new Serial();
  constructor(private ctx: Context, private registry: DshBotRegistry) {}
  close() { return this.queue.close(); }
  async request(input: z.input<typeof capabilityRequest>) {
    const r = parse(capabilityRequest, input);
    return this.queue.run(async () => {
      const llm = this.ctx.get('llm');
      if (r.action === 'models') {
        if (!llm) throw new OperationError('unavailable');
        const providers = await Promise.all(llm.listProviders().map(async provider => {
          try { return { ...provider, available: true, models: await llm.listModels(provider.id) }; }
          catch { return { ...provider, available: false, models: [] }; }
        }));
        return capabilityResult.parse({ kind: 'models', providers });
      }
      if (r.action === 'modelInfo') {
        if (!llm?.listProviders().some(row => row.id === r.provider)) throw new OperationError('unavailable');
        // Resolve advertised routes only; no credential discovery or model generation.
        if (!(await llm.listModels(r.provider)).some(row => row.id === r.model)) throw new OperationError('invalid');
        return capabilityResult.parse({ kind: 'modelInfo', model: await llm.resolveModelInfo(r.provider, r.model) });
      }
      const bot = await this.registry.get(r.bot.botId);
      if (bot.createdAt !== r.bot.botCreatedAt) throw new OperationError('conflict');
      if (r.action === 'freshConversation') {
        const mains = this.registry.mainSessions; if (!mains) throw new OperationError('unavailable');
        const result = await mains.fresh(bot.id, bot.createdAt, r.expectedSessionId);
        return capabilityResult.parse({ kind: 'conversation', sessionId: result.sessionId });
      }
      const root = botSkillsDirectory(bot.id, this.registry.config); await safeDirectory(root);
      if (r.action === 'inspect') {
        const main = await this.registry.mainSessions?.find(bot.id);
        const mainSessionId = this.registry.mainSessions?.boundSessionId?.(bot.id, bot.createdAt) ?? main?.sessionId;
        let dataFlow: z.output<typeof dataFlowDiagnosticSchema> = { state: 'unknown', reasons: ['unknown-lineage'] };
        if (mainSessionId) {
          const flow = this.registry.memoryOutlets;
          if (!flow) dataFlow = { state: 'unknown', reasons: ['unavailable'] };
          else try {
            const label = flow.label(mainSessionId), reasons: z.output<typeof dataFlowDiagnosticSchema>['reasons'] = [...label.restrictions];
            if (label.readers !== 'shared' && !label.readers.length) reasons.push('unknown-lineage');
            if (!canReadLabel(label, r.bot)) reasons.push('reader-mismatch');
            dataFlow = { state: reasons.length ? 'restricted' : 'clear', reasons: [...new Set(reasons)] };
          } catch { dataFlow = { state: 'unknown', reasons: ['unknown-lineage'] }; }
        }
        const agent = main && this.ctx.get('agents')?.get(SessionId(main.sessionId));
        const binding = agent && getBotBinding(agent);
        const online = !!agent && binding?.botId === bot.id && binding.botCreatedAt === bot.createdAt;
        const skills = online ? agent.ctx.get('skills') as NativeSkills | undefined : undefined;
        let loaded: Awaited<ReturnType<NativeSkills['list']>> = [], skillsAvailable = false;
        if (skills && agent) {
          try { const workingDirectory = agent.ctx.get('workingDirectory');
            const cwd = workingDirectory ? await workingDirectory.ensure(agent, new AbortController().signal) : bot.defaultCwd;
            loaded = await skills.list({ scope: agent, cwd }); skillsAvailable = true; } catch { /* provider diagnostics stay unavailable */ }
        }
        const candidates = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && skillName.safeParse(entry.name).success);
        const ownSkills = (await Promise.all(candidates.map(async entry =>
          await checkedFile(join(root, entry.name, 'SKILL.md'), 65536) === undefined ? undefined : entry.name))).filter((name): name is string => name !== undefined);
        return capabilityResult.parse({ kind: 'inspect', mainSessionId, dataFlow, platform: platformCapabilities(this.ctx), online, skillsAvailable, skills: loaded,
          ownSkills, tools: online && agent ? agent.ctx.tools.schemas(agent).map(tool => tool.name) : [], extraDirs: bot.skills.extraDirs });
      }
      const folder = contained(root, r.name); await safeDirectory(folder);
      const file = join(folder, 'SKILL.md'); const before = await checkedFile(file, 65536);
      const hash = before === undefined ? null : digest(before);
      if (r.action === 'skillRead') return capabilityResult.parse({ kind: 'skill', name: r.name, content: before, hash });
      if (r.expectedHash !== hash) throw new OperationError('conflict');
      // Recheck generation at the actual write boundary, after filesystem awaits.
      if ((await this.registry.get(bot.id)).createdAt !== bot.createdAt) throw new OperationError('conflict');
      if (r.action === 'skillRemove') { await unlink(file); return capabilityResult.parse({ kind: 'removed' }); }
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(r.content);
      if (!match || Buffer.byteLength(r.content) > 65536) throw new OperationError('invalid');
      let front: unknown; try { front = load(match[1] ?? ''); } catch { throw new OperationError('invalid'); }
      if (!front || typeof front !== 'object' || !('name' in front) || front.name !== r.name || !('description' in front) || typeof front.description !== 'string' || !front.description.trim()) throw new OperationError('invalid');
      // Atomic replacement after CAS, using the existing managed-file symlink checks.
      const temporary = join(folder, `.skill-${randomUUID()}.tmp`);
      try { await writeFile(temporary, r.content, { flag: 'wx', mode: 0o600 });
        if ((await checkedFile(file, 65536)) !== before) throw new OperationError('conflict');
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => {}); }
      return capabilityResult.parse({ kind: 'skill', name: r.name, content: r.content, hash: digest(r.content) });
    });
  }
}
