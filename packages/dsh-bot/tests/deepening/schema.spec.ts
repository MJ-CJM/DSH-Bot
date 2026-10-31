import { required } from '../fixtures/required.js';
import { describe, expect, it } from 'vitest';
import { privateMemoryInputSchema, memoryVersionSchema, validitySchema, payloadSchema } from '../../src/shared/memory-v2.js';
import { Config } from '../../src/host/registry-config.js';
import { command, v2Fixture } from './v2-fixtures.js';

describe('I08 strict v2 boundary', () => {
  it.each(['botId', 'ownerBotKey', 'trust', 'recordedAt', 'commitSeq', 'forgetEpoch', 'sourceRefs', 'labels', 'scope'])
    ('rejects model-supplied Host field %s', field => {
      expect(privateMemoryInputSchema.safeParse({ content: 'safe', [field]: 'forged' }).success).toBe(false);
    });
  it('enforces private owner, shared role restrictions, interval bounds and payload byte size', async () => {
    const f = await v2Fixture();
    try {
      const c = command(f), v = required(c.versions[0]), p = required(c.payloads[v.contentRef]);
      expect(memoryVersionSchema.safeParse({ ...v, ownerBotKey: undefined }).success).toBe(false);
      const { ownerBotKey: _owner, ...rest } = v as Extract<typeof v, { scope: 'private' }>;
      expect(memoryVersionSchema.safeParse({ ...rest, scope: 'shared', shard: 'user', kind: 'bot_role' }).success).toBe(false);
      expect(validitySchema.safeParse({ from: 2, to: 2, basis: 'explicit' }).success).toBe(false);
      expect(payloadSchema.safeParse({ ...p, content: '中'.repeat(683) }).success).toBe(false);
    } finally { await f.close(); }
  });
  it('defaults to Host time zone and validates shares/time zone', () => {
    expect(Config({}).quotaTimeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(() => Config({ quotaTimeZone: 'invalid/zone' })).toThrow();
    expect(() => Config({ privateShare: 0.9 })).toThrow();
  });
});
