import { useSettingsDraft } from './SettingsNavigation.js';
import { SegmentedTabs, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { DshBotMemoryRemoteMethods } from '../../shared/remote-contract.js';
import type { MemoryQuery, ManagedMemoryRow, MemoryResolve } from '../../shared/memory-management.js';
import type { SharedMemoryCatalog } from '../shared-memory-state.js';
import { draftQualifiers, memoryDraft, memoryDrafts, type ManagedDraft } from '../memory-drafts.js';
import type { MemoryPanelProps } from './MemoryPanel.js';
import { AutoShareStatus } from './AutoShareStatus.js';
import { SharedMemoryList } from './SharedMemoryList.js';
import { ManagedMemoryEditor } from './ManagedMemoryEditor.js';
import { MemoryConflicts } from './MemoryConflicts.js';
import { ForgetPreview, type ForgetActions } from './ForgetPreview.js';
import { MemoryCleanupStatus } from './MemoryCleanupStatus.js';
import styles from '../styles/bots.module.css';
import memoryStyles from '../styles/memory.module.css';

export interface SharedMemoryBinding { catalog: SharedMemoryCatalog; remote(): DshBotMemoryRemoteMethods; refresh(): Promise<void> }
export function SharedMemoryPanel({ binding, scope, botId, statuses, t }: {
  statuses?: Parameters<typeof MemoryCleanupStatus>[0]['statuses'];
  binding: SharedMemoryBinding; scope: MemoryQuery['scope']; botId: string; t: MemoryPanelProps['t'];
}) {
  const { catalog } = binding, snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
  const uid = useId();
  const drafts = useRef(memoryDrafts()), [draft, setDraft] = useState<ManagedDraft>(), [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [preview, setPreview] = useState<{ row: ManagedMemoryRow; revision: number; scope: MemoryQuery['scope']; botId: string }>();
  const confirming = preview?.botId === botId && preview.scope === scope && preview.revision === snapshot.revision &&
    !snapshot.error && snapshot.loaded ? preview.row : undefined;
  const [forget, setForget] = useState<{ row: ManagedMemoryRow; contribution: boolean }>();
  const [cleanups, setCleanups] = useState<Parameters<typeof MemoryCleanupStatus>[0]['statuses']>([]);
  useSettingsDraft(busy || drafts.current.hasDrafts());
  const [comparison, setComparison] = useState<{ revision: number; content: string }>();
  useEffect(() => { if (statuses) setCleanups(statuses); }, [statuses]);
  const life = useRef(0), active = useRef(false), currentScope = useRef(scope);
  useEffect(() => {
    life.current++; currentScope.current = scope;
    setDraft(drafts.current.get(scope)); setPreview(undefined); setForget(undefined); setError(false);
    active.current = false; setBusy(false);
    catalog.select({ scope, view: scope === 'quarantine' ? 'all' : 'facts', query: '', cursor: undefined, revision: undefined });
    setQuery('');
    return () => { life.current++; };
  }, [catalog, scope]);
  const change = (next?: ManagedDraft) => { drafts.current.put(scope, next); setDraft(next); setComparison(undefined); };
  const perform = async (action: () => Promise<unknown>, done?: () => void) => {
    if (active.current) return;
    const epoch = life.current; active.current = true; setBusy(true); setError(false);
    try {
      await action();
      if (epoch !== life.current) return;
      done?.(); await binding.refresh();
      const result = await binding.remote().cleanupStatuses();
      if (epoch === life.current && result.ok) setCleanups(result.value);
    } catch { if (epoch === life.current) setError(true); }
    finally { if (epoch === life.current) { active.current = false; setBusy(false); } }
  };
  async function save() {
    if (!draft) return;
    await perform(async () => {
      const qualifiers = draftQualifiers(draft.qualifiers), from = draft.from ? Date.parse(draft.from) : null;
      const to = draft.to ? Date.parse(draft.to) : null;
      const patch = { content: draft.content, subject: draft.subject || undefined, factKey: draft.factKey || undefined,
        qualifiers, valid: { from, to, basis: from === null && to === null ? 'unknown' as const : 'explicit' as const } };
      const remote = binding.remote();
      const result = draft.id ? await remote.revise({ id: draft.id, expectedRevision: draft.revision, patch }) :
        await remote.createManaged({ ...patch, kind: draft.kind, botId, scope: scope === 'private' ? 'private' : 'shared',
          expectedRevision: draft.revision });
      if (!result.ok) throw result.error;
    }, () => change());
  }
  const resolve = (input: MemoryResolve) => { void perform(async () => {
    const result = await binding.remote().resolve(input); if (!result.ok) throw result.error;
  }); };
  const forgetting: ForgetActions = {
    async preview(selection) {
      const remote = binding.remote(), result = forget?.contribution ? await remote.previewContribution(selection.memoryId) :
        scope === 'shared' ? await remote.previewShared(selection) : await remote.previewForget(botId, selection);
      if (!result.ok) throw result.error; return result.value;
    },
    async choose(choice) {
      const result = await binding.remote().chooseForget(choice); if (!result.ok) throw result.error;
      setCleanups(old => [...old.filter(r => r.id !== result.value.id), result.value]); await binding.refresh(); return result.value;
    },
    async retry(id) {
      const result = await binding.remote().retryCleanup(id); if (!result.ok) throw result.error;
      setCleanups(old => [...old.filter(r => r.id !== id), result.value]); await binding.refresh();
    },
  };
  return <section aria-label={t('shared.title')} data-shared-memory-panel="">
    <AutoShareStatus binding={binding} t={t} />
    <p className={styles.notice}>{t('shared.manualOnly')}</p>
    <div className={styles.actions}>
      <SegmentedTabs
        label={t('shared.views')}
        value={snapshot.input.view}
        onChange={view => { if (!busy) catalog.select({ view, cursor: undefined, revision: undefined }); }}
        items={(['facts', 'journal', 'candidates', 'conflicts', 'all'] as const).map(view => ({
          value: view,
          label: t(`shared.${view}`),
          id: `${uid}-${view}`,
          panelId: `${uid}-panel`,
        })) as [SegmentedTab<typeof snapshot.input.view>, ...SegmentedTab<typeof snapshot.input.view>[]]}
      />
    </div>
    <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-${snapshot.input.view}`}>
    <form onSubmit={e => { e.preventDefault(); catalog.select({ query, cursor: undefined, revision: undefined }); }}>
      <label>{t('memory.search')}<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <button className={styles.button} type="submit">{t('memory.search')}</button>
      <button className={styles.button} type="button" onClick={() => { void catalog.refresh(); }}>{t('shared.refresh')}</button>
    </form>
    <p>{t('memory.total', { count: snapshot.total })}</p>
    {error && <p role="alert" className={styles.error}>{t('shared.changed')}</p>}
    {snapshot.error && <p role="alert" className={styles.error}>{t('memory.loadError')}</p>}
    {scope !== 'quarantine' && <button type="button" className={styles.primaryButton} disabled={busy || !!draft}
      onClick={() => change(memoryDraft(snapshot.revision))}>{t('memory.add')}</button>}
    {draft && <ManagedMemoryEditor draft={draft} change={change} save={() => { void save(); }} close={() => change()}
      rebase={() => { void perform(async () => {
        await catalog.refresh();
        if (currentScope.current !== scope) return;
        const state = catalog.getSnapshot();
        if (state.error) throw new Error('Cannot compare');
        setComparison({ revision: state.revision,
          content: state.rows.find(row => row.version.memoryId === draft.id)?.payload.content ?? t('shared.unknown') });
      }); }} busy={busy} t={t} />}
    {draft && comparison && <fieldset aria-label={t('shared.compare')}>
      <legend>{t('shared.latestContent')}</legend><p>{comparison.content}</p>
      <button type="button" className={styles.button} onClick={() => change({ ...draft, revision: comparison.revision })}>
        {t('shared.adoptRevision')}</button>
    </fieldset>}
    {preview && !confirming && <p role="status">{t('shared.previewChanged')}</p>}
    {confirming && preview && <fieldset aria-label={t('shared.confirm')} disabled={busy}>
      <legend>{t(scope === 'quarantine' ? 'shared.assign' : 'shared.confirm')}</legend>
      <dl className={memoryStyles.confirmSummary} data-shared-confirm-summary="">
        <div>
          <dt>{t('shared.confirmAction')}</dt>
          <dd>{t(scope === 'quarantine' ? 'shared.assign' : 'shared.confirm')}</dd>
        </div>
        <div>
          <dt>{t('shared.confirmTarget')}</dt>
          <dd>{t(scope === 'quarantine' ? 'shared.scope.legacy' : 'shared.scope.shared')}</dd>
        </div>
        <div>
          <dt>{t('shared.content')}</dt>
          <dd className={memoryStyles.content}>{confirming.payload.content}</dd>
        </div>
        {confirming.payload.subject && (
          <div>
            <dt>{t('shared.subject')}</dt>
            <dd>{confirming.payload.subject}</dd>
          </div>
        )}
        {confirming.payload.factKey && (
          <div>
            <dt>{t('shared.factKey')}</dt>
            <dd>{confirming.payload.factKey}</dd>
          </div>
        )}
        <div>
          <dt>{t('shared.qualifiers')}</dt>
          <dd>
            {Object.keys(confirming.payload.qualifiers ?? {}).length > 0 ? (
              <ul className={memoryStyles.tags}>
                {Object.entries(confirming.payload.qualifiers ?? {}).map(([k, v]) => (
                  <li key={k}>{k}: {v}</li>
                ))}
              </ul>
            ) : (
              t('capabilities.empty')
            )}
          </dd>
        </div>
        <div>
          <dt>{t('shared.valid')}</dt>
          <dd>
            {typeof confirming.payload.valid?.from === 'number'
              ? new Date(confirming.payload.valid.from).toLocaleString(t('activity.locale'))
              : t('shared.unknown')}
            {' → '}
            {typeof confirming.payload.valid?.to === 'number'
              ? new Date(confirming.payload.valid.to).toLocaleString(t('activity.locale'))
              : t('shared.unbounded')}
          </dd>
        </div>
      </dl>
      <p>{t(scope === 'quarantine' ? 'shared.assignNotice' : 'shared.confirmNotice')}</p>
      <button type="button" className={styles.primaryButton} onClick={() => { void perform(async () => {
        const result = await binding.remote().confirm({ id: confirming.version.memoryId, versionId: confirming.version.versionId, expectedRevision: preview.revision,
          scope: preview.scope === 'quarantine' ? 'private' : 'shared', botId: preview.botId });
        if (!result.ok) throw result.error;
      }, () => setPreview(undefined)); }}>{t(scope === 'quarantine' ? 'shared.assign' : 'shared.confirm')}</button>
      <button type="button" className={styles.button} onClick={() => setPreview(undefined)}>{t('actions.cancel')}</button>
    </fieldset>}
    {snapshot.input.view === 'conflicts' && <MemoryConflicts rows={snapshot.rows} revision={snapshot.revision}
      resolve={resolve} busy={busy} t={t} />}
    {forget && <ForgetPreview key={`${forget.row.version.memoryId}:${forget.contribution}`} memoryId={forget.row.version.memoryId}
      actions={forgetting} contribution={forget.contribution} close={() => setForget(undefined)} t={t} />}
    <MemoryCleanupStatus statuses={cleanups} retry={id => perform(() => forgetting.retry(id))} t={t} />
    <SharedMemoryList rows={snapshot.rows} busy={busy} edit={row => change(memoryDraft(snapshot.revision, row))}
      confirm={row => setPreview({ row, revision: snapshot.revision, scope, botId })} forget={row => setForget({ row, contribution: false })}
      contribution={row => setForget({ row, contribution: true })} t={t} />
    {(snapshot.input.cursor || snapshot.next) && <div className={styles.actions}>
      <button type="button" className={styles.button} onClick={() => catalog.select({ cursor: undefined, revision: undefined })}>
        {t('memory.firstPage')}</button>
      <button type="button" className={styles.button} disabled={!snapshot.next || busy} onClick={() => catalog.nextPage()}>
        {t('memory.nextPage')}</button>
    </div>}
    </div>
  </section>;
}
