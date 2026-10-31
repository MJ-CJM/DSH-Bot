/**
 * Hand-authored spike fixture, NOT generator output.
 * The published generator cannot recognize npm-installed protocol declarations
 * at the locked version; this fixture only probes public register/$mount APIs.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { spec, type ListResult } from './contract.js';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'dshBot/list': () => Promise<RemoteResult<ListResult>>;
  }
  interface TypertRemoteNamespaceMap {
    dshBot: {
      list(): Promise<RemoteResult<ListResult>>;
    };
  }
}

export const TYPERT_REMOTE = createTypertRemoteInfo(spec, z);

export default TYPERT_REMOTE;
