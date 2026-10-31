import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { dump, load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { composeBotPreset } from '../lib/host/composer.js';
import { type BotRecord, botCreateSchema, botSchema } from '../src/shared/schema.js';

type Row = PresetDefinition['plugins'][number];
type Template = BotRecord['template'];
const config = { dataDir: '/isolated/data', presetIdPrefix: 'bot-', presetOrder: 50 };

// Test-only copies of web-app/presets from dsh-v0.2.1-rc.2, commit
// 687f282e8625c6b8d11ff58211a90524be2e4317. Production always reads the Host
// document. These hashes preserve fixture provenance without a machine path.
const fixtureHashes = {
  standard: '0d398d2a6872a73a106cb3bd19303ecccf1637e1fcad4d0bf9d8a72d2c2c68f5',
  minimal: 'a2a9ba1c9c392a45466708f18bc0aefbf300577f9b544dc06049f73a8a5b3267',
};

function fixture(template: Template): string {
  return readFileSync(new URL(`./fixtures/presets/${template}.patch.yml`, import.meta.url), 'utf8');
}

function templateRows(template: Template): Row[] {
  const patch = load(fixture(template), { schema: entryListSchema }) as {
    insert: { config: { id: string; plugins: Row[] } }[];
  }[];
  const declaration = patch[0]?.insert[0]?.config;
  if (declaration?.id !== template) throw new Error(`Unexpected ${template} fixture`);
  return declaration.plugins;
}

function documentRows(rows: readonly Row[]): string {
  return dump(rows, { schema: entryListSchema, noRefs: true, lineWidth: -1 });
}

function reader(content: string, template: Template = 'standard') {
  const readDocument = vi.fn(async () => ({ agentPreset: template, content }));
  const ctx = { agentPresets: { readDocument } } as unknown as Pick<Context, 'agentPresets'>;
  return { ctx, readDocument };
}

function bot(overrides: Partial<BotRecord> = {}): BotRecord {
  return botSchema.parse({
    ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha 助手', description: 'Bot-specific assistant',
      persona: { prefix: 'You are Alpha. 用中文回答。' } }),
    createdAt: 1, updatedAt: 1, schemaVersion: 1, ...overrides,
  });
}

function rowConfig(row: Row | undefined): Record<string, unknown> {
  expect(row).toBeDefined();
  return row?.config as Record<string, unknown>;
}

describe('composeBotPreset', () => {
  it('uses Host registry configuration for the two-argument API', async () => {
    const { ctx } = reader(documentRows(templateRows('standard')));
    const host = { ...ctx, dshBots: { config } as Context['dshBots'] };
    expect(await composeBotPreset(bot(), host)).toEqual(await composeBotPreset(bot(), ctx, config));
  });

  for (const template of ['standard', 'minimal'] as const) {
    it(`keeps the exact ${template} fixture from the locked DSH version`, () => {
      expect(createHash('sha256').update(fixture(template)).digest('hex')).toBe(fixtureHashes[template]);
    });

    for (const withModel of [false, true]) {
      for (const withDeny of [false, true]) {
        it(`snapshots ${template}, model=${withModel}, deny=${withDeny}`, async () => {
          const record = bot({ template, tools: { deny: withDeny ? ['bash', 'write'] : [] },
            ...(withModel ? { model: { provider: 'mock-provider', model: 'bot-model', reasoningEffort: 'high' } } : {}),
          });
          const source = documentRows(templateRows(template));
          const { ctx, readDocument } = reader(source, template);
          const definition = await composeBotPreset(record, ctx, config);

          expect(readDocument).toHaveBeenCalledExactlyOnceWith(template);
          expect({ input: { template, model: record.model, deny: record.tools.deny }, definition }).toMatchSnapshot();
          expect(definition.plugins.filter((row) => row.name === '@deepseek-ai/dsh-skill-filesystem')).toHaveLength(1);
          expect(definition.plugins.find((row) => row.name === 'dsh-bot/bot-context')).toMatchObject({
            config: { botId: record.id },
          });
          expect(definition.plugins.some((row) => row.name === 'cordis:group' && row.id === 'bot-alpha')).toBe(false);
        });
      }
    }
  }

  it('keeps platform expressions and all unrelated nested rows as declared', async () => {
    const rows = templateRows('standard');
    const { ctx } = reader(documentRows(rows));
    const definition = await composeBotPreset(bot(), ctx, config);
    expect(definition.plugins.find((row) => row.id === 'tool-bash')?.disabled).toEqual({
      __jsExpr: "process.platform === 'win32'",
    });
    expect(definition.plugins.find((row) => row.id === 'tool-pwsh')?.disabled).toEqual({
      __jsExpr: "process.platform !== 'win32'",
    });
    for (const row of rows.filter((row) => !['persona', 'skill-filesystem'].includes(row.id ?? ''))) {
      expect(definition.plugins.find((candidate) => candidate.id === row.id)).toStrictEqual(row);
    }
    expect(() => structuredClone(definition)).not.toThrow();
  });

  it('returns independent compositions without changing the Bot or Host template', async () => {
    const rows = templateRows('standard');
    const source = documentRows(rows);
    const { ctx } = reader(source);
    const record = bot({ skills: { extraDirs: ['/shared/skills'] } });
    const original = structuredClone(record);
    const first = await composeBotPreset(record, ctx, config);
    const untouched = structuredClone(first);
    rowConfig(first.plugins.find((row) => row.id === 'persona')).prefix = 'Changed by caller';
    const skillDirs = rowConfig(first.plugins.find((row) => row.name === '@deepseek-ai/dsh-skill-filesystem')).customSkillDirs;
    expect(Array.isArray(skillDirs)).toBe(true);
    (skillDirs as string[]).push('/caller/mutation');
    const second = await composeBotPreset(record, ctx, config);
    expect(second).toStrictEqual(untouched);
    expect(record).toStrictEqual(original);
    expect(documentRows(rows)).toBe(source);
  });

  it('uses Bot persona options and metadata, explicit order, and configured prefix', async () => {
    const record = bot({ template: 'minimal', order: 0,
      persona: { prefix: 'Complete persona', suffix: 'A suffix', complete: false },
    });
    const { ctx } = reader(documentRows(templateRows('minimal')), 'minimal');
    const definition = await composeBotPreset(record, ctx, { ...config, presetIdPrefix: 'custom-', presetOrder: 99 });
    expect(definition).toMatchObject({ id: 'custom-alpha', name: record.name, description: record.description, order: 0 });
    expect(rowConfig(definition.plugins.find((row) => row.id === 'persona'))).toStrictEqual(record.persona);
  });

  it('does not inherit the minimal template complete-prompt setting when the Bot omits it', async () => {
    const { ctx } = reader(documentRows(templateRows('minimal')), 'minimal');
    const record = bot({ template: 'minimal' });
    const definition = await composeBotPreset(record, ctx, config);
    expect(rowConfig(definition.plugins.find((row) => row.id === 'persona'))).toStrictEqual(record.persona);
    expect(definition.order).toBe(config.presetOrder);
  });

  it('edits the existing skills provider, preserving its unrelated configuration', async () => {
    const rows = templateRows('standard');
    const skills = rows.find((row) => row.name === '@deepseek-ai/dsh-skill-filesystem');
    if (!skills) throw new Error('Missing fixture skill row');
    skills.config = { providerName: 'custom-filesystem', includeDefaultRoots: false, watch: false,
      customSkillDirs: ['/template/path'] };
    const { ctx } = reader(documentRows(rows));
    const definition = await composeBotPreset(bot({ skills: { extraDirs: ['/shared/one', '/shared/two'] } }), ctx, config);
    const providers = definition.plugins.filter((row) => row.name === '@deepseek-ai/dsh-skill-filesystem');
    expect(providers).toHaveLength(1);
    expect(rowConfig(providers[0])).toStrictEqual({ providerName: 'custom-filesystem', includeDefaultRoots: false, watch: false,
      customSkillDirs: [join(config.dataDir, 'bots', 'alpha', 'skills'), '/shared/one', '/shared/two'] });
  });

  it('reads the current Host document on every composition, including edited template settings', async () => {
    const rows = templateRows('standard');
    const { ctx, readDocument } = reader(documentRows(rows));
    const first = await composeBotPreset(bot(), ctx, config);
    const tool = rows.find((row) => row.id === 'tool-web');
    if (!tool) throw new Error('Missing fixture web row');
    tool.config = { fetch: false, searchTimeoutMs: 1234 };
    readDocument.mockResolvedValueOnce({ agentPreset: 'standard', content: documentRows(rows) });
    const next = await composeBotPreset(bot(), ctx, config);
    expect(readDocument).toHaveBeenCalledTimes(2);
    expect(rowConfig(next.plugins.find((row) => row.id === 'tool-web'))).toEqual(tool.config);
    expect(rowConfig(first.plugins.find((row) => row.id === 'tool-web'))).not.toEqual(tool.config);
  });

  it('restores the native schedule row when a Host standard template omits it', async () => {
    const rows = templateRows('standard').filter(row => row.name !== '@deepseek-ai/dsh-tool-schedule');
    const { ctx } = reader(documentRows(rows));
    const definition = await composeBotPreset(bot(), ctx, config);
    expect(definition.plugins.filter(row => row.name === '@deepseek-ai/dsh-tool-schedule')).toEqual([
      { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    ]);
  });

  it('preserves an existing nested native schedule row without adding a second provider', async () => {
    const rows = templateRows('standard').filter(row => row.name !== '@deepseek-ai/dsh-tool-schedule');
    const nested = deeplyNested({ id: 'native-schedule', name: '@deepseek-ai/dsh-tool-schedule' });
    rows.push(nested);
    const { ctx } = reader(documentRows(rows));
    const definition = await composeBotPreset(bot(), ctx, config);
    expect(definition.plugins).toContainEqual(nested);
    expect(definition.plugins.some(row => row.name === '@deepseek-ai/dsh-tool-schedule')).toBe(false);
  });

  it('rejects a conflicting schedule row id instead of overwriting an unrelated Host plugin', async () => {
    const rows = templateRows('minimal');
    rows.push({ id: 'tool-schedule', name: 'custom-plugin' });
    const { ctx } = reader(documentRows(rows), 'minimal');
    await expect(composeBotPreset(bot({ template: 'minimal' }), ctx, config)).rejects.toThrow(/tool-schedule id collision/);
  });

  it('propagates a missing or unavailable Host template instead of composing a fallback', async () => {
    const unavailable = new Error('Unknown agent preset: standard');
    const { ctx, readDocument } = reader('[]');
    readDocument.mockRejectedValueOnce(unavailable);
    await expect(composeBotPreset(bot(), ctx, config)).rejects.toThrow(/Unknown agent preset: standard/);
  });

  const invalidDocuments = [
    { label: 'not a list', content: 'name: invalid' },
    { label: 'empty list', content: '[]' },
    { label: 'invalid YAML', content: '[invalid: [' },
    { label: 'unnamed plugin', content: '- id: persona\n  config: {}' },
    { label: 'invalid nested group', content: '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n- name: cordis:group\n  group: true\n  config: {}' },
  ];
  it.each(invalidDocuments)('rejects $label template content', async ({ content }) => {
    const { ctx } = reader(content);
    await expect(composeBotPreset(bot(), ctx, config)).rejects.toThrow();
  });

  it('rejects a missing persona anchor', async () => {
    const rows = templateRows('standard').filter((row) => row.id !== 'persona');
    const { ctx } = reader(documentRows(rows));
    await expect(composeBotPreset(bot(), ctx, config)).rejects.toThrow(/persona/i);
  });

  it('rejects an ambiguous persona anchor', async () => {
    const rows = templateRows('standard');
    rows.push({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Duplicate' } });
    const { ctx } = reader(documentRows(rows));
    await expect(composeBotPreset(bot(), ctx, config)).rejects.toThrow(/persona/i);
  });

  it('rejects a standard document whose skills provider anchor disappeared', async () => {
    const rows = templateRows('standard').filter((row) => row.name !== '@deepseek-ai/dsh-skill-filesystem');
    const { ctx } = reader(documentRows(rows));
    await expect(composeBotPreset(bot(), ctx, config)).rejects.toThrow(/skill/i);
  });

  it('rejects multiple filesystem skill providers rather than hiding a registration conflict', async () => {
    const rows = templateRows('standard');
    rows.push({ id: 'another-skills', name: '@deepseek-ai/dsh-skill-filesystem' });
    const { ctx } = reader(documentRows(rows));
    await expect(composeBotPreset(bot(), ctx, config)).rejects.toThrow(/skill/i);
  });

  function deeplyNested(row: Row): Row {
    return { id: 'outer-group', name: 'cordis:group', group: true, config: [
      { id: 'inner-group', name: 'cordis:group', group: true, config: [row] },
    ] };
  }

  it.each([
    { label: 'plugin name', row: { id: 'already-bound', name: 'dsh-bot/bot-context', config: { botId: 'alpha' } } },
    { label: 'reserved id', row: { id: 'bot-context', name: 'fixture-plugin' } },
  ])('rejects a Bot context $label inside recursively nested groups', async ({ row }) => {
    const rows = [...templateRows('standard'), deeplyNested(row)];
    const { ctx } = reader(documentRows(rows));
    await expect(composeBotPreset(bot(), ctx, config)).rejects.toMatchObject({
      code: 'bot/preset-failed', message: expect.stringMatching(/already contains bot-context/),
    });
  });

  it.each(['standard', 'minimal'] as const)('rejects a sole skill provider nested inside the %s template', async (template) => {
    const rows = templateRows(template).filter((row) => row.name !== '@deepseek-ai/dsh-skill-filesystem');
    rows.push(deeplyNested({ id: 'nested-skills', name: '@deepseek-ai/dsh-skill-filesystem' }));
    const { ctx } = reader(documentRows(rows), template);
    await expect(composeBotPreset(bot({ template }), ctx, config)).rejects.toMatchObject({
      code: 'bot/preset-failed', message: expect.stringMatching(/skill-filesystem/),
    });
  });

  it('rejects an additional nested skill provider even with a distinct provider name', async () => {
    const rows = templateRows('standard');
    rows.push(deeplyNested({ id: 'extra-skills', name: '@deepseek-ai/dsh-skill-filesystem',
      config: { providerName: 'another-filesystem' },
    }));
    const { ctx } = reader(documentRows(rows));
    await expect(composeBotPreset(bot(), ctx, config)).rejects.toMatchObject({
      code: 'bot/preset-failed', message: expect.stringMatching(/skill-filesystem/),
    });
  });
});
