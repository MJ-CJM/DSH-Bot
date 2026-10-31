/** Hand-authored spike fixture; this is not an automatically generated contract. */
import TYPERT_REMOTE from './typert.remote-client.js';

export const TYPERT = {
  package: 'dsh-bot-spike-remote',
  face: 'host' as const,
  schemas: [],
  get invocations() { return TYPERT_REMOTE.descriptors; },
  model: { services: [], events: [], objects: [] },
};
