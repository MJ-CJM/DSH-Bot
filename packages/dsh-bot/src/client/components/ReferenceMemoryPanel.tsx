import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { useSettingsDraft } from './SettingsNavigation.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceActions } from '../workspace-state.js';
import type { BotRecord } from '../../shared/schema.js';
import type { z } from 'zod';
const unwrap = <T,>(r: RemoteResult<T>): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
type Locale = PropsLocale<'dsh-bot'>;
import type { graphSchema } from '../../shared/reference-memory.js';
import { CopyView } from './MemoryCopySteps.js';
import { GraphTools } from './GraphTools.js';
import { formatDateTime } from '../format.js';
const inactiveSubscription = () => () => {};
export function GraphPanel({
  bot,
  actions,
  active = true,
  t,
}: { bot: BotRecord; actions: WorkspaceActions; active?: boolean } & Locale) {
  const [catalog, setCatalog] = useState<ReturnType<WorkspaceActions['createGraph']>>();
  useEffect(() => {
    const c = actions.createGraph({
      botId: bot.id,
      botCreatedAt: bot.createdAt,
    });
    setCatalog(c);
    return c.dispose;
  }, [actions, bot.id, bot.createdAt]);
  return catalog ? (
    <GraphView active={active} bot={bot} actions={actions} catalog={catalog} t={t} />
  ) : (
    <p role="status">{t('memory.loading')}</p>
  );
}
function GraphView({
  active,
  bot,
  actions,
  catalog,
  t,
}: {
  active: boolean;
  bot: BotRecord;
  actions: WorkspaceActions;
  catalog: ReturnType<WorkspaceActions['createGraph']>;
} & Locale) {
  const snapshot = useSyncExternalStore(
      active ? catalog.subscribe : inactiveSubscription,
      catalog.getSnapshot,
      catalog.getSnapshot,
    ),
    status = snapshot.status;
  const [graph, setGraph] = useState<z.output<typeof graphSchema>>();
  const [copyId, setCopyId] = useState<string>(),
    [name, setName] = useState(''),
    [observation, setObservation] = useState(''),
    [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const [savedInput, setSavedInput] = useState(JSON.stringify(['', '']));
  useSettingsDraft(busy || JSON.stringify([name, observation]) !== savedInput);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const perform = async (input: Parameters<WorkspaceActions['graph']>[0]) => {
    if (busy && input.action !== 'cancel') return;
    setBusy(true);
    setError(false);
    try {
      const r = unwrap(await actions.graph(input));
      if (!alive.current) return;
      if (input.action === 'tool' && ['create_entities', 'add_observations'].includes(input.call.tool)) setSavedInput(JSON.stringify([name, observation]));
      if (r.graph) setGraph(r.graph);
      if (r.copy) setCopyId(r.copy.id);
      await catalog.refresh();
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const key = { botId: bot.id, botCreatedAt: bot.createdAt },
    current = status?.copies.find((c) => c.id === copyId);
  return (
    <section aria-label={t('manage.graph')}>
      <p>{t('graph.coexist')}</p>
      <p role="status">
        {status ? t(`graph.${status.state}`) : t('manage.unknown')}
        {status?.reason ? ` · ${t(`graph.reason-${status.reason}`)}` : ''}
      </p>
      <details><summary>{t('settings.diagnostics')}</summary>
      <p>{t('graph.mainOnly')}</p>
      <p>{t('graph.copyHint')}</p>
      <p>
        {t('graph.version')} 2026.7.4 · {t('graph.scope')}
      </p>
      <p>
        {t('graph.writer')}: {status ? t(status.writer ? 'graph.yes' : 'graph.no') : t('manage.unknown')}
      </p>
      {status?.binding && (
        <p>
          {t('graph.file')}: {status.binding.fileIdentity}.jsonl · v{status.binding.revision}
        </p>
      )}
      </details>
      <Button
        type="button"
        disabled={busy || !snapshot.loaded}
        onClick={() => {
          void perform({
            action: 'configure',
            bot: key,
            mode: status?.binding?.mode === 'internal+reference-graph' ? 'internal' : 'internal+reference-graph',
            expectedRevision: status?.binding?.revision ?? 0,
          });
        }}
      >
        {t(status?.binding?.mode === 'internal+reference-graph' ? 'graph.disable' : 'graph.enable')}
      </Button>
      <Button
        type="button"
        disabled={busy || status?.binding?.mode !== 'internal+reference-graph'}
        onClick={() => {
          void perform({ action: 'apply', bot: key });
        }}
      >
        {t('graph.apply')}
      </Button>
      <Button
        type="button"
        disabled={busy || status?.state !== 'ready'}
        onClick={() => {
          void perform({
            action: 'tool',
            bot: key,
            call: { tool: 'read_graph', arguments: {} },
          });
        }}
      >
        {t('graph.read')}
      </Button>
      <label>
        {t('graph.query')}
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <Button
        type="button"
        disabled={busy || status?.state !== 'ready'}
        onClick={() => {
          void perform({
            action: 'tool',
            bot: key,
            call: { tool: 'search_nodes', arguments: { query } },
          });
        }}
      >
        {t('memory.search')}
      </Button>
      <details><summary>{t('graph.add')}</summary>
      <fieldset disabled={busy || status?.state !== 'ready'}>
        <legend>{t('graph.add')}</legend>
        <label>
          {t('graph.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t('graph.observation')}
          <textarea value={observation} onChange={(e) => setObservation(e.target.value)} />
        </label>
        <Button
          type="button"
          disabled={!name || !observation}
          onClick={() => {
            void perform({
              action: 'tool',
              bot: key,
              call: {
                tool: 'create_entities',
                arguments: {
                  entities: [{ name, entityType: 'note', observations: [observation] }],
                },
              },
            });
          }}
        >
          {t('graph.add')}
        </Button>
      </fieldset></details>
      {graph && (
        <ul>
          {graph.entities.map((entity) => (
            <li key={entity.name}>
              <h4>{entity.name}</h4>
              <p>{entity.entityType === 'dsh-bot-memory-v1' ? t('graph.imported') : t('graph.natural')}</p>
              <p>{entity.observations.join('\n')}</p>
            </li>
          ))}
        </ul>
      )}
      <GraphTools
        graph={graph}
        status={status}
        busy={busy}
        perform={perform}
        name={name}
        observation={observation}
        botKey={key}
        t={t}
      />
      <h3>{t('graph.copy')}</h3>
      <Button
        type="button"
        disabled={busy}
        onClick={() => {
          void perform({ action: 'preview', bot: key });
        }}
      >
        {t('manage.preview')}
      </Button>
      {busy && copyId && (
        <Button
          type="button"
          onClick={() => {
            void perform({
              action: 'cancel',
              bot: key,
              copyId,
              confirmed: true,
            });
          }}
        >
          {t('actions.cancel')}
        </Button>
      )}
      <ul>
        {status?.copies.map((c) => (
          <li key={c.id}>
            <Button type="button" onClick={() => setCopyId(c.id)}>
              {t(`graph.phase-${c.phase}`)} · {formatDateTime(c.startedAt, t('activity.locale'))} · {c.records.length}
            </Button>
          </li>
        ))}
      </ul>
      {current && (
        <CopyView
          copy={current}
          status={status}
          busy={busy}
          stage={() => {
            void perform({ action: 'stage', bot: key, copyId: current.id });
          }}
          commit={() => {
            void perform({
              action: 'commit',
              bot: key,
              copyId: current.id,
              confirmed: true,
            });
          }}
          rollback={() => {
            void perform({
              action: 'rollback',
              bot: key,
              copyId: current.id,
              confirmed: true,
            });
          }}
          t={t}
        />
      )}
      {(error || snapshot.error) && <p role="alert">{t('graph.failed')}</p>}
    </section>
  );
}
