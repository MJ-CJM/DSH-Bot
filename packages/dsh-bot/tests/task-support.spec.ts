import { expect, test, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DshBotRegistry } from '../src/host/registry.js';
import type { SupergroupWork } from '../src/shared/supergroup.js';
import { ciSourceId } from '../src/host/proactive/sources/ci.js';
import { TaskSupport } from '../src/host/supergroup/task-support.js';
import type { ConnectorRuntime } from '../src/shared/connectors.js';

function fixture() {
  let work: SupergroupWork = { id: 'work', revision: 1, owner: { botId: 'alpha', botCreatedAt: 1 },
    readers: [{ botId: 'alpha', botCreatedAt: 1 }, { botId: 'beta', botCreatedAt: 1 }],
    originSessionId: 'main', inputMessageId: 'input', inputMessageIds: ['input'], configDigest: 'config', createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 60000,
    group: { groupId: 'group', groupCreatedAt: 1 }, turnIds: [], state: 'partial', groupInputs: [], experts: [] };
  const events = [{ type: 'user/message', data: { id: 'input', source: { kind: 'user' }, content: [{ type: 'text', text: 'Exact original task' }] } }];
  const agent = { id: 'main', status: 'idle', session: { snapshotEvents: () => events }, followup: vi.fn(async () => {}) };
  let runtime: ConnectorRuntime[] = [{ assignmentId: 'assignment', sessionId: 'main', desiredRevision: 3, state: 'unavailable', reasonCode: 'missing-credential', toolCount: 0 }];
  let ciGate: Promise<void> | undefined, ciReads = 0;
  let generation = 3, enabled = true, botCreatedAt = 1, ciRevoked = false;
  const inherit = vi.fn(async (_id: string, _label: unknown) => {}), check = vi.fn(), applyIdle = vi.fn(async () => runtime);
  const ci = { id: 'ci-result', title: 'CI failed', context: { repository: 'owner/repo', branch: 'main', runId: '123', commit: 'a'.repeat(40), url: 'https://github.com/owner/repo/actions/runs/123' }, sourceId: ciSourceId({ repository: 'owner/repo', branch: 'main', generation: 5 }), sourceGeneration: 5, revision: 4, attempt: 1, job: 'build' };
  const services = {
    dshBotConnectors: { definitions: () => [], assignments: () => [{ id: 'assignment', bot: work.owner, enabled: true, desiredRevision: generation }], runtime: () => runtime, applyIdle },
    dshBotProactive: { ciCheckpoint: async () => { ciReads++; await ciGate; return { generation: 5, revoked: ciRevoked }; }, suggestions: async () => [ci] },
  };
  let failChangeAt = Number.POSITIVE_INFINITY, changeCalls = 0, changeError: Error | undefined;
  let failGetAt = Number.POSITIVE_INFINITY, getCalls = 0, getError: Error | undefined;
  const warn = vi.fn();
  const registry = { config: { proactiveCiFeed: { scope: { repository: 'owner/repo', branch: 'main', generation: 5 }, github: {} } },
    get: async () => {
      getCalls++;
      if (getError && getCalls >= failGetAt) throw getError;
      return { createdAt: botCreatedAt };
    }, memoryKernel: {}, memoryOutlets: {
      inherit, draft: (_outlet: unknown, _owner: unknown, _source: unknown, _id: unknown, target: unknown, content: string) => ({ target, content }), checker: { check },
    } } as unknown as DshBotRegistry;
  const ctx = { get: (key: keyof typeof services) => services[key], logger: { warn } } as unknown as Context;
  const support = new TaskSupport(ctx, registry, { read: () => structuredClone(work), enabled: () => enabled, valid: () => enabled,
    agent: async () => agent as unknown as Agent,
    change: async (_id, expected, update) => {
      changeCalls++;
      if (changeError && changeCalls >= failChangeAt) throw changeError;
      if (expected !== undefined && expected !== work.revision) throw new Error('CAS');
      const value = update(work);
      if (value !== work) work = structuredClone({ ...value, revision: work.revision + 1 });
      return work;
    } });
  return { support, agent, events, check, inherit, applyIdle, ci, warn,
    work: () => structuredClone(work), mutate: (patch: Partial<SupergroupWork>) => { work = { ...work, ...patch }; },
    ready: () => { runtime = [{ ...runtime[0]!, state: 'ready', appliedRevision: generation, desiredRevision: generation }]; },
    generation: (value: number) => { generation = value; runtime = [{ ...runtime[0]!, desiredRevision: value }]; },
    pauseCi: (gate: Promise<void>) => { ciGate = gate; }, ciReads: () => ciReads,
    missingRuntime: () => { runtime = []; },
    disconnect: () => { runtime = [{ ...runtime[0]!, state: 'unavailable', reasonCode: 'missing-credential' }]; },
    revoke: () => { ciRevoked = true; }, replaceBot: () => { botCreatedAt++; }, disable: () => { enabled = false; },
    failNextChangeAfter: (after: number, error: Error) => { changeCalls = 0; failChangeAt = after + 1; changeError = error; },
    failRegistryGetAfter: (after: number, error: Error) => { getCalls = 0; failGetAt = after + 1; getError = error; } };
}
const file = (revision: number) => ({ workId: 'work', expectedRevision: revision, operationId: 'file-op', question: 'Compare the documented options',
  source: { kind: 'file' as const, name: 'options.md', text: 'Option A: cost 10\nOption B: cost 20' } });

test('reading pending blockers never resolves them; ready requires the exact applied generation', async () => {
  const f = fixture();
  const first = await f.support.view('work'); expect(first.blockers).toHaveLength(1); expect(first.blockers[0]?.state).toBe('waiting');
  const reread = await f.support.view('work'); expect(reread.revision).toBe(first.revision); expect(reread.blockers[0]?.state).toBe('waiting');
  f.ready(); expect((await f.support.view('work')).blockers[0]?.state).toBe('ready');
  f.generation(4);
  const changed = await f.support.view('work'); expect(changed.blockers.map(row => row.state)).toEqual(['superseded', 'waiting']);
});

test('selected file keeps question, exact bytes, digest and fixed readers; idempotent writes do not duplicate', async () => {
  const f = fixture(), before = await f.support.view('work'), input = file(before.revision);
  const result = await f.support.add(input), duplicate = await f.support.add(input);
  expect(result.materials).toHaveLength(1); expect(duplicate.materials).toEqual(result.materials);
  expect(result.materials[0]).toMatchObject({ name: 'options.md', question: input.question, text: input.source.text, readers: f.work().readers });
  expect(f.check).toHaveBeenCalledTimes(2);
  expect(f.inherit.mock.calls[0]?.[0]).toMatch(/^task-material-[a-f0-9]{64}$/);
  expect(await f.support.text(f.work(), 'Original question')).toContain(input.source.text.replaceAll('\n', '\\n'));
  await expect(f.support.add({ ...input, question: 'Changed body' })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
});

test('only exact real original text and current configured CI observations can be admitted', async () => {
  const f = fixture(), before = await f.support.view('work');
  await expect(f.support.add({ workId: 'work', expectedRevision: before.revision, operationId: 'forged', question: 'Review', source: { kind: 'input-text', messageId: 'missing', version: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  const source = before.inputs[0]!;
  await f.support.add({ workId: 'work', expectedRevision: before.revision, operationId: 'real-input', question: 'Review', source: { kind: 'input-text', messageId: source.messageId, version: source.version } });
  f.events[0]!.data.content[0]!.text = 'Changed transcript';
  await expect(f.support.text(f.work(), 'Review')).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  const ci = fixture(), view = await ci.support.view('work'), selected = view.ci[0]!;
  expect(view.ci[0]?.citation).toMatch(/^https:\/\/github.com\//);
  await ci.support.add({ workId: 'work', expectedRevision: view.revision, operationId: 'ci-op', question: 'Why did this fail?', source: { kind: 'github-ci', id: selected.id, version: selected.version } });
  ci.revoke(); await expect(ci.support.text(ci.work(), 'Review')).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
});

test('credential and existing no-egress checks reject persistence and execution', async () => {
  const f = fixture(), view = await f.support.view('work');
  await expect(f.support.add({ ...file(view.revision), source: { kind: 'file', name: 'secret.txt', text: `ghp_${'a'.repeat(30)}` } })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
  f.check.mockImplementation(() => { throw new Error('no-egress'); });
  await expect(f.support.add(file(view.revision))).rejects.toThrow('no-egress');
  expect(f.work().materials).toBeUndefined(); expect(f.agent.followup).not.toHaveBeenCalled();
});

test('continuation waits for readiness, preserves exact original identity, queues once and blocks a second operation', async () => {
  const f = fixture(), first = await f.support.view('work');
  const input = { workId: 'work', expectedRevision: first.revision, operationId: 'resume-op', text: 'Continue comparing costs', blockerIds: first.blockers.map(row => row.id) };
  await expect(f.support.resume(input)).rejects.toMatchObject({ code: 'dsh-bot/unavailable' }); expect(f.agent.followup).not.toHaveBeenCalled();
  f.ready(); const ready = await f.support.view('work'), valid = { ...input, expectedRevision: ready.revision };
  const result = await f.support.resume(valid); expect(result.resumes[0]?.state).toBe('queued'); expect(result.blockers[0]?.state).toBe('continued');
  expect(f.agent.followup).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.agent.followup.mock.calls)).not.toContain('workId=');
  await f.support.resume(valid); expect(f.agent.followup).toHaveBeenCalledTimes(1);
  await expect(f.support.resume({ ...valid, operationId: 'duplicate-new-op', expectedRevision: result.revision })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
});

test('lost native response persists unknown and never retries; changed input and revoked identity refuse continuation', async () => {
  const f = fixture(); f.ready(); const first = await f.support.view('work');
  f.agent.followup.mockRejectedValue(new Error('transport disconnected'));
  const input = { workId: 'work', expectedRevision: first.revision, operationId: 'unknown-op', text: 'Continue', blockerIds: [] };
  const result = await f.support.resume(input); expect(result.resumes[0]?.state).toBe('unknown');
  await f.support.resume(input); expect(f.agent.followup).toHaveBeenCalledTimes(1);
  const changed = fixture(); changed.ready(); const view = await changed.support.view('work');
  changed.events.push({ ...changed.events[0]!, data: { ...changed.events[0]!.data, id: 'new-unrelated-input' } });
  await expect(changed.support.resume({ ...input, expectedRevision: view.revision })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  changed.replaceBot(); await expect(changed.support.view('work')).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  f.disable(); await expect(f.support.view('work')).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
});


test.each(['missing-runtime', 'wrong-applied-generation'] as const)('enabled assignment %s remains waiting and cannot dispatch', async condition => {
  const f = fixture(); f.ready();
  if (condition === 'missing-runtime') f.missingRuntime(); else f.generation(4);
  const view = await f.support.view('work');
  expect(view.blockers.some(row => row.state === 'waiting')).toBe(true);
  await expect(f.support.resume({ workId: 'work', expectedRevision: view.revision, operationId: condition, text: 'Continue', blockerIds: [] })).rejects.toMatchObject({ code: 'dsh-bot/unavailable' });
  expect(f.agent.followup).not.toHaveBeenCalled();
});

test('credential removal after continuation creates a new pending item in the same assignment generation', async () => {
  const f = fixture(); const waiting = await f.support.view('work'); f.ready();
  const ready = await f.support.view('work');
  const queued = await f.support.resume({ workId: 'work', expectedRevision: ready.revision, operationId: 'first-ready-resume', text: 'Continue', blockerIds: ready.blockers.map(row => row.id) });
  expect(queued.blockers[0]?.state).toBe('continued');
  f.disconnect(); const next = await f.support.view('work');
  const fresh = next.blockers.find(row => row.state === 'waiting');
  expect(fresh).toBeDefined(); expect(fresh?.id).not.toBe(waiting.blockers[0]?.id);
  expect(fresh?.desiredRevision).toBe(waiting.blockers[0]?.desiredRevision);
});


test('concurrent view polling never overwrites admitted material after a delayed source read', async () => {
  const f = fixture(), initial = await f.support.view('work');
  let release!: () => void; f.pauseCi(new Promise(resolve => { release = resolve; }));
  const before = f.ciReads(), delayed = f.support.view('work');
  await vi.waitFor(() => expect(f.ciReads()).toBeGreaterThan(before));
  const adding = f.support.add(file(initial.revision));
  await vi.waitFor(() => expect(f.work().materials).toHaveLength(1));
  const committedRevision = f.work().revision; release();
  const [oldView, added] = await Promise.all([delayed, adding]);
  expect(oldView.revision).toBeLessThan(committedRevision);
  expect(added.materials).toHaveLength(1); expect(f.work().materials).toHaveLength(1);
  expect(f.work().revision).toBe(committedRevision);
});

test('concurrent duplicate material and resume operations reserve exactly once', async () => {
  const f = fixture(), initial = await f.support.view('work'), input = file(initial.revision);
  const admitted = await Promise.all([f.support.add(input), f.support.add(input)]);
  expect(admitted[0].materials).toHaveLength(1); expect(f.work().materials).toHaveLength(1);
  f.ready(); const ready = await f.support.view('work');
  const resume = { workId: 'work', expectedRevision: ready.revision, operationId: 'concurrent-resume', text: 'Continue', blockerIds: ready.blockers.map(row => row.id) };
  await Promise.all([f.support.resume(resume), f.support.resume(resume)]);
  expect(f.work().resumes).toHaveLength(1); expect(f.agent.followup).toHaveBeenCalledTimes(1);
});

test('unknown continuation only reconciles exact native user-message evidence and never dispatches again', async () => {
  const f = fixture(); f.ready();
  const before = await f.support.view('work');
  f.agent.followup.mockImplementationOnce(() => { throw new Error('unknown after dispatch'); });
  const input = { workId: 'work', expectedRevision: before.revision, operationId: 'reconcile-op', text: 'Continue with the exact evidence', blockerIds: before.blockers.filter(r => r.state === 'ready').map(r => r.id) };
  await f.support.resume(input);
  const receipt = f.work().resumes![0]!;
  expect(receipt.state).toBe('unknown');
  expect((await f.support.view('work')).resumes[0]?.state).toBe('unknown');
  f.events.push({ type: 'user/message', data: { id: receipt.messageId, source: { kind: 'user' }, content: [{ type: 'text', text: input.text }] } });
  expect((await f.support.view('work')).resumes[0]?.state).toBe('queued');
  await f.support.view('work'); expect(f.agent.followup).toHaveBeenCalledTimes(1);
});

test('post-persistence view/change errors in add() and resume() normalize to recovery-needed with redacted logs (#57)', async () => {
  const sentinel = 'TASK-SUPPORT-SECRET-SENTINEL';
  const poisoned = Object.assign(new Error(`storage failed: ${sentinel}`), {
    name: `Poisoned-${sentinel}`,
    code: `POISONED-${sentinel}`,
  });

  // add(): material persists, then post-commit view() fails.
  const fAdd = fixture();
  const initial = await fAdd.support.view('work');
  // 1st owner.change persists material; view() calls owner.change right after.
  fAdd.failNextChangeAfter(1, poisoned);
  await expect(fAdd.support.add(file(initial.revision))).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
  expect(fAdd.work().materials).toHaveLength(1);
  expect(fAdd.warn).toHaveBeenCalledWith('[dsh-bot] Task material persisted; confirmation failed', {
    workId: 'work', phase: 'view', errorName: 'unknown',
  });
  expect(JSON.stringify(fAdd.warn.mock.calls)).not.toContain(sentinel);
  // Idempotent replay while view() still fails also normalizes to recovery-needed.
  fAdd.failNextChangeAfter(0, poisoned);
  await expect(fAdd.support.add(file(initial.revision))).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
  expect(fAdd.work().materials).toHaveLength(1);

  // resume(): receipt persists, dispatch fails, and marking unknown fails.
  const fResume = fixture();
  fResume.ready();
  const ready = await fResume.support.view('work');
  fResume.agent.followup.mockRejectedValueOnce(poisoned);
  // view() inside resume() performs 2 owner.change calls, then persist is the 3rd; fail the 4th (mark-unknown).
  fResume.failNextChangeAfter(3, poisoned);
  await expect(fResume.support.resume({
    workId: 'work', expectedRevision: ready.revision, operationId: 'resume-post-persist',
    text: 'Continue safely', blockerIds: ready.blockers.map(r => r.id),
  })).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
  expect(fResume.work().resumes).toHaveLength(1);
  expect(fResume.agent.followup).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(fResume.warn.mock.calls)).not.toContain(sentinel);
  expect(fResume.warn).toHaveBeenCalledWith('[dsh-bot] Task resume persisted; confirmation failed', {
    workId: 'work', phase: 'mark-unknown', errorName: 'unknown',
  });

  // resume(): dispatch succeeds and queued persists, then final view() fails.
  const fResumeView = fixture();
  fResumeView.ready();
  const readyView = await fResumeView.support.view('work');
  // 2 changes in pre-resume view, 1 persist, 1 finalize -> fail 5th (final view()).
  fResumeView.failNextChangeAfter(4, poisoned);
  await expect(fResumeView.support.resume({
    workId: 'work', expectedRevision: readyView.revision, operationId: 'resume-view-fail',
    text: 'Continue safely', blockerIds: readyView.blockers.map(r => r.id),
  })).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
  expect(fResumeView.work().resumes?.[0]?.state).toBe('queued');
  expect(JSON.stringify(fResumeView.warn.mock.calls)).not.toContain(sentinel);
});
