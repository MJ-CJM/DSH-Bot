import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'p34-memory-probes';
export const inject = [
  'loader',
  'dshBots',
  'dshBotAutomation',
  'dshBotReferenceMemory',
  'dshBotWorkspace',
  'typertGateway',
  'agents',
  'sessions',
  'sessionController',
  'subagents',
  'tools',
  'dshBotConnectors',
  'agentDefaultModel',
];
export function apply(ctx, config) {
  ctx.effect(() => {
    const nativeSpawn = childProcess.spawn;
    childProcess.spawn = function (...args) {
      const child = Reflect.apply(nativeSpawn, this, args);
      const argv = args[1];
      if (
        Array.isArray(argv) &&
        argv.some((value) => typeof value === 'string' && value.endsWith('/server-memory/dist/index.js'))
      ) {
        const memoryFile = args[2]?.env?.MEMORY_FILE_PATH;
        const botIdentity = memoryFile ? memoryFile.split('/').at(-2) : 'unknown';
        if (spawnedMemory.some((row) => !row.closed && row.botIdentity === botIdentity))
          writerOverlaps.push(botIdentity);
        const row = { pid: child.pid, closed: false, botIdentity };
        spawnedMemory.push(row);
        child.once('close', () => {
          row.closed = true;
        });
      }
      return child;
    };
    syncBuiltinESMExports();

    const abort = new AbortController();
    let stopping = false,
      peer;
    const save = (name, value) =>
      writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
    const wait = async (fn) => {
      const until = Date.now() + 60000;
      while (!stopping && Date.now() < until) {
        const value = await fn();
        if (value) return value;
        await delay(30);
      }
      throw new Error('Memory probe deadline');
    };
    const run = (async () => {
      await ctx.loader.await();
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      peer = new Peer(ctx, {
        principal: { kind: 'owner' },
        interactions: 'none',
      });
      const invoke = (namespace, input) =>
        ctx.typertGateway.invoke({
          namespace: `dshBot.${namespace}`,
          method: 'request',
          args: { input },
          peer,
          signal: abort.signal,
        });
      const graph = (input) => invoke('referenceMemory', input),
        transfer = (input) => invoke('workspace', input);
      const first = config.phase === 'first';
      if (first)
        for (const id of ['alpha', 'beta'])
          await ctx.dshBots.create({
            id,
            name: `Memory ${id}`,
            template: 'minimal',
            persona: { prefix: `Memory probe ${id}` },
          });
      const bots = await ctx.dshBots.list(),
        keys = Object.fromEntries(bots.map((b) => [b.id, { botId: b.id, botCreatedAt: b.createdAt }]));
      const mains = Object.fromEntries(
        await Promise.all(
          ['alpha', 'beta'].map(async (id) => [id, (await ctx.dshBots.openConversation(id)).sessionId]),
        ),
      );
      const bot = keys.alpha,
        beta = keys.beta;
      const path = (key, identity) => join(process.env.DSH_HOME, 'dsh-bot/memory', hashKey(key), `${identity}.jsonl`);
      if (first) {
        await ctx.dshBots.memoryFor('alpha').save(
          {
            kind: 'fact',
            content: 'Alpha likes oolong tea',
            tags: ['tea', '中文'],
            pinned: true,
          },
          { by: 'user', at: 123, sessionId: 'synthetic-provenance' },
        );
        await ctx.dshBots.memoryFor('alpha').save(
          {
            kind: 'preference',
            content: 'Keep all metadata',
            tags: ['metadata'],
            pinned: false,
          },
          { by: 'user', at: 456 },
        );
        const memoryFile = join(config.outputDir, 'storages/dsh_bot.json'),
          beforeBytes = await readFile(memoryFile, 'utf8');
        const a = await graph({
          action: 'configure',
          bot,
          mode: 'internal+reference-graph',
          expectedRevision: 0,
        });
        assert.equal(a.status.state, 'ready');
        const b = await graph({
          action: 'configure',
          bot: beta,
          mode: 'internal+reference-graph',
          expectedRevision: 0,
        });
        assert.equal(b.status.state, 'ready');
        const native = ctx.agents.get(mains.alpha);
        assert.ok(native);
        const call = (agent, tool, args) =>
          agent.ctx.tools.execute({
            agent,
            name: `mcp__bot_memory_graph__${tool}`,
            arguments: args,
            callId: ToolCallId(randomUUID()),
            signal: abort.signal,
          });
        const writes = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            call(native, 'create_entities', {
              entities: [
                {
                  name: `parallel-${i}`,
                  entityType: 'test',
                  observations: [`value-${i}`],
                },
              ],
            }),
          ),
        );
        assert.ok(writes.every((r) => !r.isError));
        const read = await graph({
          action: 'tool',
          bot,
          call: { tool: 'read_graph', arguments: {} },
        });
        assert.equal(read.graph.entities.length, 20);
        await graph({
          action: 'tool',
          bot: beta,
          call: {
            tool: 'create_entities',
            arguments: {
              entities: [
                {
                  name: 'parallel-0',
                  entityType: 'test',
                  observations: ['beta-only'],
                },
              ],
            },
          },
        });
        assert.ok(
          !JSON.stringify(
            (
              await graph({
                action: 'tool',
                bot,
                call: { tool: 'read_graph', arguments: {} },
              })
            ).graph,
          ).includes('beta-only'),
        );
        assert.equal(
          (
            await graph({
              action: 'tool',
              bot: beta,
              call: { tool: 'read_graph', arguments: {} },
            })
          ).graph.entities.length,
          1,
        );
        const ptc = native.ctx.plugin({name:'synthetic-ptc-presentation',inject:['tools','systemPrompt'],apply(owner){owner.tools.presentAs('ptc');}});
        await ptc.await();
        const unsupported = await graph({action:'apply',bot}); assert.equal(unsupported.status.reason,'unsupported'); assert.equal(unsupported.status.writer,false);
        await assert.rejects(() => graph({action:'tool',bot,call:{tool:'read_graph',arguments:{}}}));
        await ptc.dispose(); assert.equal((await graph({action:'apply',bot})).status.state,'ready');
        const copied = (await graph({ action: 'preview', bot })).copy;
        assert.equal(copied.records.length, 2);
        let batch = 0;
        const offFault = ctx.on(
          'tools/pre-execute',
          async (exec, next) => {
            if (
              exec.name === 'mcp__bot_memory_graph__create_entities' &&
              exec.arguments.entities?.[0]?.entityType === 'dsh-bot-memory-v1' &&
              ++batch === 2
            )
              return { kind: 'deny', reason: 'Synthetic half-batch failure' };
            return next();
          },
          { prepend: true },
        );
        await assert.rejects(() => graph({ action: 'stage', bot, copyId: copied.id }));
        offFault();
        const failed = (await graph({ action: 'status', bot })).status.copies.find((r) => r.id === copied.id);
        assert.equal(failed.phase, 'failed');
        assert.equal(failed.records[0].status, 'written');
        const staged = (await graph({ action: 'stage', bot, copyId: copied.id })).copy;
        assert.equal(staged.phase, 'verified');
        assert.ok(staged.records.every((r) => r.status === 'verified'));
        assert.deepEqual((await graph({ action: 'stage', bot, copyId: copied.id })).copy, staged);
        const committed = await graph({
          action: 'commit',
          bot,
          copyId: copied.id,
          confirmed: true,
        });
        assert.equal(committed.copy.phase, 'committed');
        await graph({ action: 'apply', bot });
        const imported = (
          await graph({
            action: 'tool',
            bot,
            call: { tool: 'read_graph', arguments: {} },
          })
        ).graph;
        assert.equal(imported.entities.length, 2);
        const envelope = JSON.parse(
          imported.entities.find((e) => JSON.parse(e.observations[0]).record.pinned).observations[0],
        );
        assert.equal(envelope.record.source.sessionId, 'synthetic-provenance');
        assert.equal(envelope.record.source.at, 123);
        assert.deepEqual(envelope.record.tags, ['tea', '中文']);
        assert.equal(await readFile(memoryFile, 'utf8'), beforeBytes);
        await graph({
          action: 'rollback',
          bot,
          copyId: copied.id,
          confirmed: true,
        });
        assert.equal(
          (
            await graph({
              action: 'tool',
              bot,
              call: { tool: 'read_graph', arguments: {} },
            })
          ).graph.entities.length,
          20,
        );
        assert.ok(
          (await readFile(path(bot, committed.status.binding.fileIdentity), 'utf8')).includes('dsh-bot-memory-record'),
        );
        // Concurrent source change blocks an otherwise verified pointer commit.
        const race = (await graph({ action: 'preview', bot })).copy;
        await graph({ action: 'stage', bot, copyId: race.id });
        await ctx.dshBots.memoryFor('alpha').save({
          kind: 'note',
          content: 'Concurrent source change',
          tags: [],
          pinned: false,
        });
        await assert.rejects(() => graph({ action: 'commit', bot, copyId: race.id, confirmed: true }));
        // Cancel preserves the staged file and current binding.
        await graph({
          action: 'rollback',
          bot,
          copyId: race.id,
          confirmed: true,
        });
        const fresh = (await graph({ action: 'preview', bot })).copy;
        await graph({ action: 'stage', bot, copyId: fresh.id });
        await graph({
          action: 'commit',
          bot,
          copyId: fresh.id,
          confirmed: true,
        });
        await graph({ action: 'apply', bot });
        // Exports exclude paths, provenance sessions and permission/connector/channel grants.
        const skillsRoot = join(config.outputDir, 'bots-data/bots/alpha/skills');
        await mkdir(join(skillsRoot, 'tea'), { recursive: true });
        await writeFile(join(skillsRoot, 'tea/SKILL.md'), '# Tea\nUse oolong.\n');
        const exported = await transfer({
          action: 'export',
          bot,
          includeSkills: true,
          includeMemories: true,
        });
        const serialized = JSON.stringify(exported);
        assert.ok(!serialized.includes(process.env.DSH_HOME));
        assert.ok(!serialized.includes(mains.alpha));
        assert.ok(!serialized.includes('synthetic-provenance'));
        const preview = await transfer({
          action: 'preview',
          newId: 'imported',
          document: exported.document,
        });
        assert.equal(preview.preview.conflict, false);
        const installed = await transfer({
          action: 'import',
          previewId: preview.preview.id,
          confirmed: true,
        });
        assert.equal(installed.preview.phase, 'committed');
        assert.equal((await ctx.dshBots.get('imported')).skills.extraDirs.length, 0);
        assert.equal((await ctx.dshBots.get('imported')).channels.length, 0);
        assert.equal(
          await readFile(join(config.outputDir, 'bots-data/bots/imported/skills/tea/SKILL.md'), 'utf8'),
          '# Tea\nUse oolong.\n',
        );
        assert.deepEqual(
          await transfer({
            action: 'import',
            previewId: preview.preview.id,
            confirmed: true,
          }),
          installed,
        );
        assert.equal(
          (
            await transfer({
              action: 'preview',
              newId: 'imported',
              document: exported.document,
            })
          ).preview.conflict,
          true,
        );
        await assert.rejects(() =>
          transfer({
            action: 'preview',
            newId: 'bad',
            document: {
              ...exported.document,
              skillsManifest: [{ path: '../escape', content: 'x' }],
            },
          }),
        );
        await assert.rejects(() =>
          transfer({
            action: 'preview',
            newId: 'bad',
            document: {
              ...exported.document,
              bot: { ...exported.document.bot, defaultCwd: '/machine/path' },
            },
          }),
        );
        await assert.rejects(() => graph({ action: 'status', bot, sessionId: mains.beta }));
        await symlink(join(skillsRoot, 'tea/SKILL.md'), join(skillsRoot, 'link.md'));
        await assert.rejects(() =>
          transfer({
            action: 'export',
            bot,
            includeSkills: true,
            includeMemories: false,
          }),
        );
        const receipt = await ctx.sessionController.prompt(
          {
            sessionId: mains.alpha,
            requestId: randomUUID(),
            mode: 'queue',
            content: [
              {
                type: 'text',
                text: 'P34_MEMORY_MODEL_ONLY search the reference graph for oolong and use its stored value.',
              },
            ],
          },
          abort.signal,
        );
        assert.equal(receipt.accepted, true);
        await native.whenIdle();
        assert.equal(await ctx.sessions.flush(native.session), true);
        assert.ok(native.session.snapshotEvents().some((e) => e.type === 'tool/result'));
        // Corruption is rejected without replacing the original bytes; recovery remains explicit.
        const betaStatus = (await graph({ action: 'status', bot: beta })).status;
        await graph({
          action: 'configure',
          bot: beta,
          mode: 'internal',
          expectedRevision: betaStatus.binding.revision,
        });
        const betaFile = path(beta, betaStatus.binding.fileIdentity),
          betaBytes = await readFile(betaFile, 'utf8');
        await writeFile(betaFile, '{broken graph');
        const broken = await graph({
          action: 'configure',
          bot: beta,
          mode: 'internal+reference-graph',
          expectedRevision: betaStatus.binding.revision + 1,
        });
        assert.equal(broken.status.state, 'unavailable');
        assert.equal(await readFile(betaFile, 'utf8'), '{broken graph');
        await writeFile(betaFile, betaBytes);
        assert.equal((await graph({ action: 'apply', bot: beta })).status.state, 'ready');
        const beforeUpdate = await ctx.dshBots.get('alpha');
        await ctx.dshBots.update('alpha', { description: 'Synthetic new preset generation' }, beforeUpdate.updatedAt);
        assert.equal((await ctx.dshBots.openConversation('alpha')).sessionId, mains.alpha);
        const activation = await ctx.subagents.startActivation({
          provider: 'spawn',
          delivery: 'caller',
          label: 'Same Bot worker',
          signal: abort.signal,
          request: {
            parent: native,
            agentPreset: 'bot-alpha',
            agentOptions: ctx.agentDefaultModel.currentSelection(),
            prompt: [{ type: 'text', text: 'P34_MEMORY_MODEL_ONLY same Bot worker retains internal memory only.' }],
            maxDepth: 1,
          },
        });
        try {
          const result = await activation.result;
          assert.equal(result.stopReason, 'completed');
        } finally {
          await activation.dispose();
        }
        const memoryPreview = await transfer({ action: 'previewMemories', bot: beta, document: exported.document });
        await transfer({ action: 'import', previewId: memoryPreview.preview.id, confirmed: true });
        assert.equal(await ctx.dshBots.memoryFor('beta').count(), 3);
        const repeatPreview = await transfer({ action: 'previewMemories', bot: beta, document: exported.document });
        await transfer({ action: 'import', previewId: repeatPreview.preview.id, confirmed: true });
        assert.equal(await ctx.dshBots.memoryFor('beta').count(), 3);
        const cancelCopy = (await graph({ action: 'preview', bot })).copy;
        let began;
        const beganWriting = new Promise((resolve) => {
          began = resolve;
        });
        const offCancel = ctx.on(
          'tools/pre-execute',
          async (exec, next) => {
            if (
              exec.name !== 'mcp__bot_memory_graph__create_entities' ||
              exec.arguments.entities?.[0]?.entityType !== 'dsh-bot-memory-v1'
            )
              return next();
            began();
            if (!exec.signal.aborted)
              await new Promise((resolve) => exec.signal.addEventListener('abort', resolve, { once: true }));
            return { kind: 'cancel' };
          },
          { prepend: true },
        );
        const cancelledStage = graph({ action: 'stage', bot, copyId: cancelCopy.id }).catch((error) => error);
        await beganWriting;
        const cancelled = await graph({ action: 'cancel', bot, copyId: cancelCopy.id, confirmed: true });
        await cancelledStage;
        offCancel();
        assert.equal(cancelled.copy.phase, 'rolled-back');
        await save('evidence', {
          ptcFailsClosed: true, concurrentCancellation: true,
          workerUsesInternalOnly: true,
          retainedGenerationMain: true,
          memoryBatchDeduplicated: true,
          halfBatchFailureResumed: true,
          loopbackModelTool: true,
          corruptionPreserved: true,
          parallelWrites: 20,
          independentBotFiles: true,
          nativeTools: true,
          metadataReadback: true,
          internalBytesUnchanged: true,
          rollbackRetainsBothFiles: true,
          sourceConflictRejected: true,
          idempotentStage: true,
          newBotImport: true,
          noOverwrite: true,
          traversalAndSymlinkRejected: true,
          portableExport: true,
          snapshotCount: (await ctx.dshBots.memoryFor('alpha').snapshot(20)).length,
        });
        await save('identity', {
          mains,
          bot,
          beta,
          binding: (await graph({ action: 'status', bot })).status.binding,
        });
      } else {
        const saved = JSON.parse(await readFile(resolve(config.outputDir, 'first-identity.json'), 'utf8'));
        assert.deepEqual(mains, saved.mains);
        const restored = await graph({
          action: 'tool',
          bot,
          call: { tool: 'read_graph', arguments: {} },
        });
        assert.equal(restored.graph.entities.length, 3);
        assert.equal(restored.status.binding.fileIdentity, saved.binding.fileIdentity);
        assert.equal((await ctx.dshBots.memoryFor('alpha').snapshot(20)).length, 3);
        await save('evidence', {
          sameMainIdentity: true,
          graphColdReadback: true,
          internalEntriesRetained: true,
          noAutomaticModelCalls: true,
        });
      }
      console.log('P34_MEMORY_READY');
      await wait(async () => {
        try {
          return await readFile(resolve(config.outputDir, `${config.phase}-finish`), 'utf8');
        } catch {
          return false;
        }
      });
      const subprocesses = ownMemoryPids();
      assert.ok(subprocesses.length >= 2);
      process.kill(subprocesses[0], 'SIGTERM');
      await wait(async () => !running(subprocesses[0]));
      // The disconnected public tool reports failure; an explicit apply closes the generation before reconnect.
      for (const key of [bot, beta]) {
        try {
          await graph({
            action: 'tool',
            bot: key,
            call: { tool: 'read_graph', arguments: {} },
          });
        } catch {
          /* disconnected generation */
        }
        await graph({ action: 'apply', bot: key });
      }
      await ctx.dshBotReferenceMemory.close();
      await wait(async () => [...subprocesses, ...ownMemoryPids()].every((pid) => !running(pid)));

      for (const main of Object.values(mains)) {
        const agent = ctx.agents.get(main);
        if (agent)
          assert.equal(
            agent.ctx.tools.schemas(agent).filter((t) => t.name.startsWith('mcp__bot_memory_graph__')).length,
            0,
          );
      }
      await save('disposed', {
        status: 'PASS',
        graphTools: 0,
        subprocesses: spawnedMemory,
        allSubprocessesExited: spawnedMemory.every((row) => row.closed),
        writerOverlaps,
      });
      assert.deepEqual(writerOverlaps, []);
      console.log('P34_MEMORY_DONE');
    })().catch(async (e) => {
      await save('failure', { error: String(e), stack: e.stack });
      console.log('P34_MEMORY_FAILED');
    });
    return async () => {
      stopping = true;
      abort.abort();
      await run;
      await peer?.dispose();
      childProcess.spawn = nativeSpawn;
      syncBuiltinESMExports();
    };
  });
}
// Same stable public-file identity derivation as the product; only synthetic keys enter this probe.
import { createHash } from 'node:crypto';
const hashKey = (key) =>
  createHash('sha256')
    .update(JSON.stringify([key.botId, key.botCreatedAt]))
    .digest('hex');

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const spawnedMemory = [];
const writerOverlaps = [];
function ownMemoryPids() {
  return spawnedMemory.filter((row) => !row.closed).map((row) => row.pid);
}
