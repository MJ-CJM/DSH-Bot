import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { IntegrationMethods } from '../shared/integrations-contract.js';
import { integrationCatalogSchema } from '../shared/integrations.js';
import type { IntegrationCatalog } from '../shared/integrations.js';
import { createPollingCatalog, type PollingCatalog, type BotCatalogOptions } from './state.js';
const unwrap = <T>(r: RemoteResult<T>) => {
  if (!r.ok) throw r.error;
  return r.value;
};
export const EMPTY_INTEGRATIONS: IntegrationCatalog = {
  definitions: [],
  assignments: [],
  runtime: [],
  policies: [],
  notifications: [],
  unread: 0,
  imSupported: false,
  desktopSupported: false,
  defaults: { dailyLimit: 20, cooldownSec: 60 },
};
export interface NativeCredentialRemote {
  describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>;
  set(ref: string, value: string): Promise<RemoteResult<void>>;
  unset(ref: string): Promise<RemoteResult<void>>;
}
export interface IntegrationActions {
  credentials(): NativeCredentialRemote | undefined;
  catalog: PollingCatalog<IntegrationCatalog>;
  connectors(): IntegrationMethods<'dshBot.connectors'>;
  notifications(): IntegrationMethods<'dshBot.notifications'>;
  write<T>(action: () => Promise<RemoteResult<T>>): Promise<T>;
}
export function createIntegrationActions(ctx: Context, options: BotCatalogOptions): IntegrationActions {
  const connectors = () => {
    const r = ctx.get('remote.dshBot.connectors');
    if (!r) throw new Error('Integrations unavailable');
    return r;
  };
  const notifications = () => {
    const r = ctx.get('remote.dshBot.notifications');
    if (!r) throw new Error('Integrations unavailable');
    return r;
  };
  const catalog = createPollingCatalog(
    ctx,
    EMPTY_INTEGRATIONS,
    async () => integrationCatalogSchema.parse(unwrap(await connectors().catalog())),
    options,
  );
  return {
    catalog,
    connectors,
    notifications,
    credentials: () => ctx.get('remote.credentials') as NativeCredentialRemote | undefined,
    async write(action) {
      const value = unwrap(await action());
      await catalog.refresh();
      return value;
    },
  };
}
