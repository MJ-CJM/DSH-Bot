import type { MemoryPanelProps } from './MemoryPanel.js';
import type { CleanupStatus } from '../../shared/memory-forget.js';
import styles from '../styles/bots.module.css';

export function MemoryCleanupStatus({ statuses, retry, t }: {
  statuses: readonly CleanupStatus[]; retry(id: string): Promise<unknown>; t: MemoryPanelProps['t'];
}) {
  // Repeated polling/retry receipts replace by job identity. Completed jobs share one current banner.
  const latest = [...new Map(statuses.map(status => [status.id, status])).values()];
  return <div>
    {latest.some(status => status.strong) && <p className={styles.notice} role="status">{t('forget.strong')}</p>}
    {latest.filter(status => !status.strong).map(status => <div key={status.id} className={styles.notice} role="status">
    <strong>{t(status.strong ? 'forget.strong' : status.stopped ? 'forget.stopped' : 'forget.pending')}</strong>
    {!status.strong && <p>{t('forget.blocked')}</p>}
    {status.reasons.includes('system-head') && <p>{t('forget.legacyOptions')}</p>}
    {status.reasons.map(reason => <p key={reason}>{t(`forget.reason.${reason}`)}</p>)}
    {!status.strong && <button type="button" className={styles.button} onClick={() => { void retry(status.id); }}>
      {t('forget.retry')}</button>}
  </div>)}</div>;
}
