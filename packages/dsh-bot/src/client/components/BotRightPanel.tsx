import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives';
import { Button, IconSettingsOutlineRegular, Modal, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useId, useRef, useState } from 'react';
import type { BotDetailTarget, ProactiveDetailTarget } from '../detail-state.js';
import type { BotKey } from '../../shared/identity.js';
import { useProactiveWork, type ProactiveWorkSource, type ProactiveWorkSnapshot } from '../proactive/work-state.js';
import { FollowUpPanel, type FollowUpNavigation } from '../proactive/FollowUpPanel.js';
import { followUpSessionTarget, type FollowUpSource } from '../proactive/follow-up-state.js';
import type { BotCatalog, BotCatalogEntry } from '../state.js';
import { BotAvatar } from './BotAvatar.js';
import { MessageOverviewPanel, type MessageActions } from './MessageOverview.js';
import { RetainedPanel } from './RetainedPanel.js';
import styles from '../styles/bot-panel.module.css';
import css from '../styles/bot-panel.module.css?inline';

export const BOT_PANEL_SECTIONS = ['overview', 'tasks', 'messages'] as const;
export type BotPanelSection = (typeof BOT_PANEL_SECTIONS)[number];
export interface BotPanelParams { botId: string; botCreatedAt?: number; section?: BotPanelSection }
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'dsh-bot-bot': BotPanelParams }
}
export const BOT_PANEL_ID = 'dsh-bot.bot-panel';
export const BOT_PANEL_KIND = 'dsh-bot-bot';

export interface BotRightPanelInjected {
  hooks: { catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'> };
  proactiveWork?: ProactiveWorkSource;
  followUp?: FollowUpSource;
  messages?: MessageActions;
  onOpenSession(id: string): Promise<void>;
  /** Open the Bot's main conversation in the main view. */
  onStart(botId: string): Promise<void>;
  /** Full settings remain on the Bots page. */
  onOpenSettings(owner: BotKey): void;
  onOpenMemory?(owner: BotKey): void;
  onOpenWork(owner: BotKey, target?: BotDetailTarget): void;
}
type Runtime = Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'sessionId' | 'useTabInfo'>;
export type BotRightPanelProps = Runtime & InjectFace<BotRightPanelInjected> & PropsLocale<'dsh-bot'>;

/** Navigation parameters name the Bot; a restored tab without them shows this Session's own Bot. */
export function panelEntry(entries: readonly BotCatalogEntry[], sessionId: string, params: unknown): BotCatalogEntry | undefined {
  if (params && typeof params === 'object' && 'botId' in params && typeof params.botId === 'string') {
    const { botId } = params;
    const generation = 'botCreatedAt' in params && typeof params.botCreatedAt === 'number' ? params.botCreatedAt : undefined;
    return entries.find(e => e.bot.id === botId &&
      (generation === undefined ? e.status?.mainSessionId === sessionId : e.bot.createdAt === generation));
  }
  return entries.find(e => e.status?.mainSessionId === sessionId);
}
function requestedSection(params: unknown): BotPanelSection | undefined {
  const value = params && typeof params === 'object' && 'section' in params ? params.section : undefined;
  return BOT_PANEL_SECTIONS.find(s => s === value);
}

export function BotRightPanel({ useTabInfo, ...props }: BotRightPanelProps) {
  const { navigation, visible } = useTabInfo().tab;
  return <BotPanelContent {...props} navigation={navigation} visible={visible} />;
}

export interface BotPreviewState extends BotKey { sessionId: BotRightPanelProps['sessionId']; section?: BotPanelSection; revision: number }
export interface BotPreviewInjected extends BotRightPanelInjected {
  hooks: BotRightPanelInjected['hooks'] & {
    preview: { getSnapshot(): BotPreviewState | undefined; subscribe(listener: () => void): () => void };
  };
  onClose(): void;
  onOpenInSidebar(section: BotPanelSection): void;
}

/** The native modal owns Escape, focus restoration and close chrome. */
export function BotPreview({ usePreview, onClose, onOpenInSidebar, ...props }: InjectFace<BotPreviewInjected> & PropsLocale<'dsh-bot'>) {
  const preview = usePreview(value => value);
  if (!preview) return null;
  return <>
    <style>{css}</style>
    <Modal open title={props.t('botPanel.title')} closeLabel={props.t('actions.close')} onClose={onClose}
      className={styles.preview} contentClassName={styles.previewContent}>
      <BotPanelContent {...props} key={preview.revision} sessionId={preview.sessionId}
        navigation={{ params: preview, revision: preview.revision }} visible compact onOpenInSidebar={onOpenInSidebar} />
    </Modal>
  </>;
}

type BotPanelContentProps = Omit<BotRightPanelProps, 'useTabInfo'> & {
  navigation: { params?: unknown; revision: number };
  visible: boolean;
  compact?: boolean;
  onOpenInSidebar?(section: BotPanelSection): void;
};
function BotPanelContent({ sessionId, navigation, visible, compact, onOpenInSidebar, useCatalog, proactiveWork, followUp, messages, onOpenSession, onStart, onOpenSettings, onOpenMemory, onOpenWork, t }: BotPanelContentProps) {
  const snapshot = useCatalog(value => value);
  const entry = panelEntry(snapshot.entries, sessionId, navigation.params);
  const [section, setSection] = useState<BotPanelSection>(() => requestedSection(navigation.params) ?? 'overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  const uid = useId();
  const [revision, setRevision] = useState(navigation.revision);
  const owner = entry && { botId: entry.bot.id, botCreatedAt: entry.bot.createdAt };
  const { snapshot: work } = useProactiveWork(proactiveWork, owner, visible && section !== 'messages');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Every navigation to this page resets the view, even a repeat with the same Bot or section.
  if (revision !== navigation.revision) {
    setRevision(navigation.revision);
    setSection(requestedSection(navigation.params) ?? 'overview');
    setError(false);
  }
  if (!entry || !owner) {
    const loading = !snapshot.loaded && !snapshot.error;
    return <section className={`${styles.panel} ${compact ? styles.previewPanel : ''}`} data-bot-panel="" aria-label={t('botPanel.title')}><style>{css}</style>
      <p role="status" className={styles.notice}>{t(loading ? 'bots.loading' : navigation.params ? 'botPanel.missing' : 'botPanel.empty')}</p>
    </section>;
  }
  const { bot, status } = entry;
  const current = status?.mainSessionId === sessionId;
  const open = async () => {
    setBusy(true); setError(false);
    try { await onStart(bot.id); } catch { if (alive.current) setError(true); } finally { if (alive.current) setBusy(false); }
  };
  const tabs = BOT_PANEL_SECTIONS.map(value => ({ value, label: t(`botPanel.${value}`), id: `${uid}-${value}`, panelId: `${uid}-${value}-panel` })) as [SegmentedTab<BotPanelSection>, ...SegmentedTab<BotPanelSection>[]];
  const state = status?.preset.state;
  const tasks = summarizeWork(work, t);
  const categories = taskGroups.filter(kind => tasks[kind].length > 0);
  const subject = { kind: 'bot' as const, bot: owner };
  const openFollowUp: FollowUpNavigation = {
    canOpen: origin => origin.kind === 'work' || !!followUpSessionTarget(origin),
    open: (origin, signal) => origin.kind === 'work'
      ? onOpenWork(owner, { kind: 'work', id: origin.ticketId })
      : followUp?.openSession(origin, signal),
  };
  return <section className={`${styles.panel} ${compact ? styles.previewPanel : ''}`} data-bot-panel={bot.id} aria-label={t('botPanel.title')}>
    <style>{css}</style>
    <header className={styles.header}>
      <BotAvatar bot={bot} size={compact ? 40 : 56} />
      <div className={styles.identity}>
        <h2 className={styles.name}>{bot.name}</h2>
        <p className={styles.description}>{bot.description || t('persona.empty')}</p>
      </div>
    </header>
    {state !== undefined && state !== 'ok' && <p role="status" className={styles.warning}>
      {t(state === 'broken' ? 'card.statusBroken' : state === 'missing' ? 'card.statusMissing' : 'card.statusUnknown')} {status?.preset.reason}
    </p>}
    <div className={styles.actions}>
      {current ? <span className={styles.current} data-bot-panel-current="">{t('botPanel.current')}</span>
        : <Button variant="primary" size="sm" disabled={busy || state !== 'ok'} onClick={() => { void open(); }}>{t('chat.openChat')}</Button>}
      <Button variant="ghost" size="sm" onClick={() => onOpenSettings(owner)}>
        <IconSettingsOutlineRegular size={16} /><span>{t('botPanel.settings')}</span>
      </Button>
    </div>
    {error && <p role="alert" className={styles.warning}>{t('activity.openError')}</p>}
    <div className={styles.tabs}><SegmentedTabs label={t('botPanel.title')} value={section} onChange={setSection} items={tabs} /></div>
    <RetainedPanel active={section === 'overview'} id={`${uid}-overview-panel`} labelledBy={`${uid}-overview`}>
      <section className={styles.section} data-bot-panel-overview="">
        {followUp && <FollowUpPanel source={followUp} subject={subject} mode="summary" active={visible && section === 'overview'}
          onShowAll={() => { setSection('tasks'); document.getElementById(`${uid}-tasks`)?.focus(); }} t={t} />}
        <div className={styles.taskOverview}>
          <div>
            <h3>{t('botPanel.taskSummary')}</h3>
            <WorkStatus snapshot={work} hasSource={!!proactiveWork} t={t} />
            {work.status?.state === 'ready' && categories.length > 0 &&
              <p className={styles.notice}>{categories.map(kind => t(`botPanel.taskGroup.${kind}`)).join(' · ')}</p>}
            {work.status?.state === 'ready' && !work.error && categories.length === 0 &&
              <p className={styles.notice}>{t('botPanel.taskEmpty')}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => {
            setSection('tasks');
            document.getElementById(`${uid}-tasks`)?.focus();
          }}>{t('botPanel.viewTasks')}</Button>
        </div>
        <section>
          <h3>{t('botPanel.duties')}</h3>
          {(work.responsibilities ?? []).filter(row => !row.responsibility.deleted).slice(0, 2).map(({ responsibility: duty }) =>
            <p key={duty.id} className={styles.notice}>{duty.name} · {t(`responsibility.mode.${duty.mode}`)}</p>)}
          {work.loaded && !work.error && !work.responsibilities?.some(row => !row.responsibility.deleted) &&
            <p className={styles.notice}>{t('botPanel.noDuties')}</p>}
          <Button variant="ghost" size="sm" onClick={() => onOpenWork(owner)}>{t('botPanel.manageDuties')}</Button>
        </section>
        <details className={styles.role}>
          <summary>{t('botPanel.role')}</summary>
          <p className={styles.persona}>{[bot.persona.prefix, bot.persona.suffix].filter(Boolean).join('\n\n') || t('persona.empty')}</p>
        </details>
        {onOpenMemory && <Button variant="ghost" size="sm" onClick={() => onOpenMemory(owner)}>{t('botPanel.personalContext')}</Button>}
        <details className={styles.role}>
          <summary>{t('botPanel.moreInfo')}</summary>
          <dl className={styles.facts}>
            <dt>{t('manage.model')}</dt><dd>{bot.model ? `${bot.model.provider} / ${bot.model.model}` : t('capabilities.modelDefault')}</dd>
            <dt>{t('memory.title')}</dt><dd>{t(bot.memory.enabled ? 'detail.memoryEnabled' : 'memory.disabled')}</dd>
          </dl>
        </details>
      </section>
    </RetainedPanel>
    <RetainedPanel active={section === 'tasks'} id={`${uid}-tasks-panel`} labelledBy={`${uid}-tasks`}>
      {followUp && <div className={styles.section}><FollowUpPanel source={followUp} subject={subject} mode="detail"
        active={visible && section === 'tasks'} navigation={openFollowUp} t={t} /></div>}
      <BotTaskSummary snapshot={work} hasSource={!!proactiveWork} groups={tasks} onOpen={target => onOpenWork(owner, target)} t={t} />
    </RetainedPanel>
    <RetainedPanel active={section === 'messages'} id={`${uid}-messages-panel`} labelledBy={`${uid}-messages`}>
      <div className={styles.section}>
        {messages && visible && section === 'messages' &&
          <MessageOverviewPanel key={bot.id} botId={bot.id} actions={messages} onOpen={onOpenSession} t={t} />}
        {!messages && <p className={styles.notice}>{t('messages.disabled')}</p>}
      </div>
    </RetainedPanel>
    {onOpenInSidebar && <div className={styles.sidebarAction}>
      <Button variant="ghost" size="sm" onClick={() => onOpenInSidebar(section)}>{t('botPanel.openSidebar')}</Button>
    </div>}
  </section>;
}

const taskGroups = ['decide', 'running', 'check', 'done'] as const;
type TaskGroups = Record<(typeof taskGroups)[number], Array<{ target: ProactiveDetailTarget; title: string; status: string }>>;

function summarizeWork(snapshot: ProactiveWorkSnapshot, t: PropsLocale<'dsh-bot'>['t']): TaskGroups {
  const groups: TaskGroups = {
    decide: [], running: [], check: [], done: [],
  };
  for (const row of snapshot.work) {
    const bucket = row.state === 'unknown' || row.notice?.state === 'unknown' ? 'check' :
      row.state === 'accepted' ? 'done' :
      row.state === 'delivered' ? 'decide' :
      row.state === 'pending' || row.state === 'claimed' || row.state === 'sent' ? 'running' : undefined;
    if (bucket && groups[bucket].length < 3) groups[bucket].push({
      target: { kind: 'work', id: row.ticketId }, title: row.title,
      status: t(row.notice?.state === 'unknown' && row.state !== 'unknown' ? 'botPanel.taskNoticeUnknown' : `proactive.state.${row.state}`),
    });
  }
  for (const row of snapshot.suggestions) {
    if (groups.decide.length === 3) break;
    if (row.state === 'open' && Date.parse(row.expiresAt) > Date.now()) groups.decide.push({
      target: { kind: 'suggestion', id: row.id }, title: row.title, status: t('botPanel.taskSuggestion'),
    });
  }
  return groups;
}

function WorkStatus({ snapshot, hasSource, t }: PropsLocale<'dsh-bot'> & { snapshot: ProactiveWorkSnapshot; hasSource: boolean }) {
  const { status, error, refreshedAt } = snapshot;
  if (error && refreshedAt !== undefined) return <p className={styles.notice} role="status">
    {t('proactive.refreshStale', { at: new Date(refreshedAt).toLocaleString(t('activity.locale')) })}
  </p>;
  if (error || !hasSource) return <p className={styles.notice} role="status">{t('proactive.unavailable')}</p>;
  if (status?.state === 'disabled') return <p className={styles.notice}>{t('botPanel.taskDisabled')}</p>;
  return status?.state !== 'ready' ? <p className={styles.notice} role="status">{t('proactive.starting')}</p> : null;
}

function BotTaskSummary({ snapshot, hasSource, groups, onOpen, t }: PropsLocale<'dsh-bot'> & {
  snapshot: ProactiveWorkSnapshot;
  hasSource: boolean;
  groups: TaskGroups;
  onOpen(target?: BotDetailTarget): void;
}) {
  return <div className={styles.section}>
    <WorkStatus snapshot={snapshot} hasSource={hasSource} t={t} />
    {snapshot.status?.state === 'ready' && <>
      <p className={styles.notice}>{t('botPanel.taskSummary')}</p>
      {taskGroups.map(kind => groups[kind].length > 0 &&
        <section key={kind} className={styles.taskGroup}>
          <h3>{t(`botPanel.taskGroup.${kind}`)}</h3>
          <ul className={styles.taskList}>
            {groups[kind].map(row => <li key={`${row.target.kind}:${row.target.id}`}>
              <Button variant="ghost" size="sm" onClick={() => onOpen(row.target)}>
                <span>{row.title}</span><small>{row.status}</small>
              </Button>
            </li>)}
          </ul>
        </section>)}
      {!snapshot.error && taskGroups.every(kind => groups[kind].length === 0) && <p className={styles.notice}>{t('botPanel.taskEmpty')}</p>}
    </>}
    <div className={styles.actions}>
      <Button variant="ghost" size="sm" onClick={() => onOpen()}>{t('botPanel.openWork')}</Button>
      <Button variant="ghost" size="sm" onClick={() => onOpen({ kind: 'other-work' })}>{t('botPanel.otherWork')}</Button>
    </div>
  </div>;
}

export interface BotPanelTitleInjected { hooks: { catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'> } }
/** The tab chip follows the Bot it shows, in the current language. */
export function BotPanelTitle({ sessionId, useTabInfo, useCatalog, t }: Runtime & InjectFace<BotPanelTitleInjected> & PropsLocale<'dsh-bot'>) {
  const params = useTabInfo().tab.navigation.params;
  const name = useCatalog(value => panelEntry(value.entries, sessionId, params)?.bot.name);
  return <>{name ?? t('botPanel.title')}</>;
}
