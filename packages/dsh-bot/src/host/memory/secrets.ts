import { DshBotError } from '../errors.js';
import { hasCredential } from '../../shared/secrets.js';

/** Check unparsed text first so validation failures cannot echo secrets. */
export function rejectMemorySecrets(input: { content?: unknown; tags?: unknown }): void {
  const values = [input?.content, ...(Array.isArray(input?.tags) ? input.tags : [])];
  if (values.some((value) => typeof value === 'string'
    && hasCredential(value))) {
    throw new DshBotError('memory/rejected',
      'memory/rejected: Memory contains a possible credential or private key. Remove it before saving.');
  }
}

export const rejectModelSecrets = rejectMemorySecrets;
