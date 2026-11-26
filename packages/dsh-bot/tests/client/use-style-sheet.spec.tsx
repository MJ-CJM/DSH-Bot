// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import { GroupSessionBadge } from '../../src/client/components/GroupSessionBadge.js';
import { SessionBotLeading, type SessionBotRowProps } from '../../src/client/components/SessionBotLeading.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { createSupergroupUiBridge, SupergroupWorkCard } from '../../src/client/supergroup.js';
import type { BotCatalog, CatalogSnapshot } from '../../src/client/state.js';
import type { ActivitySnapshot } from '../../src/client/activity-state.js';
import { WorkspaceMessage, type WorkspaceGroupMessage } from '../../src/client/workspace-group.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { SupergroupWorkView } from '../../src/shared/supergroup.js';
import { bots, summary, view } from './group-fixture.js';
import { bot } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) =>
  en.ui[key].replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? name))) as PropsLocale<'dsh-bot'>['t'];

function mountContainer() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  return { container, root, unmount };
}

describe('ref-counted document.head stylesheet deduplication', () => {
  it('mounts only one <style> in document.head across 50 WorkspaceMessage instances and cleans up on unmount', async () => {
    const ctx = new Context();
    cleanups.push(async () => { await ctx.fiber.dispose(); });
    const groupView = view();
    const groupKey = { groupId: groupView.group.id, groupCreatedAt: groupView.group.createdAt };
    ctx.provide('remote.dshBot.groups', {
      view: vi.fn(async () => ({ ok: true, value: groupView })),
      list: vi.fn(async () => ({ ok: true, value: [summary()] })),
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const { container, root, unmount } = mountContainer();
    const nodes: Array<ChatNode<'dsh-bot-group'>> = Array.from({ length: 50 }, (_, index) => ({
      key: `msg-${index}`,
      id: `msg-${index}`,
      kind: 'dsh-bot-group',
      target: 'chat',
      anchorSeq: index + 1,
      location: { kind: 'session' },
      visibility: 'visible',
      data: {
        group: groupKey,
        message: { id: `msg-${index}`, seq: index + 1, at: 1000 + index, text: `Hello ${index}`, turnId: 't1', authorKind: 'user', attachments: [] },
      } satisfies WorkspaceGroupMessage,
    }));

    await act(async () => {
      root.render(nodes.map(node => (
        <WorkspaceMessage key={node.key} node={node} sessionId={groupView.group.rootSessionId} actions={actions} onOpenSession={async () => {}} t={t} />
      )));
    });
    expect(container.querySelectorAll('[data-workspace-group-message]')).toHaveLength(50);
    expect(container.querySelectorAll('style')).toHaveLength(0);
    expect(document.head.querySelectorAll('style[data-dsh-bot-style="groups"]')).toHaveLength(1);

    await unmount();
    expect(document.head.querySelectorAll('style[data-dsh-bot-style="groups"]')).toHaveLength(0);
  });

  it('mounts only one <style> in document.head across 50 active SupergroupWorkCard instances and cleans up on unmount', async () => {
    const ctx = new Context();
    cleanups.push(async () => { await ctx.fiber.dispose(); });
    const group = view();
    const key = { groupId: group.group.id, groupCreatedAt: group.group.createdAt };
    ctx.provide('remote.dshBotSupergroup', {
      forSession: vi.fn(async ({ messageId }: { sessionId: string; messageId: string }) => ({
        ok: true as const,
        value: {
          group,
          work: {
            groupInputs: [], id: `work-${messageId}`, revision: 1,
            owner: { botId: 'alpha', botCreatedAt: 1 }, originSessionId: 'origin',
            inputMessageId: messageId, inputMessageIds: [messageId],
            configDigest: 'digest', readers: [{ botId: 'alpha', botCreatedAt: 1 }],
            createdAt: 1, updatedAt: 1, expiresAt: 1000, group: key, turnIds: [], state: 'running', experts: [],
          },
        } satisfies SupergroupWorkView,
      })),
    });
    ctx.provide('remote.dshBot.groups', {
      view: vi.fn(async () => ({ ok: true, value: group })),
      list: vi.fn(async () => ({ ok: true, value: [] })),
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const bridge = createSupergroupUiBridge(ctx, actions);
    const botSnapshot = { entries: bots.map(row => ({ bot: row })) };
    const catalog = { subscribe: () => () => {}, getSnapshot: () => botSnapshot } as unknown as BotCatalog;
    const { container, root, unmount } = mountContainer();
    const messageIds = Array.from({ length: 50 }, (_, index) => `msg-${index}`);

    await act(async () => {
      root.render(messageIds.map(messageId => (
        <SupergroupWorkCard key={messageId} sessionId="origin" messageId={messageId} bridge={bridge} actions={actions} bots={catalog} t={t} />
      )));
    });
    await vi.waitFor(() => expect(container.querySelectorAll('[data-supergroup-work]')).toHaveLength(50));
    expect(container.querySelectorAll('style')).toHaveLength(0);
    expect(document.head.querySelectorAll('style[data-dsh-bot-style="groups"]')).toHaveLength(1);

    await unmount();
    expect(document.head.querySelectorAll('style[data-dsh-bot-style="groups"]')).toHaveLength(0);
  });

  it('mounts only one <style> in document.head across 50 SessionBotLeading instances and cleans up on unmount', async () => {
    const record = bot();
    const ids = Array.from({ length: 50 }, (_, index) => `session-${index}` as SessionBotRowProps['sessionId']);
    const catalog: CatalogSnapshot = { entries: [{ bot: record }], loading: false, loaded: true, pollIntervalMs: 5000 };
    const activity: ActivitySnapshot = {
      sessions: ids.map(sessionId => ({
        sessionId, botId: record.id, botCreatedAt: record.createdAt, updatedAt: 100, unread: false,
        lastMessage: { role: 'assistant', preview: 'ok', at: 100 },
      })),
      bots: [], loading: false, loaded: true, pollIntervalMs: 5000,
    };
    const { container, root, unmount } = mountContainer();

    await act(async () => {
      root.render(ids.map(sessionId => (
        <SessionBotLeading key={sessionId} sessionId={sessionId}
          useCatalog={selector => selector(catalog)} useActivity={selector => selector(activity)} t={t} />
      )));
    });
    expect(container.querySelectorAll('[data-bot-session-leading]')).toHaveLength(50);
    expect(container.querySelectorAll('style')).toHaveLength(0);
    expect(document.head.querySelectorAll('style[data-dsh-bot-style="session-row"]')).toHaveLength(1);

    await unmount();
    expect(document.head.querySelectorAll('style[data-dsh-bot-style="session-row"]')).toHaveLength(0);
  });

  it('keeps zero <style> elements inside GroupSessionBadge <button> and cleans up head stylesheet on unmount', async () => {
    const groupSummary = summary();
    const { container, root, unmount } = mountContainer();

    await act(async () => {
      root.render(
        <GroupSessionBadge
          sessionId={groupSummary.group.rootSessionId as never}
          useGroups={selector => selector({ groups: [groupSummary], loading: false, loaded: true, pollIntervalMs: 5000 })}
          onOpenGroup={() => {}}
          t={t}
        />,
      );
    });
    const button = container.querySelector('button[data-group-details-opener]');
    expect(button).not.toBeNull();
    expect(button?.querySelector('style')).toBeNull();
    expect(container.querySelectorAll('style')).toHaveLength(0);
    expect(document.head.querySelectorAll('style[data-dsh-bot-style="groups"]')).toHaveLength(1);

    await unmount();
    expect(document.head.querySelectorAll('style[data-dsh-bot-style="groups"]')).toHaveLength(0);
  });
});
