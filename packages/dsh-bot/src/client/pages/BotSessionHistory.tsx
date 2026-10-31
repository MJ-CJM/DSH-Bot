import { previewText, relativeTime } from '../activity-view.js';
import styles from '../styles/bots.module.css';

import type { BotsPageProps } from './bots-page-types.js';
import type { BotsPageModel } from './use-bots-page.js';
export function BotSessionHistory({ page, model }: { page: BotsPageProps; model: BotsPageModel }) {
  const { onOpenSession, t } = page;
  const { activity, sessions, rows, busy, navigating, navigate, locale } = model;
  return (
    <section className={styles.sessionHistory} aria-label={t('bots.history')}>
      <h3 className={styles.historyTitle}>{t('bots.history')}</h3>
      {activity.error && (
        <p role="alert" className={styles.error}>
          {t('activity.loadError')}
        </p>
      )}
      {sessions.phase !== 'ready' || (!activity.loaded && activity.loading) ? (
        <p className={styles.loading} role="status">
          {t('activity.loading')}
        </p>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>
          <h2>{t('bots.noSessions')}</h2>
          <p>{t('bots.emptySessionsHint')}</p>
        </div>
      ) : (
        <div className={styles.historyList}>
          {rows.map((session) => {
            const title = previewText(session.title, t) || t('sidebar.untitled');
            const preview = previewText(session.preview, t);
            return (
              <button
                type="button"
                key={session.id}
                className={styles.historyRow}
                data-session-id={session.id}
                disabled={busy || navigating}
                onClick={() => {
                  void navigate((signal) => onOpenSession(session.id, signal), 'activity.openError');
                }}
              >
                <span className={styles.rowHeading}>
                  <span className={styles.rowName} title={title}>
                    {title}
                  </span>
                  {session.unread && (
                    <span className={styles.unreadDot} data-unread="" role="img" aria-label={t('activity.unread')} />
                  )}
                  {session.running && <span className={styles.running}>{t('activity.running')}</span>}
                  <time className={styles.relativeTime} dateTime={new Date(session.updatedAt).toISOString()}>
                    {relativeTime(session.updatedAt, locale)}
                  </time>
                </span>
                {session.workspaceTitle && (
                  <span className={styles.relativeTime} data-workspace-meta="">
                    {session.workspaceTitle}
                  </span>
                )}
                {preview && (
                  <span className={styles.activityPreview} data-activity-preview="" title={preview}>
                    {preview}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
