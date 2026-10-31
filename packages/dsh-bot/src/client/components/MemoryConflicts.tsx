import { useState } from 'react';
import type { ManagedMemoryRow, MemoryResolve } from '../../shared/memory-management.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import styles from '../styles/bots.module.css';

export function MemoryConflicts({ rows, revision, resolve, busy, t }: {
  rows: readonly ManagedMemoryRow[]; revision: number; resolve(input: MemoryResolve): void;
  busy: boolean; t: MemoryPanelProps['t'];
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [qualifiers, setQualifiers] = useState<Record<string, string>>({}), [invalid, setInvalid] = useState(false);
  const choose = (choice: MemoryResolve['choice'], winner?: string) => {
    if (choice === 'coexist' && selected.some(id => !qualifiers[id]?.trim() || (qualifiers[id]?.trim().length ?? 0) > 200)) {
      setInvalid(true); return;
    }
    resolve({ ids: selected, expectedRevision: revision, choice, selected: winner,
      ...(choice === 'coexist' ? { qualifiers: selected.map(id => ({ id, values: {
        ...rows.find(row => row.version.memoryId === id)?.payload.qualifiers, context: qualifiers[id]?.trim() ?? '',
      } })) } : {}) });
    setInvalid(false);
  };
  return <fieldset aria-label={t('shared.resolve')} disabled={busy}>
    <legend>{t('shared.resolve')}</legend>
    <p>{t('shared.coexistHint')}</p>
    {rows.filter(row => row.state === 'disputed').map(row => <div key={row.version.memoryId}>
      <label><input type="checkbox" checked={selected.includes(row.version.memoryId)} onChange={e => setSelected(
        e.target.checked ? [...selected, row.version.memoryId] : selected.filter(id => id !== row.version.memoryId))} />
      {row.payload.content}</label>
      {selected.includes(row.version.memoryId) && <label className={styles.field}>{t('shared.appliesTo')}
        <input type="text" value={qualifiers[row.version.memoryId] ?? ''} maxLength={200}
          aria-invalid={invalid && !qualifiers[row.version.memoryId]?.trim()}
          onChange={e => setQualifiers({ ...qualifiers, [row.version.memoryId]: e.target.value })} />
      </label>}
      <button type="button" className={styles.button} disabled={!selected.includes(row.version.memoryId)}
        onClick={() => choose('select', row.version.memoryId)}>{t('shared.selectWinner')}</button>
    </div>)}
    <div className={styles.actions}>
      <button type="button" className={styles.button} disabled={!selected.length} onClick={() => choose('coexist')}>{t('shared.coexist')}</button>
      <button type="button" className={styles.dangerButton} disabled={!selected.length} onClick={() => choose('reject')}>{t('shared.reject')}</button>
    </div>{invalid && <p role="alert">{t('shared.invalid')}</p>}
  </fieldset>;
}
