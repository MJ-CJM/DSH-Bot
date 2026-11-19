import { TeamRecipes } from './TeamRecipes.js';
import { GroupExportSettings } from './GroupExportSettings.js';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Menu, PathLabel, SegmentedTabs, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupSummary, GroupView } from '../../shared/groups.js';
import { groupKey } from '../../shared/groups.js';
import { GROUP_MEMBER_LIMIT } from '../../shared/group-limits.js';
import type { BotRecord } from '../../shared/schema.js';
import type { GroupActions } from '../groups-state.js';
import { unwrapGroup } from '../groups-state.js';
import type { ExecutionBridge } from '../group-execution.js';
import type { GroupPermissionState } from '../group-permission-state.js';
import { type GroupActivityFocus, groupMemberModel, groupTurnFailure, groupTurnParticipants, groupTurnQuestion, latestMemberDelivery, recentGroupTurns } from '../group-management.js';
import { groupFailureText } from '../group-failure.js';
import { groupQuestionDraft } from '../group-recall.js';
import { BotAvatar } from './BotAvatar.js';
import { GroupAvatar } from './GroupAvatar.js';
import { GroupStatisticsBar } from './GroupStatistics.js';
import { RetainedPanel } from './RetainedPanel.js';
import { FollowUpPanel, type FollowUpNavigation } from '../proactive/FollowUpPanel.js';
import { followUpSessionTarget } from '../proactive/follow-up-state.js';
import css from '../styles/groups.module.css?inline';
import styles from '../styles/groups.module.css';

export type GroupOverviewSection = 'members' | 'activity' | 'settings';
const noMembersView = () => undefined;
const subscribeNoMembersView = () => () => {};

/** Read-only detail surface. The management page, follow-ups and execution
 * inspectors remain separate; opening this list never starts a member. */
export function GroupMembersList({ summary, actions, bots, onOpenBot, openBotLabel, t }: {
  summary: GroupSummary;
  actions: GroupActions;
  bots: readonly BotRecord[];
  onOpenBot?(bot: BotRecord): void;
  /** Describe the caller's actual destination; ordinary management opens a profile. */
  openBotLabel?: string;
} & PropsLocale<'dsh-bot'>) {
  const { id, createdAt } = summary.group;
  const [owned, setOwned] = useState<{ id: string; createdAt: number; source: ReturnType<GroupActions['createView']> }>();
  useEffect(() => {
    const source = actions.createView({ groupId: id, groupCreatedAt: createdAt });
    setOwned({ id, createdAt, source });
    return () => source.dispose();
  }, [actions, id, createdAt]);
  const catalog = owned?.id === id && owned.createdAt === createdAt ? owned.source : undefined;
  const snapshot = useSyncExternalStore(catalog?.subscribe ?? subscribeNoMembersView, catalog?.getSnapshot ?? noMembersView, catalog?.getSnapshot ?? noMembersView);
  const view = snapshot?.view;
  const matched = view?.group.id === id && view.group.createdAt === createdAt;
  if (!view || !matched) return <section className={styles.compactMembers} aria-label={t('groups.members')}>
    <style>{css}</style><p role={snapshot?.error || view ? 'alert' : 'status'}>{t(snapshot?.error || view ? 'groups.disconnected' : 'groups.loading')}</p>
    {(snapshot?.error || view) && <button className={styles.compactMemberRetry} type="button" onClick={() => { void catalog?.refresh(); }}>{t('bots.refresh')}</button>}
  </section>;
  const members = view.members.filter(member => member.removedAt === undefined).sort((a, b) => a.order - b.order);
  return <section className={styles.compactMembers} aria-label={t('groups.members')} data-group-members-list={id}>
    <style>{css}</style>
    {snapshot?.error && <p role="alert">{t('groups.disconnected')} <button className={styles.compactMemberRetry} type="button" onClick={() => { void catalog?.refresh(); }}>{t('bots.refresh')}</button></p>}
    {members.length === 0 && <p>{t('navigation.memberCount', { count: 0 })}</p>}
    {members.map(member => {
      const bot = bots.find(row => row.id === member.bot.botId && row.createdAt === member.bot.botCreatedAt);
      const speaker = view.messages.find(message => message.speaker?.bot.botId === member.bot.botId && message.speaker.bot.botCreatedAt === member.bot.botCreatedAt)?.speaker;
      const name = bot?.name ?? speaker?.name ?? member.bot.botId;
      const unavailable = !bot || view.unavailableMemberIds.includes(member.id);
      const delivery = latestMemberDelivery(view, member.id, row => row.bot.botId === member.bot.botId && row.bot.botCreatedAt === member.bot.botCreatedAt);
      const model = groupMemberModel(view.group, member, bot);
      const modelText = model.selection ? `${model.selection.provider} / ${model.selection.model}` : bot ? t(model.source) : t('groups.unavailable');
      const description = bot?.description.trim();
      const state = unavailable ? t('groups.unavailable') : !member.enabled ? t('navigation.memberDisabled') : delivery ? t(`groups.${delivery.state}`) : t('groups.ready');
      const navigationLabel = `${name} · ${openBotLabel ?? t('chat.profile')}`;
      return <article key={member.id} className={styles.compactMember} data-group-member={member.id} data-group-member-state={unavailable ? 'unavailable' : !member.enabled ? 'disabled' : delivery?.state ?? 'ready'}>
        <BotAvatar size={32} bot={bot ?? { id: member.bot.botId, avatar: speaker?.avatar, avatarColor: speaker?.avatarColor, avatarVariant: speaker?.avatarVariant }} />
        <div className={styles.compactMemberBody}>
          <div className={styles.compactMemberHeading}>
            {bot && onOpenBot ? <button type="button" className={styles.compactMemberLink} title={navigationLabel} aria-label={navigationLabel} onClick={() => onOpenBot(bot)}><strong className={styles.compactMemberLinkLabel}>{name}</strong><span className={styles.compactMemberArrow} aria-hidden="true">↗</span></button> : <strong className={styles.compactMemberName} title={name}>{name}</strong>}
            <span className={styles.compactMemberState} title={state}>{state}</span>
          </div>
          {description && description !== name && description !== bot?.id && !/^bot-[a-z0-9-]+$/i.test(description) && <p className={styles.compactMemberRole} title={description}>{description}</p>}
          <p className={styles.compactMemberModel} title={`${t('groups.model')}: ${modelText}${model.selection ? ` · ${t(model.source)}` : ''}`} data-group-member-model-source={model.selection || bot ? model.source : undefined}>
            <span className={styles.compactMemberModelValue}>{t('groups.model')}: {modelText}</span>{model.selection && <span className={styles.compactMemberModelSource}>{t(model.source)}</span>}
          </p>
        </div>
      </article>;
    })}
  </section>;
}

export function GroupOverview({ summary, actions, bots, onOpenBot, onEdit, onOpenRun, onAskBot, executionBridge, permissionState,
  section: requestedSection, onSectionChange, showHeader = true, showTabs = true, compactSettings = false, visible = true, focusTurnId, focusRequest, t }: {
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
  compactSettings?: boolean;
  visible?: boolean;
  focusTurnId?: string;
  focusRequest?: GroupActivityFocus;
} & PropsLocale<'dsh-bot'>) {
  const [catalog] = useState(() => actions.createView(groupKey(summary.group)));
  useEffect(() => () => catalog.dispose(), [catalog]);
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
  const view = snapshot.view;
  const [section, setSection] = useState<GroupOverviewSection>(requestedSection ?? 'members');
  const currentSection = requestedSection ?? section;
  const selectSection = (next: GroupOverviewSection) => {
    if (onSectionChange) onSectionChange(next);
    else setSection(next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [menu, setMenu] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const navigation = useRef(new AbortController());
  useEffect(() => {
    if (navigation.current.signal.aborted) navigation.current = new AbortController();
    const owner = navigation.current;
    return () => owner.abort();
  }, []);
  const uid = useId();
  if (!view) return <p role={snapshot.error ? 'alert' : 'status'}>{t(snapshot.error ? 'groups.disconnected' : 'groups.loading')}</p>;
  if (view.group.id !== summary.group.id || view.group.createdAt !== summary.group.createdAt || view.group.rootSessionId !== summary.group.rootSessionId)
    return <p role="alert">{t('groups.disconnected')}</p>;
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
  const subject = { kind: 'group' as const, group: groupKey(view.group) };
  const followUp = actions.followUp;
  const continuationMembers = active.filter(member => !view.unavailableMemberIds.includes(member.id)).map(member => {
    const bot = bots.find(item => item.id === member.bot.botId && item.createdAt === member.bot.botCreatedAt);
    return { id: member.id, bot: member.bot, label: bot?.name ?? member.bot.botId };
  });
  const overMemberLimit = members.length > GROUP_MEMBER_LIMIT;
  const groupContinuation = followUp?.groupContinuation && !overMemberLimit && !view.group.archived && view.group.state === 'ready' ? {
    members: continuationMembers.map(member => continuationMembers.some(peer => peer.id !== member.id && peer.label === member.label)
      ? { ...member, label: `${member.label} · ${member.bot.botId}` } : member),
    transport: followUp.groupContinuation,
    canContinue: (turnId: string) => view.turns.some(turn => turn.id === turnId && ['completed', 'partial'].includes(turn.state)),
    onAccepted: () => { void Promise.allSettled([catalog.refresh(), actions.catalog.refresh()]); },
  } : undefined;
  const openFollowUp: FollowUpNavigation = {
    canOpen: origin => origin.kind === 'group-turn' || !!followUpSessionTarget(origin),
    open: (origin, signal) => {
      if (origin.kind !== 'group-turn') return followUp?.openSession(origin, signal);
      if (!view.turns.some(turn => turn.id === origin.turnId)) throw new Error('Original group activity unavailable');
      if (onOpenRun) return onOpenRun(view, origin.turnId);
      return actions.openRun(subject.group, origin.turnId, signal);
    },
  };
  const tabs = (['members', 'activity', 'settings'] as const).map(value => ({ value,
    label: t(`groups.view.${value}`), id: `${uid}-${value}`, panelId: `${uid}-${value}-panel`,
  })) as [import('@deepseek-ai/dsh-client-ui-primitives').SegmentedTab<GroupOverviewSection>, ...import('@deepseek-ai/dsh-client-ui-primitives').SegmentedTab<GroupOverviewSection>[]];
  return <article className={styles.overview} aria-label={view.group.name} data-group-overview={view.group.id}>
    <style>{css}</style>
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
          items={[{ id: 'teams', label: t('teams.title') }, { id: 'archive', label: t('groups.archive'), disabled: busy || view.group.archived }]}
          onSelect={id => { if (id === 'teams') { setMenu(false); setTeamsOpen(true); } else void archive(); }} />
      </div>
    </header>}
    {teamsOpen && <TeamRecipes view={view} actions={actions} onClose={() => setTeamsOpen(false)} onSaved={() => Promise.all([catalog.refresh(), actions.catalog.refresh()])} t={t} />}
    {(error || snapshot.error) && <p role="alert">{t(error ? 'groups.conflict' : 'groups.disconnected')}</p>}
    {overMemberLimit && <p role="status">{t('groups.memberLimitBlocked', { limit: GROUP_MEMBER_LIMIT })}</p>}
    <div className={styles.overviewFacts}>
      <span><StateDot state={view.running ? 'ongoing' : view.group.archived ? 'idle' : 'done'} />{t(view.running ? 'groups.running' : view.group.archived ? 'groups.archived' : 'groups.ready')}</span>
      {view.group.modelSelection && <span>{t('groups.modelSourceGroup')}: {view.group.modelSelection.provider} / {view.group.modelSelection.model}</span>}
      {permissionState && <GroupPermissionLabel state={permissionState} t={t} />}
    </div>
    {showTabs && <div className={styles.overviewTabs}><SegmentedTabs label={t('groups.manage')} value={currentSection}
      onChange={selectSection} items={tabs} /></div>}
    <RetainedPanel active={currentSection === 'members'} id={`${uid}-members-panel`} labelledBy={`${uid}-members`}>
      {followUp && <FollowUpPanel source={followUp} subject={subject} mode="summary" editable={!view.group.archived}
        active={visible && currentSection === 'members'} onShowAll={() => {
          selectSection('activity');
          document.getElementById(`${uid}-activity`)?.focus();
        }} t={t} />}
      <GroupMembersView key={JSON.stringify(groupKey(view.group))} view={view} bots={bots} actions={actions} active={visible && currentSection === 'members'} onOpenBot={onOpenBot} onAskBot={onAskBot} executionBridge={executionBridge} t={t} />
    </RetainedPanel>
    <RetainedPanel active={currentSection === 'activity'} id={`${uid}-activity-panel`} labelledBy={`${uid}-activity`}>
      {followUp && <FollowUpPanel source={followUp} subject={subject} mode="detail" editable={!view.group.archived}
        active={visible && currentSection === 'activity'} navigation={openFollowUp} groupContinuation={groupContinuation} t={t} />}
      <GroupActivityView view={view} bots={bots} actions={actions} executionBridge={executionBridge}
        active={currentSection === 'activity'} focusTurnId={focusTurnId} focusRequest={focusRequest} t={t}
        onOpenRun={onOpenRun ?? ((target, turnId) => {
          setError(false);
          void actions.openRun(groupKey(target.group), turnId, navigation.current.signal).catch(() => setError(true));
        })} />
    </RetainedPanel>
    <RetainedPanel active={currentSection === 'settings'} id={`${uid}-settings-panel`} labelledBy={`${uid}-settings`}>
      {visible && currentSection === 'settings' && <GroupExportSettings group={view.group} actions={actions} bots={bots} onSaved={catalog.refresh} t={t} />}
      {compactSettings ? <details><summary>{t('botMode.advanced')}</summary><GroupSettingsView view={view} bots={bots} t={t} /></details> : <GroupSettingsView view={view} bots={bots} t={t} />}
      {!view.group.supergroup && <label><input type="checkbox" checked={view.group.onDemand ?? false} disabled={busy || view.group.archived || view.group.mode !== 'natural'} onChange={event => {
        const onDemand = event.currentTarget.checked; setBusy(true); setError(false);
        void actions.remote().edit(groupKey(view.group), { expectedRevision: view.group.revision, expectedMembershipRevision: view.group.membershipRevision,
          name: view.group.name, mode: view.group.mode, members: active.map(member => member.bot), historyConfirmed: true, onDemand,
        }).then(result => { unwrapGroup(result); return Promise.all([catalog.refresh(), actions.catalog.refresh()]); }).catch(() => setError(true)).finally(() => setBusy(false));
      }} />{t('teams.onDemand')}</label>}
      <p>{t(view.group.supergroup ? 'simple.automaticTeam' : 'teams.onDemandHint')}</p>
      {!showHeader && <Button variant="outline" onClick={() => setTeamsOpen(true)}>{t('teams.title')}</Button>}
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
      const delivery = latestMemberDelivery(view, memberId, row => row.bot.botId === bot.id && row.bot.botCreatedAt === bot.createdAt
        && Boolean(row.childSessionId) && !row.joinedDeliveryId && !['pending', 'starting'].includes(row.state));
      const turn = view.turns.find(row => row.id === delivery?.turnId);
      if (!delivery || !turn) {
        await onAskBot?.(bot, '', controller.signal);
        return;
      }
      const group = groupKey(view.group);
      const messageId = (bot.memory.enabled && delivery.triggerMessageId) || turn.inputMessageId;
      const message = view.messages.find(row => row.id === messageId)
        ?? await actions?.quotedMessage(group, messageId, controller.signal);
      if (controller.signal.aborted) return;
      if (!message) throw new Error('Question unavailable');
      const prompt = bot.memory.enabled ? groupQuestionDraft(t, {
        group, groupName: view.group.name, turnId: turn.id, deliveryId: delivery.id,
        sessionId: view.group.rootSessionId, messageId: message.id, seq: message.seq,
      }) : message.text.trim();
      await onAskBot?.(bot, prompt, controller.signal);
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
          {turn.routing && <p className={styles.activityOverviewMeta} data-group-routing={turn.id}>{t('teams.routing', { reason: t(`teams.reason.${turn.routing.reason}`), selected: turn.routing.selectedMemberIds.length, candidates: turn.routing.candidateMemberIds.length, calls: view.deliveries.filter(row => row.turnId === turn.id && row.startedAt !== undefined).length, decider: turn.routing.deciderCalls, requests: turn.routing.modelRequests ?? 0 })}</p>}
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
