import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { groupKey } from '../../shared/groups.js';
import type { GroupActions } from '../groups-state.js';
import styles from '../styles/bots.module.css';

/** Counts are an owner projection; opening this locator never reads or approves reply bodies. */
export function DirectoryPending({ groups, t }: { groups: GroupActions } & PropsLocale<'dsh-bot'>) {
  const snapshot = useSyncExternalStore(groups.catalog.subscribe, groups.catalog.getSnapshot);
  const [failed, setFailed] = useState(false), [opening, setOpening] = useState(false);
  const navigation = useRef<AbortController>();
  useEffect(() => () => navigation.current?.abort(), []);
  const rows = snapshot.groups.filter(row => !row.group.archived && (row.exportPendingCount ?? 0) > 0);
  if (!rows.length && !failed && !snapshot.error) return null;
  return <section data-directory-export-pending="" aria-label={t('groups.export.queue')}>
    <h2>{t('groups.export.queue')}</h2>
    {!snapshot.error && rows.map(row => <p key={JSON.stringify(groupKey(row.group))}>
      <Button variant="ghost" className={styles.pendingLocator} data-directory-pending-group={row.group.id} data-directory-created-at={row.group.createdAt} disabled={opening}
        onClick={() => {
          if (navigation.current) return;
          const controller = new AbortController(); navigation.current = controller;
          setOpening(true); setFailed(false);
          void groups.open(groupKey(row.group), controller.signal).catch(() => { if (!controller.signal.aborted) setFailed(true); }).finally(() => {
            if (navigation.current === controller) navigation.current = undefined;
            if (!controller.signal.aborted) setOpening(false);
          });
        }}>{row.group.name} · {t('groups.export.queueCount', { count: row.exportPendingCount ?? 0 })}</Button>
    </p>)}
    {(failed || snapshot.error) && <p role="alert">{t('groups.disconnected')} <Button variant="ghost" onClick={() => { setFailed(false); void groups.catalog.refresh(); }}>{t('bots.refresh')}</Button></p>}
  </section>;
}
