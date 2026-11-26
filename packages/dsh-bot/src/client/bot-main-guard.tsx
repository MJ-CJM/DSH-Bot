import type { Context } from '@deepseek-ai/cordis';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotCatalog } from './state.js';
import { useStyleSheet } from './use-style-sheet.js';
import styles from './styles/groups.module.css';
import css from './styles/groups.module.css?inline';

export function unavailableBotMain(
  owner: Pick<ComposerChainProps, 'sessionId' | 'pendingInteraction'>,
  entries: ReturnType<BotCatalog['getSnapshot']>['entries'],
  preset?: string | null,
) {
  if (!owner.sessionId || owner.pendingInteraction) return null;
  const entry = entries.find(({ status }) => status?.boundMainSessionId === owner.sessionId || status?.mainSessionId === owner.sessionId);
  const status = entry?.status;
  if (!status) return null;
  return status.mainSessionState === 'unavailable' || (preset && preset !== status.presetId) ? { botId: entry.bot.id } : null;
}

/** Only a known Bot main with an unconfirmed identity receives this composer. Native approvals keep their own seat. */
export function registerBotMainGuard(ctx: Context, catalog: BotCatalog, onDetails: (botId: string) => void) {
  ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', locale: 'dsh-bot', priority: -15, select: owner => {
      const sessions = ctx.get('sessions') as unknown as ISessions | undefined;
      const preset = owner.sessionId && sessions?.list.getSnapshot().byId[owner.sessionId]?.projectionValues?.agentPreset;
      return unavailableBotMain(owner, catalog.getSnapshot().entries, preset ?? undefined);
    },
  }, ({ matched, t }: { matched: { botId: string } } & PropsLocale<'dsh-bot'>) => {
    useStyleSheet('groups', css);
    return <section className={`${styles.panel} ${styles.workspace} ${styles.fallbackComposer}`} data-bot-main-unavailable={matched.botId}>
      <div className={styles.fallbackCard}>
        <p role="status" className={styles.fallbackMessage}>{t('chat.identityUnavailable')}</p>
        <div className={styles.bar}>
          <Button variant="outline" size="sm" onClick={() => { void catalog.refresh(); }}>{t('bots.refresh')}</Button>
          <Button variant="ghost" size="sm" onClick={() => onDetails(matched.botId)}>{t('chat.profile')}</Button>
        </div>
      </div>
    </section>;
  },
  )), 'dsh-bot: scoped unavailable Bot composer');
}
