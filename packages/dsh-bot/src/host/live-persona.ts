import type { Agent } from '@deepseek-ai/dsh-agent';
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import type { BotRecord } from '../shared/schema.js';
import { DshBotError } from './errors.js';

type Persona = BotRecord['persona'];

/** Shadow the preset's public persona slots in the narrower Agent scope.
 * Only committed persona prose is refreshed; models, tools and permissions stay
 * with their original generation. A step already sent to a provider is immutable.
 */
export function installLivePersona(agent: Agent, read: () => Persona | undefined,
  subscribe: (changed: () => void) => () => void) {
  let current: Persona | undefined;
  const releases: Array<() => void> = [];
  let disposed = false;
  let updateError: unknown;
  const clear = () => { for (const off of releases.splice(0).reverse()) off(); };
  const register = (persona: Persona) => {
    try {
      releases.push(agent.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: () => { if (updateError) throw updateError; return persona.prefix; },
        ...(persona.complete ? { complete: true } : {}),
      }));
      releases.push(agent.ctx.systemPrompt.section({
        name: PERSONA_SUFFIX_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        text: () => { if (updateError) throw updateError; return persona.suffix ?? ''; },
      }));
    } catch (error) { clear(); throw error; }
  };
  const apply = (next: Persona) => {
    if (current && current.prefix === next.prefix && current.suffix === next.suffix &&
      Boolean(current.complete) === Boolean(next.complete)) { updateError = undefined; return; }
    const previous = current;
    clear();
    current = undefined;
    try { register(next); current = { ...next }; updateError = undefined; }
    catch (error) {
      if (previous) { register(previous); current = previous; }
      throw error;
    }
  };
  const refresh = () => {
    if (disposed) throw new DshBotError('bot/unavailable', 'Bot persona context is unloading');
    const next = read();
    if (!next) throw new DshBotError('bot/unavailable', 'This Bot generation is no longer available');
    apply(next);
  };
  let offStep: () => void;
  let offChange: (() => void) | undefined;
  try {
    // AgentLoop assembles before pre-step. Refresh synchronously after a registry
    // commit, not in pre-step, so the very next assembly sees the new complete flag.
    offChange = subscribe(() => {
      if (disposed) return;
      try {
        const persona = read();
        if (!persona) return; // pre-step still rejects a retired generation.
        apply(persona);
      } catch (error) { updateError = error; }
    });
    // Register the listener before the first committed read: preset activation
    // and home/model setup may have awaited across a completed persona update.
    refresh();
    offStep = agent.ctx.on('agent/pre-step', async (_input, next) => {
      if (updateError) throw updateError;
      refresh();
      return next();
    }, { prepend: true });
  } catch (error) { offChange?.(); clear(); throw error; }
  return () => { if (disposed) return; disposed = true; offChange?.(); offStep(); clear(); };
}
