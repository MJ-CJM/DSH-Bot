import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { groupKey, type GroupRecord } from '../../shared/groups.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import { unwrapGroup, type GroupActions } from '../groups-state.js';
import { conversationKey, forgetRecentPreference } from '../pages/recent-conversations.js';
import { directoryWindow, readDirectoryWindow, writeDirectoryWindow } from '../pages/native-directory.js';
import styles from '../styles/bots.module.css';
import { Modal } from './Modal.js';

function deleteError(error: unknown) {
  if (hasOperationCode(error, 'busy')) return 'groups.deleteBusy';
  if (hasOperationCode(error, 'unsupported')) return 'groups.deleteManaged';
  if (hasOperationCode(error, 'conflict') || hasOperationCode(error, 'not-found')) return 'groups.deleteChanged';
  if (hasOperationCode(error, 'recovery-needed')) return 'groups.deleteRecovery';
  return 'groups.deleteUnconfirmed';
}

/** Consent belongs to the group incarnation and revision captured when the menu was chosen. */
export function GroupDeleteDialog({ group, actions, section = 'groups', onClose, onDeleted, t }: {
  group: GroupRecord;
  actions: GroupActions;
  section?: 'groups' | 'recent';
  onClose(): void;
  onDeleted?(group: GroupRecord): void;
} & PropsLocale<'dsh-bot'>) {
  const list = useSyncExternalStore(actions.catalog.subscribe, actions.catalog.getSnapshot);
  const current = list.groups.find(row => row.group.id === group.id && row.group.createdAt === group.createdAt);
  const changed = list.loaded && (!current || current.group.revision !== group.revision);
  const [error, setError] = useState<ReturnType<typeof deleteError>>();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const callbacks = useRef({ onDeleted, onClose });
  callbacks.current = { onDeleted, onClose };
  const reason = group.supergroup ? 'groups.deleteManaged' : changed ? 'groups.deleteChanged'
    : current?.running ? 'groups.deleteBusy' : list.error ? 'groups.disconnected' : error;
  const confirm = async () => {
    if (submitting.current || reason || !list.loaded) return;
    submitting.current = true;
    setBusy(true);
    try {
      if (!unwrapGroup(await actions.remote().deleteGroup(groupKey(group), group.revision))) throw new Error();
    } catch (cause) {
      if (mounted.current) {
        setError(deleteError(cause));
        submitting.current = false;
        setBusy(false);
      }
      await actions.catalog.refresh();
      return;
    }
    const key = conversationKey('group', group.id, group.createdAt);
    forgetRecentPreference(key);
    const { storage, path } = directoryWindow();
    if (readDirectoryWindow(storage, path, 'selection').selected === key) writeDirectoryWindow(storage, path, 'selection', {});
    if (mounted.current) {
      callbacks.current.onDeleted?.(group);
      callbacks.current.onClose();
    }
    await actions.catalog.refresh();
    actions.returnAfterDeletion?.(groupKey(group), group.rootSessionId, section);
  };
  return <Modal title={t('groups.deleteTitle', { name: group.name })} busy={busy} onClose={onClose} t={t}>
    <div className={styles.editorBody}>
      {list.groups.some(row => row.group.name === group.name && row.group.id !== group.id) && <p>{group.id}</p>}
      {group.supergroup ? null : <p>{t('groups.deleteImpact')}</p>}
      {reason && <p role="alert">{t(reason)}</p>}
    </div>
    <footer className={styles.dialogFooter}>
      <Button disabled={busy} onClick={onClose}>{t('actions.cancel')}</Button>
      <Button className={styles.dangerButton} disabled={busy || !!reason || !list.loaded} onClick={() => void confirm()}>{t('groups.delete')}</Button>
    </footer>
  </Modal>;
}
