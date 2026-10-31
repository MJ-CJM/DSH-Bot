import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { MemoryRecord } from '../../shared/schema.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import { kindKeys } from './MemoryEditor.js';
import styles from '../styles/bots.module.css';
import panel from '../styles/memory.module.css';
interface Props {
  records: readonly MemoryRecord[];
  busy: boolean;
  draft: boolean;
  pendingDelete?: string;
  t: PropsLocale<'dsh-bot'>['t'];
  onOpenSession: MemoryPanelProps['onOpenSession'];
  onUpdate: MemoryPanelProps['onUpdate'];
  onRemove: MemoryPanelProps['onRemove'];
  previewForget?(id: string): void;
  edit(record?: MemoryRecord): void;
  setPendingDelete(value?: string): void;
  setNotice(value: undefined): void;
  perform(action: () => unknown | Promise<unknown>, errorKey: 'memory.saveError' | 'memory.removeError' | 'memory.openError',
    successKey?: 'memory.saved' | 'memory.removed', done?: () => void): Promise<void>;
}
export function MemoryList({ records, busy, draft, pendingDelete, t, onOpenSession, onUpdate, onRemove, previewForget,
  edit, setPendingDelete, setNotice, perform }: Props) {
  function timestamp(value: number, label: 'memory.created' | 'memory.updated') {
    const date = new Date(value);
    const valid = Number.isFinite(date.getTime());
    return (
        <time dateTime={valid ? date.toISOString() : undefined}>
          {t(label, { time: valid ? date.toLocaleString() : t('memory.timeUnavailable') })}
        </time>
      );
    }
    return (
        <ul className={panel.list}>
          {records.map((record) => (
            <li key={record.id} className={panel.record}>
              <div className={panel.metadata}>
                <span>{t(kindKeys[record.kind])}</span>
                {record.pinned && <span>{t('memory.pinned')}</span>}
                <span>
                  {t(
                    record.source?.by === 'user'
                      ? 'memory.sourceUser'
                      : record.source?.by === 'model'
                        ? 'memory.sourceModel'
                        : 'memory.sourceUnknown',
                  )}
                </span>
              </div>
              <p className={panel.content}>{record.content}</p>
              {record.tags.length > 0 && (
                <ul className={panel.tags} aria-label={t('memory.tags')}>
                  {[...new Set(record.tags)].map((tag) => (
                    <li key={tag}>{tag}</li>
                  ))}
                </ul>
              )}
              <div className={panel.metadata}>
                {timestamp(record.createdAt, 'memory.created')}
                {timestamp(record.updatedAt, 'memory.updated')}
              </div>
              <div className={styles.actions}>
                {record.source?.sessionId && (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={busy}
                    title={record.source.sessionId}
                    onClick={() => {
                      const sessionId = record.source?.sessionId;
                      if (sessionId) void perform(() => onOpenSession(sessionId), 'memory.openError');
                    }}
                  >
                    {t('memory.sourceSession')}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy || Boolean(draft)}
                  onClick={() => {
                    void perform(
                      () => onUpdate(record.id, { pinned: !record.pinned }),
                      'memory.saveError',
                      'memory.saved',
                    );
                  }}
                >
                  {t(record.pinned ? 'memory.unpin' : 'memory.pin')}
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy || Boolean(draft)}
                  onClick={() => edit(record)}
                >
                  {t('card.edit')}
                </button>
                <button
                  type="button"
                  className={styles.dangerButton}
                  disabled={busy || Boolean(draft)}
                  onClick={() => {
                    if (previewForget) previewForget(record.id);
                    else setPendingDelete(record.id);
                    setNotice(undefined);
                  }}
                >
                  {t('actions.delete')}
                </button>
              </div>
              {pendingDelete === record.id && (
                <fieldset className={panel.confirm}>
                  <legend className={styles.warning}>{t('memory.deleteConfirm')}</legend>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busy}
                      onClick={() => setPendingDelete(undefined)}
                    >
                      {t('actions.cancel')}
                    </button>
                    <button
                      type="button"
                      className={styles.dangerButton}
                      disabled={busy}
                      onClick={() => {
                        void perform(
                          () => onRemove(record.id),
                          'memory.removeError',
                          'memory.removed',
                          () => setPendingDelete(undefined),
                        );
                      }}
                    >
                      {t('memory.deleteAction')}
                    </button>
                  </div>
                </fieldset>
              )}
            </li>
          ))}
        </ul>
  );
}
