import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GROUP_RECALL_QUERY_MAX, type GroupRecallItem, type GroupRecallPage } from '../../shared/group-recall.js';
import type { BotRecord } from '../../shared/schema.js';
import type { GroupRecallBinding } from '../group-recall.js';
import styles from '../styles/bots.module.css';
import panel from '../styles/memory.module.css';

type Locale = PropsLocale<'dsh-bot'>;
type Action = 'open' | 'remember';
const PAGE_SIZE = 3;

export function GroupRecallPanel({ bot, binding, t }: { bot: BotRecord; binding: GroupRecallBinding } & Locale) {
  return <section className={panel.recall} aria-label={t('groupRecall.title')}>
    <h3>{t('groupRecall.title')}</h3>
    {bot.memory.enabled
      ? <GroupRecallResults key={`${bot.id}:${bot.createdAt}`} bot={bot} binding={binding} t={t} />
      : <p className={styles.hint}>{t('groupRecall.disabled')}</p>}
  </section>;
}

function GroupRecallResults({ bot, binding, t }: { bot: BotRecord; binding: GroupRecallBinding } & Locale) {
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState<GroupRecallPage>();
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [actionError, setActionError] = useState<Action>();
  const active = useRef<AbortController | undefined>(undefined);
  const { id, createdAt } = bot;

  const load = useCallback(async (query: string, cursor?: string) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setFailed(false);
    setActionError(undefined);
    if (!cursor) {
      setSubmitted(query);
      setPage(undefined);
    }
    try {
      const next = await binding.read({ id, createdAt }, { limit: PAGE_SIZE, ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) });
      if (controller.signal.aborted) return;
      setPage(previous => cursor && previous && !next.unavailable ? {
        ...next, items: [...previous.items, ...next.items], incomplete: previous.incomplete || next.incomplete,
      } : next);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) {
        active.current = undefined;
        setBusy(false);
      }
    }
  }, [binding, id, createdAt]);

  useEffect(() => {
    void load('');
    return () => active.current?.abort();
  }, [load]);

  const actOn = async (action: Action, item: GroupRecallItem) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setActionError(undefined);
    try {
      await binding[action](bot, item, controller.signal);
    } catch {
      if (!controller.signal.aborted) setActionError(action);
    } finally {
      if (!controller.signal.aborted) {
        active.current = undefined;
        setBusy(false);
      }
    }
  };

  return <>
    <p className={styles.hint}>{t('groupRecall.description')}</p>
    <form className={panel.search} onSubmit={event => {
      event.preventDefault();
      if (!active.current) void load(search.trim());
    }}>
      <div className={panel.searchGroup}>
        <label className={styles.field}>{t('groupRecall.search')}
          <input type="search" maxLength={GROUP_RECALL_QUERY_MAX} value={search} onChange={event => setSearch(event.target.value)} />
        </label>
        <button className={styles.button} type="submit" disabled={busy}>{t('memory.searchAction')}</button>
      </div>
    </form>
    {busy && <p className={styles.hint} role="status">{t('groupRecall.loading')}</p>}
    {failed && <div className={styles.actions}>
      <p className={styles.error} role="alert">{t('groupRecall.loadFailed')}</p>
      <button className={styles.button} type="button" disabled={busy}
        onClick={() => void load(submitted, page?.nextCursor)}>{t('actions.retry')}</button>
    </div>}
    {actionError && <p className={styles.error} role="alert">{t(`groupRecall.${actionError}Failed`)}</p>}
    {page?.unavailable ? <p className={styles.hint} role="status">{t('groupRecall.unavailable')}</p>
      : page?.incomplete && <p className={styles.hint} role="status">{t('groupRecall.incomplete')}</p>}
    {page && !page.items.length && !page.incomplete && !page.unavailable && !failed && <p className={styles.hint}>
      {t(submitted ? 'groupRecall.noMatches' : 'groupRecall.empty')}
    </p>}
    {page && page.items.length > 0 && <ul className={panel.list}>
      {page.items.map(item => <GroupRecallRow key={JSON.stringify([item.group, item.turnId, item.deliveryId])}
        item={item} busy={busy} actOn={actOn} t={t} />)}
    </ul>}
    {page?.nextCursor && !failed && <div className={styles.actions}>
      <button className={styles.button} type="button" disabled={busy}
        onClick={() => void load(submitted, page.nextCursor)}>{t('groupRecall.more')}</button>
    </div>}
  </>;
}

function GroupRecallRow({ item, busy, actOn, t }: {
  item: GroupRecallItem; busy: boolean; actOn(action: Action, item: GroupRecallItem): Promise<void>;
} & Locale) {
  const question = item.sources.find(source => source.role === 'question');
  const answer = item.sources.find(source => source.role === 'answer');
  const date = new Date(item.at);
  const validDate = Number.isFinite(date.getTime());
  return <li className={panel.record}>
    <div className={panel.metadata}>
      <strong>{item.groupName}</strong>
      <span>{t('groupRecall.executionStatus', { state: t(`groups.${item.state}`) })}</span>
      <time dateTime={validDate ? date.toISOString() : undefined}>{validDate ? date.toLocaleString(t('activity.locale')) : t('memory.timeUnavailable')}</time>
    </div>
    {question && <p className={panel.recallPreview}>{question.text}</p>}
    {item.sources.length > 0 && <details>
      <summary>{t('groupRecall.excerpts')}</summary>
      {item.sources.map(source => <div className={panel.recallExcerpt} key={JSON.stringify([source.sessionId, source.messageId, source.role])}>
        <p className={panel.metadata}>{t(`groupRecall.source.${source.role}`)}</p>
        <p className={panel.content}>{source.text}</p>
      </div>)}
    </details>}
    {item.sources.length === 0 && <p className={styles.hint}>{t('groupRecall.unavailable')}</p>}
    {item.sources.length > 0 && <div className={styles.actions}>
      <button className={styles.button} type="button" disabled={busy} onClick={() => void actOn('open', item)}>{t('groupRecall.open')}</button>
      {answer && <button className={styles.button} type="button" disabled={busy} onClick={() => void actOn('remember', item)}>{t('groupRecall.remember')}</button>}
    </div>}
  </li>;
}
