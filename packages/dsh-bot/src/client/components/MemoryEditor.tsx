import type { FormEvent } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { MemoryRecord } from '../../shared/schema.js';
import styles from '../styles/bots.module.css';
import panel from '../styles/memory.module.css';
export interface Draft {
  record?: MemoryRecord;
  content: string;
  kind: MemoryRecord['kind'];
  tags: string;
  pinned: boolean;
}
export const kindKeys = {
  profile: 'memory.kindProfile',
  preference: 'memory.kindPreference',
  fact: 'memory.kindFact',
  note: 'memory.kindNote',
} as const;

interface Props {
  draft: Draft;
  busy: boolean;
  invalid: boolean;
  uid: string;
  t: PropsLocale<'dsh-bot'>['t'];
  setDraft(draft: Draft): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onCancel(): void;
}
export function MemoryEditor({ draft, busy, invalid, uid, t, setDraft, onSubmit, onCancel }: Props) {
  return (
    <form
      className={panel.form}
      aria-label={t(draft.record ? 'memory.edit' : 'memory.add')}
      onSubmit={onSubmit}
      noValidate
    >
      <h3>{t(draft.record ? 'memory.edit' : 'memory.add')}</h3>
      <label className={styles.field}>
        {t('memory.content')}
        <textarea
          rows={4}
          value={draft.content}
          disabled={busy}
          required
          aria-invalid={invalid}
          aria-describedby={invalid ? `${uid}-content-error` : undefined}
          onChange={(event) => setDraft({ ...draft, content: event.target.value })}
        />
      </label>
      {invalid && (
        <p id={`${uid}-content-error`} className={styles.error} role="alert">
          {t('memory.contentInvalid')}
        </p>
      )}
      <div className={styles.formRow}>
        <label className={styles.field}>
          {t('memory.kind')}
          <select
            value={draft.kind}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryRecord['kind'] })}
          >
            {Object.entries(kindKeys).map(([kind, key]) => (
              <option key={kind} value={kind}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.checkboxField}>
          <input
            type="checkbox"
            checked={draft.pinned}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })}
          />
          {t('memory.pinned')}
        </label>
      </div>
      <label className={styles.field}>
        {t('memory.tags')}
        <textarea
          rows={2}
          value={draft.tags}
          disabled={busy}
          aria-describedby={`${uid}-tags-hint`}
          onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
        />
        <span className={styles.hint} id={`${uid}-tags-hint`}>
          {t('memory.tagsHint')}
        </span>
      </label>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => {
            onCancel();
          }}
        >
          {t('actions.cancel')}
        </button>
        <button type="submit" className={styles.primaryButton} disabled={busy}>
          {t('memory.save')}
        </button>
      </div>
    </form>
  );
}
