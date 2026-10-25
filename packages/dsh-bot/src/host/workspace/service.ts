import { randomUUID } from 'node:crypto';
import { lstat, readdir, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  botExportSchema,
  importPreviewSchema,
  workspaceRequestSchema,
  workspaceResultSchema,
  type BotExport,
} from '../../shared/workspace.js';
import type { BotKey } from '../../shared/integrations.js';
import type { DshBotRegistry } from '../registry.js';
import type { Connectors } from '../connectors/service.js';
import { botSkillsDirectory } from '../composer.js';
import { checkedFile, contained, safeDirectory } from '../reference-memory/files.js';
import { digest, need, OperationError, parse, Serial } from '../common/operations.js';

const previewRowSchema = z.strictObject({
  preview: importPreviewSchema,
  document: botExportSchema,
});
export const workspaceDomain = defineDomain({
  name: 'dsh_bot_workspace',
  version: 1,
  tables: { previews: domainTable(previewRowSchema) },
});
export class WorkspaceManagement {
  private queue = new Serial();
  private closing?: Promise<void>;
  constructor(
    private ctx: Context,
    private registry: DshBotRegistry,
    private connectors: Connectors,
    private domain: Domain<typeof workspaceDomain>,
  ) {}
  private async bot(key: BotKey) {
    const bot = await this.registry.get(key.botId);
    if (bot.createdAt !== key.botCreatedAt) throw new OperationError('conflict');
    return bot;
  }
  private async files(botId: string) {
    const root = botSkillsDirectory(botId, this.registry.config);
    await safeDirectory(root);
    const files: BotExport['skillsManifest'] = [];
    let size = 0;
    const walk = async (dir: string, prefix: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        if (entry.isSymbolicLink()) throw new OperationError('invalid');
        const full = contained(root, path);
        if (entry.isDirectory()) {
          await safeDirectory(full, false);
          await walk(full, `${path}/`);
        } else {
          const content = need(await checkedFile(full, 262144));
          size += Buffer.byteLength(content);
          if (size > 1048576 || files.length >= 128) throw new OperationError('invalid');
          // Text skills only; reject binary instead of silently corrupting an archive.
          if (content.includes('\0') || content.includes('\ufffd')) throw new OperationError('unsupported');
          files.push({ path, content });
        }
      }
    };
    await walk(root, '');
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  private async conflict(id: string, doc: BotExport) {
    if ((await this.registry.list()).some((b) => b.id === id)) return true;
    const root = botSkillsDirectory(id, this.registry.config);
    for (const file of doc.skillsManifest) {
      const target = contained(root, file.path);
      // Existing ancestors must be real directories; an existing target is never overwritten.
      let parent = dirname(target);
      while (parent.startsWith(root)) {
        try {
          const st = await lstat(parent);
          if (!st.isDirectory() || st.isSymbolicLink()) return true;
        } catch (e) {
          if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'ENOENT') throw e;
        }
        if (parent === root) break;
        parent = dirname(parent);
      }
      try {
        await lstat(target);
        return true;
      } catch (e) {
        if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'ENOENT') throw e;
      }
    }
    return false;
  }
  async request(input: z.input<typeof workspaceRequestSchema>) {
    const r = parse(workspaceRequestSchema, input);
    return this.queue.run(async () => {
      if (r.action === 'summary') {
        const runs = this.ctx.get('dshBotAutomationStores')?.runs.list({ limit: 50 });
        return workspaceResultSchema.parse({
          kind: 'summary',
          summary: {
            available: runs !== undefined,
            sampleSize: runs?.length ?? 0,
            accepted:
              runs?.filter((r) => ['queued', 'running', 'waiting_approval', 'delivered'].includes(r.status)).length ??
              0,
            completed: runs?.filter((r) => r.status === 'succeeded').length ?? 0,
            failed: runs?.filter((r) => ['failed', 'cancelled', 'timed_out', 'skipped'].includes(r.status)).length ?? 0,
            unknown: runs?.filter((r) => r.status === 'recovery_needed').length ?? 0,
          },
        });
      }
      if (r.action === 'inspect')
        return workspaceResultSchema.parse({
          kind: 'preview',
          preview: need(this.domain.table('previews').get(r.previewId)).preview,
        });
      if (r.action === 'export') {
        const bot = await this.bot(r.bot);
        const {
          id: _id,
          createdAt: _created,
          updatedAt: _updated,
          schemaVersion: _version,
          defaultCwd: _cwd,
          skills: _skills,
          mcpServers: _mcp,
          channels,
          ...portable
        } = bot;
        const memoryRecords = r.includeMemories
          ? (await this.registry.memoryFor(bot.id).snapshot(Number.MAX_SAFE_INTEGER)).map(
              ({ id: _mid, botId: _bid, createdAt: _mc, updatedAt: _mu, source: _source, ...fields }) => fields,
            )
          : [];
        const document = parse(botExportSchema, {
          format: 'dsh-bot-export',
          version: 1,
          bot: portable,
          skillsManifest: r.includeSkills ? await this.files(bot.id) : [],
          memoryRecords,
          connectorTemplates: this.connectors
            .assignments()
            .filter((a) => a.bot.botId === bot.id && a.bot.botCreatedAt === bot.createdAt)
            .map((a) => ({ connectorId: a.connectorId, enabled: false })),
          channelTemplates: channels.map((c) => ({
            kind: c.kind,
            enabled: false,
          })),
        });
        if ((await this.bot(r.bot)).updatedAt !== bot.updatedAt) throw new OperationError('conflict');
        return workspaceResultSchema.parse({ kind: 'export', document });
      }
      if (r.action === 'preview' || r.action === 'previewMemories') {
        const document = parse(botExportSchema, r.document);
        const target = r.action === 'previewMemories' ? await this.bot(r.bot) : undefined;
        const newId = r.action === 'preview' ? r.newId : r.bot.botId;
        const sourceDigest = target
          ? digest(
              (await this.registry.memoryFor(target.id).snapshot(Number.MAX_SAFE_INTEGER)).sort((a, b) =>
                a.id.localeCompare(b.id),
              ),
            )
          : undefined;
        const refs = document.connectorTemplates.map((c) => c.connectorId),
          definitions = new Set(this.connectors.definitions().map((d) => d.id));
        const preview = importPreviewSchema.parse({
          id: `import:${randomUUID()}`,
          newId,
          digest: digest(document),
          files: target ? [] : document.skillsManifest.map((f) => f.path),
          scope: target ? 'memories' : 'bot',
          ...(r.action === 'previewMemories' ? { targetBot: r.bot, targetDigest: sourceDigest } : {}),
          memories: document.memoryRecords.length,
          connectorRefs: target ? [] : refs,
          missingConnectorRefs: target ? [] : refs.filter((id) => !definitions.has(id)),
          conflict: target ? false : await this.conflict(newId, document),
          phase: 'preview',
        });
        await this.domain.table('previews').put(preview.id, { preview, document });
        return workspaceResultSchema.parse({ kind: 'preview', preview });
      }
      const row = structuredClone(need(this.domain.table('previews').get(r.previewId)));
      if (row.preview.phase === 'committed')
        return workspaceResultSchema.parse({
          kind: 'preview',
          preview: row.preview,
        });
      if (
        row.preview.phase !== 'preview' ||
        (row.preview.scope === 'bot' && (await this.conflict(row.preview.newId, row.document)))
      )
        throw new OperationError('conflict');
      row.preview.phase = 'applying';
      await this.domain.table('previews').put(row.preview.id, row);
      if (row.preview.scope === 'memories') {
        await this.bot(need(row.preview.targetBot));
        try {
          await this.registry.memoryFor(row.preview.newId).saveBatch(row.document.memoryRecords, (records) => {
            if (
              digest(records.sort((a, b) => a.id.localeCompare(b.id))) !== row.preview.targetDigest ||
              this.registry.presetBot(row.preview.newId).createdAt !== row.preview.targetBot?.botCreatedAt
            )
              throw new OperationError('conflict');
          });
          row.preview.phase = 'committed';
        } catch {
          row.preview.phase = 'failed';
          await this.domain.table('previews').put(row.preview.id, row);
          throw new OperationError('recovery-needed');
        }
        await this.domain.table('previews').put(row.preview.id, row);
        return workspaceResultSchema.parse({
          kind: 'preview',
          preview: row.preview,
        });
      }
      const createdFiles: string[] = [];
      try {
        const root = botSkillsDirectory(row.preview.newId, this.registry.config);
        await safeDirectory(root);
        // Reserve files exclusively before publishing the new Bot. Cleanup only files created by this operation.
        for (const file of row.document.skillsManifest) {
          const target = contained(root, file.path);
          await safeDirectory(dirname(target));
          await writeFile(target, file.content, { flag: 'wx', mode: 0o600 });
          createdFiles.push(target);
        }
        const bot = await this.registry.create({
          ...row.document.bot,
          id: row.preview.newId,
          skills: { extraDirs: [] },
          mcpServers: [],
          channels: [],
        });
        row.preview.createdBot = { botId: bot.id, botCreatedAt: bot.createdAt };
        await this.domain.table('previews').put(row.preview.id, row);
        for (const m of row.document.memoryRecords)
          await this.registry.memoryFor(bot.id).save(m, { by: 'user', at: Date.now() });
        for (const connectorId of row.preview.connectorRefs.filter(
          (id) => !row.preview.missingConnectorRefs.includes(id),
        )) {
          await this.connectors.saveAssignment(
            {
              id: `import:${digest([row.preview.id, connectorId])}`,
              bot: row.preview.createdBot,
              connectorId,
              enabled: false,
            },
            0,
          );
        }
        row.preview.phase = 'committed';
        await this.domain.table('previews').put(row.preview.id, row);
        return workspaceResultSchema.parse({
          kind: 'preview',
          preview: row.preview,
        });
      } catch {
        row.preview.phase = 'failed';
        await this.domain.table('previews').put(row.preview.id, row);
        if (!row.preview.createdBot) for (const file of createdFiles) await unlink(file);
        throw new OperationError('recovery-needed');
      }
    });
  }
  close() {
    this.closing ??= (async () => {
      await this.queue.close();
      await this.domain.close();
    })();
    return this.closing;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotWorkspace: WorkspaceManagement;
  }
}
