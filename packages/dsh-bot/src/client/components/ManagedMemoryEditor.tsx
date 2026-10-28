import { useId } from 'react';
import type { ManagedDraft } from '../memory-drafts.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import styles from '../styles/bots.module.css';

export function ManagedMemoryEditor({ draft, change, save, close, rebase, busy, t }: {
  draft: ManagedDraft; change(draft: ManagedDraft): void; save(): void; close(): void; rebase(): void;
  busy: boolean; t: MemoryPanelProps['t'];
}) {
  const uid = useId();
  const field = (key: 'content' | 'subject' | 'factKey' | 'qualifiers' | 'from' | 'to') => <label className={styles.field} htmlFor={`${uid}-${key}`}>
    {t(`shared.${key}`)}
    {key === 'content' ? <textarea id={`${uid}-${key}`} aria-label={t(`shared.${key}`)} value={draft[key]} disabled={busy}
      onChange={e => change({ ...draft, [key]: e.target.value })} /> :
      <input id={`${uid}-${key}`} aria-label={t(`shared.${key}`)} value={draft[key]} disabled={busy}
        onChange={e => change({ ...draft, [key]: e.target.value })} />}
  </label>;
  return <form aria-label={t('shared.editor')} onSubmit={e => { e.preventDefault(); save(); }}>
    {field('content')}{field('subject')}{field('factKey')}{field('qualifiers')}{field('from')}{field('to')}
    {!draft.id && <label>{t('shared.kind')}<select value={draft.kind} onChange={e => change({
      ...draft, kind: e.target.value as ManagedDraft['kind'] })}>
      <option value="user_fact">{t('shared.facts')}</option><option value="user_event">{t('shared.journal')}</option>
    </select></label>}
    <p className={styles.hint}>{t('shared.timeHint')}</p>
    <div className={styles.actions}>
      <button type="submit" className={styles.primaryButton} disabled={busy}>{t('memory.save')}</button>
      <button type="button" className={styles.button} disabled={busy} onClick={close}>{t('actions.cancel')}</button>
      <button type="button" className={styles.button} disabled={busy} onClick={rebase}>{t('shared.compare')}</button>
    </div>
  </form>;
}
