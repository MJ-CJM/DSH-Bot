// @vitest-environment jsdom
// B01: execute the published rc.2 Client closure and public registries/assembler.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import { it, expect } from 'vitest';
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

import { groupMessageDefinition } from '../../src/client/workspace-group.js';
it('native assembler emits exactly one exclusive group Bot card and leaves ordinary/native context alone', async () => {
  const api = runtime(), ctx = new Context();
  try {
    const events = new api.ConversationEventRegistry(ctx), views = new api.ConversationViewRegistry(ctx);
    views.register(view('chat')); events.register(definition('native'));
    const off = events.register(groupMessageDefinition);
    const source = { kind: 'dsh-bot-group', group: { groupId: 'g', groupCreatedAt: 1 }, turnId: 'turn',
      memberId: 'a', speaker: { bot: { botId: 'alpha', botCreatedAt: 1 }, name: 'Alpha' } };
    const row = (seq: number, value: unknown): SessionLiveEventEntry => ({ type: 'event', event: {
      seq: SessionSeq(seq), time: 1, type: 'user/message', surfaceOp: 'append', data: { id: `message-${seq}`, role: 'user',
        source: value, content: [{ type: 'text', text: 'fixture' }] } } }) as unknown as SessionLiveEventEntry;
    const a = new api.ConversationNodeAssembler(events, views); a.activateTarget('chat');
    a.replaceWindow([row(0, source), row(1, { kind: 'user' }), row(2, { kind: 'schedule' }), row(3, { kind: 'dsh-bot-group' })], false); a.flush();
    expect((a.snapshot('chat') as readonly ConversationViewNode[]).map(node => node.kind)).toEqual(['dsh-bot-group', 'native', 'native', 'native']);
    off(); const b = new api.ConversationNodeAssembler(events, views); b.activateTarget('chat'); b.replaceWindow([row(0, source)], false); b.flush();
    expect((b.snapshot('chat') as readonly ConversationViewNode[]).map(node => node.kind)).toEqual(['native']);
  } finally { await ctx.fiber.dispose(); }
});
