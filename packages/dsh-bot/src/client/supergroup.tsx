import { TaskSupportPanel, type TaskSupportActions, type createTaskOriginFocus } from './task-support.js';
import type { IntegrationActions } from './integrations-state.js';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { supergroupViewSchema, type SupergroupWorkView } from '../shared/supergroup.js';
import { SUPERGROUP_REMOTE } from '../shared/supergroup-contract.js';
import type { GroupActions } from './groups-state.js';
import type { BotCatalog } from './state.js';
import type { ExecutionBridge } from './group-execution.js';
import { createChangeStream } from './change-stream.js';
import { GroupTurnExecution } from './components/GroupTurnExecution.js';
import { BotAvatar } from './components/BotAvatar.js';
import css from './styles/groups.module.css?inline';
import styles from './styles/groups.module.css';
import settingsCss from './styles/integrations.module.css?inline';
import settingsStyles from './styles/integrations.module.css';

export interface SupergroupSettingsActions {
  settings(): Promise<{ enabled: boolean }>;
  configure(input: { enabled: boolean; expectedEnabled: boolean }): Promise<{ enabled: boolean }>;
}

/** Owner setting for automatic collaboration, independent of navigation. */
export function SupergroupSettings({ actions, t }: { actions: SupergroupSettingsActions } & PropsLocale<'dsh-bot'>) {
  const [value, setValue] = useState<{ enabled: boolean }>();
  const [busy, setBusy] = useState(true), [failed, setFailed] = useState(false);
  const alive = useRef(false), lock = useRef(false);
  const refresh = useCallback(async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setFailed(false);
    try { const next = await actions.settings(); if (alive.current) setValue(next); }
    catch { if (alive.current) { setValue(undefined); setFailed(true); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }, [actions]);
  useEffect(() => {
    alive.current = true; void refresh();
    return () => { alive.current = false; };
  }, [refresh]);
  return <section className={settingsStyles.panel} data-supergroup-settings="" aria-label={t('supergroup.settingsTitle')}>
    <style>{settingsCss}</style>
    <h3>{t('supergroup.settingsTitle')}</h3>
    <p>{t('supergroup.settingsScope')}</p>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <span>{t('supergroup.settingsGlobal')}</span>
      <Switch label={t('supergroup.settingsTitle')} checked={value?.enabled ?? false} disabled={busy || !value || failed} onChange={enabled => {
        if (lock.current || !value || failed) return;
        lock.current = true; setBusy(true); setFailed(false);
        void actions.configure({ enabled, expectedEnabled: value.enabled }).then(next => {
          if (alive.current) setValue(next);
        }, () => {
          // A lost response may follow a committed edit. Keep the last accepted
          // value and offer a read, never blindly repeat or flip optimistically.
          if (alive.current) setFailed(true);
        }).finally(() => { lock.current = false; if (alive.current) setBusy(false); });
      }} />
    </div>
    <p role="status">{busy ? t('supergroup.settingsSaving') : !value ? t('supergroup.settingsUnknown') : value.enabled ? t('supergroup.settingsEnabled') : t('supergroup.settingsDisabled')}</p>
    <p>{t('supergroup.settingsPermissions')}</p>
    <p>{t('supergroup.settingsReturn')}</p>
    {failed && <><p role="alert">{t('supergroup.settingsFailed')}</p><Button disabled={busy} onClick={() => { void refresh(); }}>{t('bots.refresh')}</Button></>}
  </section>;
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'supergroup-work': { messageId: string } }
}
/** Add one presentation seat while preserving the native human input renderer. */
export const supergroupMessageDefinition: ConversationNodeDefinition<{ messageId: string }> = {
  kind: 'supergroup-work', target: 'chat',
  match: event => event.type === 'user/message' && isAppendSurfaceEvent(event) && event.data.source.kind === 'user'
    ? { id: String(event.data.id), role: 'start' } : null,
  start: (_context, match) => ({ messageId: match.event.type === 'user/message' ? String(match.event.data.id) : '' }),
  update: context => context.state,
  buildViewNode: context => !context.state ? null : {
    key: context.key, id: context.id, kind: 'supergroup-work', target: 'chat', data: context.state,
    anchorSeq: Number(context.start?.event.seq ?? 0), location: context.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible', groupTree: 'input',
  } satisfies ChatNode<'supergroup-work'>,
};

type Snapshot = { value?: SupergroupWorkView | null; failed?: boolean };
interface WorkSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Snapshot;
  refresh(): Promise<void>;
}
export interface SupergroupUiBridge {
  source(sessionId: string, messageId: string): WorkSource;
  cancel(work: SupergroupWorkView['work']): Promise<void>;
  support?: { actions: TaskSupportActions; integrations?: IntegrationActions; openSession?(id: string): Promise<void>; focus?: ReturnType<typeof createTaskOriginFocus> };
}

/** Passive shared invalidation stream; native Chat events trigger authoritative
 * reads too. No extra scheduler, timer, Session writes, or model execution. */
export function createSupergroupUiBridge(ctx: Context, groups: GroupActions): SupergroupUiBridge {
  const entries = new Map<string, { source: WorkSource; listeners: Set<() => void> }>();
  let active = true;
  const remote = () => {
    const service = ctx.get('remote.dshBotSupergroup');
    if (!active || !service) throw new Error('Supergroup unavailable');
    return service;
  };
  const refreshAll = () => { for (const entry of entries.values()) void entry.source.refresh(); };
  const stream = createChangeStream(ctx, refreshAll);
  let offGroups: (() => void) | undefined;
  const start = () => {
    stream.start();
    offGroups ??= groups.catalog.watch?.(refreshAll);
  };
  const stop = () => { offGroups?.(); offGroups = undefined; void stream.stop(); };
  ctx.effect(() => () => { active = false; stop(); entries.clear(); }, 'dsh-bot: Supergroup projection lifetime');
  return {
    source(sessionId, messageId) {
      const key = JSON.stringify([sessionId, messageId]);
      const existing = entries.get(key);
      if (existing) return existing.source;
      let snapshot: Snapshot = {}, epoch = 0, pending: Promise<void> | undefined, again = false;
      const listeners = new Set<() => void>();
      const publish = (next: Snapshot) => { snapshot = next; for (const listener of listeners) listener(); };
      const source: WorkSource = {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener); entries.set(key, { source, listeners }); start(); void source.refresh();
          return () => {
            listeners.delete(listener);
            if (!listeners.size) { epoch++; pending = undefined; entries.delete(key); if (!entries.size) stop(); }
          };
        },
        refresh() {
          if (!active || !listeners.size) return Promise.resolve();
          start();
          if (pending) { again = true; return pending; }
          const generation = epoch;
          const task = (async () => {
            do {
              again = false;
              try {
                const result = await remote().forSession({ sessionId, messageId });
                if (!result.ok) throw result.error;
                const value = supergroupViewSchema.nullable().parse(result.value);
                if (value && (value.work.originSessionId !== sessionId || !value.work.inputMessageIds.includes(messageId)))
                  throw new Error('Supergroup input mismatch');
                if (value?.group && (!value.work.group || value.group.group.id !== value.work.group.groupId
                  || value.group.group.createdAt !== value.work.group.groupCreatedAt)) throw new Error('Supergroup group mismatch');
                if (active && generation === epoch && listeners.size) publish({ value });
              } catch {
                if (active && generation === epoch && listeners.size) publish({ value: snapshot.value, failed: true });
              }
            } while (again && active && generation === epoch && listeners.size);
          })().finally(() => { if (pending === task) pending = undefined; });
          pending = task;
          return task;
        },
      };
      return source;
    },
    async cancel(work) {
      if (work.state !== 'creating' && work.state !== 'running' && !(work.initialPending && work.state === 'partial')) { refreshAll(); return; }
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await remote().forSession({ sessionId: work.originSessionId, messageId: work.inputMessageId });
        if (!response.ok) throw response.error;
        const view = supergroupViewSchema.nullable().parse(response.value);
        const current = view?.work;
        if (!current || current.id !== work.id || current.createdAt !== work.createdAt
          || current.owner.botId !== work.owner.botId || current.owner.botCreatedAt !== work.owner.botCreatedAt
          || current.originSessionId !== work.originSessionId || current.inputMessageId !== work.inputMessageId
          || !current.inputMessageIds.includes(work.inputMessageId)
          || (work.group && (!current.group || current.group.groupId !== work.group.groupId
            || current.group.groupCreatedAt !== work.group.groupCreatedAt))
          || (view.group && (!current.group || view.group.group.id !== current.group.groupId
            || view.group.group.createdAt !== current.group.groupCreatedAt))) throw new Error('Supergroup stop identity mismatch');
        // A stale card must not turn a finished result into a cancelled work.
        if (current.state !== 'creating' && current.state !== 'running' && !(current.initialPending && current.state === 'partial')) { refreshAll(); return; }
        try {
          const result = await remote().cancel({ workId: current.id, expectedRevision: current.revision });
          if (!result.ok) throw result.error;
          refreshAll(); return;
        } catch (error) {
          // Only a checked CAS conflict permits one re-read of this exact
          // work. Transport failures may have committed and are never replayed.
          if (attempt === 0 && error && typeof error === 'object' && 'code' in error
            && error.code === 'dsh-bot/conflict') continue;
          throw error;
        }
      }
    },
  };
}

type CardProps = { sessionId: string; messageId: string; bridge: SupergroupUiBridge; actions: GroupActions; bots: BotCatalog;
  executionBridge?: ExecutionBridge; nativeRevision?: unknown } & Partial<PropsRenderFactories> & PropsLocale<'dsh-bot'>;
const noFocus = () => undefined;
const noFocusSubscription = () => () => {};

export function SupergroupWorkCard({ sessionId, messageId, bridge, actions, bots, executionBridge, nativeRevision, renderFactorySlot, t }: CardProps) {
  const source = useMemo(() => bridge.source(sessionId, messageId), [bridge, sessionId, messageId]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const botState = useSyncExternalStore(bots.subscribe, bots.getSnapshot);
  useEffect(() => { if (nativeRevision !== undefined) void source.refresh(); }, [source, nativeRevision]);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const card = useRef<HTMLElement>(null);
  const focus = bridge.support?.focus;
  const requested = useSyncExternalStore(focus?.subscribe ?? noFocusSubscription, focus?.getSnapshot ?? noFocus);
  const value = snapshot.value;
  useEffect(() => {
    const work = value?.work;
    if (!requested || !work || !card.current || requested.originSessionId !== sessionId || requested.inputMessageId !== messageId
      || requested.workId !== work.id || requested.owner.botId !== work.owner.botId || requested.owner.botCreatedAt !== work.owner.botCreatedAt) return;
    card.current.scrollIntoView?.({ block: 'center' });
    card.current.focus({ preventScroll: true });
    focus?.set();
  }, [requested, value, focus, sessionId, messageId]);
  if (!value) return snapshot.failed ? <p role="status">{t('supergroup.unavailable')}</p> : null;
  const { work, group } = value;
  const directPeer = !work.group && work.id.startsWith('peer:');
  // Direct messaging renders progress, receipts and the answer in the native conversation.
  // Keep its separate diagnostic only when a work state needs attention.
  if (work.inputMessageId !== messageId || (directPeer && work.state !== 'unknown' && work.state !== 'partial')) return null;
  const turns = group?.turns.filter(row => work.turnIds.includes(row.id)) ?? [];
  const members = group?.members.filter(row => row.enabled && row.removedAt === undefined).sort((a, b) => a.order - b.order) ?? [];
  const memberCount = group ? members.length : undefined;
  const live = work.state === 'running' || work.state === 'creating';
  return <section ref={card} tabIndex={-1} className={`dsh-bot-group-workspace ${styles.panel} ${styles.workCard}`} data-supergroup-work={work.id} data-supergroup-state={work.state} aria-label={t(work.initialPending ? 'taskSupport.initialTitle' : 'supergroup.title')}>
    <style>{css}</style>
    <div className={styles.workHeading}>
      <strong className={styles.workName} title={group?.group.name}>{group?.group.name ?? t(work.initialPending ? 'taskSupport.initialTitle' : 'supergroup.title')}</strong>
      <span className={styles.workStatus} role="status"><span aria-hidden="true">{live ? '◌' : work.state === 'completed' ? '✓' : '−'}</span>{t(work.initialPending && work.state === 'partial' ? 'taskSupport.waiting' : `supergroup.${work.state}`)}</span>
    </div>
    <div className={styles.workFooter}>
      <div className={styles.workMembers}>
        <span className={styles.workFaces} aria-hidden="true">{members.slice(0, 4).map(member => {
          const bot = botState.entries.find(row => row.bot.id === member.bot.botId && row.bot.createdAt === member.bot.botCreatedAt)?.bot;
          const speaker = group?.messages.find(message => message.speaker?.bot.botId === member.bot.botId && message.speaker.bot.botCreatedAt === member.bot.botCreatedAt)?.speaker;
          return <BotAvatar key={member.id} className={styles.workFace} size={24} bot={bot ?? { id: member.bot.botId, avatar: speaker?.avatar, avatarColor: speaker?.avatarColor, avatarVariant: speaker?.avatarVariant }} />;
        })}</span>
        {memberCount !== undefined && <span>{t('supergroup.members', { count: memberCount })}</span>}
      </div>
      <div className={styles.workActions}>
        {group && <button className={styles.workDiscussion} type="button" aria-label={t('supergroup.viewDiscussion')} disabled={busy} onClick={() => {
          if (lock.current) return; lock.current = true; setBusy(true); setFailed(false);
          void actions.open({ groupId: group.group.id, groupCreatedAt: group.group.createdAt })
            .catch(() => setFailed(true)).finally(() => { lock.current = false; setBusy(false); });
        }}>{t('supergroup.viewDiscussion')} <span aria-hidden="true">↗</span></button>}
        {(live || work.initialPending && work.state === 'partial') && <button className={styles.workStop} type="button" aria-label={t('supergroup.stop')} disabled={busy} onClick={() => {
          if (lock.current) return; lock.current = true; setBusy(true); setFailed(false);
          void bridge.cancel(work).catch(() => setFailed(true)).finally(() => { lock.current = false; setBusy(false); });
        }}><span aria-hidden="true">□</span>{t('supergroup.stop')}</button>}
      </div>
    </div>
    {!directPeer && bridge.support && <details onToggle={event => setSupportOpen(event.currentTarget.open)} data-task-support-entry="">
      <summary>{t('taskSupport.title')}</summary>
      {supportOpen && <TaskSupportPanel readOnly={['cancelled', 'unknown'].includes(work.state)} workId={work.id} actions={bridge.support.actions} integrations={bridge.support.integrations}
        bot={botState.entries.find(row => row.bot.id === work.owner.botId && row.bot.createdAt === work.owner.botCreatedAt)?.bot}
        refresh={() => source.refresh()} openSession={bridge.support.openSession} t={t} />}
    </details>}
    {work.state === 'unknown' && work.reason && <details>
      <summary>{t('execution.advanced')}</summary><p>{work.reason}</p>
    </details>}
    {(snapshot.failed || failed) && <p role="alert">{t('supergroup.unavailable')}</p>}
    {group && turns.length > 0 && <details className={styles.workExecution}><summary>{t('groups.executionDetails')}</summary>{turns.map(turn => <GroupTurnExecution key={JSON.stringify([work.id, group.group.id, group.group.createdAt, turn.id])}
      view={group} turn={turn} actions={actions} bots={bots} onOpenExecution={id => executionBridge?.open(id)}
      executionBridge={executionBridge} renderFactorySlot={renderFactorySlot} onStopTurn={null} onRequestSupplement={null} t={t} />)}</details>}
  </section>;
}

export async function registerSupergroup(ctx: Context, actions: GroupActions, bots: BotCatalog, executionBridge?: ExecutionBridge, support?: SupergroupUiBridge['support']): Promise<void> {
  await ctx.effect(async () => await ctx.remote.$mount(SUPERGROUP_REMOTE), 'dsh-bot: Supergroup Remote');
  const nativeSettings: SupergroupSettingsActions = {
    async settings() {
      const service = ctx.get('remote.dshBotSupergroup'); if (!service) throw new Error('Supergroup unavailable');
      const result = await service.settings(); if (!result.ok) throw result.error; return result.value;
    },
    async configure(input) {
      const service = ctx.get('remote.dshBotSupergroup'); if (!service) throw new Error('Supergroup unavailable');
      const result = await service.configure(input); if (!result.ok) throw result.error; return result.value;
    },
  };
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-botgroup', locale: 'dsh-bot',
  }, (props: PropsRuntime<'plugins.bundle.config'> & PropsLocale<'dsh-bot'>) => props.view === 'summary'
    ? <span>{props.t('supergroup.settingsTitle')}</span> : <SupergroupSettings actions={nativeSettings} t={props.t} />)), 'dsh-bot: Supergroup settings');
  const bridge = createSupergroupUiBridge(ctx, actions);
  bridge.support = support;
  ctx.inject(['uiConversation'], scope => {
    scope.effect(() => scope.slots.inject('conversation.chat.node', () => scope.effect(function* () {
      yield scope.slots.register({ name: 'conversation.chat.node', key: 'supergroup-work', locale: 'dsh-bot' },
        (props: PropsRuntime<'conversation.chat.node', 'supergroup-work'> & PropsLocale<'dsh-bot'> & PropsRenderFactories) => {
          const nativeRevision = props.useConversation(value => value);
          return <SupergroupWorkCard {...props} messageId={props.node.data.messageId} bridge={bridge}
            actions={actions} bots={bots} executionBridge={executionBridge} nativeRevision={nativeRevision} />;
        });
      yield scope.uiConversation.events.register(supergroupMessageDefinition);
    }, 'dsh-bot: Supergroup message projection')), 'dsh-bot: Supergroup renderer');
  });
}
