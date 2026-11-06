import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives';
import { Button, IconSettingsOutlineRegular, Modal, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useId, useRef, useState } from 'react';
import type { RoutineActions } from '../automation-state.js';
import type { BackgroundActions } from '../background-work-state.js';
import type { BotCatalog, BotCatalogEntry } from '../state.js';
import { BackgroundTasksPanel } from './BackgroundTasksPanel.js';
import { BotAvatar } from './BotAvatar.js';
import { MessageOverviewPanel, type MessageActions } from './MessageOverview.js';
import { RetainedPanel } from './RetainedPanel.js';
import { RoutinePanel } from './RoutinePanel.js';
import styles from '../styles/bot-panel.module.css';
import css from '../styles/bot-panel.module.css?inline';

export const BOT_PANEL_SECTIONS = ['overview', 'tasks', 'messages'] as const;
export type BotPanelSection = (typeof BOT_PANEL_SECTIONS)[number];
export interface BotPanelParams { botId: string; section?: BotPanelSection }
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'dsh-bot-bot': BotPanelParams }
}
export const BOT_PANEL_ID = 'dsh-bot.bot-panel';
export const BOT_PANEL_KIND = 'dsh-bot-bot';

export interface BotRightPanelInjected {
  hooks: { catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'> };
  routines?: RoutineActions;
  background?: BackgroundActions;
  messages?: MessageActions;
  onOpenSession(id: string): Promise<void>;
  /** Open the Bot's main conversation in the main view. */
  onStart(botId: string): Promise<void>;
  /** Full settings remain on the Bots page. */
  onOpenSettings(botId: string): void;
}
type Runtime = Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'sessionId' | 'useTabInfo'>;
export type BotRightPanelProps = Runtime & InjectFace<BotRightPanelInjected> & PropsLocale<'dsh-bot'>;

/** Navigation parameters name the Bot; a restored tab without them shows this Session's own Bot. */
export function panelEntry(entries: readonly BotCatalogEntry[], sessionId: string, params: unknown): BotCatalogEntry | undefined {
  const botId = params && typeof params === 'object' && 'botId' in params && typeof params.botId === 'string' ? params.botId : undefined;
  return botId ? entries.find(e => e.bot.id === botId) : entries.find(e => e.status?.mainSessionId === sessionId);
}
function requestedSection(params: unknown): BotPanelSection | undefined {
  const value = params && typeof params === 'object' && 'section' in params ? params.section : undefined;
  return BOT_PANEL_SECTIONS.find(s => s === value);
}

export function BotRightPanel({ useTabInfo, ...props }: BotRightPanelProps) {
  const navigation = useTabInfo().tab.navigation;
  return <BotPanelContent {...props} navigation={navigation} />;
}

export interface BotPreviewState { botId: string; sessionId: BotRightPanelProps['sessionId']; section?: BotPanelSection; revision: number }
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
        navigation={{ params: preview, revision: preview.revision }} compact onOpenInSidebar={onOpenInSidebar} />
    </Modal>
  </>;
}

type BotPanelContentProps = Omit<BotRightPanelProps, 'useTabInfo'> & {
  navigation: { params?: unknown; revision: number };
  compact?: boolean;
  onOpenInSidebar?(section: BotPanelSection): void;
};
function BotPanelContent({ sessionId, navigation, compact, onOpenInSidebar, useCatalog, routines, background, messages, onOpenSession, onStart, onOpenSettings, t }: BotPanelContentProps) {
  const snapshot = useCatalog(value => value);
  const entry = panelEntry(snapshot.entries, sessionId, navigation.params);
  const [section, setSection] = useState<BotPanelSection>(() => requestedSection(navigation.params) ?? 'overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  const uid = useId();
  const [revision, setRevision] = useState(navigation.revision);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Every navigation to this page resets the view, even a repeat with the same Bot or section.
  if (revision !== navigation.revision) {
    setRevision(navigation.revision);
    setSection(requestedSection(navigation.params) ?? 'overview');
    setError(false);
  }
  if (!entry) {
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
      <Button variant="ghost" size="sm" onClick={() => onOpenSettings(bot.id)}>
        <IconSettingsOutlineRegular size={16} /><span>{t('botPanel.settings')}</span>
      </Button>
    </div>
    {error && <p role="alert" className={styles.warning}>{t('activity.openError')}</p>}
    <div className={styles.tabs}><SegmentedTabs label={t('botPanel.title')} value={section} onChange={setSection} items={tabs} /></div>
    <RetainedPanel active={section === 'overview'} id={`${uid}-overview-panel`} labelledBy={`${uid}-overview`}>
      <section className={styles.section} data-bot-panel-overview="">
        <h3>{t('persona.title')}</h3>
        <p className={styles.persona}>{bot.persona.prefix || t('persona.empty')}</p>
        <dl className={styles.facts}>
          <dt>{t('manage.model')}</dt><dd>{bot.model ? `${bot.model.provider} / ${bot.model.model}` : t('capabilities.modelDefault')}</dd>
          <dt>{t('memory.title')}</dt><dd>{t(bot.memory.enabled ? 'detail.memoryEnabled' : 'memory.disabled')}</dd>
          <dt>{t('detail.identity')}</dt><dd><code>{bot.id}</code></dd>
        </dl>
      </section>
    </RetainedPanel>
    <RetainedPanel active={section === 'tasks'} id={`${uid}-tasks-panel`} labelledBy={`${uid}-tasks`}>
      <div className={styles.section}>
        {routines && <RoutinePanel actions={routines} bots={[bot]} botId={bot.id} onOpenSession={onOpenSession} t={t} />}
        {background && <BackgroundTasksPanel bot={bot} actions={background} t={t} />}
        {!routines && !background && <p className={styles.notice}>{t('native.unavailable')}</p>}
      </div>
    </RetainedPanel>
    <RetainedPanel active={section === 'messages'} id={`${uid}-messages-panel`} labelledBy={`${uid}-messages`}>
      <div className={styles.section}>
        {messages ? <MessageOverviewPanel key={bot.id} botId={bot.id} actions={messages} onOpen={onOpenSession} t={t} />
          : <p className={styles.notice}>{t('messages.disabled')}</p>}
      </div>
    </RetainedPanel>
    {onOpenInSidebar && <div className={styles.sidebarAction}>
      <Button variant="ghost" size="sm" onClick={() => onOpenInSidebar(section)}>{t('botPanel.openSidebar')}</Button>
    </div>}
  </section>;
}

export interface BotPanelTitleInjected { hooks: { catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'> } }
/** The tab chip follows the Bot it shows, in the current language. */
export function BotPanelTitle({ sessionId, useTabInfo, useCatalog, t }: Runtime & InjectFace<BotPanelTitleInjected> & PropsLocale<'dsh-bot'>) {
  const params = useTabInfo().tab.navigation.params;
  const name = useCatalog(value => panelEntry(value.entries, sessionId, params)?.bot.name);
  return <>{name ?? t('botPanel.title')}</>;
}
