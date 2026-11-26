import { Button, Checkbox, SegmentedTabs, JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives';
import { useSettingsDraft } from './SettingsNavigation.js';
import { TransferPreview } from './TransferPreview.js';
import { useEffect, useId, useRef, useState } from 'react';
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
  const uid = useId();
  const [section, setSection] = useState<'export' | 'import'>(bot ? 'export' : 'import');
  const [exportDocument, setExportDocument] = useState('');
  const fileEpoch = useRef(0);
  const [scope, setScope] = useState<'bot' | 'memories'>('bot');
  const [document, setDocument] = useState(''),
    [newId, setNewId] = useState(''),
    [skills, setSkills] = useState(false),
    [memories, setMemories] = useState(false);
  const [preview, setPreview] =
    useState<Extract<Awaited<ReturnType<WorkspaceActions['workspace']>>, { ok: true }>['value']>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const [acceptedDraft, setAcceptedDraft] = useState(JSON.stringify(['', '']));
  useSettingsDraft(busy || JSON.stringify([document, newId]) !== acceptedDraft);
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
  const invalidate = () => {
    setPreview(undefined);
    setError(false);
  };
  return (
    <div>
      <p>{t('manage.portableHint')}</p>
      <SegmentedTabs label={t('manage.transfer')} value={section} onChange={next => { setSection(next); setError(false); }} items={[{ value: 'export', id: `${uid}-export`, panelId: `${uid}-export-panel`, label: t('manage.export') }, { value: 'import', id: `${uid}-import`, panelId: `${uid}-import-panel`, label: t('manage.import') }]} />
      <section role="tabpanel" id={`${uid}-export-panel`} aria-labelledby={`${uid}-export`} hidden={section !== 'export'} aria-label={t('manage.export')}>
      <p>{t('manage.textSkills')}</p>
      {bot && (
        <fieldset disabled={busy}>
          <legend>{t('manage.export')}</legend>
          <Checkbox checked={skills} onChange={next => { setSkills(next); setError(false); }} label={t('manage.includeSkills')} />
          <Checkbox checked={memories} onChange={next => { setMemories(next); setError(false); }} label={t('manage.includeMemories')} />
          <Button
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
                  const text = JSON.stringify(r.document, null, 2);
                  setExportDocument(text);
                }
              });
            }}
          >
            {t('manage.export')}
          </Button>
          <Button
            type="button"
            disabled={!exportDocument}
            onClick={() => {
              const url = URL.createObjectURL(new Blob([exportDocument], { type: 'application/json' }));
              const link = window.document.createElement('a');
              link.href = url;
              link.download = `dsh-bot-${bot.id}.json`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            {t('manage.download')}
          </Button>
        </fieldset>
      )}
      {exportDocument && <JsonBlock label={t('manage.exportJson')} payload={safeJson(exportDocument)} truncatedLabel={count => t('manage.jsonTruncated', { count })} />}
      </section>
      <section role="tabpanel" id={`${uid}-import-panel`} aria-labelledby={`${uid}-import`} hidden={section !== 'import'} aria-label={t('manage.import')}>
      <label>{t('manage.chooseFile')}<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0], epoch = ++fileEpoch.current;
        if (!file) return;
        setError(false);
        if (file.size > 1024 * 1024) { setError(true); return; }
        void file.text().then(text => { if (alive.current && epoch === fileEpoch.current) { setDocument(text); invalidate(); } }, () => { if (alive.current && epoch === fileEpoch.current) setError(true); });
        event.currentTarget.value = '';
      }} /></label>
      <label>
        {t('manage.document')}
        <textarea
          rows={12}
          value={document}
          onChange={(e) => {
            fileEpoch.current++; setDocument(e.target.value);
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
      <Button
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
      </Button>
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
                if (alive.current) { setPreview(r); setAcceptedDraft(JSON.stringify([document, newId])); }
                await Promise.allSettled([actions.refreshBots?.()]);
              } catch (error) {
                const r = unwrap(
                  await actions.workspace({
                    action: 'inspect',
                    previewId: review.id,
                  }),
                );
                if (alive.current) setPreview(r);
                if (r.kind === 'preview' && r.preview.phase === 'committed') {
                  await Promise.allSettled([actions.refreshBots?.()]);
                }
                throw error;
              }
            });
          }}
        />
      )}
      </section>
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
