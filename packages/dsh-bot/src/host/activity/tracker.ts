import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '../registry.js';
import { firstUserProjection } from './first-user.js';

type ActivitySink = Pick<Context['dshBots'], 'recordActivity'>;

// Coordinates this plugin's activity observers across retained preset owners.
// A new owner releases the old lease before installing its own registration.
const activeTrackers = new WeakMap<Agent, () => void>();

/** Track the exact mounted Bot generation, including blank-session selection.
 * Both the preset owner and Agent own cleanup; stable preset ids alone cannot
 * distinguish a retained generation from the newly selected generation.
 */
export function registerBotPresetActivity(ctx: Context, botId: string, botCreatedAt: number): void {
  const presetScope = scopeOf(ctx);
  if (!presetScope) throw new Error('Bot activity requires a preset scope');
  // The preset plugin declares dshBots; the loop-owned Agent context does not.
  // Capture the injected service here while owning event resources on the Agent.
  const registry = ctx.dshBots;
  ctx.effect(() => {
    const agents = new Map<Agent, () => void>();
    const refresh = (agent: Agent) => {
      if (!scopeChainOf(scopeOf(agent.ctx)).includes(presetScope)) {
        agents.get(agent)?.();
        return;
      }
      if (agents.has(agent)) return;
      activeTrackers.get(agent)?.();
      let dispose: (() => void) | undefined;
      dispose = agent.ctx.effect(() => {
        const off = registerActivityTracking(agent, botId, botCreatedAt, registry);
        return () => {
          if (activeTrackers.get(agent) === dispose) activeTrackers.delete(agent);
          if (agents.get(agent) === dispose) agents.delete(agent);
          off();
        };
      }, 'dsh-bot: agent activity');
      agents.set(agent, dispose);
      activeTrackers.set(agent, dispose);
    };
    const offCreated = ctx.on('agent/created', ({ agent }) => { refresh(agent); });
    const offSelected = ctx.on('agent-preset/selected', (sessionId) => {
      const agent = ctx.agents.get(sessionId);
      if (agent) refresh(agent);
    });
    return () => {
      offCreated();
      offSelected();
      const errors: unknown[] = [];
      for (const dispose of [...agents.values()]) {
        try { dispose(); } catch (error) { errors.push(error); }
      }
      agents.clear();
      if (errors.length) throw new AggregateError(errors, 'Bot activity lifecycle cleanup failed');
    };
  }, 'dsh-bot: preset activity');
}

/** Called within the Bot's agent/created effect. Only complete, newly appended
 * human/assistant text is observed; streaming deltas and replay are not writes. */
export function registerActivityTracking(agent: Agent, botId: string, botCreatedAt: number, registry: ActivitySink): () => void {
  const header = agent.session.header;
  if (header.origin === 'subagent' || header.parentSession || (header.delegationDepth ?? 0) > 0) return () => {};
  const projections = agent.ctx.get('sessionProjections');
  let offProjection: (() => void) | undefined;
  try {
    // The public registry ref-counts this one shared definition. Registration is
    // owned by the requesting Agent effect and reads no history during startup.
    offProjection = projections?.register(firstUserProjection);
  } catch { /* Optional metadata must not prevent a Bot session from starting. */ }
  const offEvent = agent.ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return;
    let role: 'user' | 'assistant';
    let text: string;
    if (event.type === 'user/message' && event.data.source.kind === 'user' && event.surfaceOp === 'append') {
      role = 'user';
      text = event.data.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    } else if (event.type === 'assistant/message' && !event.data.interrupted && event.surfaceOp === 'append') {
      role = 'assistant';
      text = event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    } else return;
    // An image-only human input is still the latest user message and clears an
    // earlier assistant unread state. Tool/reasoning-only assistant steps do not.
    if (role === 'assistant' && !text.trim()) return;
    // Public projection view is optional in reduced Host compositions. Reading
    // a title must not make conversation progress depend on that service.
    let title: string | undefined;
    let firstUserText: string | undefined;
    try {
      const value = projections?.snapshot(session).values.title;
      if (typeof value === 'string') title = value;
    } catch { /* Title is optional metadata. */ }
    try {
      const value = offProjection ? projections?.stateOf(session, 'dshBotFirstUserPreview') : undefined;
      if (typeof value === 'string') firstUserText = value;
    } catch { /* Never infer first input from a later event when unavailable. */ }
    const reportUnavailable = () => {
      // Never include raw messages, title, or backend causes in this observer log.
      agent.ctx.logger.warn('[dsh-bot] activity update unavailable');
    };
    try {
      void registry.recordActivity({
        sessionId: session.id, botId, expectedBotCreatedAt: botCreatedAt,
        role, text, at: event.time, seq: event.seq, ...(title === undefined ? {} : { title }),
        ...(firstUserText === undefined ? {} : { firstUserText }),
      }).catch(reportUnavailable);
    } catch { reportUnavailable(); }
  });
  return () => { offEvent(); offProjection?.(); };
}
