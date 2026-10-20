import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import TYPERT_REMOTE from './typert.remote-client.js';

export const TYPERT = {
  package: 'dsh-bot',
  face: 'host',
  schemas: [],
  get invocations() { return TYPERT_REMOTE.descriptors; },
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;

export default TYPERT;
