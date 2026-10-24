import { describe, expect, it } from 'vitest';
import { botExportSchema, workspaceRequestSchema } from '../src/shared/workspace.js';
import { memoryEntity, verifyMemoryEntity } from '../src/host/reference-memory/service.js';
import { connectorInputSchema } from '../src/shared/p34.js';
import { memorySchema } from '../src/shared/schema.js';
const bot = { botId: 'alpha', botCreatedAt: 123 };
const record = memorySchema.parse({
  id: 'memory-alpha',
  botId: 'alpha',
  kind: 'fact',
  content: 'Tea preference',
  tags: ['中文', 'a,b'],
  pinned: true,
  source: { by: 'user', at: 3, sessionId: 'synthetic-session' },
  createdAt: 5,
  updatedAt: 9,
});
const portable = {
  format: 'dsh-bot-export',
  version: 1,
  bot: { name: 'Portable' },
};
describe('P34 portable boundaries and exact memory envelopes', () => {
  it('round trips every metadata field and keeps natural graph nodes out of the memory contract', () => {
    const entity = memoryEntity(bot, record);
    expect(() => verifyMemoryEntity(bot, record, entity)).not.toThrow();
    expect(JSON.parse(entity.observations[0] ?? '').record).toEqual(record);
    expect(memoryEntity(bot, record).name).toBe(entity.name);
    expect(() => verifyMemoryEntity(bot, record, { ...entity, entityType: 'natural' })).toThrow();
  });
  it.each(['id', 'kind', 'content', 'tags', 'pinned', 'source', 'createdAt', 'updatedAt'] as const)(
    'rejects a changed %s even when the entity name is unchanged',
    (key) => {
      const entity = memoryEntity(bot, record),
        envelope = JSON.parse(entity.observations[0] ?? '');
      envelope.record[key] =
        key === 'pinned'
          ? false
          : key === 'createdAt' || key === 'updatedAt'
            ? 7
            : key === 'tags'
              ? ['different']
              : key === 'source'
                ? undefined
                : 'changed';
      expect(() =>
        verifyMemoryEntity(bot, record, {
          ...entity,
          observations: [JSON.stringify(envelope)],
        }),
      ).toThrow();
    },
  );
  it('rejects a different Bot incarnation, extra observations and credential sentinels', () => {
    const entity = memoryEntity(bot, record);
    expect(() => verifyMemoryEntity({ ...bot, botCreatedAt: 124 }, record, entity)).toThrow();
    expect(() =>
      verifyMemoryEntity(bot, record, {
        ...entity,
        observations: [...entity.observations, 'unverified'],
      }),
    ).toThrow();
    expect(() => memoryEntity(bot, { ...record, content: `sk-${'A'.repeat(32)}` })).toThrow();
  });
  it.each(['../escape', '/absolute', 'a/../escape', 'a//b', 'a\\b', 'a\0b'])('refuses unsafe skill path %s', (path) => {
    expect(
      botExportSchema.safeParse({
        ...portable,
        skillsManifest: [{ path, content: 'safe' }],
      }).success,
    ).toBe(false);
  });
  it.each(['defaultCwd', 'skills', 'mcpServers', 'channels', 'mainSessionId', 'createdAt', 'id'])(
    'does not accept machine or authority field %s in a portable Bot',
    (key) => {
      expect(
        botExportSchema.safeParse({
          ...portable,
          bot: { ...portable.bot, [key]: 'forged' },
        }).success,
      ).toBe(false);
    },
  );
  it('rejects secrets, duplicate skill destinations, enabled grants, unsupported versions and oversized documents', () => {
    for (const patch of [
      { bot: { name: 'Machine', persona: { prefix: 'Use /Users/synthetic/private' } } },
      { bot: { name: 'Secret', persona: { prefix: `sk-${'x'.repeat(32)}` } } },
      {
        skillsManifest: [
          { path: 'SKILL.md', content: 'a' },
          { path: 'SKILL.md', content: 'b' },
        ],
      },
      { connectorTemplates: [{ connectorId: 'github', enabled: true }] },
      { version: 2 },
      { bot: { name: 'Huge', description: 'x'.repeat(1048577) } },
    ]) {
      expect(botExportSchema.safeParse({ ...portable, ...patch }).success).toBe(false);
    }
  });
  it('reserves the managed graph namespace and rejects arbitrary session / file identities on management requests', () => {
    expect(
      connectorInputSchema.safeParse({
        id: 'hijack',
        label: 'hijack',
        serverName: 'bot_memory_graph',
        transport: 'streamable-http',
        url: 'http://127.0.0.1/mcp',
      }).success,
    ).toBe(false);
    expect(
      workspaceRequestSchema.safeParse({
        action: 'export',
        bot,
        includeSkills: false,
        includeMemories: false,
        sessionId: 'forged',
      }).success,
    ).toBe(false);
  });
});
