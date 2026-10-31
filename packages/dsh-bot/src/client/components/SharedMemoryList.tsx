import type { ManagedMemoryRow } from '../../shared/memory-management.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import { MemoryProvenance } from './MemoryProvenance.js';
import panel from '../styles/memory.module.css';
import styles from '../styles/bots.module.css';

export function SharedMemoryList({ rows, busy, edit, confirm, forget, contribution, t }: {
  rows: readonly ManagedMemoryRow[]; busy: boolean; edit(row: ManagedMemoryRow): void;
  confirm(row: ManagedMemoryRow): void; forget(row: ManagedMemoryRow): void; contribution(row: ManagedMemoryRow): void;
  t: MemoryPanelProps['t'];
}) {
  return <ul className={panel.list} data-shared-memory-list="">{rows.map(row => <li key={row.version.memoryId}
    data-memory-id={row.version.memoryId} className={panel.record}>
    <p className={panel.content}>{row.payload.content}</p>
    <span>{t(`shared.state.${row.state}`)}</span>
    <MemoryProvenance row={row} t={t} />
    <div className={styles.actions}>
      <button type="button" className={styles.button} disabled={busy} onClick={() => edit(row)}>{t('memory.edit')}</button>
      <button type="button" className={styles.button} disabled={busy} onClick={() => confirm(row)}>
        {t(row.version.scope === 'private' ? 'shared.publish' : 'shared.confirm')}</button>
      <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => forget(row)}>{t('actions.delete')}</button>
      {row.version.scope === 'shared' && row.version.shard !== 'user' && <button type="button" className={styles.dangerButton}
        disabled={busy} onClick={() => contribution(row)}>{t('shared.forgetContribution')}</button>}
    </div>
  </li>)}</ul>;
}
