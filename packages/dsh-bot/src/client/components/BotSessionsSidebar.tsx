import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { useState } from 'react';
import { Button, Menu, IconEllipsisOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BotCatalog, BotCatalogEntry } from '../state.js';
import type { ActivityCatalog } from '../activity-state.js';
import { botSessionRows, previewText, relativeTime, sortBotEntries } from '../activity-view.js';
import { type ChatLauncherActions, useChatLauncher } from '../chat-launcher.js';
import { BotAvatar } from './BotAvatar.js';
import { WhaleGlyph } from './WhaleGlyph.js';
import { Modal } from './Modal.js';
import styles from '../styles/sidebar.module.css';
import css from '../styles/sidebar.module.css?inline';
import modalCss from '../styles/bots.module.css?inline';

export interface BotSessionsSidebarInjected extends ChatLauncherActions {
  hooks: {
    catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'>;
    activity: Pick<ActivityCatalog, 'getSnapshot' | 'subscribe'>;
    workspaceCatalog: Context['workspaces']['list'];
  };
  sessionLimit: number;
  onOpenSession(id: SessionId): Promise<void>;
  onManage(): void;
  onRefresh(): Promise<void>;
}
export type BotSessionsSidebarProps = Pick<PropsRuntime<'sidebar.footer.action'>, 'wide' | 'useSessions'>
  & PropsLocale<'dsh-bot'> & InjectFace<BotSessionsSidebarInjected>;

/** Only Host-list members with an exact Host status mapping belong to a Bot. */
export function groupBotSessions(entries: readonly BotCatalogEntry[], sessions: SessionListState, archived: readonly SessionId[] = []) {
  const groups = new Map(entries.map(({ bot }) => [bot.id, [] as SessionSummary[]]));
  const mapping = new Map(entries.flatMap(({ bot, status }) => status ? [[status.presetId, bot.id] as const] : []));
  const hidden = new Set(archived);
  for (const id of sessions.ids) {
    const session = sessions.byId[id];
    if (!session || session.parentId || session.origin === 'subagent' || hidden.has(id)) continue;
    const preset = session.projectionValues?.agentPreset;
    const botId = typeof preset === 'string' ? mapping.get(preset) : undefined;
    if (botId && entries.find(entry => entry.bot.id === botId)?.status?.mainSessionId === id) groups.get(botId)?.push(session);
  }
  for (const group of groups.values()) group.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  return groups;
}

/** rc.2 exposes footer actions, but no additive workspace section slot. */
export function BotSessionsSidebar({ wide, useSessions, useCatalog, useActivity, useWorkspaceCatalog, sessionLimit, onStart, onStartInWorkspace, getPreferredWorkspace, onOpenSession, onManage, onRefresh, t }: BotSessionsSidebarProps) {
  const snapshot = useCatalog((value) => value);
  const sessions = useSessions((value) => value);
  const activity = useActivity((value) => value);
  const workspaces = useWorkspaceCatalog((value) => value);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [moreBot, setMoreBot] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const chat = useChatLauncher({ workspaces, getPreferredWorkspace, t, onStart: async (...args) => {
    await onStart(...args);
    if (!args[1]?.aborted) setOpen(false);
  }, onStartInWorkspace: async (...args) => {
    await onStartInWorkspace(...args);
    if (!args[2]?.aborted) setOpen(false);
  } });
  const locale = t('activity.locale');
  const unreadCount = activity.bots.reduce((total, bot) => total + bot.unreadCount, 0);
  const entries = sortBotEntries(snapshot.entries, activity.bots, locale);
  const openSession = (id: SessionId) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    // The injected action awaits markRead before navigating. A refused read
    // keeps the dialog available for retry instead of hiding the failure.
    void onOpenSession(id).then(() => setOpen(false)).catch(() => {
      setError(t('activity.openError'));
    }).finally(() => setBusy(false));
  };
  const manage = () => { onManage(); setOpen(false); };
  const start = (id: string, inWorkspace = false) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void (inWorkspace ? chat.startInWorkspace(id) : chat.start(id)).catch((reason: unknown) => {
      setError(`${t('errors.start')} ${reason instanceof Error ? reason.message : ''}`.trim());
    }).finally(() => setBusy(false));
  };
  return <>
    <style data-dsh-bot-sidebar-styles="">{css}</style>
    <button type="button" className={styles.trigger} aria-label={t('sidebar.sessions')} title={t('sidebar.sessions')}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => { setError(undefined); setOpen((value) => !value); }}>
      <span className={styles.chatIcon} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M5 5h14v11H9l-4 4V5Z" /><path d="M9 9h6M9 12h4" />
        </svg>
        <span className={styles.whaleBadge}><WhaleGlyph size={11} /></span>
      </span>
      {wide && <span>{t('sidebar.sessions')}</span>}
      {unreadCount > 0 && <span className={styles.unreadDot} role="status"
        data-bot-unread="footer" data-unread="true" aria-label={t('activity.unreadCount', { count: unreadCount })} />}
    </button>
    {(open || chat.dialog) && <style data-dsh-bot-sidebar-dialog-styles="">{modalCss}</style>}
    {open && !chat.dialog && <Modal title={t('sidebar.sessions')} titleAction={{ onClick: manage, label: t('sidebar.manage') }}
      busy={busy} onClose={() => setOpen(false)} t={t}>
      <section className={styles.content} aria-label={t('bots.title')}>
        <header className={styles.header}>
          <button type="button" className={styles.action} onClick={manage}>{t('sidebar.manage')}</button>
        </header>
        {snapshot.error && <div role="alert" className={styles.error}>
          <p>{t('errors.load')}</p><button type="button" className={styles.action} onClick={() => { void onRefresh(); }}>{t('actions.retry')}</button>
        </div>}
        {!snapshot.loaded && snapshot.loading && <p role="status" className={styles.empty}>{t('bots.loading')}</p>}
        {activity.error && <div role="alert" className={styles.error}>
          <p>{t('activity.loadError')}</p><button type="button" className={styles.action} onClick={() => { void onRefresh(); }}>{t('actions.retry')}</button>
        </div>}
        {snapshot.loaded && !snapshot.error && !snapshot.entries.length && <p className={styles.empty}>{t('bots.empty')}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {entries.map(({ bot, status }) => {
          const rows = botSessionRows(bot.id, snapshot.entries, sessions, activity.sessions, workspaces.archivedSessionIds, workspaces.items);
          const botUnread = activity.bots.find((item) => item.botId === bot.id)?.unreadCount ?? 0;
          const limit = limits[bot.id] ?? sessionLimit;
          const expanded = !collapsed.has(bot.id);
          return <section key={bot.id} className={styles.group} data-bot-id={bot.id}>
            <div className={styles.botRow}>
              <button type="button" className={styles.botButton} aria-expanded={expanded} aria-label={t('sidebar.toggle', { name: bot.name })}
                onClick={() => setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(bot.id)) next.delete(bot.id); else next.add(bot.id);
                  return next;
                })}>
                <span className={styles.chevron} aria-hidden="true">{expanded ? '⌄' : '›'}</span>
                <BotAvatar bot={bot} size={28} />
                <span className={styles.name}>{bot.name}</span>
                {botUnread > 0 && <span className={styles.unreadCount} role="img" data-bot-unread={bot.id} data-unread="true"
                  aria-label={t('activity.unreadCount', { count: botUnread })}>{botUnread}</span>}
              </button>
              <button type="button" className={styles.newSession} aria-label={t('sidebar.newSession', { name: bot.name })}
                title={t('sidebar.newSession', { name: bot.name })} disabled={busy || snapshot.loading || Boolean(snapshot.error) || status?.preset.state !== 'ok'}
                onClick={() => start(bot.id)}>+</button>
              <Menu open={moreBot === bot.id} onClose={() => setMoreBot(undefined)} align="end"
                anchor={<Button variant="ghost" size="sm" disabled={busy} aria-label={t('sidebar.moreActions', { name: bot.name })}
                  aria-haspopup="menu" aria-expanded={moreBot === bot.id} onClick={() => setMoreBot(moreBot === bot.id ? undefined : bot.id)}><IconEllipsisOutlineRegular size={14} /></Button>}
                items={[{ id: 'workspace', label: t('chat.inWorkspace'), disabled: busy || snapshot.loading || Boolean(snapshot.error) || status?.preset.state !== 'ok' }]}
                onSelect={() => { setMoreBot(undefined); start(bot.id, true); }} />
            </div>
            {expanded && <div className={styles.sessions}>
              {sessions.phase !== 'ready' ? <p role="status" className={styles.empty}>{t('sidebar.loading')}</p>
                : rows.length === 0 ? <p className={styles.empty}>{t('sidebar.emptySessions')}</p>
                  : rows.slice(0, limit).map((session) => {
                    const title = previewText(session.title, t) || t('sidebar.untitled');
                    const preview = previewText(session.preview, t);
                    return <button type="button" key={session.id} className={styles.session} disabled={busy}
                      data-session-id={session.id} aria-label={title} title={title}
                      onClick={() => openSession(session.id)}>
                      <span className={styles.sessionHeading}>
                        <span className={styles.sessionTitle}>{title}</span>
                        <span className={styles.time}>{relativeTime(session.updatedAt, locale)}</span>
                        {session.unread && <span className={styles.unreadDot} role="img" data-session-unread={session.id} data-unread="true"
                          aria-label={t('activity.unread')} />}
                      </span>
                      {session.workspaceTitle && <span className={styles.time} data-workspace-meta="">{session.workspaceTitle}</span>}
                      {preview && <span className={styles.preview} data-activity-preview="" title={preview}>{preview}</span>}
                      {session.running && <span className={styles.running}>{t('activity.running')}</span>}
                    </button>;
                  })}
              {rows.length > limit && <button type="button" className={styles.more} onClick={() => setLimits((current) => ({ ...current, [bot.id]: limit + sessionLimit }))}>{t('sidebar.more')}</button>}
            </div>}
          </section>;
        })}
      </section>
    </Modal>}
    {chat.dialog}
  </>;
}
