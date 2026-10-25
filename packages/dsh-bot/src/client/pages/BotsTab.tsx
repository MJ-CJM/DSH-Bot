import { MessageOverviewPanel } from '../components/MessageOverview.js';
import { RoutinePanel } from '../components/RoutinePanel.js';
import { Button, IconEllipsisOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { BotAvatar } from '../components/BotAvatar.js';
import { BotList } from '../components/BotList.js';
import styles from '../styles/bots.module.css';

import type { BotsPageProps } from './bots-page-types.js';
import type { BotsPageModel } from './use-bots-page.js';
import { BotSessionHistory } from './BotSessionHistory.js';
export function BotsTab({ page, model }: { page: BotsPageProps; model: BotsPageModel }) {
  const { onStart, routines, onOpenSession, t } = page;
  const {
    tab,
    entries,
    compact,
    showDetail,
    busy,
    navigating,
    activity,
    selected,
    listElement,
    listId,
    setSelectedId,
    setMore,
    setToast,
    setShowDetail,
    navigate,
    backElement,
    focusListOnReturn,
    more,
    open,
    ready,
    snapshot,
    toast,
  } = model;
  return (
    <>
      {tab === 'bots' && entries.length > 0 && (
        <div className={styles.twoPane}>
          {(!compact || !showDetail) && (
            <BotList
              disabled={busy || navigating}
              entries={entries}
              activities={activity.bots}
              t={t}
              selectedId={selected?.bot.id}
              listRef={listElement}
              idPrefix={listId}
              onSelect={(id) => {
                setSelectedId(id);
                setMore(false);
                setToast(undefined);
              }}
              onActivate={(id) => {
                setShowDetail(true);
                void navigate((signal) => onStart(id, signal), 'errors.start');
              }}
            />
          )}
          {selected && (!compact || showDetail) && (
            <article className={styles.botDetail} data-bot-detail={selected.bot.id}>
              {compact && (
                <Button
                  ref={backElement}
                  variant="ghost"
                  size="sm"
                  className={styles.backButton}
                  onClick={() => {
                    focusListOnReturn.current = true;
                    setShowDetail(false);
                    setMore(false);
                  }}
                >
                  {t('bots.back')}
                </Button>
              )}
              <header className={styles.detailHeader}>
                <div className={styles.cardHeading}>
                  <BotAvatar bot={selected.bot} size={64} />
                  <div className={styles.cardIdentity}>
                    <h2 className={styles.detailTitle}>{selected.bot.name}</h2>
                    <span className={styles.botId}>{selected.bot.id}</span>
                  </div>
                  <Menu
                    open={more}
                    onClose={() => setMore(false)}
                    align="end"
                    className={styles.moreContainer}
                    anchor={
                      <Button
                        variant="ghost"
                        size="sm"
                        className={styles.iconButton}
                        disabled={busy}
                        aria-label={t('card.more')}
                        title={t('card.more')}
                        aria-haspopup="menu"
                        aria-expanded={more}
                        onClick={() => setMore(!more)}
                      >
                        <IconEllipsisOutlineRegular size={18} />
                      </Button>
                    }
                    items={[
                      { id: 'duplicate', label: t('card.duplicate'), disabled: busy },
                      { id: 'delete', label: t('actions.delete'), disabled: busy, danger: true },
                    ]}
                    onSelect={(action) => {
                      setMore(false);
                      if (action === 'duplicate' || action === 'delete') open({ kind: action, bot: selected.bot });
                    }}
                  />
                </div>
                <p className={styles.description}>{selected.bot.description || t('card.noDescription')}</p>
                <p className={styles.hint}>{t('editor.cwdPermissions')}</p>
                {selected.status?.warnings?.includes('avatar/invalid') && (
                  <p className={styles.statusNotice}>{t('avatar.invalidStored')}</p>
                )}
                {!ready && (
                  <p className={styles.statusNotice} role="status" id={`${listId}-status`}>
                    {t(
                      !selected.status || snapshot.error || snapshot.loading
                        ? 'card.statusUnknown'
                        : selected.status.preset.state === 'broken'
                          ? 'card.statusBroken'
                          : 'card.statusMissing',
                    )}
                    {selected.status?.preset.reason ? ` ${selected.status.preset.reason}` : ''}
                  </p>
                )}
                <div className={styles.detailActions}>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || navigating || !ready}
                    aria-describedby={!ready ? `${listId}-status` : undefined}
                    onClick={() => {
                      void navigate((signal) => onStart(selected.bot.id, signal), 'errors.start');
                    }}
                  >
                    {t('bots.newSession')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => open({ kind: 'edit', bot: selected.bot })}
                  >
                    {t('card.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => open({ kind: 'memory', bot: selected.bot })}
                  >
                    {t('memory.title')}
                  </Button>
                </div>
                {toast?.inline && (
                  <p className={styles.error} role="alert" data-chat-error="">
                    {toast.text}
                  </p>
                )}
              </header>
              {routines && (
                <RoutinePanel
                  key={selected.bot.id}
                  actions={routines}
                  bots={entries.map((entry) => entry.bot)}
                  botId={selected.bot.id}
                  onOpenSession={onOpenSession}
                  t={t}
                />
              )}
              {page.messages && <MessageOverviewPanel botId={selected.bot.id} actions={page.messages} onOpen={page.onOpenSession} t={t} />}
              <BotSessionHistory page={page} model={model} />
            </article>
          )}
        </div>
      )}
    </>
  );
}
