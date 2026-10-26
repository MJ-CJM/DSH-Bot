import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { sameBot } from '../../shared/identity.js';
import type { ForgetSelection, ForgetChoice, ForgetJob, CleanupReason } from '../../shared/memory-forget.js';
import type { DshBotRegistry } from '../registry.js';
import { ForgetPreviews } from './forget-preview.js';
import { ForgetRunner } from './forget-runner.js';
import { cleanHistory } from './history.js';
import { detectRootInstructions } from './root-instructions.js';

/** Host-owned conservative closure. No user/model-supplied session IDs or verified flags. */
export class MemoryForgetting {
  readonly previews: ForgetPreviews;
  readonly runner: ForgetRunner;
  readonly root = join(resolveDshHome(), 'dsh-bot', 'bots');
  constructor(private readonly ctx: Context, private readonly registry: DshBotRegistry) {
    const kernel = registry.memoryKernel;
    if (!kernel) throw new Error('Memory kernel unavailable');
    this.previews = new ForgetPreviews(kernel, () => this.inventory());
    this.runner = new ForgetRunner(kernel, this.previews, {
      drain: () => registry.memoryAdmission.drain(),
      history: async id => {
        const result = await ctx.sessionController.resolveAgent(id as Agent['session']['id']);
        if (!('agent' in result)) return ['unavailable'];
        return cleanHistory(result.agent, {
          flush: s => ctx.sessions.flush(s),
          readSurface: s => {
            const query = ctx.get('sessionQuery');
            if (!query) throw new Error('Surface reader unavailable');
            return query.readSurface(s.id);
          },
          rawReadPolicyVerified: false,
        });
      },
      copies: async () => {
        const graph = ctx.get('dshBotReferenceMemory');
        if (!graph) throw new Error('Reference memory unavailable; cleanup pending');
        await graph.forgetCleanup();
      },
      verifyInventory: job => this.verify(job),
    });
  }
  async preview(botId: string, selection: ForgetSelection) {
    const bot = await this.registry.get(botId);
    const v = this.registry.memoryKernel?.snapshot.versions.get(selection.memoryId);
    if (v?.scope !== 'private' || !sameBot(v.ownerBotKey, { botId, botCreatedAt: bot.createdAt }))
      throw new Error('Memory not found');
    return this.previews.create(selection);
  }
  choose(choice: ForgetChoice) { return this.runner.choose(choice); }
  roots() { return detectRootInstructions(this.root); }
  private async inventory() {
    const kernel = this.registry.memoryKernel;
    if (!kernel) throw new Error('Memory kernel unavailable');
    const agents = this.registry.memoryAdmission.sessions();
    const mainIds = this.registry.mainSessions?.boundSessionIds() ?? [];
    const reads = [...kernel.domain.table('receipts').entries()].filter(([, r]) => r.state === 'read');
    const sessionIds = [...new Set([...mainIds, ...agents.map(a => a.session.id), ...reads.map(([, r]) => r.sessionId)])].sort();
    const roots = await this.roots(), graph = this.ctx.get('dshBotReferenceMemory');
    const copies = graph ? await graph.forgetInventory() : undefined;
    return {
      sessionIds, historyNodes: agents.reduce((n, a) => n + a.session.surface.nodes.length, 0),
      summaries: agents.reduce((n, a) => n + a.session.snapshotEvents().filter(e => e.sourceEventSeqs?.length).length, 0),
      copies: copies?.count ?? 0, pendingMessages: agents.reduce((n, a) => n + a.inbox.nextStep.length + a.inbox.nextTurn.length, 0),
      conservative: true, rootInstructions: roots.files.some(f => f.state !== 'absent'),
      stamp: { roots, copies: copies?.stamp, reads, sessions: agents.map(a => ({ id: a.session.id,
        seqs: a.session.snapshotEvents().map(e => e.seq), inbox: [...a.inbox.nextStep, ...a.inbox.nextTurn] })) },
    };
  }
  private async verify(job: ForgetJob): Promise<CleanupReason[]> {
    const current = await this.inventory(), reasons: CleanupReason[] = ['raw-read-policy', 'inventory'];
    if (current.rootInstructions) reasons.push('root-instructions');
    if (current.pendingMessages) reasons.push('inbox');
    if (current.sessionIds.some(id => !job.sessionIds.includes(id))) reasons.push('history');
    if (current.copies) reasons.push('copies');
    // rc.2 has no proven audit covering every historical child and every raw-read outlet. Never fake verified.
    return reasons;
  }
}
