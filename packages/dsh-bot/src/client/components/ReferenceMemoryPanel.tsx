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
import type { GraphStatus, CopyReceipt, graphSchema } from '../../shared/reference-memory.js';
export function GraphPanel({ bot, actions, t }: { bot: BotRecord; actions: WorkspaceActions } & Locale) {
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
    <GraphView bot={bot} actions={actions} catalog={catalog} t={t} />
  ) : (
    <p role="status">{t('memory.loading')}</p>
  );
}
function GraphView({
  bot,
  actions,
  catalog,
  t,
}: {
  bot: BotRecord;
  actions: WorkspaceActions;
  catalog: ReturnType<WorkspaceActions['createGraph']>;
} & Locale) {
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot),
    status = snapshot.status;
  const [graph, setGraph] = useState<z.output<typeof graphSchema>>();
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [relationType, setRelationType] = useState('');
  const [confirmTool, setConfirmTool] = useState<string>();
  const [copyId, setCopyId] = useState<string>(),
    [name, setName] = useState(''),
    [observation, setObservation] = useState(''),
    [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
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
      <p>{t('graph.mainOnly')}</p>
      <p>{t('graph.copyHint')}</p>
      <p>
        {t('graph.version')} 2026.7.4 · {t('graph.scope')}
      </p>
      <p role="status">
        {status ? t(`graph.${status.state}`) : t('manage.unknown')}
        {status?.reason ? ` · ${t(`graph.reason-${status.reason}`)}` : ''}
      </p>
      <p>
        {t('graph.writer')}: {status ? t(status.writer ? 'graph.yes' : 'graph.no') : t('manage.unknown')}
      </p>
      {status?.binding && (
        <p>
          {t('graph.file')}: {status.binding.fileIdentity}.jsonl · v{status.binding.revision}
        </p>
      )}
      <button
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
      </button>
      <button
        type="button"
        disabled={busy || status?.binding?.mode !== 'internal+reference-graph'}
        onClick={() => {
          void perform({ action: 'apply', bot: key });
        }}
      >
        {t('graph.apply')}
      </button>
      <button
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
      </button>
      <label>
        {t('graph.query')}
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <button
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
      </button>
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
        <button
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
        </button>
      </fieldset>
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
      <details>
        <summary>{t('graph.advanced')}</summary>
        <p>{t('graph.advancedHint')}</p>
        <label>
          {t('graph.from')}
          <input
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setConfirmTool(undefined);
            }}
          />
        </label>
        <label>
          {t('graph.to')}
          <input
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setConfirmTool(undefined);
            }}
          />
        </label>
        <label>
          {t('graph.relation')}
          <input
            value={relationType}
            onChange={(e) => {
              setRelationType(e.target.value);
              setConfirmTool(undefined);
            }}
          />
        </label>
        <button
          type="button"
          disabled={busy || status?.state !== 'ready' || !from || !to || !relationType}
          onClick={() => {
            void perform({
              action: 'tool',
              bot: key,
              call: {
                tool: 'create_relations',
                arguments: { relations: [{ from, to, relationType }] },
              },
            });
          }}
        >
          {t('graph.addRelation')}
        </button>
        <ul>
          {graph?.relations.map((r) => (
            <li key={JSON.stringify([r.from, r.to, r.relationType])}>
              {r.from} → {r.to} · {r.relationType}
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={
            busy ||
            status?.state !== 'ready' ||
            !name ||
            !observation ||
            graph?.entities.find((e) => e.name === name)?.entityType === 'dsh-bot-memory-v1'
          }
          onClick={() => {
            void perform({
              action: 'tool',
              bot: key,
              call: {
                tool: 'add_observations',
                arguments: {
                  observations: [{ entityName: name, observations: [observation] }],
                },
              },
            });
          }}
        >
          {t('graph.appendObservation')}
        </button>
        <label>
          <input
            type="checkbox"
            checked={confirmTool === JSON.stringify([name, observation, from, to, relationType])}
            onChange={(e) =>
              setConfirmTool(e.target.checked ? JSON.stringify([name, observation, from, to, relationType]) : undefined)
            }
          />
          {t('graph.confirmTool')}
        </label>
        <button
          type="button"
          disabled={
            busy ||
            status?.state !== 'ready' ||
            !name ||
            confirmTool !== JSON.stringify([name, observation, from, to, relationType])
          }
          onClick={() => {
            void perform({
              action: 'tool',
              bot: key,
              call: {
                tool: 'delete_entities',
                arguments: { entityNames: [name] },
              },
            });
          }}
        >
          {t('graph.deleteEntity')}
        </button>
        <button
          type="button"
          disabled={
            busy ||
            status?.state !== 'ready' ||
            !from ||
            !to ||
            !relationType ||
            confirmTool !== JSON.stringify([name, observation, from, to, relationType])
          }
          onClick={() => {
            void perform({
              action: 'tool',
              bot: key,
              call: {
                tool: 'delete_relations',
                arguments: { relations: [{ from, to, relationType }] },
              },
            });
          }}
        >
          {t('graph.deleteRelation')}
        </button>
      </details>
      <h3>{t('graph.copy')}</h3>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void perform({ action: 'preview', bot: key });
        }}
      >
        {t('manage.preview')}
      </button>
      {busy && copyId && (
        <button
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
        </button>
      )}
      <ul>
        {status?.copies.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => setCopyId(c.id)}>
              {t(`graph.phase-${c.phase}`)} · {new Date(c.startedAt).toLocaleString()} · {c.records.length}
            </button>
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
function CopyView({
  copy,
  status,
  busy,
  stage,
  commit,
  rollback,
  t,
}: {
  copy: CopyReceipt;
  status?: GraphStatus;
  busy: boolean;
  stage(): void;
  commit(): void;
  rollback(): void;
} & Locale) {
  return (
    <section aria-label={t('graph.copy')}>
      <p>{t(`graph.phase-${copy.phase}`)}</p>
      <p>
        {t('graph.file')}: {copy.targetFileIdentity}.jsonl
      </p>
      <p>
        {t('graph.verifiedCount', {
          count: copy.records.filter((r) => r.status === 'verified').length,
          total: copy.records.length,
        })}
      </p>
      <ul>
        {copy.records.map((r) => (
          <li key={r.memoryId}>
            {r.memoryId} · {t(`graph.record-${r.status}`)}
          </li>
        ))}
      </ul>
      <button type="button" disabled={busy || !['preview', 'staging', 'failed'].includes(copy.phase)} onClick={stage}>
        {t('graph.stage')}
      </button>
      <button type="button" disabled={busy || copy.phase !== 'verified'} onClick={commit}>
        {t('graph.commit')}
      </button>
      <button
        type="button"
        disabled={
          busy || copy.phase === 'rolled-back' || (copy.phase === 'committed' && status?.binding?.importId !== copy.id)
        }
        onClick={rollback}
      >
        {t('graph.rollback')}
      </button>
    </section>
  );
}
