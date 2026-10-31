import { useId, useState } from 'react';
import { draftQualifiers, qualifierDraft, type ManagedDraft } from '../memory-drafts.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import styles from '../styles/bots.module.css';

export function ManagedMemoryEditor({ draft, change, save, close, rebase, busy, t }: {
  draft: ManagedDraft; change(draft: ManagedDraft): void; save(): void; close(): void; rebase(): void;
  busy: boolean; t: MemoryPanelProps['t'];
}) {
  const uid = useId(), [invalid, setInvalid] = useState(false);
  const field = (key: 'content' | 'subject' | 'factKey' | 'from' | 'to') => <label className={styles.field} htmlFor={`${uid}-${key}`}>
    {t(`shared.${key}`)}
    {key === 'content' ? <textarea id={`${uid}-${key}`} aria-label={t(`shared.${key}`)} value={draft[key]} disabled={busy}
      onChange={e => change({ ...draft, [key]: e.target.value })} /> :
      <input id={`${uid}-${key}`} aria-label={t(`shared.${key}`)} value={draft[key]} disabled={busy}
        onChange={e => change({ ...draft, [key]: e.target.value })} />}
  </label>;
  return <form aria-label={t('shared.editor')} onSubmit={e => {
    e.preventDefault();
    try { draftQualifiers(draft.qualifiers); } catch { setInvalid(true); return; }
    setInvalid(false); save();
  }}>
    {field('content')}{field('subject')}{field('factKey')}
    <fieldset disabled={busy} aria-describedby={invalid ? `${uid}-qualifier-error` : undefined}>
      <legend>{t('shared.qualifiers')}</legend>
      {draft.qualifiers.map((row, index) => <div key={row.id} data-qualifier-row="">
        {(['key', 'value'] as const).map(key => <label className={styles.field} key={key}>
          {t(`shared.qualifier.${key}`)}
          <input value={row[key]} maxLength={key === 'key' ? 64 : 200} aria-invalid={invalid}
            onChange={e => change({ ...draft, qualifiers: draft.qualifiers.map((old, i) =>
              i === index ? { ...old, [key]: e.target.value } : old) })} />
        </label>)}
        <button type="button" className={styles.button} onClick={() => change({ ...draft,
          qualifiers: draft.qualifiers.filter((_, i) => i !== index) })}>{t('shared.qualifier.remove')}</button>
      </div>)}
      <button type="button" className={styles.button} onClick={() => change({ ...draft,
        qualifiers: [...draft.qualifiers, qualifierDraft()] })}>{t('shared.qualifier.add')}</button>
      {invalid && <p id={`${uid}-qualifier-error`} role="alert">{t('shared.qualifier.invalid')}</p>}
    </fieldset>
    {field('from')}{field('to')}
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
