import { CapabilitiesPanel } from '../components/CapabilitiesPanel.js';
import { MessageOverviewPanel } from '../components/MessageOverview.js';
import { BackgroundTasksPanel } from '../components/BackgroundTasksPanel.js';
import { RoutinePanel } from '../components/RoutinePanel.js';
import { BotAvatar } from '../components/BotAvatar.js';
import styles from '../styles/bots.module.css';
import type { BotsPageProps } from './bots-page-types.js';
import type { BotsPageModel } from './use-bots-page.js';
import { BotSessionHistory } from './BotSessionHistory.js';
import { Modal } from '../components/Modal.js';
import { useState } from 'react';
export function BotsTab({ page, model }: { page: BotsPageProps; model: BotsPageModel }) {
  const [panel, setPanel] = useState<'work' | 'settings' | 'history'>();
  const { t } = page;
  const text = (key: string) => t(key as Parameters<typeof t>[0]);
  const { selected, showDetail, tab, busy, open } = model;
  if (tab !== 'bots' || !showDetail || !selected || model.dialog) return null;
  return <Modal title={selected.bot.name} busy={busy} onClose={() => { model.setShowDetail(false); setPanel(undefined); }} t={t}>
    <article className={styles.editorBody} data-bot-detail={selected.bot.id}>
      <header className={styles.detailHeader}>
        <button className={styles.button} type="button" onClick={() => open({ kind: 'edit', bot: selected.bot })}>
          <BotAvatar bot={selected.bot} size={48} /> {selected.bot.name}
        </button>
        {selected.bot.description && <p>{selected.bot.description}</p>}
        {selected.status?.preset.state !== 'ok' && <p role="status">{t(selected.status?.preset.state === 'broken' ? 'card.statusBroken' : selected.status?.preset.state === 'missing' ? 'card.statusMissing' : 'card.statusUnknown')} {selected.status?.preset.reason}</p>}
        <div className={styles.detailActions}>
          <button type="button" className={styles.primaryButton} disabled={busy || model.navigating || !model.ready} onClick={() => { void model.navigate(signal => page.onStart(selected.bot.id, signal), 'errors.start'); }}>{text('chat.openChat')}</button>
          <button type="button" className={styles.button} onClick={() => open({ kind: 'edit', bot: selected.bot })}>{t('card.edit')}</button>
          <button type="button" className={styles.button} onClick={() => setPanel(panel === 'work' ? undefined : 'work')}>{text('chat.workFiles')}</button>
          <details><summary>{t('card.more')}</summary>
            <button type="button" className={styles.button} onClick={() => setPanel('settings')}>{text('chat.compatibility')}</button>
            <button type="button" className={styles.button} onClick={() => setPanel('history')}>{t('bots.history')}</button>
            <button type="button" className={styles.button} onClick={() => open({ kind: 'memory', bot: selected.bot })}>{t('memory.title')}</button>
            <button type="button" className={styles.button} onClick={() => open({ kind: 'duplicate', bot: selected.bot })}>{t('card.duplicate')}</button>
            <button type="button" className={styles.dangerButton} onClick={() => open({ kind: 'delete', bot: selected.bot })}>{t('actions.delete')}</button>
          </details>
        </div>
      </header>
      <section aria-label={t('persona.title')} data-bot-persona={selected.bot.id}>
        <h3>{t('persona.title')}</h3>
        {selected.bot.persona.prefix ? selected.bot.persona.prefix.length > 240 ? <details>
          <summary>{t('persona.expand')}</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.bot.persona.prefix}</p>
        </details> : <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.bot.persona.prefix}</p> : <p>{t('persona.empty')}</p>}
        {page.onEditPersona && <button type="button" className={styles.button} disabled={busy || model.navigating || !model.ready} onClick={() => {
          void model.navigate(async () => { await page.onEditPersona?.(selected.bot); model.setShowDetail(false); }, 'errors.start');
        }}>{t('persona.edit')}</button>}
      </section>
      {panel === 'work' && <>
        {page.background && <BackgroundTasksPanel key={`work:${selected.bot.id}:${selected.bot.createdAt}`} bot={selected.bot} actions={page.background} t={t} />}
        {page.routines && <RoutinePanel actions={page.routines} bots={model.entries.map(entry => entry.bot)} botId={selected.bot.id} onOpenSession={page.onOpenSession} t={t} />}
        {page.messages && <MessageOverviewPanel botId={selected.bot.id} actions={page.messages} onOpen={page.onOpenSession} t={t} />}
      </>}
      {panel === 'settings' && page.models && <CapabilitiesPanel bot={selected.bot} actions={page.models} t={t} />}
      {panel === 'history' && <BotSessionHistory page={page} model={model} />}
    </article>
  </Modal>;
}
