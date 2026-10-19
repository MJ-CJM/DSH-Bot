/** Explicit contribution; the rc.2 external generator is not used for this package. */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { z } from 'zod';
import { dshBotRemoteSpec } from './shared/remote-contract.js';
export type {
  DshBotActivityMethods, DshBotActivityRemoteMethods, DshBotRemoteMethods,
  ActivityRecord, ActivitySession, ActivityListResult, BotChange, BotHome,
} from './shared/remote-contract.js';
export { ACTIVITY_HIDDEN_PREVIEW, isHiddenActivityPreview, type BotActivity } from './shared/activity.js';

export const TYPERT_REMOTE = createTypertRemoteInfo(dshBotRemoteSpec, z);
export default TYPERT_REMOTE;
