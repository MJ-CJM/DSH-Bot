import { createGroupStatsSource, type GroupStatsSource } from './group-statistics.js';
import { useEffect, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client';

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'dsh-bot-execution': { childId: string } }
}
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { dshBotGroupExecution: unknown }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'dsh-bot.group.execution': { kind: 'single'; scope: 'session' } }
}
export type ExecutionSlots = PropsRenderSlots<'dsh-bot.group.execution'>;
export interface ExecutionBridge { ctx: Context; statistics?: GroupStatsSource; open(childId: string): void; retainReadOnly(id: SessionId, reason: string): () => void }

/** This embedded occurrence has no native view tabs; leave saved view selection alone. */
function ExecutionViews({ renderSlot }: ConversationViewsProps) {
  return renderSlot('conversation.session', { view: 'chat' });
}

/** Read-only presentation of a real child binding; no Session open/prompt/stop calls. */
export function GroupExecution({ childId, bridge, SessionProvider, renderSlot, t }: {
  childId: string; bridge: ExecutionBridge;
} & ExecutionSlots & PropsLocale<'dsh-bot'>) {
  const [reference, setReference] = useState<SessionReference>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setReference(undefined); setFailed(false);
    let alive = true;
    const release = bridge.ctx.effect(() => {
      const sessions = bridge.ctx.get('sessions') as unknown as ISessions;
      const ref = sessions.retain(childId as SessionId, { source: 'dshBotGroupExecution' });
      const unbind = bridge.retainReadOnly(childId as SessionId, t('execution.readOnly'));
      void ref.ready.then(() => { if (alive) setReference(ref); }, () => { if (alive) setFailed(true); });
      return () => { alive = false; ref.release(); unbind(); };
    }, 'dsh-bot: embedded group execution');
    return () => { alive = false; release(); };
  }, [bridge, childId, t]);
  return <div data-group-execution={childId} style={{ height: '100%', minHeight: 180, display: 'flex', flexDirection: 'column' }}>
    {failed ? <p role="alert">{t('execution.unavailable')}</p> : reference ?
      <SessionProvider session={reference}>{renderSlot('dsh-bot.group.execution', {})}</SessionProvider> : <p role="status">{t('groups.loading')}</p>}
  </div>;
}

export function registerGroupExecution(ctx: Context): ExecutionBridge {
  const mounted = new Map<SessionId, number>();
  let active = true;
  const bridge: ExecutionBridge = { ctx, statistics: createGroupStatsSource(ctx), open(childId) { if (!active) return; ctx.get('sidebarRight')?.openTab('dsh-bot-execution', { params: { childId } }); }, retainReadOnly(id, reason) {
    mounted.set(id, (mounted.get(id) ?? 0) + 1);
    ctx.get('conversation')?.blocks.set(id, { reason });
    let live = true;
    return () => {
      if (!live) return; live = false;
      const n = (mounted.get(id) ?? 1) - 1;
      if (n) mounted.set(id, n);
      else { mounted.delete(id); ctx.get('conversation')?.blocks.set(id, undefined); }
    };
  } };
  ctx.effect(() => () => { active = false; for (const id of mounted.keys()) ctx.get('conversation')?.blocks.set(id, undefined); mounted.clear(); }, 'dsh-bot: execution view lifetime');
  ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: -30,
    // ConversationContent supplies a subscribed pendingInteraction owner. Native
    // approval/question takeovers must win while the ordinary child input stays
    // blocked; never snapshot pending state here or change the Host's policy.
    select: owner => owner.sessionId && mounted.has(owner.sessionId) && owner.pendingInteraction == null ? { readOnly: true } : null,
  }, () => null)), 'dsh-bot: execution composer suppression');
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], scope => {
    const t = scope.locale.bind('dsh-bot');
    scope.effect(() => scope.sidebarRightTabs.register({ id: 'dsh-bot.execution', kind: 'dsh-bot-execution', title: () => t('groups.executionDetails') }), 'dsh-bot: execution tab');
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.effect(function* () {
      yield scope.slots.register({
      name: 'sidebar.right.pane.tab', key: 'dsh-bot.execution', locale: 'dsh-bot',
      children: { 'dsh-bot.group.execution': { kind: 'single', scope: 'session' } },
    }, (props: PropsRuntime<'sidebar.right.pane.tab'> & ExecutionSlots & PropsLocale<'dsh-bot'>) => {
      const params = props.useTabInfo().tab.navigation.params;
      return params && 'childId' in params ? <GroupExecution key={params.childId} {...props} childId={params.childId} bridge={bridge} /> : <p>{props.t('execution.unavailable')}</p>;
    });
      yield scope.slots.inject('dsh-bot.group.execution', () => scope.slots.register({ name: 'dsh-bot.group.execution' },
        ({ renderFactorySlot }: PropsRenderFactories) => renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: { views: ExecutionViews } })));
    }, 'dsh-bot: execution tab slots')), 'dsh-bot: execution tab body');
  });
  return bridge;
}
