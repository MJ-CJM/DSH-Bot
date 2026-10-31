import type { Context } from '@deepseek-ai/cordis';
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { onboardingSourceSchema, type OnboardingSource } from '../shared/onboarding-source.js';
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'dsh-bot-onboarding-notice': OnboardingSource }
}
/** Only the exact persisted native source is presented; prompt text remains in
 * the native log and is never disguised as a message written by the user. */
export const onboardingNoticeDefinition: ConversationNodeDefinition<OnboardingSource> = {
  kind: 'dsh-bot-onboarding-notice', target: 'chat',
  match(event) {
    if (event.type !== 'user/message' || !isAppendSurfaceEvent(event)) return null;
    const source = onboardingSourceSchema.safeParse(event.data.source);
    return source.success && source.data.inputId === event.data.id ? { id: String(event.data.id), role: 'start', exclusive: true } : null;
  },
  start(_context, match) {
    if (match.event.type !== 'user/message') throw new Error('Onboarding message required');
    return onboardingSourceSchema.parse(match.event.data.source);
  },
  update: context => context.state,
  buildViewNode(context): ChatNode<'dsh-bot-onboarding-notice'> | null {
    if (!context.state) return null;
    return { key: context.key, id: context.id, kind: 'dsh-bot-onboarding-notice', target: 'chat',
      anchorSeq: Number(context.start?.event.seq ?? 0), location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible', data: context.state };
  },
};
export function OnboardingNotice({ t }: PropsLocale<'dsh-bot'>) {
  return <p role="note" data-bot-onboarding-notice="" style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: '0.875rem' }}>{t('onboarding.notice')}</p>;
}
export function registerOnboardingNotice(ctx: Context) {
  ctx.inject(['uiConversation'], scope => {
    scope.effect(() => scope.slots.inject('conversation.chat.node', () => scope.effect(function* () {
      yield scope.slots.register({ name: 'conversation.chat.node', key: 'dsh-bot-onboarding-notice', locale: 'dsh-bot' }, OnboardingNotice);
      yield scope.uiConversation.events.register(onboardingNoticeDefinition);
    }, 'dsh-bot: onboarding notice projection')), 'dsh-bot: onboarding notice slot');
  });
}
