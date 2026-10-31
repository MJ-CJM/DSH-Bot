import { useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { WorkspaceActions } from '../workspace-state.js';
import type { z } from 'zod';
type Locale = PropsLocale<'dsh-bot'>;
import type { GraphStatus, graphSchema } from '../../shared/reference-memory.js';
export function GraphTools({
  graph,
  status,
  busy,
  perform,
  name,
  observation,
  botKey: key,
  t,
}: Locale & {
  graph?: z.output<typeof graphSchema>;
  status?: GraphStatus;
  busy: boolean;
  perform(input: Parameters<WorkspaceActions['graph']>[0]): Promise<void>;
  name: string;
  observation: string;
  botKey: { botId: string; botCreatedAt: number };
}) {
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [relationType, setRelationType] = useState('');
  const [confirmTool, setConfirmTool] = useState<string>();
  return (
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
  );
}
