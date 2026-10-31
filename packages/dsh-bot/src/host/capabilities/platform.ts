import type { Context } from '@deepseek-ai/cordis';
interface BrowserRegistration { readonly providerName?: string }
interface SpeechObservation { snapshot(): { providers: readonly { id: string; name: string; preparation: { phase: string } }[]; selection: { providerId: string } } }
/** Observe only public optional service facts. Registration is not proof of tool ownership or execution. */
export function platformCapabilities(ctx: Context) {
  const browser = ctx.get('browserUse') as BrowserRegistration | undefined;
  const speech = ctx.get('speechToText') as SpeechObservation | undefined;
  let voice: { available: boolean; selectedProvider?: string; providers: { id: string; name: string; phase: string }[] } = { available: false, providers: [] };
  if (speech) {
    try { const snapshot = speech.snapshot();
      voice = { available: true, selectedProvider: snapshot.selection.providerId,
        providers: snapshot.providers.map(provider => ({ id: provider.id, name: provider.name, phase: provider.preparation.phase })) };
    } catch { /* Readiness unavailable; do not prepare, download, record or transcribe. */ }
  }
  return { browser: { ...(browser?.providerName ? { provider: browser.providerName } : {}), toolBridge: false as const }, voice };
}
