import type { MemoryPanelProps } from './MemoryPanel.js';
import type { CleanupStatus } from '../../shared/memory-forget.js';
import styles from '../styles/bots.module.css';

export function MemoryCleanupStatus({ statuses, retry, t }: {
  statuses: readonly CleanupStatus[]; retry(id: string): Promise<unknown>; t: MemoryPanelProps['t'];
}) {
  return <div>{statuses.map(status => <div key={status.id} className={styles.notice} role="status">
    <strong>{t(status.strong ? 'forget.strong' : status.stopped ? 'forget.stopped' : 'forget.pending')}</strong>
    {!status.strong && <p>{t('forget.blocked')}</p>}
    {status.reasons.map(reason => <p key={reason}>{t(`forget.reason.${reason}`)}</p>)}
    {!status.strong && <button type="button" className={styles.button} onClick={() => { void retry(status.id); }}>
      {t('forget.retry')}</button>}
  </div>)}</div>;
}
