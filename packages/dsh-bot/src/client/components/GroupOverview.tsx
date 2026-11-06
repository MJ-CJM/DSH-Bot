import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Menu, PathLabel, SegmentedTabs, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupSummary, GroupView } from '../../shared/groups.js';
import { groupKey } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import type { GroupActions } from '../groups-state.js';
import { unwrapGroup } from '../groups-state.js';
import type { ExecutionBridge } from '../group-execution.js';
import type { GroupPermissionState } from '../group-permission-state.js';
import { type GroupActivityFocus, groupMemberModel, groupTurnFailure, groupTurnParticipants, groupTurnQuestion, latestMemberDelivery, recentGroupTurns } from '../group-management.js';
import { groupFailureText } from '../group-failure.js';
import { BotAvatar } from './BotAvatar.js';
import { GroupAvatar } from './GroupAvatar.js';
import { GroupStatisticsBar } from './GroupStatistics.js';
import { RetainedPanel } from './RetainedPanel.js';
import styles from '../styles/groups.module.css';

export type GroupOverviewSection = 'members' | 'activity' | 'settings';

export function GroupOverview({ summary, actions, bots, onOpenBot, onEdit, onOpenRun, onAskBot, executionBridge, permissionState,
  section: requestedSection, onSectionChange, showHeader = true, showTabs = true, focusTurnId, focusRequest, t }: {
  summary: GroupSummary;
  actions: GroupActions;
  bots: BotRecord[];
  onOpenBot?(bot: BotRecord): void;
  onEdit?(view: GroupView): void;
  onOpenRun?(view: GroupView, turnId: string): void;
  onAskBot?(bot: BotRecord, prompt: string, signal?: AbortSignal): void | Promise<void>;
  executionBridge?: ExecutionBridge;
  permissionState?: GroupPermissionState;
  section?: GroupOverviewSection;
  onSectionChange?(section: GroupOverviewSection): void;
  showHeader?: boolean;
  showTabs?: boolean;
  focusTurnId?: string;
  focusRequest?: GroupActivityFocus;
} & PropsLocale<'dsh-bot'>) {
  const [catalog] = useState(() => actions.createView(groupKey(summary.group)));
  useEffect(() => () => catalog.dispose(), [catalog]);
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
  const view = snapshot.view;
  const [section, setSection] = useState<GroupOverviewSection>(requestedSection ?? 'members');
  const currentSection = requestedSection ?? section;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [menu, setMenu] = useState(false);
  const navigation = useRef(new AbortController());
  useEffect(() => {
    if (navigation.current.signal.aborted) navigation.current = new AbortController();
    const owner = navigation.current;
    return () => owner.abort();
  }, []);
  const uid = useId();
  if (!view) return <p role={snapshot.error ? 'alert' : 'status'}>{t(snapshot.error ? 'groups.disconnected' : 'groups.loading')}</p>;
  const open = async () => {
    setBusy(true); setError(false);
    try { await actions.open(groupKey(view.group), navigation.current.signal); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const archive = async () => {
    setMenu(false); setBusy(true); setError(false);
    try {
      unwrapGroup(await actions.remote().archive(groupKey(view.group), view.group.revision));
      await Promise.all([catalog.refresh(), actions.catalog.refresh()]);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const members = view.members.filter(member => member.removedAt === undefined);
  const active = members.filter(member => member.enabled);
  const tabs = (['members', 'activity', 'settings'] as const).map(value => ({ value,
    label: t(`groups.view.${value}`), id: `${uid}-${value}`, panelId: `${uid}-${value}-panel`,
  })) as [import('@deepseek-ai/dsh-client-ui-primitives').SegmentedTab<GroupOverviewSection>, ...import('@deepseek-ai/dsh-client-ui-primitives').SegmentedTab<GroupOverviewSection>[]];
  return <article className={styles.overview} aria-label={view.group.name} data-group-overview={view.group.id}>
    {showHeader && <header className={styles.overviewHeader}>
      <GroupAvatar size={48} members={active} bots={bots} label={view.group.name} />
      <div className={styles.overviewIdentity}>
        <h3>{view.group.name}</h3>
        <p>{t('navigation.memberCount', { count: active.length })} · {t(`groups.${view.group.mode}`)}</p>
        <PathLabel path={view.group.cwd} />
      </div>
      <div className={styles.overviewActions}>
        <Button variant="primary" disabled={busy} onClick={() => { void open(); }}>{t('groups.open')}</Button>
        {onEdit && <Button variant="outline" disabled={busy || view.group.archived} onClick={() => onEdit(view)}>{t('groups.edit')}</Button>}
        <Menu open={menu} onClose={() => setMenu(false)} align="end"
          anchor={<Button variant="ghost" aria-label={t('card.more')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>···</Button>}
          items={[{ id: 'archive', label: t('groups.archive'), disabled: busy || view.group.archived }]}
          onSelect={() => { void archive(); }} />
      </div>
    </header>}
    {(error || snapshot.error) && <p role="alert">{t(error ? 'groups.conflict' : 'groups.disconnected')}</p>}
    <div className={styles.overviewFacts}>
      <span><StateDot state={view.running ? 'ongoing' : view.group.archived ? 'idle' : 'done'} />{t(view.running ? 'groups.running' : view.group.archived ? 'groups.archived' : 'groups.ready')}</span>
      {view.group.modelSelection && <span>{t('groups.modelSourceGroup')}: {view.group.modelSelection.provider} / {view.group.modelSelection.model}</span>}
      {permissionState && <GroupPermissionLabel state={permissionState} t={t} />}
    </div>
    {showTabs && <div className={styles.overviewTabs}><SegmentedTabs label={t('groups.manage')} value={currentSection}
      onChange={next => { if (onSectionChange) onSectionChange(next); else setSection(next); }} items={tabs} /></div>}
    <RetainedPanel active={currentSection === 'members'} id={`${uid}-members-panel`} labelledBy={`${uid}-members`}>
      <GroupMembersView key={JSON.stringify(groupKey(view.group))} view={view} bots={bots} actions={actions} active={currentSection === 'members'} onOpenBot={onOpenBot} onAskBot={onAskBot} executionBridge={executionBridge} t={t} />
    </RetainedPanel>
    <RetainedPanel active={currentSection === 'activity'} id={`${uid}-activity-panel`} labelledBy={`${uid}-activity`}>
      <GroupActivityView view={view} bots={bots} actions={actions} executionBridge={executionBridge}
        active={currentSection === 'activity'} focusTurnId={focusTurnId} focusRequest={focusRequest} t={t}
        onOpenRun={onOpenRun ?? ((target, turnId) => {
          setError(false);
          void actions.openRun(groupKey(target.group), turnId, navigation.current.signal).catch(() => setError(true));
        })} />
    </RetainedPanel>
    <RetainedPanel active={currentSection === 'settings'} id={`${uid}-settings-panel`} labelledBy={`${uid}-settings`}>
      <GroupSettingsView view={view} bots={bots} t={t} />
      {!showHeader && onEdit && <Button variant="outline" disabled={busy || view.group.archived}
        onClick={() => onEdit(view)}>{t('groups.edit')}</Button>}
    </RetainedPanel>
  </article>;
}

function GroupPermissionLabel({ state, t }: { state: GroupPermissionState } & PropsLocale<'dsh-bot'>) {
  const snapshot = useSyncExternalStore(state.store.subscribe, state.store.getSnapshot);
  if (!snapshot.currentValue) return null;
  const key = snapshot.currentValue === 'read-only' ? 'groups.permissionReadOnly' : snapshot.currentValue === 'workspace-write'
    ? 'groups.permissionWorkspaceWrite' : snapshot.currentValue === 'danger-full-access' ? 'groups.permissionFull'
    : snapshot.currentValue === 'auto' ? 'groups.permissionAuto' : undefined;
  return <span>{t(key ?? 'groups.permission')}: {key ? t(key) : snapshot.currentValue}</span>;
}

export function GroupMembersView({ view, bots, actions, active = true, onOpenBot, onAskBot, executionBridge, t }: {
  view: GroupView;
  bots: readonly BotRecord[];
  onOpenBot?(bot: BotRecord): void;
  onAskBot?(bot: BotRecord, prompt: string, signal?: AbortSignal): void | Promise<void>;
  actions?: GroupActions;
  active?: boolean;
  executionBridge?: ExecutionBridge;
} & PropsLocale<'dsh-bot'>) {
  const members = view.members.filter(member => member.removedAt === undefined);
  const [menu, setMenu] = useState<string>();
  const [asking, setAsking] = useState<string>();
  const [askError, setAskError] = useState<string>();
  const pendingAsk = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    if (!active) { setMenu(undefined); setAsking(undefined); setAskError(undefined); }
    return () => pendingAsk.current?.abort();
  }, [active]);
  const ask = async (bot: BotRecord, memberId: string) => {
    if (!active) return;
    pendingAsk.current?.abort();
    const controller = new AbortController(); pendingAsk.current = controller;
    setAsking(memberId); setAskError(undefined);
    try {
      const turn = recentGroupTurns(view, 1)[0];
      const message = turn ? view.messages.find(row => row.id === turn.inputMessageId)
        ?? await actions?.quotedMessage(groupKey(view.group), turn.inputMessageId, controller.signal) : undefined;
      if (controller.signal.aborted) return;
      if (turn && !message) throw new Error('Question unavailable');
      // Only the original question is a draft; labels, IDs and attachment placeholders are not.
      await onAskBot?.(bot, message?.text.trim() ?? '', controller.signal);
    } catch {
      if (!controller.signal.aborted) setAskError(memberId);
    } finally {
      if (!controller.signal.aborted) setAsking(undefined);
    }
  };
  return <section className={styles.memberOverview} aria-label={t('groups.members')}>
    {members.map(member => {
      const bot = bots.find(row => row.id === member.bot.botId && row.createdAt === member.bot.botCreatedAt);
      const name = bot?.name ?? member.bot.botId;
      const unavailable = !bot || view.unavailableMemberIds.includes(member.id);
      const delivery = latestMemberDelivery(view, member.id);
      const model = groupMemberModel(view.group, member, bot);
      const description = bot?.description.trim();
      const hasDescription = description && description !== name && description !== bot?.id && !/^bot-[a-z0-9-]+$/i.test(description);
      const state = unavailable ? 'warning' : !member.enabled ? 'idle' : delivery?.state === 'failed' ? 'error'
        : delivery && ['pending', 'starting', 'running'].includes(delivery.state) ? 'ongoing' : 'idle';
      const items = [
        ...(bot && onOpenBot ? [{ id: 'profile', label: t('chat.profile') }] : []),
        ...(delivery?.childSessionId && executionBridge ? [{ id: 'execution', label: t('execution.viewDetails') }] : []),
        ...(bot && onAskBot ? [{ id: 'ask', label: t('groups.askInChat'), disabled: unavailable || !!asking }] : []),
      ];
      return <article key={member.id} className={styles.memberOverviewRow} data-group-member={member.id}>
        {bot ? <BotAvatar bot={bot} size={36} /> : <GroupAvatar size={36} />}
        <div className={styles.memberOverviewIdentity}>
          <div className={styles.memberOverviewHeadline}>
            <strong className={styles.memberOverviewName}>{name}</strong>
            <span className={styles.memberOverviewState}><StateDot state={state} />{unavailable ? t('groups.unavailable') : !member.enabled ? t('navigation.memberDisabled') : delivery ? t(`groups.${delivery.state}`) : t('groups.idle')}</span>
          </div>
          {hasDescription && <p className={styles.memberOverviewDescription}>{description}</p>}
          <p className={styles.memberOverviewMeta}>
            {model.selection ? `${model.selection.provider} / ${model.selection.model} · ${t(model.source)}` : t(model.source)}
          </p>
          {asking === member.id && <p role="status">{t('groups.loading')}</p>}
          {askError === member.id && <p role="alert">{t('groups.askFailed')}</p>}
        </div>
        {items.length > 0 && <div className={styles.memberOverviewActions}>
          <Menu open={menu === member.id} onClose={() => setMenu(undefined)} align="end" items={items}
            anchor={<Button variant="ghost" className={styles.quietAction} aria-label={t('execution.memberActions', { name })}
              aria-haspopup="menu" aria-expanded={menu === member.id} onClick={() => setMenu(menu === member.id ? undefined : member.id)}>···</Button>}
            onSelect={id => {
              setMenu(undefined);
              if (id === 'profile' && bot) onOpenBot?.(bot);
              else if (id === 'execution' && delivery?.childSessionId) executionBridge?.open(delivery.childSessionId as string);
              else if (id === 'ask' && bot) void ask(bot, member.id);
            }} />
        </div>}
      </article>;
    })}
  </section>;
}

export function GroupActivityView({ view, bots, actions, onOpenRun, executionBridge, focusTurnId, focusRequest, active = true, t }: {
  view: GroupView;
  bots: readonly BotRecord[];
  actions: GroupActions;
  onOpenRun?(view: GroupView, turnId: string): void;
  executionBridge?: ExecutionBridge;
  focusTurnId?: string;
  focusRequest?: GroupActivityFocus;
  active?: boolean;
} & PropsLocale<'dsh-bot'>) {
  const targetTurnId = focusRequest?.turnId ?? focusTurnId, sequence = focusRequest?.sequence ?? 0;
  const focus = useMemo(() => targetTurnId ? { turnId: targetTurnId, sequence } : undefined, [targetTurnId, sequence]);
  const turns = recentGroupTurns(view);
  // A direct navigation can target a run outside the ten recent questions.
  const focused = view.turns.find(turn => turn.id === focus?.turnId);
  const hasFocusedTurn = !!focused;
  if (focused && !turns.some(turn => turn.id === focused.id)) turns.push(focused);
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active || !focus || !hasFocusedTurn) return;
    const target = [...(container.current?.querySelectorAll<HTMLElement>('[data-group-activity]') ?? [])]
      .find(element => element.dataset.groupActivity === focus.turnId);
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [active, focus, hasFocusedTurn]);
  return <section ref={container} className={styles.activityOverview} aria-label={t('groups.view.activity')} data-group-activity-focus={focus?.turnId}>
    {turns.length === 0 && <p>{t('groups.noActivity')}</p>}
    {turns.map(turn => {
      const participants = groupTurnParticipants(view, turn, bots);
      const failure = groupTurnFailure(view, turn);
      return <article key={turn.id} className={styles.activityOverviewRow} data-group-activity={turn.id} data-focused={focus?.turnId === turn.id || undefined}>
        <div className={styles.activityOverviewMain}>
          <strong>{groupTurnQuestion(view, turn) ?? t(view.messages.some(message => message.id === turn.inputMessageId && message.attachments?.length) ? 'groups.attachments' : 'statistics.historical')}</strong>
          <p className={styles.activityOverviewMeta}>
            {t(`groups.${turn.state}`)} · {new Intl.DateTimeFormat(t('activity.locale'), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(turn.createdAt))}
          </p>
          {participants.length > 0 && <p className={styles.activityOverviewMeta}>{t('groups.participants', { names: new Intl.ListFormat(t('activity.locale'), { type: 'conjunction' }).format(participants) })}</p>}
          {failure && <p className={styles.activityOverviewFailure}>{groupFailureText(failure, t)}</p>}
        </div>
        <Button variant="ghost" onClick={() => {
          if (onOpenRun) onOpenRun(view, turn.id);
          else void actions.open(groupKey(view.group));
        }}>{t('groups.viewRun')}</Button>
      </article>;
    })}
    {executionBridge?.statistics && view.turns.length > 0 && <GroupStatisticsBar view={view} bridge={executionBridge} bots={[...bots]} focusRequest={focus} active={active} t={t} />}
  </section>;
}

export function GroupSettingsView({ view, bots, t }: { view: GroupView; bots: readonly BotRecord[] } & PropsLocale<'dsh-bot'>) {
  const overrides = view.group.memberModelSelections?.length ?? 0;
  const botDefaults = view.members.filter(member => {
    const bot = bots.find(row => row.id === member.bot.botId && row.createdAt === member.bot.botCreatedAt);
    return bot?.model;
  }).length;
  return <section className={styles.settingsOverview} aria-label={t('groups.view.settings')}>
    <dl>
      <dt>{t('groups.mode')}</dt><dd>{t(`groups.${view.group.mode}`)}</dd>
      <dt>{t('groups.cwd')}</dt><dd><PathLabel path={view.group.cwd} /></dd>
      <dt>{t('groups.modelGroupDefault')}</dt><dd>{view.group.modelSelection ? `${view.group.modelSelection.provider} / ${view.group.modelSelection.model}` : t('groups.modelSourceDsh')}</dd>
      <dt>{t('groups.modelOverrides')}</dt><dd>{t('groups.modelOverrideCount', { count: overrides })}</dd>
      <dt>{t('groups.botModelDefaults')}</dt><dd>{t('groups.botModelDefaultCount', { count: botDefaults })}</dd>
      <dt>{t('groups.archived')}</dt><dd>{t(view.group.archived ? 'groups.yes' : 'groups.no')}</dd>
      <dt>{t('groups.lifecycle')}</dt><dd>{t(`groups.lifecycle.${view.group.state}`)}</dd>
    </dl>
  </section>;
}
