import { TransferPreview } from './TransferPreview.js';
import { useEffect, useRef, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceActions } from '../workspace-state.js';
import type { BotRecord } from '../../shared/schema.js';
const unwrap = <T,>(r: RemoteResult<T>): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
type Locale = PropsLocale<'dsh-bot'>;
import { botExportSchema, type BotExport } from '../../shared/workspace.js';
export function TransferPanel({ bot, actions, t }: { bot?: BotRecord; actions: WorkspaceActions } & Locale) {
  const [scope, setScope] = useState<'bot' | 'memories'>('bot');
  const [document, setDocument] = useState(''),
    [newId, setNewId] = useState(''),
    [skills, setSkills] = useState(false),
    [memories, setMemories] = useState(false);
  const [preview, setPreview] =
    useState<Extract<Awaited<ReturnType<WorkspaceActions['workspace']>>, { ok: true }>['value']>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const perform = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await fn();
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const review = preview?.kind === 'preview' ? preview.preview : undefined;
  const invalidate = () => setPreview(undefined);
  return (
    <div>
      <p>{t('manage.portableHint')}</p>
      <p>{t('manage.textSkills')}</p>
      {bot && (
        <fieldset disabled={busy}>
          <legend>{t('manage.export')}</legend>
          <label>
            <input type="checkbox" checked={skills} onChange={(e) => setSkills(e.target.checked)} />
            {t('manage.includeSkills')}
          </label>
          <label>
            <input type="checkbox" checked={memories} onChange={(e) => setMemories(e.target.checked)} />
            {t('manage.includeMemories')}
          </label>
          <button
            type="button"
            onClick={() => {
              void perform(async () => {
                const r = unwrap(
                  await actions.workspace({
                    action: 'export',
                    bot: { botId: bot.id, botCreatedAt: bot.createdAt },
                    includeSkills: skills,
                    includeMemories: memories,
                  }),
                );
                if (alive.current && r.kind === 'export') {
                  setDocument(JSON.stringify(r.document, null, 2));
                  invalidate();
                }
              });
            }}
          >
            {t('manage.export')}
          </button>
          <button
            type="button"
            disabled={!document || !botExportSchema.safeParse(safeJson(document)).success}
            onClick={() => {
              const url = URL.createObjectURL(new Blob([document], { type: 'application/json' }));
              const link = window.document.createElement('a');
              link.href = url;
              link.download = `dsh-bot-${bot.id}.json`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            {t('manage.download')}
          </button>
        </fieldset>
      )}
      <label>
        {t('manage.document')}
        <textarea
          rows={12}
          value={document}
          onChange={(e) => {
            setDocument(e.target.value);
            invalidate();
          }}
        />
      </label>
      <label>
        {t('manage.importScope')}
        <select
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as typeof scope);
            invalidate();
          }}
        >
          <option value="bot">{t('manage.asBot')}</option>
          <option value="memories" disabled={!bot}>
            {t('manage.asMemories')}
          </option>
        </select>
      </label>
      {scope === 'bot' && (
        <label>
          {t('manage.newId')}
          <input
            value={newId}
            onChange={(e) => {
              setNewId(e.target.value);
              invalidate();
            }}
          />
        </label>
      )}
      <button
        type="button"
        disabled={busy || !document || (scope === 'bot' && !newId)}
        onClick={() => {
          void perform(async () => {
            const parsed: BotExport = botExportSchema.parse(safeJson(document));
            const r = unwrap(
              await actions.workspace(
                scope === 'memories' && bot
                  ? {
                      action: 'previewMemories',
                      bot: { botId: bot.id, botCreatedAt: bot.createdAt },
                      document: parsed,
                    }
                  : { action: 'preview', newId, document: parsed },
              ),
            );
            if (alive.current) setPreview(r);
          });
        }}
      >
        {t('manage.preview')}
      </button>
      {review && (
        <TransferPreview
          review={review}
          busy={busy}
          t={t}
          confirm={() => {
            void perform(async () => {
              try {
                const r = unwrap(
                  await actions.workspace({
                    action: 'import',
                    previewId: review.id,
                    confirmed: true,
                  }),
                );
                if (alive.current) setPreview(r);
              } catch (error) {
                const r = unwrap(
                  await actions.workspace({
                    action: 'inspect',
                    previewId: review.id,
                  }),
                );
                if (alive.current) setPreview(r);
                throw error;
              }
            });
          }}
        />
      )}
      {error && <p role="alert">{t('manage.failed')}</p>}
    </div>
  );
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
