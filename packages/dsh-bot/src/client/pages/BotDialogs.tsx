import { botIdSchema } from '../../shared/ids.js';
import { BotEditor } from '../components/BotEditor.js';
import { Modal } from '../components/Modal.js';
import styles from '../styles/bots.module.css';

import type { BotsPageProps } from './bots-page-types.js';
import type { BotsPageModel } from './use-bots-page.js';
import { MemoryTab } from './BotMemoryTab.js';
export function BotDialogs({ page, model }: { page: BotsPageProps; model: BotsPageModel }) {
  const { createMemoryPanel, onEnsureHome, onEnsureBotsWorkspace, onPickDirectory, onDelete, onDuplicate, t } = page;
  const {
    dialog,
    snapshot,
    busy,
    save,
    setDialog,
    memoryCount,
    setCountAttempt,
    deleteMemories,
    setDeleteMemories,
    deleteHome,
    setDeleteHome,
    perform,
    copyId,
    setCopyInvalid,
    copyInput,
    copyInvalid,
    setCopyId,
  } = model;
  return (
    <>
      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <BotEditor
          avatarWarning={
            dialog.kind === 'edit' &&
            snapshot.entries.find(({ bot }) => bot.id === dialog.bot.id)?.status?.warnings?.includes('avatar/invalid')
          }
          key={dialog.kind === 'edit' ? dialog.bot.id : 'new'}
          memoryPanel={
            dialog.kind === 'edit' ? (
              <MemoryTab
                bot={snapshot.entries.find(({ bot }) => bot.id === dialog.bot.id)?.bot ?? dialog.bot}
                create={createMemoryPanel}
                t={t}
              />
            ) : undefined
          }
          bot={dialog.kind === 'edit' ? dialog.bot : undefined}
          onEnsureHome={onEnsureHome}
          onEnsureBotsWorkspace={onEnsureBotsWorkspace}
          onPickDirectory={onPickDirectory}
          busy={busy}
          onSave={save}
          onCancel={() => setDialog(undefined)}
          t={t}
        />
      )}
      {dialog?.kind === 'memory' && (
        <Modal title={t('memory.title')} busy={busy} onClose={() => setDialog(undefined)} t={t}>
          <MemoryTab
            bot={snapshot.entries.find(({ bot }) => bot.id === dialog.bot.id)?.bot ?? dialog.bot}
            create={createMemoryPanel}
            t={t}
          />
        </Modal>
      )}
      {dialog?.kind === 'delete' && (
        <Modal title={t('delete.title')} busy={busy} onClose={() => setDialog(undefined)} t={t}>
          <div className={styles.editorBody}>
            <p>{t('delete.description', { name: dialog.bot.name })}</p>
            {memoryCount.count !== undefined ? (
              <p>{t('delete.memoryCount', { count: memoryCount.count })}</p>
            ) : memoryCount.failed ? (
              <div role="alert" className={styles.error}>
                <p>{t('delete.countError')}</p>
                <button type="button" className={styles.button} onClick={() => setCountAttempt((value) => value + 1)}>
                  {t('actions.retry')}
                </button>
              </div>
            ) : (
              <p role="status">{t('delete.countLoading')}</p>
            )}
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={deleteMemories}
                disabled={busy}
                onChange={(event) => setDeleteMemories(event.target.checked)}
              />
              {t('delete.memories')}
            </label>
            <p className={styles.warning}>{t(deleteMemories ? 'delete.memoriesWarning' : 'delete.keepMemories')}</p>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={deleteHome}
                disabled={busy}
                onChange={(event) => setDeleteHome(event.target.checked)}
              />
              {t('delete.home')}
            </label>
            <p className={styles.warning}>{t(deleteHome ? 'delete.homeWarning' : 'delete.keepHome')}</p>
            <p className={styles.warning}>{t('delete.history')}</p>
            <p className={styles.warning}>{t('manage.deleteImpact')}</p>
          </div>
          <footer className={styles.dialogFooter}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => setDialog(undefined)}>
              {t('actions.cancel')}
            </button>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={busy || memoryCount.count === undefined}
              onClick={() => {
                void perform(
                  () => onDelete(dialog.bot.id, deleteMemories, deleteHome),
                  'errors.delete',
                  deleteMemories ? 'delete.success' : 'delete.keptSuccess',
                ).catch(() => {});
              }}
            >
              {t('actions.delete')}
            </button>
          </footer>
        </Modal>
      )}
      {dialog?.kind === 'duplicate' && (
        <Modal title={t('duplicate.title')} busy={busy} onClose={() => setDialog(undefined)} t={t}>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const result = botIdSchema.safeParse(copyId);
              setCopyInvalid(!result.success);
              if (result.success)
                void perform(
                  () => onDuplicate(dialog.bot.id, result.data),
                  'errors.duplicate',
                  'duplicate.success',
                ).catch(() => {});
            }}
          >
            <div className={styles.editorBody}>
              <p>{t('duplicate.description', { name: dialog.bot.name })}</p>
              <label className={styles.field} htmlFor={copyInput}>
                {t('duplicate.id')}
                <input
                  id={copyInput}
                  value={copyId}
                  disabled={busy}
                  aria-invalid={copyInvalid}
                  aria-describedby={copyInvalid ? `${copyInput}-error` : undefined}
                  onChange={(event) => setCopyId(event.target.value)}
                />
              </label>
              {copyInvalid && (
                <p id={`${copyInput}-error`} role="alert" className={styles.error}>
                  {t('validation.id')}
                </p>
              )}
            </div>
            <footer className={styles.dialogFooter}>
              <button type="button" className={styles.button} disabled={busy} onClick={() => setDialog(undefined)}>
                {t('actions.cancel')}
              </button>
              <button type="submit" className={styles.primaryButton} disabled={busy}>
                {t('duplicate.action')}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
