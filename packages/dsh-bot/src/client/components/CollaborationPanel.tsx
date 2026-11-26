import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { useSettingsBot } from './SettingsBotContext.js';
import { useSettingsDraft } from './SettingsNavigation.js';
import { ManagementHeader } from './ManagementHeader.js';
import { hasOperationCode } from '../../shared/operation-errors.js';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotRecord } from '../../shared/schema.js';
import { EMPTY_BOARD, type CollaborationActions } from '../collaboration-state.js';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import css from '../styles/integrations.module.css?inline';
import styles from '../styles/integrations.module.css';
export interface CollaborationPanelProps extends PropsLocale<'dsh-bot'> {
  actions: CollaborationActions;
  bots: BotRecord[];
  onOpenSession(id: string): Promise<void>;
}
export function CollaborationPanel({ actions, bots, onOpenSession, t }: CollaborationPanelProps) {
  const { bot, select: setSelected } = useSettingsBot(bots);
  return (
    <section className={styles.panel} aria-label={t('team.title')}>
      <style>{css}</style>
      {!bot && <ManagementHeader title={t('team.title')} selector={{ bots, value: '', onChange: setSelected }} t={t} />}
      {bot && (
        <Board key={`${bot.id}:${bot.createdAt}`} actions={actions} bot={bot} bots={bots} onBotChange={setSelected} onOpenSession={onOpenSession} t={t} />
      )}
    </section>
  );
}
const emptyBoardSnapshot: ReturnType<ReturnType<CollaborationActions['createBoard']>['getSnapshot']> = {
  ...EMPTY_BOARD,
  loading: true,
  loaded: false,
  pollIntervalMs: 0,
};
const subscribeEmptyBoard = () => () => {};
const getEmptyBoard = () => emptyBoardSnapshot;

function Board({ actions, bot, bots, onBotChange, onOpenSession, t }: CollaborationPanelProps & { bot: BotRecord; onBotChange(id: string): void }) {
  const key = useMemo(() => ({ botId: bot.id, botCreatedAt: bot.createdAt }), [bot.id, bot.createdAt]);
  const [owned, setOwned] = useState<{ key: typeof key; source: ReturnType<CollaborationActions['createBoard']> }>();
  useEffect(() => {
    const source = actions.createBoard(key);
    setOwned({ key, source });
    return () => source.dispose();
  }, [actions, key]);
  const catalog = owned?.key === key ? owned.source : undefined;
  const data = useSyncExternalStore(catalog?.subscribe ?? subscribeEmptyBoard, catalog?.getSnapshot ?? getEmptyBoard, catalog?.getSnapshot ?? getEmptyBoard);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [savedDraft, setSavedDraft] = useState(JSON.stringify(['', '', []]));
  const draftSignature = JSON.stringify([subject, description, blockedBy]);
  useSettingsDraft(draftSignature !== savedDraft);
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
      await catalog?.refresh();
    } catch (e) {
      if (alive.current) {
        setError(
          hasOperationCode(e, 'conflict') ? 'conflict' : hasOperationCode(e, 'recovery-needed') ? 'recovery' : 'failed',
        );
      }
      await catalog?.refresh();
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const link = data.link;
  return (
    <>
      <ManagementHeader title={t('team.title')} selector={{ bots, value: bot.id, onChange: onBotChange }} actions={<Button
        type="button"
        onClick={() => {
          void catalog?.refresh();
        }}
      >
        {t('bots.refresh')}
      </Button>} t={t} />
      <p>{t('team.distinction')}</p>
      {data.supported && <details><summary>{t('settings.howItWorks')}</summary><p>{t('team.inherits')}</p><p>{t('team.delegateHint')}</p></details>}
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
      {!data.loaded && data.loading && <p role="status">{t('bots.loading')}</p>}
      {data.loaded && !data.supported && <div role="status"><p>{t('team.unsupported')}</p><p>{t('team.nextStep')}</p></div>}
      {data.loaded && data.supported && !data.link && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            void write(() => actions.remote().ensure(key, 0));
          }}
        >
          {t('team.ensure')}
        </Button>
      )}
      {link && (
        <>
          <p>
            {bot.name} · {link.nativeTeamId}
          </p>
          <Button
            type="button"
            onClick={() => {
              void onOpenSession(link.leadSessionId);
            }}
          >
            {t('notifications.openSession')}
          </Button>
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
                <Button
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
                </Button>
                <Button
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
                </Button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void write(async () => {
                const result = await actions.remote().createTask(key, { subject, description, blockedBy });
                if (result.ok) setSavedDraft(draftSignature);
                return result;
              });
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
            <Button type="submit" disabled={busy}>
              {t('team.createTask')}
            </Button>
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
      <ManagementHeader title={t('im.title')} actions={<Button
        type="button"
        onClick={() => {
          void actions.im.refresh();
        }}
      >
        {t('bots.refresh')}
      </Button>} t={t} />
      {data.error && <p role="alert">{t('integrations.loadFailed')}</p>}
      <p role="status">{t(`im.${data.reason}`)}</p>
      <p>{t('im.nextStep')}</p>
      <details><summary>{t('settings.diagnostics')}</summary><p>{t('im.pin')}: {data.pin}</p><p>{t('im.gateHint')}</p></details>
    </section>
  );
}
