import type { Context } from '@deepseek-ai/cordis';

export type BotsSection = 'bots' | 'groups' | 'recent';
export interface PageIdentity { id: string; createdAt: number }
export interface ListPosition { query: string; hidden: boolean }
export interface PageRequest { sequence: number; section: BotsSection; create?: 'bot' | 'group' }
export interface BotsPageNavigation {
  open?(section: BotsSection, create?: 'bot' | 'group'): void;
  subscribe?(listener: () => void): () => void;
  getRequest?(): PageRequest | undefined;
  consume?(sequence: number): void;
  section: BotsSection;
  create?: 'bot' | 'group';
  group?: PageIdentity;
  lists: Record<'bots' | 'recent', ListPosition>;
  scroll: Record<BotsSection, number>;
}

export function pageNavigation(): BotsPageNavigation {
  let request: PageRequest | undefined, sequence = 0;
  const listeners = new Set<() => void>();
  return { section: 'bots', lists: { bots: { query: '', hidden: false }, recent: { query: '', hidden: false } },
    scroll: { bots: 0, groups: 0, recent: 0 },
    getRequest: () => request,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open(section, create) { request = { sequence: ++sequence, section, create }; for (const notify of listeners) notify(); },
    consume(id) { if (request?.sequence === id) { request = undefined; for (const notify of listeners) notify(); } },
  };
}

/** Display state only: survives native panel remounts, never stores settings or credentials. */
export function createPageNavigation(ctx: Context): BotsPageNavigation {
  const state = pageNavigation();
  ctx.effect(() => () => { Object.assign(state, pageNavigation()); delete state.group; }, 'dsh-bot: page navigation');
  return state;
}
