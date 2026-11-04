import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { Button, IconChevronDownOutlineRegular, IconDatabaseOutlineRegular, IconGaugeOutlineRegular, Menu, Modal, StateDot, type MenuEntry, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives';
import type { GroupDelivery, GroupTurn, GroupView } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import type { ExecutionBridge } from '../group-execution.js';
import { aggregateStatistics, cachePercent, contextPercent, defaultStatisticsTurn, groupStatisticsWorkers, loadingStatistics, readStatisticsOnce, statisticsDeliveries, tokenTotal, type ChildStatistics } from '../group-statistics.js';
import styles from '../styles/groups.module.css';

type Localized = PropsLocale<'dsh-bot'>;
const emptyPreference = { subscribe: () => () => {}, getSnapshot: () => undefined };
export function useStatisticsMode(bridge: ExecutionBridge) {
  const form = useMemo(() => {
    const scope = bridge.ctx.get('configForms')?.get('ui-chat');
    return scope ? { subscribe: (listener: () => void) => scope.subscribe(listener), getSnapshot: () => scope.getSnapshot() } : emptyPreference;
  }, [bridge]);
  const snapshot = useSyncExternalStore(form.subscribe, form.getSnapshot);
  const value = snapshot?.value as { performanceUsage?: string } | undefined;
  return value?.performanceUsage === 'detailed' ? 'detailed' : 'compact';
}
type Worker = { delivery: GroupDelivery; conflict: boolean };
/** No reads for reserved IDs. Reset the visible snapshot synchronously on scope changes. */
function useStatistics(bridge: ExecutionBridge, parentId: string, workers: Worker[]) {
  const signature = JSON.stringify(workers.map(({ delivery, conflict }) =>
    delivery.childSessionId && !conflict && !['pending', 'starting'].includes(delivery.state) ? delivery.childSessionId : null));
  const sources = useMemo(() => (JSON.parse(signature) as Array<string | null>).map(childId =>
    childId ? bridge.statistics?.source(parentId, childId) : undefined), [bridge, parentId, signature]);
  const [state, setState] = useState<{ sources: typeof sources; values: ChildStatistics[] }>();
  useEffect(() => {
    let live = true;
    const refresh = () => { if (live) setState({ sources, values: sources.map(source => source?.getSnapshot() ?? loadingStatistics) }); };
    const off = sources.map(source => source?.subscribe(refresh)); refresh();
    return () => { live = false; for (const dispose of off) dispose?.(); };
  }, [sources]);
  return state?.sources === sources ? state.values : sources.map(() => loadingStatistics);
}
/** Settled sessions read concurrently while the whole-group scope loads. */
const READ_AT_ONCE = 4;
type GroupRow = ReturnType<typeof groupStatisticsWorkers>[number];
/**
 * Whole-group totals, read only while that scope is chosen. Sessions that can still change
 * stay subscribed; settled ones are read a few at a time, released at once, and remembered
 * for this view, so the group never holds every member session open.
 */
function useGroupTotals(bridge: ExecutionBridge, parentId: string, rows: GroupRow[], enabled: boolean) {
  const live = rows.filter(row => row.live);
  const liveValues = useStatistics(bridge, parentId, enabled ? live.map(row => ({ delivery: row.delivery, conflict: false })) : []);
  const settled = useRef(new Map<string, ChildStatistics>());
  const [, setRevision] = useState(0);
  const signature = JSON.stringify(enabled ? rows.filter(row => !row.live).map(row => row.childId) : []);
  useEffect(() => {
    const cache = settled.current, statistics = bridge.statistics;
    // A failed read is retried each time the scope is entered or the settled set changes.
    for (const [id, value] of cache) if (value.state !== 'ready') cache.delete(id);
    const queue = (JSON.parse(signature) as string[]).filter(id => !cache.has(id));
    if (!queue.length || !statistics) return;
    const controller = new AbortController();
    const work = async () => {
      for (let id = queue.shift(); id !== undefined && !controller.signal.aborted; id = queue.shift()) {
        const value = await readStatisticsOnce(statistics.source(parentId, id), controller.signal);
        if (controller.signal.aborted) return;
        cache.set(id, value); setRevision(n => n + 1);
      }
    };
    for (let i = 0; i < Math.min(READ_AT_ONCE, queue.length); i++) void work();
    return () => controller.abort();
  }, [bridge, parentId, signature]);
  if (!enabled) return [];
  return rows.map(row => row.live ? liveValues[live.indexOf(row)] ?? loadingStatistics : settled.current.get(row.childId) ?? loadingStatistics);
}
const number =(value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
/**
 * The native composer's compact token count (517 / 12.2K / 1.2M), spelled by the
 * shared common `number.*` vocabulary so group and native statistics read alike.
 */
export function compactTokens(value: number, t: Localized['t']) {
  const scaled = (n: number) => n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
  if (value < 1e3) return String(value);
  return value < 1e6 ? t('number.thousand', { value: scaled(value / 1e3) }) : t('number.million', { value: scaled(value / 1e6) });
}
/** Native state-dot semantics: ongoing work, user attention, failure, done, or nothing in progress. */
export const TURN_DOT: Record<GroupTurn['state'], StateDotState> = {
  accepted: 'ongoing', running: 'ongoing', idle: 'idle', paused: 'warning', completed: 'done', partial: 'error', cancelled: 'idle', recovery_needed: 'warning',
};
/** First non-empty line with runs of whitespace folded, so a pasted log does not fill a menu row. */
export const questionLine = (text: string) => text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
const clock = (at: number) => {
  const date = new Date(at), today = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
};
const LATEST = '__latest', GROUP = '__group';
type UsageView = Pick<ChildStatistics, 'modelSelection' | 'pressure'> & { usage?: ChildStatistics['usage'] | undefined; activity?: { turns: number; steps: number } | undefined };
/** `aggregate` sums several sessions: no single model or context estimate applies. */
function UsageDetails({ value, aggregate = false, t }: { value: UsageView; aggregate?: boolean } & Localized) {
  const context = aggregate ? undefined : contextPercent(value);
  return <dl className={styles.statisticsDetails}>
    {!aggregate && value.modelSelection?.lastUsed && <><dt>{t('statistics.model')}</dt><dd>{value.modelSelection.lastUsed.provider} / {value.modelSelection.lastUsed.model}</dd></>}
    {value.activity && <><dt>{t('statistics.activity')}</dt><dd>{t('statistics.counts', value.activity)}</dd></>}
    {value.usage && tokenTotal(value.usage) > 0 ? <>
      <dt>{t('statistics.input')}</dt><dd>{number(value.usage.uncachedInputTokens)}</dd>
      <dt>{t('statistics.read')}</dt><dd>{number(value.usage.cacheReadTokens)}</dd>
      <dt>{t('statistics.write')}</dt><dd>{number(value.usage.cacheWriteTokens)}</dd>
      <dt>{t('statistics.output')}</dt><dd>{number(value.usage.outputTokens)}</dd>
    </> : <><dt>{t('statistics.usage')}</dt><dd>{t('statistics.noUsage')}</dd></>}
    {!aggregate && <><dt>{t('statistics.context')}</dt><dd>{context === undefined ? t('statistics.noEstimate') : t('statistics.contextEstimate', { percent: number(context) })}</dd></>}
  </dl>;
}
export function GroupMemberStatistics({ bridge, parentId, workers, t }: { bridge: ExecutionBridge; parentId: string; workers: Worker[] } & Localized) {
  const values = useStatistics(bridge, parentId, workers);
  const sum = aggregateStatistics(values), single = workers.length === 1;
  const value = values[0] ?? loadingStatistics;
  const mode = useStatisticsMode(bridge);
  const [open, setOpen] = useState(false);
  const cache = sum.usage && tokenTotal(sum.usage) > 0 ? cachePercent(sum.usage) : undefined;
  const context = single ? contextPercent(value) : undefined;
  const partial = workers.some((worker, i) => worker.conflict || !worker.delivery.childSessionId || ['pending', 'starting'].includes(worker.delivery.state) || values[i]?.state !== 'ready');
  const status = (worker: Worker, item: ChildStatistics) => worker.conflict ? 'conflict' : !worker.delivery.childSessionId || ['pending', 'starting'].includes(worker.delivery.state) ? 'waiting' : item.state === 'loading' ? 'loading' : item.state === 'unavailable' ? 'unavailable' : undefined;
  const missing = single && workers[0] ? status(workers[0], value) : undefined;
  return <div className={styles.memberStatistics} data-group-member-statistics={workers[0]?.delivery.childSessionId ?? workers[0]?.delivery.id}>
    {missing ? <span>{t(`statistics.${missing}`)}</span> : <>
      {!single && <span>{t('statistics.executions', { count: workers.length })}</span>}
      {mode === 'detailed' && sum.activity && <span>{t('statistics.counts', sum.activity)}</span>}
      {single && value.activity && value.activity.decodeMs > 0 && <span title={t('statistics.speed')}>{number(value.activity.decodeTokens / (value.activity.decodeMs / 1000))} tok/s</span>}
      {sum.usage && tokenTotal(sum.usage) > 0 ? <>
        {mode === 'detailed' && <span>{compactTokens(tokenTotal(sum.usage), t)} tok</span>}
        {cache !== undefined && <span>{t('statistics.cache', { percent: number(cache) })}</span>}
      </> : <span>{t('statistics.noUsage')}</span>}
      {single && <span title={t('statistics.lastEstimate')}>{context === undefined ? t('statistics.noEstimate') : t('statistics.contextEstimate', { percent: number(context) })}</span>}
      {partial && <span>{t('statistics.incomplete')}</span>}
      <button type="button" className={styles.statPill} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{t('statistics.details')}</button>
      {open && <Modal open title={t('statistics.details')} closeLabel={t('actions.close')} description={t('statistics.scope')}
        className={styles.statisticsDialog} contentClassName={styles.statisticsContent} onClose={() => setOpen(false)}
        footer={<Button size="sm" onClick={() => setOpen(false)}>{t('actions.close')}</Button>}>
        {workers.map((worker, i) => <section className={styles.statisticsSection} key={worker.delivery.childSessionId ?? worker.delivery.id}>
          {!single && <h3>{t('statistics.execution', { count: i + 1 })} · {t(`groups.${worker.delivery.state}`)}</h3>}
          {status(worker, values[i] ?? loadingStatistics) ? <p>{t(`statistics.${status(worker, values[i] ?? loadingStatistics) ?? 'unavailable'}`)}</p> : <UsageDetails value={values[i] ?? loadingStatistics} t={t} />}
        </section>)}
      </Modal>}
    </>}
  </div>;
}
export function GroupStatisticsBar({ view, bridge, sent, bots = [], t }: {
  view: GroupView; bridge: ExecutionBridge; bots?: BotRecord[]; sent?: { turnId: string; followup: boolean; sequence: number };
} & Localized) {
  const [selected, setSelected] = useState<string>();
  const [pinned, setPinned] = useState(false), [whole, setWhole] = useState(false), [menu, setMenu] = useState(false), [open, setOpen] = useState(false);
  useEffect(() => { if (selected === undefined) setSelected(defaultStatisticsTurn(view.turns)?.id); }, [selected, view.turns]);
  // Sending a question shows that question, as before; the whole-group scope is left with it.
  useEffect(() => { if (sent) { setSelected(sent.turnId); setPinned(sent.followup); setWhole(false); } }, [sent]);
  const turn = view.turns.find(row => row.id === selected) ?? (selected === undefined ? defaultStatisticsTurn(view.turns) : undefined);
  const workers = turn && !whole ? statisticsDeliveries(view, turn.id) : [];
  const questionValues = useStatistics(bridge, view.group.rootSessionId, workers);
  const groupRows = whole ? groupStatisticsWorkers(view) : [];
  const groupValues = useGroupTotals(bridge, view.group.rootSessionId, groupRows, whole);
  const values = whole ? groupValues : questionValues;
  const mode = useStatisticsMode(bridge), sum = aggregateStatistics(values);
  const cache = sum.usage && tokenTotal(sum.usage) > 0 ? cachePercent(sum.usage) : undefined;
  const members = [...new Set(workers.map(row => row.delivery.memberId))];
  const readable = members.filter(id => workers.every((row, i) => row.delivery.memberId !== id || (!row.conflict && values[i]?.state === 'ready'))).length;
  const expected = new Set([...(turn?.orderedMemberIds ?? []), ...members]).size;
  const sessionsReady = groupValues.filter(value => value.state === 'ready').length;
  const partial = (whole ? sessionsReady < groupRows.length : readable < expected) || values.some(value => !value.activity || !value.usage);
  const coverage = whole ? t('statistics.sessionsReadable', { count: sessionsReady, total: groupRows.length }) : t('statistics.partial', { count: readable, total: expected });
  // Names what the numbers cover, on hover of the activity and usage readings.
  const scope = whole ? t('statistics.groupScopeHint', { questions: view.turns.length, count: sessionsReady, total: groupRows.length })
    : t('statistics.questionScope', { count: readable, total: expected });
  const emptyState = whole ? (!groupRows.length ? 'waiting' : values.some(value => value.state === 'loading') ? 'loading' : !sum.readable ? 'unavailable' : 'noUsage')
    : !workers.length || workers.every(({ delivery }) => !delivery.childSessionId || ['pending', 'starting'].includes(delivery.state)) ? 'waiting'
    : values.some(value => value.state === 'loading') ? 'loading' : !sum.readable ? 'unavailable' : 'noUsage';
  const other = whole ? 0 : view.turns.filter(row => row.id !== turn?.id && ['accepted', 'running', 'paused'].includes(row.state)).length;
  const text = (row: GroupTurn) => view.messages.find(message => message.id === row.inputMessageId)?.text ?? `${t('statistics.historical')} · ${new Date(row.createdAt).toLocaleString()}`;
  const title = (row: GroupTurn) => questionLine(text(row));
  const label = (d: GroupDelivery) => bots.find(bot => bot.id === d.bot.botId && bot.createdAt === d.bot.botCreatedAt)?.name ??
    view.messages.find(message => message.speaker?.bot.botId === d.bot.botId && message.speaker.bot.botCreatedAt === d.bot.botCreatedAt)?.speaker?.name ?? d.bot.botId;
  if (!view.turns.length) return null;
  const recent = [...view.turns].sort((a, b) => b.createdAt - a.createdAt);
  // Rows are built only while the list shows; each carries the native state dot plus time, status and members.
  const questions = (): MenuEntry[] => {
    const names = new Map<string, string[]>();
    for (const delivery of view.deliveries) {
      const name = label(delivery), list = names.get(delivery.turnId) ?? [];
      if (!list.includes(name)) names.set(delivery.turnId, [...list, name]);
    }
    return [{ id: LATEST, label: t('statistics.followLatest') },
      { id: GROUP, label: <span className={styles.questionOption} data-statistics-scope="group">
        <span className={styles.questionTitle}>{t('statistics.wholeGroup')}</span>
        <span className={styles.questionMeta}>{t('statistics.wholeGroupHint', { count: view.turns.length })}</span>
      </span> },
      { type: 'separator', id: 'questions' },
      ...recent.map(row => ({ id: row.id, icon: <StateDot state={TURN_DOT[row.state]} />,
        label: <span className={styles.questionOption} data-statistics-question={row.id}>
          <span className={styles.questionTitle} title={title(row)}>{title(row)}</span>
          <span className={styles.questionMeta}>{[clock(row.createdAt), t(`statistics.status.${row.state}`), (names.get(row.id) ?? []).join(', ')].filter(Boolean).join(' · ')}</span>
        </span> }))];
  };
  const current = whole ? t('statistics.wholeGroup') : turn ? title(turn) : '';
  const shown = !current ? t('statistics.select') : pinned || whole ? current : t('statistics.latestQuestion', { title: current });
  const tokenCount = mode === 'detailed' && sum.usage && tokenTotal(sum.usage) > 0 ? tokenTotal(sum.usage) : undefined;
  // Per-question lines for the whole-group details; a session shared by questions sits under its first one.
  const breakdown = (row: GroupTurn) => {
    const own = groupRows.flatMap((worker, i) => worker.delivery.turnId === row.id ? [groupValues[i] ?? loadingStatistics] : []);
    const total = aggregateStatistics(own), usage = total.usage && tokenTotal(total.usage) > 0 ? total.usage : undefined;
    if (!own.length) return t('statistics.waiting');
    if (own.some(value => value.state === 'loading')) return t('statistics.loading');
    if (!usage) return t(total.readable ? 'statistics.noUsage' : 'statistics.unavailable');
    const hit = cachePercent(usage);
    return [`${compactTokens(tokenTotal(usage), t)} tok`, hit === undefined ? '' : t('statistics.cache', { percent: number(hit) })].filter(Boolean).join(' · ');
  };
  return <div className={styles.statisticsBar} data-group-statistics-bar data-statistics-turn={whole ? undefined : turn?.id} data-statistics-scope={whole ? 'group' : 'question'}>
    {/* Portaled so the panel's bordered-button default never reaches the native rows; it opens upward from the page foot. */}
    <Menu open={menu} onClose={() => setMenu(false)} portal side="top" className={styles.questionAnchor} listClassName={styles.questionMenu}
      selectedId={whole ? GROUP : pinned ? turn?.id : LATEST}
      anchor={<button type="button" className={`${styles.statPill} ${styles.questionTrigger}`} title={current || undefined}
        aria-label={`${t('statistics.select')}: ${shown}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
        <span className={styles.statLabel}>{shown}</span><IconChevronDownOutlineRegular size={12} />
      </button>}
      items={menu ? questions() : []}
      onSelect={id => {
        setMenu(false); setWhole(id === GROUP);
        if (id !== GROUP) { setPinned(id !== LATEST); setSelected(id === LATEST ? recent[0]?.id : id); }
      }} />
    {turn || whole ? <>
      {whole ? <span className={styles.statisticsStatus} data-statistics-status="group"><span className={styles.statLabel}>{t('statistics.questionCount', { count: view.turns.length })}</span></span>
        : turn && <span className={styles.statisticsStatus} data-statistics-status={turn.state}><StateDot state={TURN_DOT[turn.state]} /><span className={styles.statLabel}>{t(`statistics.status.${turn.state}`)}</span></span>}
      {mode === 'detailed' && sum.activity && <span className={`${styles.statItem} ${styles.statisticsWide}`} title={scope}><IconGaugeOutlineRegular /><span className={styles.statLabel}>{t('statistics.counts', sum.activity)}</span></span>}
      {(tokenCount !== undefined || cache !== undefined) && <span className={`${styles.statItem} ${tokenCount === undefined ? styles.statisticsWide : ''}`} data-group-usage="" title={scope}>
        <IconDatabaseOutlineRegular />
        {tokenCount !== undefined && <span data-group-token-total={tokenCount}>{compactTokens(tokenCount, t)} tok</span>}
        {tokenCount !== undefined && cache !== undefined && <span className={`${styles.statSep} ${styles.statisticsWide}`} aria-hidden="true">·</span>}
        {cache !== undefined && <span className={styles.statisticsWide}>{t('statistics.cache', { percent: number(cache) })}</span>}
      </span>}
      {tokenCount === undefined && !sum.reported && <span className={styles.statItem}>{t(`statistics.${emptyState}`)}</span>}
      {partial && <span className={`${styles.statItem} ${styles.statisticsWide}`}>{t('statistics.incomplete')} · {coverage}</span>}
      {other > 0 && <button type="button" className={`${styles.statPill} ${styles.statisticsWide}`} onClick={() => setMenu(true)}>{t('statistics.other', { count: other })}</button>}
      <button type="button" className={styles.statPill} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{t('statistics.details')}</button>
      {open && <Modal open title={t('statistics.details')} closeLabel={t('actions.close')} description={t(whole ? 'statistics.groupScope' : 'statistics.scope')}
        className={styles.statisticsDialog} contentClassName={styles.statisticsContent} onClose={() => setOpen(false)}
        footer={<Button size="sm" onClick={() => setOpen(false)}>{t('actions.close')}</Button>}>
        {whole ? <>
          <p className={styles.statisticsQuestion}>{t('statistics.wholeGroup')} · {t('statistics.questionCount', { count: view.turns.length })}</p><p className={styles.statisticsCoverage}>{coverage}</p>
          <section className={styles.statisticsSection}><UsageDetails value={{ usage: sum.usage, activity: sum.activity }} aggregate t={t} /></section>
          <section className={styles.statisticsSection} data-statistics-breakdown=""><h3>{t('statistics.byQuestion')}</h3>
            <dl className={`${styles.statisticsDetails} ${styles.statisticsBreakdown}`}>{recent.map(row => <div key={row.id} data-statistics-breakdown-row={row.id}><dt>{title(row)}</dt><dd>{breakdown(row)}</dd></div>)}</dl>
          </section>
        </> : turn && <>
          <p className={styles.statisticsQuestion}>{text(turn)}</p><p className={styles.statisticsCoverage}>{coverage}</p>
          {workers.map((worker, i) => <section className={styles.statisticsSection} key={worker.delivery.childSessionId ?? worker.delivery.id}><h3>{label(worker.delivery)} · {t(`groups.${worker.delivery.state}`)}</h3>
            {worker.conflict ? <p>{t('statistics.conflict')}</p> : values[i]?.state === 'ready' ? <UsageDetails value={values[i] ?? loadingStatistics} t={t} /> : <p>{t(`statistics.${values[i]?.state === 'unavailable' ? 'unavailable' : 'loading'}`)}</p>}
          </section>)}
        </>}
      </Modal>}
    </> : <span>{t('statistics.unavailable')}</span>}
  </div>;
}
