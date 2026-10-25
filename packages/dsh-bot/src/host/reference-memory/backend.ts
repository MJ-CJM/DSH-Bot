import type { Agent } from '@deepseek-ai/dsh-agent';
import { type BotKey, sameBot } from '../../shared/integrations.js';
import { type GraphStatus, GRAPH_PREFIX } from '../../shared/reference-memory.js';
import { getBotBinding } from '../bot-context.js';
import { OperationError, need } from '../common/operations.js';

import { keyOf } from './model.js';
import { ReferenceWriter } from './writer.js';
export class ReferenceBackend extends ReferenceWriter {
  status(bot: BotKey): GraphStatus {
    const binding = this.binding(bot),
      l = this.live.get(keyOf(bot));
    const tools = l?.child ? l.agent.ctx.tools.schemas(l.agent).filter((t) => t.name.startsWith(GRAPH_PREFIX)) : [];
    return {
      bot,
      ...(binding ? { binding } : {}),
      state:
        !binding || binding.mode === 'internal'
          ? 'internal'
          : l?.accepting && tools.length
            ? 'ready'
            : this.reasons.has(keyOf(bot))
              ? 'unavailable'
              : 'pending',
      ...(this.reasons.get(keyOf(bot)) ? { reason: this.reasons.get(keyOf(bot)) } : {}),
      toolCount: tools.length,
      writer: !!l,
      copies: [...this.domain.table('copies').entries()]
        .map(([, r]) => r.receipt)
        .filter((r) => sameBot(r.bot, bot))
        .map((r) => structuredClone(r)),
    };
  }
  async apply(bot: BotKey) {
    return this.control.run(async () => {
      await this.assertBot(bot);
      await this.applyNow(bot);
    });
  }
  protected async main(bot: BotKey): Promise<Agent | undefined> {
    const main = await this.registry.mainSessions?.find(bot.botId);
    if (!main) return undefined;
    const agent = this.ctx.agents.get(main.sessionId as Agent['session']['id']);
    if (
      !agent ||
      !sameBot(need(getBotBinding(agent)), bot) ||
      agent.session.header.parentSession ||
      agent.session.header.origin === 'subagent'
    )
      throw new OperationError('conflict');
    return agent;
  }
  protected async applyNow(bot: BotKey) {
    const binding = this.binding(bot);
    if (!binding || binding.mode === 'internal' || this.stopping) return;
    const agent = await this.main(bot);
    if (!agent) {
      this.reasons.set(keyOf(bot), 'main-only');
      return;
    }
    if (agent.status !== 'idle') {
      this.reasons.set(keyOf(bot), 'busy');
      return;
    }
    // PTC needs a separately verified dispatch combination. Keep graph writes closed in that mode.
    let unsupportedMode = false;
    try {
      unsupportedMode = Boolean(agent.ctx.tools.get('run_code', agent));
    } catch {
      unsupportedMode = true;
    }
    if (unsupportedMode) {
      await this.stop(bot);
      this.reasons.set(keyOf(bot), 'unsupported');
      return;
    }
    const old = this.live.get(keyOf(bot));
    if (
      old?.agent === agent &&
      old.identity === binding.fileIdentity &&
      old.accepting &&
      agent.ctx.tools.schemas(agent).some((t) => t.name === `${GRAPH_PREFIX}read_graph`)
    )
      return;
    try {
      await agent.runMaintenance(async () => {
        await this.stop(bot);
        await this.mount(bot, agent, binding.fileIdentity, false);
      });
    } catch {
      if (!this.reasons.has(keyOf(bot))) this.reasons.set(keyOf(bot), 'initialization-failed');
    }
  }
  protected async ready(bot: BotKey) {
    await this.applyNow(bot);
    const l = this.live.get(keyOf(bot));
    if (!l?.accepting || !l.child) throw new OperationError('unavailable');
    // Presence in the public visible table does not prove PTC dispatch. Never forge a parent token.
    if (l.agent.ctx.tools.get('run_code', l.agent)) throw new OperationError('unsupported');
    return l;
  }
  botChanged(id: string) {
    for (const l of this.live.values())
      if (l.bot.botId === id) {
        let current = false;
        try {
          current = this.registry.presetBot(id).createdAt === l.bot.botCreatedAt;
        } catch {
          /* removed */
        }
        if (!current) {
          l.accepting = false;
          void this.control.run(() => this.closeLive(l)).catch(() => {});
        }
      }
  }
  close(): Promise<void> {
    this.stopping = true;
    for (const l of this.live.values()) l.accepting = false;
    for (const cancel of this.copying.values()) cancel.abort();
    this.closing ??= (async () => {
      await this.control.close();
      for (const l of [...this.live.values()]) await this.closeLive(l);
      await this.domain.close();
    })();
    return this.closing;
  }
}
