import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { Modal } from './Modal.js';
import styles from '../styles/bots.module.css';

type DraftRegistry = { set(id: string, dirty: boolean): void; leave(run: () => void): void };
export const SettingsDrafts = createContext<DraftRegistry | undefined>(undefined);

/** Only a dirty flag leaves the editor; values, including secrets, stay local. */
export function useSettingsDraft(dirty: boolean) {
  const registry = useContext(SettingsDrafts), id = useId();
  useLayoutEffect(() => {
    registry?.set(id, dirty);
    return () => registry?.set(id, false);
  }, [registry, id, dirty]);
}
const leaveImmediately = (run: () => void) => run();
export function useSettingsLeave() { return useContext(SettingsDrafts)?.leave ?? leaveImmediately; }

export function useSettingsNavigation(t: PropsLocale<'dsh-bot'>['t']) {
  const parent = useContext(SettingsDrafts), scope = useId();
  const dirty = useRef(new Set<string>());
  useEffect(() => () => parent?.set(scope, false), [parent, scope]);
  const [pending, setPending] = useState<{ run(): void }>();
  const [registry] = useState<DraftRegistry>(() => ({
    set(id, value) { if (value) dirty.current.add(id); else dirty.current.delete(id); parent?.set(scope, dirty.current.size > 0); },
    leave(run) { if (dirty.current.size) setPending({ run }); else run(); },
  }));
  return {
    registry,
    leave: registry.leave,
    confirmation: pending && <Modal title={t('navigation.unsaved')} t={t} onClose={() => setPending(undefined)}>
      <div className={styles.editorBody}>
        <p>{t('navigation.unsavedHint')}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => setPending(undefined)}>{t('navigation.keepEditing')}</button>
          <button type="button" className={styles.dangerButton} onClick={() => { setPending(undefined); pending.run(); }}>{t('navigation.discardLeave')}</button>
        </div>
      </div>
    </Modal>,
  };
}
