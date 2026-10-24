import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { P34Methods } from '../shared/p34-contract.js';
import { p34CatalogSchema } from '../shared/p34.js';
import type { P34Catalog } from '../shared/p34.js';
import { createPollingCatalog, type PollingCatalog, type BotCatalogOptions } from './state.js';
const unwrap = <T>(r: RemoteResult<T>) => { if (!r.ok) throw r.error; return r.value; };
export const EMPTY_P34: P34Catalog = { definitions: [], assignments: [], runtime: [], policies: [], notifications: [], unread: 0, imSupported: false, desktopSupported: false, defaults: { dailyLimit: 20, cooldownSec: 60 } };
export interface NativeCredentialRemote {
  describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialInfo>>>;
  set(ref: string, value: string): Promise<RemoteResult<void>>;
  unset(ref: string): Promise<RemoteResult<void>>;
}
export interface P34Actions {
  credentials(): NativeCredentialRemote | undefined;
  catalog: PollingCatalog<P34Catalog>;
  connectors(): P34Methods<'dshBot.connectors'>;
  notifications(): P34Methods<'dshBot.notifications'>;
  write<T>(action: () => Promise<RemoteResult<T>>): Promise<T>;
}
export function createP34Actions(ctx: Context, options: BotCatalogOptions): P34Actions {
  const connectors = () => { const r = ctx.get('remote.dshBot.connectors'); if (!r) throw new Error('P34 unavailable'); return r; };
  const notifications = () => { const r = ctx.get('remote.dshBot.notifications'); if (!r) throw new Error('P34 unavailable'); return r; };
  const catalog = createPollingCatalog(ctx, EMPTY_P34, async () => p34CatalogSchema.parse(unwrap(await connectors().catalog())), options);
  return { catalog, connectors, notifications, credentials: () => ctx.get('remote.credentials') as NativeCredentialRemote | undefined, async write(action) { const value = unwrap(await action()); await catalog.refresh(); return value; } };
}
