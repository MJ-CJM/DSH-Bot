import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { OnboardingStatus, StartOnboardingInput } from '../../shared/onboarding.js';
import { onboardingTransportKey, type OnboardingTransport } from '../onboarding-transport.js';
import type { SessionBotBadgeProps } from './SessionBotBadge.js';

const emptyFailures: ReadonlySet<string> = new Set();
const noSubscribe = () => () => {};
const noFailures = () => emptyFailures;

export interface FirstChatActions {
  onboardingTransport?: OnboardingTransport;
  onOnboardingStatus?(botId: string): Promise<OnboardingStatus>;
  onRetryOnboarding?(input: StartOnboardingInput): Promise<OnboardingStatus>;
}
/** This utility never blocks the native composer or sends a user message. */
export function FirstChatHint({ sessionId, useCatalog, useActivity, onOnboardingStatus, onRetryOnboarding, onboardingTransport, t }: SessionBotBadgeProps & FirstChatActions) {
  const failures = useSyncExternalStore(onboardingTransport?.subscribe ?? noSubscribe, onboardingTransport?.getSnapshot ?? noFailures);
  const catalog = useCatalog(value => value);
  const entry = catalog.entries.find(row => row.status?.mainSessionId === sessionId);
  const activity = useActivity(value => value);
  const [status, setStatus] = useState<OnboardingStatus>();
  const [unavailable, setUnavailable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const generation = useRef(0);
  const botId = entry?.bot.id;
  const createdAt = entry?.bot.createdAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Bot generation changes and explicit safe retries must restart this status read.
  useEffect(() => {
    generation.current++;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(undefined); setUnavailable(false);
    if (botId && onOnboardingStatus) {
      const read = async () => {
        try {
          const value = await onOnboardingStatus(botId);
          if (!active) return;
          if (value.sessionId && value.sessionId !== sessionId) return;
          setStatus(value); setUnavailable(false);
          if (['pending', 'dispatching', 'submitted'].includes(value.state)) timer = setTimeout(() => { void read(); }, catalog.pollIntervalMs);
        } catch { if (active) setUnavailable(true); }
      };
      void read();
    }
    return () => { active = false; generation.current++; clearTimeout(timer); };
  }, [botId, createdAt, sessionId, onOnboardingStatus, catalog.pollIntervalMs, readRevision]);
  if (!entry || !activity.loaded) return null;
  const hasActivity = activity.sessions.some(row => row.sessionId === sessionId);
  if (status?.state === 'completed' || status?.state === 'skipped' || hasActivity) return null;
  const transportFailed = status?.operationId && failures.has(onboardingTransportKey({ botId: entry.bot.id, operationId: status.operationId, sessionId }));
  const safePending = status?.state === 'pending' && status.retryable;
  const failed = unavailable || status?.state === 'failed';
  const key = transportFailed && safePending ? 'onboarding.deliveryFailed' : safePending ? 'onboarding.notDispatched' : failed ? 'onboarding.failed' : status?.state === 'uncertain' ? 'onboarding.uncertain' :
    status && ['pending', 'dispatching', 'submitted'].includes(status.state) ? 'onboarding.pending' : 'chat.firstMessage';
  return <span role="note" data-bot-first-chat={botId} data-onboarding-state={status?.state ?? (unavailable ? 'unavailable' : 'none')}
    style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: '0.875rem', maxWidth: '28rem', overflowWrap: 'anywhere' }}>
    {t(key)}
    {(status?.state === 'failed' || safePending) && status?.retryable && status.operationId && onRetryOnboarding && <button type="button" disabled={retrying}
      style={{ marginInlineStart: '0.5rem', padding: '0.25rem 0.5rem', borderRadius: '0.5rem', font: 'inherit', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l3)' }}
      onClick={() => {
        setRetrying(true);
        const epoch = generation.current;
        void onRetryOnboarding({ botId: entry.bot.id, operationId: status.operationId as string, sessionId }).then(value => {
          if (epoch !== generation.current) return;
          setRetrying(false); setStatus(value); setReadRevision(value => value + 1);
        }, () => { if (epoch === generation.current) setUnavailable(true); }).finally(() => {
          if (epoch === generation.current) setRetrying(false);
        });
      }}>{t('onboarding.retry')}</button>}
  </span>;
}
