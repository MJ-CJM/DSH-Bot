import { hasOperationCode } from '../../shared/operation-errors.js';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotRecord } from '../../shared/schema.js';
import type { CollaborationActions } from '../collaboration-state.js';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import css from '../styles/integrations.module.css?inline';
import styles from '../styles/integrations.module.css';
export interface CollaborationPanelProps extends PropsLocale<'dsh-bot'> {
  actions: CollaborationActions;
  bots: BotRecord[];
  onOpenSession(id: string): Promise<void>;
}
export function CollaborationPanel({ actions, bots, onOpenSession, t }: CollaborationPanelProps) {
  const [selected, setSelected] = useState('');
  const bot = bots.find((b) => b.id === selected) ?? bots[0];
  return (
    <section className={styles.panel} aria-label={t('team.title')}>
      <style>{css}</style>
      <h2>{t('team.title')}</h2>
      <p>{t('team.inherits')}</p>
      <p>{t('team.delegateHint')}</p>
      <label>
        {t('integrations.bot')}
        <select value={bot?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.id})
            </option>
          ))}
        </select>
      </label>
      {bot && (
        <Board key={`${bot.id}:${bot.createdAt}`} actions={actions} bot={bot} onOpenSession={onOpenSession} t={t} />
      )}
    </section>
  );
}
function Board({ actions, bot, onOpenSession, t }: Omit<CollaborationPanelProps, 'bots'> & { bot: BotRecord }) {
  const key = useMemo(() => ({ botId: bot.id, botCreatedAt: bot.createdAt }), [bot.id, bot.createdAt]);
  const catalog = useMemo(() => actions.createBoard(key), [actions, key]);
  useEffect(() => () => catalog.dispose(), [catalog]);
  const data = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [error, setError] = useState<'conflict' | 'recovery' | 'failed'>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const writing = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const write = async (fn: () => Promise<RemoteResult<unknown>>) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const r = await fn();
      if (!r.ok) throw r.error;
      await catalog.refresh();
    } catch (e) {
      if (alive.current) {
        setError(
          hasOperationCode(e, 'conflict') ? 'conflict' : hasOperationCode(e, 'recovery-needed') ? 'recovery' : 'failed',
        );
      }
      await catalog.refresh();
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const link = data.link;
  return (
    <>
      {data.error && <p role="alert">{t('integrations.loadFailed')}</p>}
      {error && (
        <p role="alert">
          {t(
            error === 'conflict'
              ? 'team.conflict'
              : error === 'recovery'
                ? 'team.recovery'
                : 'integrations.operationFailed',
          )}
        </p>
      )}
      <button
        type="button"
        onClick={() => {
          void catalog.refresh();
        }}
      >
        {t('bots.refresh')}
      </button>
      {!data.loaded && data.loading && <p role="status">{t('bots.loading')}</p>}
      {data.loaded && !data.supported && <p>{t('team.unsupported')}</p>}
      {data.loaded && data.supported && !data.link && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void write(() => actions.remote().ensure(key, 0));
          }}
        >
          {t('team.ensure')}
        </button>
      )}
      {link && (
        <>
          <p>
            {bot.name} · {link.nativeTeamId}
          </p>
          <button
            type="button"
            onClick={() => {
              void onOpenSession(link.leadSessionId);
            }}
          >
            {t('notifications.openSession')}
          </button>
          <h3>{t('team.members')}</h3>
          <ul>
            {data.members.map((m) => (
              <li key={m.id}>
                {m.name} · {t(`team.role-${m.role}`)} · {t(`team.${m.status}`)}
                {m.description && <p>{m.description}</p>}
              </li>
            ))}
          </ul>
          <h3>{t('team.tasks')}</h3>
          <ul>
            {data.tasks.map((task) => (
              <li key={task.id}>
                <p>
                  {task.subject} · v{task.revision} · {t(`team.${task.status}`)} · {task.ownerName ?? t('team.unowned')}
                </p>
                <p>{task.description}</p>
                {task.blockedBy.length > 0 && (
                  <p>
                    {t('team.blockedBy')}: {task.blockedBy.join(', ')}
                  </p>
                )}
                {[...new Set(task.writeScopeWarnings)].map((w) => (
                  <p key={w}>{w}</p>
                ))}
                <button
                  type="button"
                  disabled={busy || !task.ready || task.status !== 'pending'}
                  onClick={() => {
                    void write(() =>
                      actions
                        .remote()
                        .updateTask(key, { taskId: task.id, expectedRevision: task.revision, action: 'claim' }),
                    );
                  }}
                >
                  {t('team.claim')}
                </button>
                <button
                  type="button"
                  disabled={busy || task.status !== 'in_progress'}
                  onClick={() => {
                    void write(() =>
                      actions
                        .remote()
                        .updateTask(key, { taskId: task.id, expectedRevision: task.revision, action: 'complete' }),
                    );
                  }}
                >
                  {t('team.complete')}
                </button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void write(() => actions.remote().createTask(key, { subject, description, blockedBy }));
            }}
          >
            <label>
              {t('team.subject')}
              <input required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
            </label>
            <label>
              {t('team.description')}
              <textarea
                required
                maxLength={16384}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              {t('team.blockedBy')}
              <select
                multiple
                value={blockedBy}
                onChange={(e) => setBlockedBy([...e.target.selectedOptions].map((o) => o.value))}
              >
                {data.tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.subject} ({task.id})
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy}>
              {t('team.createTask')}
            </button>
          </form>
        </>
      )}
    </>
  );
}
export function ImPanel({ actions, t }: { actions: CollaborationActions } & PropsLocale<'dsh-bot'>) {
  const data = useSyncExternalStore(actions.im.subscribe, actions.im.getSnapshot, actions.im.getSnapshot);
  return (
    <section className={styles.panel} aria-label={t('im.title')}>
      <style>{css}</style>
      <h2>{t('im.title')}</h2>
      {data.error && <p role="alert">{t('integrations.loadFailed')}</p>}
      <p>
        {t('im.pin')}: {data.pin}
      </p>
      <p>{t(`im.${data.reason}`)}</p>
      <p>{t('im.gateHint')}</p>
      <button
        type="button"
        onClick={() => {
          void actions.im.refresh();
        }}
      >
        {t('bots.refresh')}
      </button>
      <button type="button" disabled>
        {t('im.bind')}
      </button>
      <button type="button" disabled>
        {t('im.send')}
      </button>
    </section>
  );
}
