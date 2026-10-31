import { ManagementHeader } from './ManagementHeader.js';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ScheduleTimingChange } from '@deepseek-ai/dsh-schedule/client';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { BotRecord } from '../../shared/schema.js';
import type { LegacyEntry } from '../../shared/native-schedule.js';
import type { RoutineActions, NativeTask } from '../automation-state.js';
import { Modal } from './Modal.js';
import styles from '../styles/routines.module.css';
import css from '../styles/routines.module.css?inline';
type T = PropsLocale<'dsh-bot'>['t'];
function formatTime(at: string | undefined, t: T) {
  return at
    ? new Intl.DateTimeFormat(t('activity.locale'), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
    : t('routine.none');
}
export function nativeRuleLabel(r: NativeTask, t: T) {
  if (r.kind === 'every') {
    const seconds = r.everySeconds;
    const unit =
      seconds % 86400 === 0 ? 'day' : seconds % 3600 === 0 ? 'hour' : seconds % 60 === 0 ? 'minute' : 'second';
    const count = seconds / { day: 86400, hour: 3600, minute: 60, second: 1 }[unit];
    return t(`routine.every.${unit}.${count === 1 ? 'one' : 'other'}`, { count });
  }
  if (r.kind === 'at' || r.kind === 'after') return `${t('routine.kind.at')} · ${formatTime(r.scheduledAt, t)}`;
  return `${t(`routine.kind.${r.kind}`)} · ${r.kind === 'cron' ? r.expression : r.kind === 'weekly' ? `${r.weekdays.join(', ')} · ${r.time}` : r.time} · ${r.timeZone}`;
}
function errorText(error: unknown, t: T) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return ['automation/conflict', 'schedule_conflict'].includes(code)
    ? t('routine.conflict')
    : `${t('routine.error')}${code ? ` (${code})` : ''}`;
}
type Dialog =
  | { kind: 'edit' | 'delete' | 'run'; record: NativeTask; operationId?: string }
  | { kind: 'legacy'; record: LegacyEntry };
export function RoutinePanel({
  actions,
  bots,
  botId,
  onOpenSession,
  t,
}: {
  actions: RoutineActions;
  bots: readonly BotRecord[];
  botId?: string;
  onOpenSession(id: string): Promise<void>;
  t: T;
}) {
  const data = useSyncExternalStore(actions.catalog.subscribe, actions.catalog.getSnapshot);
  const [dialog, setDialog] = useState<Dialog>();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const records = data.routines.filter((r) => !botId || r.botId === botId);
  const legacy = data.legacy.filter(
    (r) => !botId || (r.botId === botId && bots.some((b) => b.id === r.botId && b.createdAt === r.botCreatedAt)),
  );
  const writable = data.loaded && !data.error;
  async function perform(action: () => Promise<void>, accepted = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (alive.current) {
        setDialog(undefined);
        if (accepted) setNotice(t('routine.accepted'));
      }
    } catch (error) {
      if (alive.current) setError(errorText(error, t));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function open(next: Dialog) {
    setError('');
    setNotice('');
    setDialog(next);
  }
  const record = records.find((r) => r.id === selected);
  return (
    <section className={styles.panel} data-routine-panel={botId ?? 'overview'} aria-label={t('routine.title')}>
      <style>{css}</style>
      <ManagementHeader title={t('routine.title')} level={3} description={t('routine.hint')} actions={
        <button type="button" disabled={busy} onClick={() => { void actions.catalog.refresh(); }}>{t('bots.refresh')}</button>
      } t={t} />
      {!data.loaded && !data.error && <p role="status">{t('routine.loading')}</p>}
      {data.error && <p role="alert">{errorText(data.error, t)}</p>}
      {data.loaded && !data.nativeAvailable && <p role="status">{t('native.unavailable')}</p>}
      {!dialog && error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {writable && records.length === 0 && <p>{t('routine.empty')}</p>}
      <div className={styles.list}>
        {records.map((r) => (
          <article className={styles.card} key={r.id} data-routine-id={r.id}>
            <div className={styles.header}>
              <strong className={styles.title}>{r.title}</strong>
              <span>{bots.find((b) => b.id === r.botId)?.name ?? r.botId}</span>
            </div>
            <p>{nativeRuleLabel(r, t)}</p>
            <p className={styles.meta}>
              {t(r.status === 'active' ? 'routine.enabled' : 'native.ended')} · {t('routine.next')}:{' '}
              {r.status === 'active' ? formatTime(r.scheduledAt, t) : t('routine.none')}
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={!writable || busy}
                onClick={() => open({ kind: 'run', record: r, operationId: crypto.randomUUID() })}
              >
                {t('routine.runNow')}
              </button>
              <button
                type="button"
                disabled={!writable || busy || r.status !== 'active'}
                onClick={() => open({ kind: 'edit', record: r })}
              >
                {t('card.edit')}
              </button>
              <button type="button" disabled={!writable || busy} onClick={() => open({ kind: 'delete', record: r })}>
                {t('actions.delete')}
              </button>
              <button type="button" onClick={() => setSelected(selected === r.id ? undefined : r.id)}>
                {t('routine.history')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void onOpenSession(r.sessionId).catch(() => setError(t('activity.openError')));
                }}
              >
                {t('routine.openSession')}
              </button>
            </div>
          </article>
        ))}
      </div>
      {record && <DeliveryHistory key={record.id} actions={actions} record={record} t={t} />}
      {(legacy.length > 0 || data.legacyUnavailable || data.legacySkipped > 0) && (
        <section data-legacy-routines="">
          <h4>{t('native.legacyTitle')}</h4>
          <p>{t('native.legacyHint')}</p>
          {(data.legacyUnavailable || data.legacySkipped > 0) && <p role="status">{t('native.legacySkipped')}</p>}
          {legacy.map((r) => (
            <article className={styles.card} key={r.id}>
              <strong>{r.title}</strong>
              <p>{r.botId}</p>
              <p className={styles.prompt}>{r.prompt}</p>
              <button type="button" disabled={busy || !writable} onClick={() => open({ kind: 'legacy', record: r })}>
                {t('actions.delete')}
              </button>
            </article>
          ))}
        </section>
      )}
      {dialog?.kind === 'edit' && (
        <NativeEditor
          record={dialog.record}
          busy={busy}
          error={error}
          t={t}
          onClose={() => setDialog(undefined)}
          onSave={(patch) => perform(() => actions.update(dialog.record, patch))}
        />
      )}
      {dialog && dialog.kind !== 'edit' && (
        <Modal
          title={t(dialog.kind === 'run' ? 'routine.runNow' : 'routine.deleteTitle')}
          busy={busy}
          onClose={() => setDialog(undefined)}
          t={t}
        >
          <div className={styles.form}>
            <p>{dialog.record.title}</p>
            <p className={styles.prompt}>{dialog.record.prompt}</p>
            <p>
              {t(
                dialog.kind === 'run'
                  ? 'routine.runConfirm'
                  : dialog.kind === 'legacy'
                    ? 'native.legacyDelete'
                    : 'routine.deleteConfirm',
              )}
            </p>
            {error && <p role="alert">{error}</p>}
            <button
              type="button"
              disabled={busy || !writable}
              onClick={() => {
                void perform(
                  () =>
                    dialog.kind === 'run'
                      ? actions.runNow(dialog.record, dialog.operationId as string)
                      : dialog.kind === 'legacy'
                        ? actions.deleteLegacy(dialog.record.id)
                        : actions.remove(dialog.record),
                  dialog.kind === 'run',
                );
              }}
            >
              {t('routine.confirm')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
function DeliveryHistory({ actions, record, t }: { actions: RoutineActions; record: NativeTask; t: T }) {
  const [source] = useState(() => actions.history(record));
  const data = useSyncExternalStore(source.subscribe, source.getSnapshot);
  useEffect(() => () => source.dispose(), [source]);
  return (
    <section className={styles.history} data-routine-history="">
      <h4>
        {record.title} · {t('routine.history')}
      </h4>
      <p>{t('native.deliveryHint')}</p>
      {data.error && <p role="alert">{errorText(data.error, t)}</p>}
      {!data.loaded && !data.error && <p role="status">{t('routine.loading')}</p>}
      {data.loaded && !data.records.length && <p>{t('routine.noHistory')}</p>}
      {data.records.map((r) => (
        <article className={styles.card} data-delivery-id={r.messageId} key={r.messageId}>
          <p>
            {t('native.delivered')}: {formatTime(r.deliveredAt, t)}
          </p>
          <p>
            {t('routine.scheduledAt')}: {formatTime(r.scheduledAt, t)}
          </p>
          <p data-routine-outcome={r.outcome?.state ?? 'unobserved'}>{t(`routine.outcome.${r.outcome?.state ?? 'unobserved'}`)}</p>
          <p className={styles.prompt}>{r.prompt ?? t('native.promptUnavailable')}</p>
        </article>
      ))}
      {data.unavailable && <p>{t('native.pruned')}</p>}
      {data.more && (
        <button
          type="button"
          onClick={() => {
            void source.loadMore();
          }}
        >
          {t('routine.more')}
        </button>
      )}
    </section>
  );
}
function NativeEditor({
  record,
  busy,
  error,
  t,
  onClose,
  onSave,
}: {
  record: NativeTask;
  busy: boolean;
  error: string;
  t: T;
  onClose(): void;
  onSave(patch: Parameters<RoutineActions['update']>[1]): Promise<void>;
}) {
  const uid = useId();
  const [title, setTitle] = useState(record.title);
  const [prompt, setPrompt] = useState(record.prompt);
  const [kind, setKind] = useState<ScheduleTimingChange['kind']>(record.kind === 'after' ? 'at' : record.kind);
  const [zone, setZone] = useState('timeZone' in record ? record.timeZone : 'UTC');
  const [at, setAt] = useState(record.scheduledAt);
  const [seconds, setSeconds] = useState(record.kind === 'every' ? record.everySeconds : 3600);
  const [time, setTime] = useState('time' in record ? record.time : '09:00:00');
  const [days, setDays] = useState(record.kind === 'weekly' ? record.weekdays.join(',') : '1,2,3,4,5');
  const [cron, setCron] = useState(record.kind === 'cron' ? record.expression : '0 9 * * 1-5');
  const [timing, setTiming] = useState(false);
  const field = (key: string, label: Parameters<T>[0], child: (id: string) => React.ReactNode) => (
    <div className={styles.field}>
      <label htmlFor={`${uid}-${key}`}>{t(label)}</label>
      {child(`${uid}-${key}`)}
    </div>
  );
  return (
    <Modal title={t('routine.edit')} busy={busy} onClose={onClose} t={t}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          const change: ScheduleTimingChange =
            kind === 'at'
              ? { kind, at }
              : kind === 'every'
                ? { kind, every_seconds: seconds }
                : kind === 'daily'
                  ? { kind, daily: { time, time_zone: zone } }
                  : kind === 'weekly'
                    ? { kind, weekly: { time, time_zone: zone, weekdays: days.split(',').map(Number) } }
                    : { kind, cron: { expression: cron, time_zone: zone } };
          void onSave({ title, prompt, ...(timing ? { change } : {}) });
        }}
      >
        <fieldset disabled={busy}>
          {field('title', 'routine.name', (id) => (
            <input id={id} required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          ))}
          {field('prompt', 'routine.prompt', (id) => (
            <textarea id={id} required rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          ))}
          {field('timing', 'native.editTiming', (id) => (
            <input id={id} type="checkbox" checked={timing} onChange={(e) => setTiming(e.target.checked)} />
          ))}
          {timing && (
            <>
              {field('rule', 'routine.rule', (id) => (
                <select id={id} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  {(['at', 'every', 'daily', 'weekly', 'cron'] as const).map((k) => (
                    <option key={k} value={k}>
                      {t(`routine.kind.${k}`)}
                    </option>
                  ))}
                </select>
              ))}
              {kind === 'at' &&
                field('at', 'routine.at', (id) => (
                  <input id={id} required value={at} onChange={(e) => setAt(e.target.value)} />
                ))}
              {kind === 'every' &&
                field('seconds', 'routine.seconds', (id) => (
                  <input
                    id={id}
                    type="number"
                    min={60}
                    step={1}
                    required
                    value={seconds}
                    onChange={(e) => setSeconds(Number(e.target.value))}
                  />
                ))}
              {['daily', 'weekly', 'cron'].includes(kind) &&
                field('zone', 'routine.timeZone', (id) => (
                  <input id={id} required value={zone} onChange={(e) => setZone(e.target.value)} />
                ))}
              {['daily', 'weekly'].includes(kind) &&
                field('time', 'routine.time', (id) => (
                  <input id={id} required value={time} onChange={(e) => setTime(e.target.value)} />
                ))}
              {kind === 'weekly' &&
                field('days', 'routine.weekdays', (id) => (
                  <input id={id} required value={days} onChange={(e) => setDays(e.target.value)} />
                ))}
              {kind === 'cron' &&
                field('cron', 'routine.cron', (id) => (
                  <input id={id} required value={cron} onChange={(e) => setCron(e.target.value)} />
                ))}
              <p>{t('native.timingHint')}</p>
            </>
          )}
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {t('editor.save')}
        </button>
      </form>
    </Modal>
  );
}
