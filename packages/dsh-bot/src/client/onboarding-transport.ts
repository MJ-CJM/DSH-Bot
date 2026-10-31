import type { StartOnboardingInput } from '../shared/onboarding.js';

export function onboardingTransportKey(input: StartOnboardingInput): string {
  return JSON.stringify([input.botId, input.operationId, input.sessionId]);
}
/** Client-local observable diagnostics carry no execution or retry authority. */
export function createOnboardingTransport() {
  let failures: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlySet<string>) => { failures = next; for (const notify of listeners) notify(); };
  return {
    getSnapshot: () => failures,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    failed(input: StartOnboardingInput) {
      const next = new Set(failures); next.add(onboardingTransportKey(input)); publish(next);
    },
    clear(input: StartOnboardingInput) {
      const next = new Set(failures); next.delete(onboardingTransportKey(input)); publish(next);
    },
    dispose() { publish(new Set()); listeners.clear(); },
  };
}
export type OnboardingTransport = ReturnType<typeof createOnboardingTransport>;
