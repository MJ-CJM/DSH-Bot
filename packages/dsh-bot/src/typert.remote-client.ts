/** Explicit contribution; the rc.2 external generator is not used for this package. */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { z } from 'zod';
import { dshBotRemoteSpec } from './shared/remote-contract.js';

export const TYPERT_REMOTE = createTypertRemoteInfo(dshBotRemoteSpec, z);
export default TYPERT_REMOTE;
