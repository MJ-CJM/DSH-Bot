import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { CAPABILITIES_REMOTE, type CapabilitiesMethods } from '../../shared/capabilities-contract.js';
import type { Capabilities } from './service.js';
export const CAPABILITIES_HOST = { package: 'dsh-bot/capabilities', face: 'host', schemas: [], get invocations() { return CAPABILITIES_REMOTE.descriptors; }, model: { services: [], events: [], objects: [] } } satisfies TypertContribution;
export class CapabilitiesRemote extends TypertRemoteService {
  constructor(ctx: Context, private capabilities: Capabilities) { super(ctx, 'dshBotCapabilitiesRemote', { namespace: 'dshBot.capabilities' }); }
  @Remote async request(input: Parameters<CapabilitiesMethods['request']>[0]) { return this.capabilities.request(input); }
}
declare module '@deepseek-ai/cordis' { interface Context { dshBotCapabilitiesRemote: CapabilitiesRemote } }
