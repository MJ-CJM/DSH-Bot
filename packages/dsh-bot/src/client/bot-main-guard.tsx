import type { Context } from '@deepseek-ai/cordis';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotCatalog } from './state.js';

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
  }, ({ matched, t }: { matched: { botId: string } } & PropsLocale<'dsh-bot'>) =>
    <section data-bot-main-unavailable={matched.botId}>
      <p role="status">{t('chat.identityUnavailable')}</p>
      <button type="button" onClick={() => { void catalog.refresh(); }}>{t('bots.refresh')}</button>
      <button type="button" onClick={() => onDetails(matched.botId)}>{t('chat.profile')}</button>
    </section>,
  )), 'dsh-bot: scoped unavailable Bot composer');
}
