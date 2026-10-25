// @vitest-environment jsdom
// B01: execute the published rc.2 Client closure and public registries/assembler.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import { describe, it, expect } from 'vitest';
import type * as Conversation from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {
  ConversationNodeDefinition,
  ConversationViewNode,
  ConversationViewDefinition,
  ConversationNodeContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import * as primitives from './platform-primitives.js';
function runtime() {
  const require = createRequire(import.meta.url);
  let loaded: typeof Conversation | undefined;
  const storePlatform = {
    notifySubscribers(listeners: Set<() => void>) {
      for (const fn of listeners) fn();
    },
    createSnapshotStore<T>(value: T) {
      return {
        getSnapshot: () => value,
        set: (next: T) => {
          value = next;
        },
        subscribe: () => () => {},
      };
    },
  };
  const loader = {
    load(entry: { factory: (require: NodeJS.Require) => typeof Conversation }) {
      loaded = entry.factory(((id: string) =>
        id === '@deepseek-ai/dsh-client-ui-primitives'
          ? primitives
          : id === '@deepseek-ai/dsh-client-store'
            ? storePlatform
            : require(id)) as NodeJS.Require);
    },
  };
  new Function(
    'window',
    readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8'),
  )({ __ModuleLoader__: loader });
  if (!loaded) throw Error('Published client did not load');
  return loaded;
}
function definition(kind: string, exclusive = false, target = 'chat'): ConversationNodeDefinition<string> {
  return {
    kind,
    target,
    match: (e) =>
      e.type === 'user/message' && (!exclusive || e.data.source.kind === 'dsh-bot-message')
        ? {
            id: String(e.seq),
            role: 'start',
            ...(exclusive ? { exclusive: true } : {}),
          }
        : null,
    start: () => kind,
    update: (c) => c.state,
    buildViewNode: (c: ConversationNodeContext<string>) => ({
      key: c.key,
      kind: c.kind,
      id: c.id,
      target,
      data: c.state,
    }),
  };
}
function view(
  target: string,
): ConversationViewDefinition<ConversationViewNode, readonly ConversationViewNode[]> {
  return {
    target,
    create: () => ({
      empty: [],
      replace: ({ nodes }) => nodes,
      apply: ({ upserts }) => upserts,
    }),
  };
}
const event = (seq: number, kind = 'user'): SessionLiveEventEntry =>
  ({
    type: 'event',
    event: {
      seq: SessionSeq(seq),
      time: 1,
      type: 'user/message',
      data: {
        id: `message-${seq}`,
        role: 'user',
        source: { kind },
        content: [{ type: 'text', text: 'text' }],
      },
    },
  }) as unknown as SessionLiveEventEntry;
describe('B01 published native Client exclusive gate', () => {
  it('claims only own messages, keeps other targets, rejects conflicts and restores native definitions on unload', async () => {
    const api = runtime(),
      ctx = new Context();
    try {
      const events = new api.ConversationEventRegistry(ctx),
        views = new api.ConversationViewRegistry(ctx);
      views.register(view('chat'));
      views.register(view('trajectory'));
      events.register(definition('native'));
      events.register(definition('other-target', false, 'trajectory'));
      const remove = events.register(definition('dsh-bot-message', true));
      const assemble = () => {
        const a = new api.ConversationNodeAssembler(events, views);
        a.activateTarget('chat');
        a.activateTarget('trajectory');
        return a;
      };
      let a = assemble();
      a.replaceWindow(
        [event(0, 'dsh-bot-message'), event(1), event(2, 'schedule'), event(3, 'dsh-bot-message-unknown')],
        false,
      );
      a.flush();
      const chat = a.snapshot('chat') as readonly ConversationViewNode[];
      expect(chat.map((n) => n.kind)).toEqual(['dsh-bot-message', 'native', 'native', 'native']);
      expect((a.snapshot('trajectory') as readonly ConversationViewNode[]).length).toBe(4);
      const conflict = events.register(definition('conflict', true));
      a = assemble();
      expect(() => a.replaceWindow([event(0, 'dsh-bot-message')], false)).toThrow('both claim');
      conflict();
      remove();
      a = assemble();
      a.replaceWindow([event(0, 'dsh-bot-message')], false);
      a.flush();
      expect((a.snapshot('chat') as readonly ConversationViewNode[])[0]?.kind).toBe('native');
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
