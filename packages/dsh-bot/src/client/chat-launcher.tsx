import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './components/Modal.js';
import styles from './styles/bots.module.css';

export interface ChatLauncherActions {
  onStart(id: string, signal?: AbortSignal): Promise<void>;
  onStartInWorkspace(id: string, workspaceId: string, signal?: AbortSignal): Promise<void>;
  getPreferredWorkspace(): string;
}

type WorkspaceSnapshot = ReturnType<Context['workspaces']['list']['getSnapshot']>;
interface PendingChoice { id: string; resolve(): void; reject(error: unknown): void }

/** Each surface owns its pending dialog; the Client apply closure owns the last successful choice. */
export function useChatLauncher({ workspaces, onStart, onStartInWorkspace, getPreferredWorkspace, t }: ChatLauncherActions & {
  workspaces: WorkspaceSnapshot; t: PropsLocale<'dsh-bot'>['t'];
}) {
  const [choice, setChoice] = useState<PendingChoice>();
  const [workspaceId, setWorkspaceId] = useState('');
  const [launching, setLaunching] = useState(false);
  const pending = useRef<PendingChoice>();
  const lifetime = useRef<AbortController>();
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => {
      lifetime.current?.abort();
      pending.current?.resolve();
      pending.current = undefined;
    };
  }, []);
  const finish = (error?: unknown) => {
    const request = pending.current;
    pending.current = undefined;
    if (!lifetime.current?.signal.aborted) { setChoice(undefined); setLaunching(false); }
    if (error === undefined) request?.resolve();
    else request?.reject(error);
  };
  const start = (id: string): Promise<void> => {
    if (lifetime.current?.signal.aborted) return Promise.resolve();
    return onStart(id, lifetime.current?.signal);
  };
  const startInWorkspace = (id: string): Promise<void> => {
    if (lifetime.current?.signal.aborted || pending.current) return Promise.resolve();
    if (workspaces.phase !== 'ready' || workspaces.state === 'error' || workspaces.items.length <= 1) {
      return onStartInWorkspace(id, workspaces.items[0]?.workspaceId ?? '', lifetime.current?.signal);
    }
    const preferred = getPreferredWorkspace();
    setWorkspaceId(workspaces.items.some((item) => item.workspaceId === preferred) ? preferred : '');
    return new Promise<void>((resolve, reject) => {
      const request = { id, resolve, reject };
      pending.current = request;
      setChoice(request);
    });
  };
  const dialog = choice && <Modal title={t('chat.workspaceChoose')} busy={launching} onClose={() => finish()} t={t}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (launching || !workspaceId) return;
      setLaunching(true);
      void onStartInWorkspace(choice.id, workspaceId, lifetime.current?.signal).then(() => finish(), finish);
    }}>
      <div className={styles.editorBody}>
        <label className={styles.field}>{t('chat.workspace')}
          <select value={workspaceId} disabled={launching || workspaces.phase !== 'ready'} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">{t('chat.workspaceChoose')}</option>
            {workspaces.items.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.title || item.path}</option>)}
          </select>
        </label>
      </div>
      <footer className={styles.dialogFooter}>
        <button type="button" className={styles.button} disabled={launching} onClick={() => finish()}>{t('actions.cancel')}</button>
        <button type="submit" className={styles.primaryButton} disabled={launching || !workspaces.items.some((item) => item.workspaceId === workspaceId)}>{t('card.start')}</button>
      </footer>
    </form>
  </Modal>;
  return { start, startInWorkspace, dialog };
}
