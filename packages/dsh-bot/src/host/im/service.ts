import type { Context } from '@deepseek-ai/cordis';
import { IM_PIN, type ImStatus } from '../../shared/collaboration.js';
/** No import of dsh-im internals and no probing real accounts/credentials. */
export function imStatus(ctx: Context): ImStatus {
  const candidate: unknown = ctx.get('dshIm');
  const service = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : undefined;
  const contractDetected = Boolean(
    service &&
      service.contractVersion === 1 &&
      service.inboundVersion === 1 &&
      ['describeBot', 'listBots', 'listTargets', 'consumeInbound', 'replyChecked', 'sendChecked'].every(
        (k) => typeof service[k] === 'function',
      ),
  );
  return {
    pin: IM_PIN,
    installed: Boolean(service),
    contractDetected,
    inboundSupported: false,
    outboundSupported: false,
    reason: !service ? 'plugin-missing' : !contractDetected ? 'contract-unavailable' : 'consumer-gate-unverified',
  };
}
