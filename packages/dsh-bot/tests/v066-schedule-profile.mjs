import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { link, open, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { renderReminderFraming, renderRecurringReminderBatchFraming } from '@deepseek-ai/dsh-schedule';
import { LoopbackAdapter } from './deepening/loopback-adapter.mjs';

export const name = 'v066-schedule-probe';
export const inject = ['loader', 'llm', 'dshBots', 'agents', 'sessionController', 'sessionPersistence', 'sessions', 'schedule'];

const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const content = text => [{ type: 'text', text }];
const ambient = new Set(['agent-instructions', 'runtime-context', 'time-context', 'tmux-context']);
// This only recognizes the exact language of the pinned public encoders. The
// result can restrict input but cannot authorize a reminder or an action.
function decodeRenderedSchedule(message) {
  if (message.source?.kind !== 'schedule' || message.content?.length !== 1) return;
  const block = message.content[0];
  if (block.type !== 'text' || typeof block.text !== 'string' || Buffer.byteLength(block.text) > 262144) return;
  const lines = block.text.split('\n');
  const field = (line, prefix) => {
    if (!line?.startsWith(prefix)) throw new Error('Unexpected schedule framing');
    return line.slice(prefix.length);
  };
  try {
    const batch = lines.length === 3;
    if (!batch && lines.length !== 5) return;
    const raw = batch ? JSON.parse(field(lines[2], 'reminders_json: ')) : [{
      schedule_id: JSON.parse(field(lines[2], 'schedule_id_json: ')),
      occurrence_at: field(lines[3], 'occurrence_at: '),
      reminder_prompt: JSON.parse(field(lines[4], 'reminder_prompt_json: ')),
    }];
    if (!Array.isArray(raw) || !raw.length || raw.length > 64) return;
    const ids = new Set();
    const rows = raw.map(({ schedule_id: id, occurrence_at: occurrenceAt, reminder_prompt: prompt }) => {
      if (typeof id !== 'string' || !id || ids.has(id) || typeof occurrenceAt !== 'string'
        || new Date(occurrenceAt).toISOString() !== occurrenceAt || typeof prompt !== 'string') throw new Error('Invalid schedule row');
      ids.add(id);
      return { record: { id, prompt, scheduledAt: occurrenceAt }, occurrenceAt };
    });
    const framed = batch ? renderRecurringReminderBatchFraming(rows) : renderReminderFraming(rows[0].record);
    if (isDeepStrictEqual(content(framed), message.content)) return { batch, rows };
  } catch {
    return undefined;
  }
}
const occurrenceKey = ({ record, occurrenceAt }) => JSON.stringify([record.id, occurrenceAt]);
const promptDigest = ({ record }) => createHash('sha256').update(record.prompt).digest('hex');
function* orders(items) {
  if (!items.length) { yield []; return; }
  for (const [index, item] of items.entries())
    for (const rest of orders(items.filter((_, i) => i !== index))) yield [item, ...rest];
}
function verifiedOrder(message, matches) {
  if (!matches.length || matches.length > 3) return;
  const rows = matches.map(({ task, receipt }) => ({
    record: { ...task, prompt: receipt.prompt, scheduledAt: receipt.scheduledAt }, occurrenceAt: receipt.scheduledAt,
  }));
  if (matches.length === 1 && !['cron', 'every'].includes(matches[0].task.kind))
    return isDeepStrictEqual(message.content, content(renderReminderFraming(rows[0].record))) ? rows : undefined;
  // Compare whole structured content against the public encoder. Never parse a native framing or authorize from a canary.
  return [...orders(rows)].find(order => isDeepStrictEqual(message.content, content(renderRecurringReminderBatchFraming(order))));
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const rebind = config.suite === 'v066-schedule-rebind';
    const rebindAlone = config.suite === 'v066-schedule-rebind-alone';
    const privacy = rebind || rebindAlone || config.suite === 'v066-schedule-privacy';
    const hostEpoch = randomUUID();
    const life = new AbortController();
    const targets = new Map(), trace = [], requests = [], reminders = [];
    const observations = new Set();
    const track = work => {
      const handled = work.catch(async error => {
        if (!life.signal.aborted) await save('fixture-error.json', { error: String(error.stack ?? error), trace });
      });
      observations.add(handled);
      void handled.then(() => observations.delete(handled));
    };
    let phase;
    try { phase = JSON.parse(readFileSync(join(config.outputDir, 'next-phase.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const freshState = (label, options = {}) => ({
      label, tasks: [], watched: new Set(), tombstones: new Map(), inserted: [], quarantine: new Map(), ...options,
    });
    if (phase) {
      for (const row of [phase.alone ? undefined : phase, phase.crossDue].filter(Boolean))
        targets.set(row.sessionId, freshState(row.label, {
          subject: row.subject, tasks: [row.task], watched: new Set([row.task.id]),
        }));
      if (phase.control) {
        const { label, sessionId, due, healthy, future } = phase.control;
        targets.set(sessionId, freshState(label, {
          tasks: [due, healthy, future], user: 'Human input alongside an independent ordinary rebind control',
        }));
      }
    }
    const later = ms => delay(ms, undefined, { signal: life.signal });
    const until = async (f, label, timeout = 8000) => {
      const end = Date.now() + timeout;
      do {
        const result = await f();
        if (result) return result;
        await later(15);
      } while (Date.now() < end);
      throw new Error(`Timed out: ${label}`);
    };
    const save = async (name, data) => {
      const file = join(config.outputDir, name);
      await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
      await rename(`${file}.tmp`, file);
    };
    const persistIntent = async (name, data) => {
      const file = join(config.outputDir, name);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(data, null, 2));
        await handle.sync();
      } finally { await handle.close(); }
      // Publish the complete intent without replacing a previous attempt.
      try { await link(temporary, file); }
      finally { await unlink(temporary); }
      const directory = await open(config.outputDir, 'r');
      try { await directory.sync(); }
      finally { await directory.close(); }
    };
    class Adapter extends LoopbackAdapter {
      async *stream(options) {
        requests.push({ sessionId: options.sessionId, messages: options.messages });
        if (targets.get(options.sessionId)?.busy && requests.length) {
          const state = targets.get(options.sessionId);
          state.busyEntered = true;
          await until(() => !state.busy, 'release busy synthetic call');
        }
        yield* super.stream(options);
      }
    }
    const adapter = new Adapter(`http://127.0.0.1:${process.env.DP_MOCK_PORT}/capture`);
    const desktop = typeof ctx.schedule.edit === 'function';
    const history = (id, task) => ctx.schedule.history({ ...(desktop ? {} : { sessionId: id }), id: task.id, limit: 10 });
    const create = (id, title, prompt, timing) => desktop
      ? ctx.schedule.create({ title, prompt, timing, target: { kind: 'session', sessionId: id } }, id, life.signal)
      : ctx.schedule.create(id, { title, prompt, ...Object.fromEntries(Object.entries(timing).filter(([k]) => k !== 'kind')) }, life.signal);
    const remove = (id, task) => desktop
      ? ctx.schedule.edit({ action: 'delete', id: task.id }, id, life.signal)
      : ctx.schedule.delete({ sessionId: id, id: task.id }, life.signal);
    const getMatches = async (id, state, messageId) => (await Promise.all(state.tasks.map(async task => {
      const page = await history(id, task);
      const receipt = page.records?.find(row => row.messageId === messageId && (!desktop || row.targetSessionId === id));
      return receipt && typeof receipt.prompt === 'string' ? { task, receipt } : undefined;
    }))).filter(Boolean);
    const watchedRows = (decoded, state) => decoded?.rows.filter(row => state.watched.has(row.record.id)) ?? [];
    const hold = async (state, message, turn) => {
      state.quarantine.set(message.id, { message, turn });
      await save(`held-${state.label}.json`, [...state.quarantine.values()]);
    };
    async function observePrivacy(agent, state, message, rows, claim) {
      const read = async () => {
        const matches = await getMatches(agent.id, state, message.id);
        return rows.filter(({ record, occurrenceAt }) => matches.some(({ task, receipt }) =>
          task.id === record.id && (task.prompt === record.prompt
            || (state.rebindIntent?.scheduleId === task.id && state.rebindIntent.nextPrompt === record.prompt))
          && receipt.prompt === record.prompt
          && receipt.scheduledAt === occurrenceAt));
      };
      let matches = await read();
      claim.initialReceiptCount = matches.length;
      const deadline = Date.now() + 1100;
      while (matches.length !== rows.length && Date.now() < deadline) {
        await later(25);
        matches = await read();
      }
      claim.finalReceiptCount = matches.length;
      for (const row of matches) if (!reminders.some(r => r.label === state.label
        && r.id === row.record.id && r.scheduledAt === row.occurrenceAt)) reminders.push({
        label: state.label, id: row.record.id, messageId: message.id, scheduledAt: row.occurrenceAt,
      });
      if (matches.length !== rows.length) {
        claim.outcome = 'privacy-filtered-unknown';
        await hold(state, message, claim.turn);
      }
    }
    function removePureWatch(agent, state, message, kind) {
      const decoded = decodeRenderedSchedule(message), rows = watchedRows(decoded, state);
      if (!rows.length || rows.length !== decoded.rows.length || !agent.inbox.remove(message.id)) return false;
      if (kind === 'inserted-filter' && agent.status === 'idle') state.emptyWake = message.id;
      const claim = { kind, at: Date.now(), label: state.label, id: message.id, outcome: 'privacy-filtered-pure', exactFullContent: true };
      trace.push(claim);
      track(observePrivacy(agent, state, message, rows, claim));
      return true;
    }
    function filterInsertedWatch(agent, state, message) {
      const decoded = decodeRenderedSchedule(message), rows = watchedRows(decoded, state);
      if (!rows.length || rows.length !== decoded.rows.length) return;
      if (agent.status === 'idle') {
        try {
          // The native followup wake latches behind this maintenance reservation
          // and opens a turn only when real pending input is left.
          track(agent.runMaintenance(async () => { removePureWatch(agent, state, message, 'maintenance-filter'); }));
          return;
        } catch {
          // An existing maintenance reservation can also report idle.
        }
      }
      removePureWatch(agent, state, message, 'inserted-filter');
    }
    async function privacyReplacement(agent, state, message, claim) {
      const decoded = decodeRenderedSchedule(message);
      if (!decoded) {
        claim.outcome = 'privacy-unrecognized';
        await hold(state, message, claim.turn);
        return null;
      }
      const watched = watchedRows(decoded, state);
      claim.exactFullContent = true;
      if (watched.length) {
        claim.outcome = 'privacy-filtered';
        await observePrivacy(agent, state, message, watched, claim);
      }
      // Only accepted native input in the persisted Session is a duplicate
      // witness. An inbox event or observation ledger cannot stand in for it.
      const stored = await ctx.sessionPersistence.open(agent.id, 'read');
      let accepted;
      try {
        const { events } = await stored.read();
        accepted = new Map(events.filter(event => event.type === 'user/message')
          .flatMap(event => decodeRenderedSchedule(event.data)?.rows ?? [])
          .map(row => [occurrenceKey(row), promptDigest(row)]));
      } finally { await stored.close(); }
      const ordinary = decoded.rows.filter(row => !state.watched.has(row.record.id));
      const newOrdinary = ordinary.filter(row => {
        const key = occurrenceKey(row);
        if (!accepted.has(key)) return true;
        if (accepted.get(key) !== promptDigest(row)) {
          claim.conflictingOrdinary ??= [];
          claim.conflictingOrdinary.push({ id: row.record.id, scheduledAt: row.occurrenceAt });
        }
        return false;
      });
      claim.duplicateOrdinary = ordinary.length - newOrdinary.length;
      if (!watched.length && newOrdinary.length === ordinary.length) return message;
      if (!newOrdinary.length) return null;
      const text = decoded.batch ? renderRecurringReminderBatchFraming(newOrdinary) : renderReminderFraming(newOrdinary[0].record);
      return { ...message, content: content(text) };
    }
    const disposers = [
      ctx.llm.registerAdapter(['dp-loopback'], adapter),
      ctx.on('schedule/changed', () => trace.push({ kind: 'changed', at: Date.now() })),
      ctx.on('agent/created', ({ agent }) => {
        const state = targets.get(agent.id);
        if (!privacy || !phase || !state) return;
        for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep])
          removePureWatch(agent, state, message, 'restored-filter');
      }),
      ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        const state = targets.get(agent.id);
        if (!state || state.testingSplice || message.source.kind !== 'schedule') return;
        trace.push({ kind: 'inserted', label: state.label, id: message.id, source: message.source, at: Date.now() });
        state.inserted.push(message);
        if (state.user && !state.userId) {
          const input = user(state.user);
          state.userId = input.id;
          agent.inject(input);
        }
        if (privacy && !state.keepNativePending) filterInsertedWatch(agent, state, message);
      }),
      ctx.on('session/flush', async session => {
        const state = targets.get(session.id);
        if (!state?.inserted.length || !state.flushMode) return;
        if (state.flushMode === 'fail') {
          state.flushMode = undefined;
          trace.push({ kind: 'flush-refusal', label: state.label, at: Date.now() });
          throw new Error('Synthetic native flush refusal before receipt');
        }
        if (state.flushMode === 'delay') {
          state.flushMode = undefined;
          await later(400);
        }
      }),
      ctx.on('agent/pre-step', async (event, next) => {
        const { agent, messages, turn } = event, state = targets.get(agent.id);
        if (privacy && state?.emptyWake) {
          const id = state.emptyWake;
          state.emptyWake = undefined;
          if (!messages.length) {
            const decision = await next();
            if (decision.kind === 'enter' && decision.messages.every(m => ambient.has(m.source.kind))) {
              trace.push({ kind: 'empty-wake-blocked', label: state.label, id, turn });
              return { kind: 'reject' };
            }
            return decision;
          }
        }
        const scheduled = messages.filter(m => m.source.kind === 'schedule');
        if (!state || !scheduled.length || (privacy && !state.watched.size)) return next();
        const decision = await next(), replacements = new Map();
        for (const message of scheduled) {
          const initial = await getMatches(agent.id, state, message.id);
          const claim = { kind: 'pre-step', at: Date.now(), label: state.label, turn, id: message.id,
            inputIds: messages.map(m => m.id), source: message.source, nativeDecision: decision.kind,
            initialReceiptCount: initial.length, finalReceiptCount: initial.length };
          trace.push(claim);
          const tombstone = state.tombstones.get(message.id);
          if (privacy) {
            if (tombstone && isDeepStrictEqual(message.content, tombstone)) {
              claim.outcome = 'deleted-no-reminder';
              replacements.set(message.id, null);
            } else {
              replacements.set(message.id, await privacyReplacement(agent, state, message, claim));
            }
            continue;
          }
          let matches = initial, ordered = verifiedOrder(message, matches);
          const deadline = Date.now() + 1100;
          while (!ordered && !state.tombstones.has(message.id) && Date.now() < deadline) {
            await later(25);
            matches = await getMatches(agent.id, state, message.id);
            ordered = verifiedOrder(message, matches);
          }
          claim.finalReceiptCount = matches.length;
          claim.exactFullContent = Boolean(ordered);
          if (tombstone && isDeepStrictEqual(message.content, tombstone)) {
            claim.outcome = 'deleted-no-reminder';
            replacements.set(message.id, null);
          } else if (!ordered) {
            // Keep the exact original for bounded reconciliation. It has no authority and does not run.
            claim.outcome = 'unverified-hold';
            await hold(state, message, turn);
            replacements.set(message.id, null);
          } else {
            const watched = matches.filter(({ task }) => state.watched.has(task.id));
            for (const { task, receipt } of watched) reminders.push({
              label: state.label, id: task.id, messageId: receipt.messageId, scheduledAt: receipt.scheduledAt,
            });
            const watchIds = new Set(watched.map(({ task }) => task.id));
            if (!watchIds.size) continue;
            const normal = ordered.filter(({ record }) => !watchIds.has(record.id));
            claim.outcome = normal.length ? 'split-by-verified-native-renderer' : 'watch-only';
            replacements.set(message.id, normal.length ? { ...message, content: content(renderRecurringReminderBatchFraming(normal)) } : null);
          }
        }
        if (decision.kind === 'reject' || !replacements.size) return decision;
        const filtered = decision.messages.flatMap(m => replacements.has(m.id) ? replacements.get(m.id) ?? [] : [m]);
        if (!filtered.some(m => !ambient.has(m.source.kind))) return { kind: 'reject' };
        return { ...decision, messages: filtered };
      }, { prepend: true }),
    ];
    const run = (async () => {
      await ctx.loader.await();
      await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders().filter(p => p.id !== 'dp-loopback'), []);
      const groups = await until(() => ctx.get('dshBotGroups'), 'group service');
      const createBot = id => ctx.dshBots.create({ id, name: id, template: 'minimal', model: { provider: 'dp-loopback', model: 'fixture' } });
      const bind = async (label, id, options = {}) => {
        const agent = (await ctx.sessionController.resolveAgent(id)).agent;
        assert.ok(agent, `Could not resolve ${label}`);
        const state = targets.get(id) ?? freshState(label, options);
        state.agent = agent;
        targets.set(id, state);
        return state;
      };
      const main = async (label, options) => {
        const bot = await createBot(label);
        return bind(label, (await ctx.dshBots.openConversation(label)).sessionId, {
          ...options, subject: { kind: 'bot', id: bot.id, createdAt: bot.createdAt },
        });
      };
      const arm = async (state, suffix, timing, watched = true, extra = '') => {
        const prompt = `Synthetic ${state.label} ${suffix} [quotes " and newline\n] ${state.tasks.length}${extra}`;
        const result = await create(state.agent.id, suffix, prompt, timing);
        const task = result.record ?? result;
        assert.ok(task.id);
        state.tasks.push(task);
        if (watched) {
          if (privacy) await save('privacy-registrations.json', [...targets.values()].flatMap(target =>
            target.tasks.filter(row => target.watched.has(row.id) || row.id === task.id).map(row => ({
              subject: target.subject, sessionId: target.agent.id, scheduleId: row.id, prompt: row.prompt,
            }))));
          state.watched.add(task.id);
        }
        return task;
      };
      const report = () => ({ desktop, privacy, realModelRequests: 0, fixtureRequests: adapter.count, reminders, trace,
        scheduleWarnings: (ctx.logger.buffer ?? []).filter(message => message.type === 'warn'
          && typeof message.args[0] === 'string' && message.args[0].startsWith('schedule:')).map(message => message.args[0]),
        requestBodies: requests.map(r => ({ label: targets.get(r.sessionId)?.label, messages: r.messages })),
        targets: [...targets.values()].map(s => ({ label: s.label, id: s.agent.id, userId: s.userId,
          tasks: s.tasks, inserted: s.inserted.map(({ id, source, content }) => ({ id, source, content })) })) });
      const driveWithNativeChange = async state => create(state.agent.id, 'Native drive control', 'Not due during this probe',
        { kind: 'after', after_seconds: 86400 });
      const receiptCounts = async state => (await Promise.all(state.tasks.map(task => history(state.agent.id, task))))
        .map(page => page.records?.length ?? 0);
      const pendingOf = state => [...state.agent.inbox.nextTurn, ...state.agent.inbox.nextStep];
      const recordFields = (record, entry) => Object.fromEntries(Object.keys(record).map(key => [key, entry[key]]));
      const targetOf = row => desktop ? row.target?.sessionId : row.sessionId;
      const occurrenceReceipt = (page, state, task) => page.records?.find(row =>
        row.scheduledAt === task.scheduledAt && (!desktop || row.targetSessionId === state.agent.id));
      const rebindOne = async state => {
        const task = phase.task;
        const stillRegistered = () => {
          const rows = JSON.parse(readFileSync(join(config.outputDir, 'privacy-registrations.json'), 'utf8'));
          return rows.some(row => row.sessionId === state.agent.id && row.scheduleId === task.id
            && row.prompt === task.prompt && isDeepStrictEqual(row.subject, phase.subject));
        };
        assert.equal(stillRegistered(), true);
        const bot = await ctx.dshBots.get(phase.subject.id);
        assert.deepEqual(state.subject, { kind: 'bot', id: bot.id, createdAt: bot.createdAt });
        assert.equal((await ctx.dshBots.openConversation(bot.id)).sessionId, state.agent.id);
        const restore = trace.find(row => row.kind === 'restored-filter' && row.id === phase.queuedId);
        const old = state.quarantine.get(phase.queuedId)?.message;
        assert.ok(restore && old && isDeepStrictEqual(old.content, phase.queuedContent));
        assert.equal(phase.receiptCount, 0);
        assert.notEqual(phase.hostEpoch, hostEpoch);
        assert.ok(task.prompt.endsWith(`\nTransport lease ${phase.oldNonce}`));
        const row = (await ctx.schedule.catalog()).find(entry => entry.id === task.id);
        assert.ok(row && targetOf(row) === state.agent.id);
        const before = await history(state.agent.id, task);
        if (occurrenceReceipt(before, state, task)) return { status: 'already-delivered', before };
        assert.equal(row.status, 'active');
        assert.ok(Date.parse(row.scheduledAt) <= Date.now());
        const expected = desktop ? row.updatedAt : recordFields(task, row);
        if (desktop) {
          assert.equal(row.target.kind, 'session');
          assert.deepEqual(row.involvedSessionIds, [state.agent.id]);
          assert.equal(row.updatedAt, task.updatedAt);
        } else assert.deepEqual(expected, task);
        assert.equal(row.prompt, task.prompt);
        assert.equal(row.scheduledAt, task.scheduledAt);
        const newNonce = randomUUID();
        const nextPrompt = task.prompt.slice(0, -phase.oldNonce.length) + newNonce;
        const intent = { operationId: randomUUID(), hostEpoch, previousHostEpoch: phase.hostEpoch, previousMessageId: old.id,
          subject: phase.subject, sessionId: state.agent.id, scheduleId: task.id, occurrence: task.scheduledAt,
          oldNonce: phase.oldNonce, newNonce, expected, nextPrompt };
        await persistIntent('rebind-intent.json', intent);
        // Recheck after the durable intent. The native compare-and-swap owns the remaining race.
        const refreshed = await history(state.agent.id, task);
        if (occurrenceReceipt(refreshed, state, task)) return { status: 'already-delivered', before, refreshed };
        if (!stillRegistered()) return { status: 'registration-changed', before, refreshed };
        state.rebindIntent = intent;
        const result = desktop
          ? await state.agent.runMaintenance(async () => ctx.agents.withInitiator(state.agent, () =>
            ctx.schedule.edit({ action: 'update', id: task.id, expectedUpdatedAt: expected, patch: { prompt: nextPrompt } }, state.agent.id, life.signal)))
          : await ctx.schedule.update({ sessionId: state.agent.id, id: task.id, expected, prompt: nextPrompt }, life.signal);
        const status = result.code ?? (desktop ? 'committed' : result.updated ? 'committed' : 'unchanged');
        if (status === 'committed') {
          const record = desktop ? result : result.record;
          for (const key of ['id', 'kind', 'title', 'scheduledAt', 'afterSeconds'])
            assert.deepEqual(record[key], task[key]);
          assert.equal(record.prompt, nextPrompt);
          if (desktop) assert.deepEqual(record.target, row.target);
        }
        await persistIntent('rebind-receipt.json', { operationId: intent.operationId, status, result });
        return { status, intent, result };
      };
      if (phase?.alone) {
        const cross = await bind(phase.crossDue.label, phase.crossDue.sessionId);
        console.log('B4_WEB_READY');
        await later(6500);
        const after = await history(cross.agent.id, phase.crossDue.task);
        await Promise.all(observations);
        assert.equal(adapter.count, 0);
        await save('cold.json', { ...report(), phase, after, nativeMutations: 0, rebindEligibility: 'no-previous-pending' });
        return;
      }
      if (phase) {
        const state = await bind('crash-window', phase.sessionId);
        const pre = await history(state.agent.id, phase.task);
        const pending = pendingOf(state).map(m => m.id);
        if (privacy) for (const message of pendingOf(state)) removePureWatch(state.agent, state, message, 'bound-filter');
        const cross = await bind(phase.crossDue.label, phase.crossDue.sessionId);
        const control = phase.control ? await bind(phase.control.label, phase.control.sessionId) : undefined;
        const crossPre = await history(cross.agent.id, phase.crossDue.task);
        const before = (await ctx.schedule.catalog()).filter(row => [phase.task.id, phase.crossDue.task.id].includes(row.id));
        await save('cold-initial.json', { phase, pre, pending, before, crossPre, ...report() });
        console.log('B4_WEB_READY');
        await later(2500);
        const beforeControl = await history(state.agent.id, phase.task);
        const crossBeforeControl = await history(cross.agent.id, phase.crossDue.task);
        let transportRebind, controlsBefore;
        if (rebind) {
          const ids = new Set(control.tasks.map(task => task.id));
          controlsBefore = (await ctx.schedule.catalog()).filter(entry => ids.has(entry.id));
          transportRebind = await rebindOne(state);
        } else await driveWithNativeChange(state);
        await later(3000);
        const after = await history(state.agent.id, phase.task);
        const afterPending = pendingOf(state).map(m => m.id);
        const events = state.agent.session.snapshotEvents().filter(e =>
          ['user/message', 'turn/end', 'request/header'].includes(e.type));
        const crossAfter = await history(cross.agent.id, phase.crossDue.task);
        await Promise.all(observations);
        if (privacy) {
          assert.ok(requests.every(request => request.sessionId !== state.agent.id && request.sessionId !== cross.agent.id),
            'cold watch-only callbacks must not issue a context-only model request');
          assert.equal(afterPending.length, 0);
          assert.ok(trace.some(e => e.id === phase.queuedId && e.kind === 'restored-filter'));
          assert.equal(reminders.filter(r => [state.label, cross.label].includes(r.label)).length, 2);
        }
        let controls;
        if (rebind) {
          const { due, healthy, future } = phase.control;
          await control.agent.whenIdle();
          const dueHistory = await history(control.agent.id, due);
          const ids = new Set(control.tasks.map(task => task.id));
          const controlsAfter = (await ctx.schedule.catalog()).filter(entry => ids.has(entry.id));
          for (const task of [healthy, future])
            assert.deepEqual(controlsAfter.find(entry => entry.id === task.id), controlsBefore.find(entry => entry.id === task.id));
          assert.equal(dueHistory.records?.length, 1);
          const ordinaryRequests = requests.filter(request => request.sessionId === control.agent.id);
          assert.equal(ordinaryRequests.length, 1);
          const ordinaryText = ordinaryRequests[0].messages.filter(message => message.role === 'user').flatMap(message => message.content);
          assert.ok(ordinaryText.some(block => block.type === 'text' && block.text === control.user));
          assert.ok(ordinaryText.some(block => block.type === 'text' && block.text === renderReminderFraming(due)));
          assert.equal(after.records?.length, 1);
          assert.equal(after.records[0].scheduledAt, phase.task.scheduledAt);
          assert.equal(after.records[0].prompt, transportRebind.intent.nextPrompt);
          assert.notEqual(after.records[0].messageId, phase.queuedId);
          assert.equal(crossAfter.records?.length, 1);
          assert.equal(crossAfter.records[0].prompt, phase.crossDue.task.prompt);
          assert.equal(transportRebind.status, 'committed');
          assert.equal(state.inserted.length, 1, 'actor-scoped desktop update must not inject a management notice');
          controls = { before: controlsBefore, after: controlsAfter, dueHistory, exactHumanAndOrdinary: true,
            watchedNativeWrites: 1, noSecondWriteAfterReceipt: Boolean(occurrenceReceipt(crossAfter, cross, phase.crossDue.task)) };
        }
        const coldReplay = state.inserted.find(message => message.id === after.records?.[0]?.messageId);
        await save('cold.json', { ...report(), phase, pre, beforeControl, after, pending, afterPending, events,
          crossBeforeControl, crossAfter, transportRebind, controls,
          coldReplayBodyMatches: Boolean(coldReplay && isDeepStrictEqual(coldReplay.content, phase.queuedContent)) });
        return;
      }
      const prepareCrash = async (crash, crossDue, control) => {
        // Keep a busy native turn so the due message remains pending during the physical crash.
        // The flush hook blocks only the native acknowledgment; the real persistence listener still writes.
        void crash.agent.runMaintenance(async signal => {
          while (!signal.aborted && !life.signal.aborted) await later(200);
        }).catch(() => {});
        await save('crash-progress.json', { phase: 'maintenance' });
        const crossTask = await arm(crossDue, 'Cross outage due', { kind: 'after', after_seconds: 7 });
        if (control) control.due = await arm(control.state, 'Independent ordinary due', { kind: 'after', after_seconds: 7 }, false);
        const oldNonce = rebind ? randomUUID() : undefined;
        const crashTask = await arm(crash, 'Unacknowledged crash watch', { kind: 'after', after_seconds: 2 }, true,
          oldNonce ? `\nTransport lease ${oldNonce}` : '');
        const releaseCrash = ctx.on('session/flush', async session => {
          if (session.id !== crash.agent.id || !crash.inserted.length) return;
          const queued = crash.inserted[0];
          try {
            await save('crash-progress.json', { phase: 'native-flush', queuedId: queued.id });
            const persistedEvents = await until(async () => {
              const handle = await ctx.sessionPersistence.open(crash.agent.id, 'read');
              try {
                const stored = await handle.read();
                const eventTypes = stored.events.filter(e => JSON.stringify(e).includes(queued.id)).map(e => e.type);
                return eventTypes.length ? eventTypes : undefined;
              } finally { await handle.close(); }
            }, 'persisted pending inbox', 6000);
            const page = await history(crash.agent.id, crashTask);
            assert.equal(page.records?.length, 0);
            const evidence = { label: crash.label, sessionId: crash.agent.id, task: crashTask, queuedId: queued.id,
              queuedContent: queued.content, persistedEvents, receiptCount: page.records.length, fixtureRequests: adapter.count,
              subject: crash.subject, hostEpoch, oldNonce,
              crossDue: { label: crossDue.label, sessionId: crossDue.agent.id, subject: crossDue.subject, task: crossTask },
            };
            if (control) evidence.control = {
              label: control.state.label, sessionId: control.state.agent.id, healthy: control.healthy, future: control.future, due: control.due,
            };
            await save('next-phase.json', evidence);
            while (!life.signal.aborted) await later(200);
          } catch (error) {
            if (!life.signal.aborted) await save('fixture-error.json', { error: String(error.stack ?? error), trace });
          }
        });
        disposers.push(releaseCrash);
      };
      if (rebind || rebindAlone) {
        const cross = await main('watch-cross-due');
        if (rebindAlone) {
          console.log('B4_WEB_READY');
          const task = await arm(cross, 'Isolated cross outage due', { kind: 'after', after_seconds: 7 });
          await save('warm.json', report());
          await save('next-phase.json', {
            alone: true, fixtureRequests: adapter.count, crossDue: { label: cross.label, sessionId: cross.agent.id, subject: cross.subject, task },
          });
          return;
        }
        const crash = await main('crash-window', { keepNativePending: true });
        const ordinary = await main('rebind-ordinary-control');
        console.log('B4_WEB_READY');
        const healthy = await arm(ordinary, 'Already delivered ordinary control', { kind: 'after', after_seconds: 2 }, false);
        const future = await arm(ordinary, 'Future ordinary control', { kind: 'after', after_seconds: 86400 }, false);
        await until(async () => (await history(ordinary.agent.id, healthy)).records?.[0], 'healthy ordinary receipt');
        await ordinary.agent.whenIdle();
        assert.equal(adapter.count, 1);
        await save('warm.json', report());
        await prepareCrash(crash, cross, { state: ordinary, healthy, future });
        return;
      }
      const personal = await main('watch-personal', { flushMode: 'delay' });
      const alongside = privacy ? await main('watch-pure-with-user', { user: 'Native human beside a pure watch' }) : undefined;
      const members = await Promise.all(['watch-group-a', 'watch-group-b'].map(createBot));
      const group = await groups.create({ operationId: 'v066-schedule-group', name: 'Schedule P0', mode: 'mention', historyConfirmed: true,
        members: members.map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt })) });
      const groupState = await bind('watch-group', group.rootSessionId, { flushMode: 'delay',
        subject: { kind: 'group', id: group.id, createdAt: group.createdAt } });
      const normal = await main('native-normal');
      const mixed = await main('watch-mixed', { flushMode: 'delay', user: 'Native human mixed input' });
      const deletion = await main('watch-deletion', { busy: true, keepNativePending: true });
      const refused = await main('watch-refusal', { flushMode: 'fail', user: 'Native human refusal input' });
      const crash = await main('crash-window', { keepNativePending: true });
      const crossDue = await main('watch-cross-due');
      const after = { kind: 'after', after_seconds: 2 };
      console.log('B4_WEB_READY');
      await arm(personal, 'Personal watch', after);
      if (alongside) await arm(alongside, 'Pure watch with real user', after);
      await arm(groupState, 'Group watch', after);
      await arm(normal, 'Ordinary only', after, false);
      deletion.agent.followup(user('Busy synthetic deletion call'));
      await until(() => deletion.busyEntered, 'deletion target busy');
      const removed = await arm(deletion, 'Deleted watch', after);
      const deletedReceipt = await until(async () => (await history(deletion.agent.id, removed)).records?.[0], 'deleted reminder original receipt');
      const queued = [...deletion.agent.inbox.nextTurn, ...deletion.agent.inbox.nextStep].find(m => m.id === deletedReceipt.messageId);
      assert.ok(queued, 'native reminder still pending while model is busy');
      assert.ok(verifiedOrder(queued, [{ task: removed, receipt: deletedReceipt }]));
      deletion.tombstones.set(queued.id, queued.content);
      assert.equal((await remove(deletion.agent.id, removed)).deleted, true);
      assert.equal((await history(deletion.agent.id, removed)).code, 'schedule_not_found');
      const stillQueued = [...deletion.agent.inbox.nextTurn, ...deletion.agent.inbox.nextStep].some(m => m.id === queued.id);
      assert.ok(stillQueued, 'native deletion must not have removed the old message');
      deletion.busy = false;
      await deletion.agent.whenIdle();
      const deleted = { originalReceipt: deletedReceipt, historyAfterDelete: 'schedule_not_found', stillQueued };
      const due = new Date(Math.ceil((Date.now() + 5000) / 60000) * 60000);
      const cron = { kind: 'cron', cron: { expression: `${due.getUTCMinutes()} ${due.getUTCHours()} * * *`, time_zone: 'UTC' } };
      await arm(mixed, 'Mixed watch one', cron); await arm(mixed, 'Mixed ordinary', cron, false); await arm(mixed, 'Mixed watch two', cron);
      const refusedWatch = await arm(refused, 'Refused watch', cron);
      const nested = privacy ? renderReminderFraming({ ...refusedWatch, prompt: 'Synthetic nested framing is ordinary data' }) : '';
      if (privacy) refused.user += `\n${nested}`;
      const refusedOrdinary = await arm(refused, 'Refused ordinary', cron, false, privacy ? `\n${nested}` : '');
      const unknown = privacy ? 'privacy-filtered-unknown' : 'unverified-hold';
      const firstRefused = await until(() => trace.find(e => e.label === refused.label && e.outcome === unknown
        && refused.quarantine.has(e.id)), 'mixed receipt refusal', due.getTime() - Date.now() + 12000);
      await Promise.all([personal, groupState, normal, mixed, refused].map(s => s.agent.whenIdle()));
      if (alongside) await alongside.agent.whenIdle();
      const held = refused.quarantine.get(firstRefused.id).message;
      const refusedHistoryBeforeControl = await Promise.all(refused.tasks.map(t => history(refused.agent.id, t)));
      // Preserve the exact public Inbox message and native target without reissuing a new followup.
      // The native queue is held via maintenance so this test cannot race or wake a model.
      if (!privacy) await refused.agent.runMaintenance(async () => {
        refused.testingSplice = true;
        try {
          assert.equal(pendingOf(refused).some(m => m.id === held.id), false);
          refused.agent.inbox.splice('next-turn', 0, 0, [held]);
          assert.deepEqual(pendingOf(refused).find(m => m.id === held.id), held);
          assert.equal(await ctx.sessions.flush(refused.agent.session), true);
          assert.equal(refused.agent.inbox.remove(held.id), true);
          assert.equal(pendingOf(refused).some(m => m.id === held.id), false);
        } finally { refused.testingSplice = false; }
      });
      await driveWithNativeChange(normal);
      await until(async () => (await receiptCounts(refused)).every(n => n === 1), 'retry receipt after native management wake', 4000).catch(() => undefined);
      await refused.agent.whenIdle();
      const refusedHistory = await Promise.all(refused.tasks.map(t => history(refused.agent.id, t)));
      const retryReceipts = refusedHistory.flatMap((page, i) => (page.records ?? []).map(receipt => ({ task: refused.tasks[i], receipt })));
      const retryMessage = refused.inserted.find(message => message.id === retryReceipts[0]?.receipt.messageId);
      const retry = {
        heldMessageId: held.id, restoredAndRemovedExactInboxInput: !privacy,
        retryMessageId: retryMessage?.id, distinctMessageId: Boolean(retryMessage && held.id !== retryMessage.id),
        sameOccurrence: retryReceipts.length === 2 && retryReceipts.every(({ task, receipt }) => task.scheduledAt === receipt.scheduledAt),
        sameOriginalContent: Boolean(retryMessage && isDeepStrictEqual(held.content, retryMessage.content)),
        originalBodyVerifiedByNewReceipts: Boolean(verifiedOrder(held, retryReceipts)),
        beforeControl: refusedHistoryBeforeControl, afterControl: refusedHistory,
        events: refused.agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id),
      };
      if (privacy) {
        const committed = refused.agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data);
        const modelInputs = requests.filter(r => r.sessionId === refused.agent.id);
        const modeled = modelInputs.flatMap(r => r.messages.filter(message => message.role === 'user').flatMap(m => m.content));
        const ordinary = { record: refusedOrdinary, occurrenceAt: refusedOrdinary.scheduledAt };
        const expectedOrdinary = renderRecurringReminderBatchFraming([ordinary]);
        const admitted = committed.find(message => message.id === held.id);
        assert.equal(firstRefused.finalReceiptCount, 0);
        assert.equal(modelInputs.length, 1, 'native retry must not repeat the original ordinary request');
        assert.deepEqual(admitted?.content, content(expectedOrdinary));
        assert.deepEqual(admitted?.source, held.source);
        assert.ok(modeled.some(b => b.type === 'text' && b.text === expectedOrdinary), 'ordinary outer row and nested frame survive');
        assert.ok(modeled.some(b => b.type === 'text' && b.text === refused.user), 'same-step human text survives');
        assert.ok(modeled.every(b => b.type !== 'text' || !b.text.includes('Synthetic watch-refusal Refused watch')));
        assert.ok(trace.some(e => e.id === retryMessage?.id && e.duplicateOrdinary === 1));
        assert.ok(!reminders.some(r => r.messageId === held.id));
        assert.equal(reminders.filter(r => r.label === refused.label).length, 1);
        assert.ok(requests.every(r => r.sessionId !== personal.agent.id && r.sessionId !== groupState.agent.id),
          'pure reminders must not open a model request after removing their inbox input');
        const alongsideRequests = requests.filter(r => r.sessionId === alongside.agent.id);
        assert.equal(alongsideRequests.length, 1);
        const alongsideText = alongsideRequests[0].messages.filter(message => message.role === 'user').flatMap(m => m.content);
        assert.ok(alongsideText.some(b => b.type === 'text' && b.text === alongside.user));
        assert.ok(alongsideText.every(b => b.type !== 'text' || !b.text.includes('Pure watch with real user')));
        retry.privacy = { originalOrdinaryMessageId: admitted.id, modelRequests: modelInputs.length,
          preservedExactHumanAndOrdinary: true, originalWatchUnknown: true, retryDuplicateSuppressed: true };
      }
      let desktopNotice;
      if (privacy && desktop) {
        const before = new Set(mixed.inserted.map(message => message.id));
        await ctx.schedule.create({
          title: 'External management probe', prompt: 'Not due during this probe',
          timing: { kind: 'after', after_seconds: 86400 }, target: { kind: 'session', sessionId: mixed.agent.id },
        }, undefined, life.signal);
        const notice = await until(() => mixed.inserted.find(message => !before.has(message.id)), 'desktop management notice');
        mixed.agent.followup(user('Human input after native management notice'));
        await mixed.agent.whenIdle();
        desktopNotice = {
          messageId: notice.id, source: notice.source, content: notice.content,
          outcome: trace.find(e => e.id === notice.id && e.kind === 'pre-step')?.outcome,
        };
        assert.equal(desktopNotice.outcome, 'privacy-unrecognized');
      }
      for (const task of refused.tasks) await remove(refused.agent.id, task);
      await Promise.all(observations);
      await save('warm.json', { ...report(), deleted, retry, desktopNotice });

      await prepareCrash(crash, crossDue);
    })().catch(async error => {
      if (!life.signal.aborted) {
        await save('fixture-error.json', { error: String(error.stack ?? error), trace });
        console.error('B4_WEB_FAILED', error);
      }
    });
    return async () => {
      life.abort();
      for (const dispose of disposers.reverse()) dispose();
      await run;
      await Promise.all(observations);
    };
  });
}
