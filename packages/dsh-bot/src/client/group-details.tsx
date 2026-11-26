import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import { Button, SegmentedTabs, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives';
import { groupKey, type GroupSummary, type GroupView } from '../shared/groups.js';
import type { BotRecord } from '../shared/schema.js';
import type { ExecutionBridge } from './group-execution.js';
import { unwrapGroup, type GroupActions } from './groups-state.js';
import type { BotCatalog } from './state.js';
import { GroupAvatar } from './components/GroupAvatar.js';
import { GroupMembersList, GroupOverview } from './components/GroupOverview.js';
import { GroupRosterEditor } from './components/GroupsPanel.js';
import { SettingsDrafts, useSettingsNavigation } from './components/SettingsNavigation.js';
import { WorkMaterials, type WorkMaterialsActions } from './work-materials.js';
import css from './styles/groups.module.css?inline';
import styles from './styles/groups.module.css';

const tabId = 'dsh-bot.group-details';
const tabKind = 'dsh-bot-group-details';
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'dsh-bot-group-details': { id: string; createdAt: number } }
}
const sections = ['details', 'activity', 'materials', 'members', 'settings'] as const;
type Section = typeof sections[number];
type Dependencies = {
  actions: GroupActions;
  bots: BotCatalog;
  executionBridge?: ExecutionBridge;
  work: WorkMaterialsActions;
  openOrigin(group: GroupSummary): Promise<void>;
  stopWork(group: GroupSummary): Promise<void>;
  openBot(bot: BotRecord): Promise<void>;
};

const emptyMaterialsSnapshot: ReturnType<ReturnType<GroupActions['createView']>['getSnapshot']> = {
  loading: true,
  loaded: false,
  pollIntervalMs: 0,
};
const subscribeNoMaterials = () => () => {};
const getEmptyMaterials = () => emptyMaterialsSnapshot;

function GroupMaterials({ summary, actions, t }: { summary: GroupSummary; actions: GroupActions } & PropsLocale<'dsh-bot'>) {
  const { id: groupId, createdAt: groupCreatedAt } = summary.group;
  const [owned, setOwned] = useState<{ id: string; createdAt: number; source: ReturnType<GroupActions['createView']> }>();
  useEffect(() => {
    const source = actions.createView({ groupId, groupCreatedAt });
    setOwned({ id: groupId, createdAt: groupCreatedAt, source });
    return () => source.dispose();
  }, [actions, groupId, groupCreatedAt]);
  const catalog = owned?.id === groupId && owned.createdAt === groupCreatedAt ? owned.source : undefined;
  const { view, error } = useSyncExternalStore(catalog?.subscribe ?? subscribeNoMaterials, catalog?.getSnapshot ?? getEmptyMaterials, catalog?.getSnapshot ?? getEmptyMaterials);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const lifecycle = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const owner = new AbortController();
    lifecycle.current = owner;
    return () => owner.abort();
  }, []);
  const open = (action: (signal: AbortSignal) => Promise<unknown>) => {
    const signal = lifecycle.current?.signal;
    if (lock.current || !signal || signal.aborted) return;
    lock.current = true;
    setBusy(true);
    setFailed(false);
    void action(signal).catch(() => { if (!signal.aborted) setFailed(true); }).finally(() => {
      lock.current = false;
      if (!signal.aborted) setBusy(false);
    });
  };
  const key = groupKey(summary.group);
  if (error) return <p role="alert">{t('groups.disconnected')} <button type="button" onClick={() => { void catalog?.refresh(); }}>{t('bots.refresh')}</button></p>;
  if (!view) return <p role="status">{t('groups.loading')}</p>;
  if (view.group.id !== key.groupId || view.group.createdAt !== key.groupCreatedAt || view.group.rootSessionId !== summary.group.rootSessionId)
    return <p role="alert">{t('groups.disconnected')}</p>;
  const results = view.deliveries.flatMap(delivery => {
    const message = view.messages.find(row => row.id === delivery.outputMessageId);
    return delivery.state === 'completed' && message ? [{ delivery, message }] : [];
  });
  const inputs = view.messages.filter(message => message.authorKind === 'user' || message.attachments?.length);
  return <section aria-busy={busy} data-group-materials="">
    <p>{t('botMode.materialScope')}</p>
    {failed && <p role="alert">{t('activity.openError')}</p>}
    {results.length > 0 && <section><h4>{t('botMode.results')}</h4>{results.map(({ delivery, message }) =>
      <Button key={delivery.id} disabled={busy} variant="ghost" onClick={() => open(signal => actions.openRun(key, delivery.turnId, signal, { messageId: message.id, seq: message.seq }))}>
        {t('botMode.resultBy', { name: message.speaker?.name ?? summary.group.name })}
      </Button>)}</section>}
    {inputs.map(message => <article key={message.id}>
      {message.authorKind === 'user' && <p>{message.text}</p>}
      {message.attachments?.map(attachment => <Button key={attachment.attachment.attachmentId} variant="ghost" disabled={busy}
        onClick={() => open(async () => unwrapGroup(await actions.remote().openAttachment(key, message.id, attachment.attachment.attachmentId)))}>
        {attachment.type === 'file' ? attachment.attachment.name : t('groups.attachments')}
      </Button>)}
    </article>)}
  </section>;
}

function GroupDetails({ summary, actions, bots, work, executionBridge, openOrigin, stopWork, openBot, close, t }: Dependencies &
  { summary: GroupSummary; close(): void } & PropsLocale<'dsh-bot'>) {
  const botState = useSyncExternalStore(bots.subscribe, bots.getSnapshot);
  const [section, setSection] = useState<Section>('details');
  const [editing, setEditing] = useState<GroupView>();
  const navigation = useSettingsNavigation(t);
  const [stopping, setStopping] = useState(false);
  const stopLock = useRef(false);
  const [failed, setFailed] = useState(false);
  const uid = useId();
  const records = botState.entries.map(row => row.bot);
  const { group, members } = summary;
  const labels = { details: 'botMode.details', activity: 'botPanel.tasks', materials: 'botMode.materials', members: 'groups.members', settings: 'simple.groupSettings' } as const;
  const tabs = sections.map(value => ({ value, label: t(labels[value]), id: `${uid}-${value}`, panelId: `${uid}-panel` })) as [SegmentedTab<Section>, ...SegmentedTab<Section>[]];
  return <SettingsDrafts.Provider value={navigation.registry}><section className={`${styles.panel} ${styles.overview} ${styles.groupDetails}`} data-group-details={group.id} aria-label={t('botMode.detailsAndMaterials')}>
    <style>{css}</style>
    <header className={styles.overviewHeader}><GroupAvatar size={40} members={members.filter(member => member.removedAt === undefined)} bots={records} />
      <div className={styles.overviewIdentity}><h3>{group.name}</h3><p>{t('navigation.memberCount', { count: members.filter(member => member.removedAt === undefined).length })}</p></div>
      <Button variant="ghost" size="sm" onClick={() => navigation.leave(close)}>{t('actions.close')}</Button>
    </header>
    <div className={styles.groupDetailsTabs}><SegmentedTabs label={t('botMode.detailsAndMaterials')} value={section} onChange={next => {
      if (next !== section) navigation.leave(() => { setEditing(undefined); setSection(next); });
    }} items={tabs} /></div>
    {failed && <p role="alert">{t('activity.openError')}</p>}
    {group.supergroup && summary.running && <Button variant="ghost" disabled={stopping} onClick={() => {
      if (stopLock.current) return;
      stopLock.current = true;
      setStopping(true);
      setFailed(false);
      void stopWork(summary).catch(() => setFailed(true)).finally(() => { stopLock.current = false; setStopping(false); });
    }}>{t('supergroup.stop')}</Button>}
    <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-${section}`}>
      {section === 'details' && <>
        <p>{t(group.archived ? 'groups.archived' : summary.running ? 'groups.running' : 'groups.ready')}</p>
        <p>{t(group.supergroup ? 'botMode.groupScope' : 'botMode.materialScope')}</p>
        {group.supergroup && <Button variant="ghost" onClick={() => { setFailed(false); void openOrigin(summary).catch(() => setFailed(true)); }}>{t('taskSupport.openOrigin')}</Button>}
      </>}
      {section === 'materials' && <>
        {group.supergroup && <WorkMaterials scope={{ group: groupKey(group) }} sessionId={group.rootSessionId} actions={work} bots={records} t={t} />}
        <GroupMaterials summary={summary} actions={actions} t={t} />
      </>}
      {section === 'members' && <GroupMembersList summary={summary} actions={actions} bots={records} onEdit={setEditing} openBotLabel={t('chat.openChat')}
        onOpenBot={bot => { setFailed(false); void openBot(bot).catch(() => setFailed(true)); }} t={t} />}
      {(section === 'activity' || section === 'settings') && <GroupOverview summary={summary} actions={actions} bots={records}
        section={section} showHeader={false} showTabs={false} compactSettings executionBridge={executionBridge} onEdit={setEditing} onDeleted={close} t={t} />}
    </div>
    {editing && <GroupRosterEditor bots={records} initial={editing} actions={actions} onClose={() => setEditing(undefined)} t={t} />}
    {navigation.confirmation}
  </section></SettingsDrafts.Provider>;
}

export function registerGroupDetails(ctx: Context, deps: Dependencies) {
  let ready = false;
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], scope => {
    const t = scope.locale.bind('dsh-bot');
    scope.effect(() => {
      const release = scope.sidebarRightTabs.register({ id: tabId, kind: tabKind, title: () => t('botMode.detailsAndMaterials') });
      ready = true;
      return () => { ready = false; release(); };
    }, 'dsh-bot: group details tab');
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: tabId, locale: 'dsh-bot',
    }, (props: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'dsh-bot'>) => {
      const { visible, navigation } = props.useTabInfo().tab;
      const catalog = useSyncExternalStore(deps.actions.catalog.subscribe, deps.actions.catalog.getSnapshot);
      const target = navigation.params as { id?: string; createdAt?: number } | undefined;
      const summary = catalog.groups.find(({ group }) => group.rootSessionId === props.sessionId &&
        (!target || group.id === target.id && group.createdAt === target.createdAt));
      if (!visible) return null;
      if (!summary) return <p role="status">{props.t(catalog.error ? 'groups.disconnected' : catalog.loaded ? 'navigation.targetMissing' : 'groups.loading')}</p>;
      return <GroupDetails key={JSON.stringify([summary.group.id, summary.group.createdAt, navigation.revision])} summary={summary} {...deps} close={() => { if (scope.sidebarRight.isExpanded()) scope.sidebarRight.toggleExpanded(); }} t={props.t} />;
    })), 'dsh-bot: group details body');
  });
  return (summary: GroupSummary) => {
    const sidebar = ctx.get('sidebarRight');
    const { id, createdAt, rootSessionId } = summary.group;
    if (!ready || sidebar?.mounted.getSnapshot() !== rootSessionId as SessionId) return false;
    try { sidebar.openTab(tabKind, { params: { id, createdAt } }); return true; }
    catch { return false; }
  };
}
