import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

const namespace = 'dsh-bot';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-bot': keyof typeof en.ui;
  }
}

function DshBotBadge({ t }: PropsLocale<typeof namespace>) {
  return (
    <span
      data-dsh-bot-badge=""
      title={t('badge.description')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 6,
        margin: '4px 8px',
        padding: '3px 9px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        lineHeight: '18px',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M8 8 12 4l4 4M6 11h12v9H6zM10 15h.01M14 15h.01"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {t('badge.label')}
    </span>
  );
}

// Standard Web/Desktop composition includes locale (dsh-v0.2.1-rc.2:
// packages/bundle/web-app/cordis.patch.yml:257-258). Cordis waits for both services.
export const inject = ['slots', 'locale'];

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(namespace, {
    en: en.ui,
    zh: zh.ui,
  }), 'dsh-bot: dictionaries');
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'dsh-bot',
      order: 5,
      locale: namespace,
    }, DshBotBadge)), 'dsh-bot: composer badge');
}
