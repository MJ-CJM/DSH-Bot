import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import type * as Core from '../../vendor/superagent/src/core/index.ts';

type Settings = {
  paused: boolean;
  sources: Record<string, { enabled: boolean; config: Record<string, unknown> }>;
  policy: { rules: Array<{ id: string; name: string; enabled: boolean; instruction: string }>;
    sources: Record<string, { allowed: Array<{ id: string }>; admission: Record<string, Record<string, string>> }> };
  eval: { mode: 'observe' | 'auto' | 'off'; timeoutSeconds: number; model: null };
  executor: { model: null; maxWorkers: number; directory: string; prepare: string; blockedCommands: string[] };
};
type Assessment = {
  decision: 'accept'; title: string; scope: string; reason: string; intent_evidence: string;
  rule_assessments: Array<{ rule_id: string; matched: boolean; reason: string }>;
  direction: { implementation_requested: boolean; target_basis: 'specified'; requires_design_decision: boolean; evidence: string };
};
type Artifact = typeof Core & {
  settingsPolicy(settings: Settings, scope: Core.SourceScope): Core.Policy;
  assessmentOutcome(assessment: Assessment, settings: Settings, strength: Core.Strength): Core.AssessmentOutcome;
};

/** Exact pinned core and policy bundle, stub ports only. No Host, model, network, or production mutation. */
export async function runSemantics(artifactPath: string) {
  const api = await import(pathToFileURL(artifactPath).href) as Artifact;
  const assertions: Array<{ id: string; layer: 'UNIT'; status: 'PASS' | 'FAIL'; detail: string }> = [];
  const snapshots: Record<string, unknown> = {};
  const check = (id: string, run: () => void) => {
    try { run(); assertions.push({ id, layer: 'UNIT', status: 'PASS', detail: 'Pinned upstream implementation; deterministic substitute ports.' }); }
    catch (error) { assertions.push({ id, layer: 'UNIT', status: 'FAIL', detail: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  };
  const assessment: Assessment = { decision: 'accept', title: 'Fix specified typo', scope: 'One fixture string', reason: 'Specified target',
    intent_evidence: 'Please fix this exact typo', rule_assessments: [{ rule_id: 'fixture', matched: true, reason: 'Exact requested target' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Known fixture target' } };
  const fixture = (mode: Settings['eval']['mode'] = 'observe') => {
    const settings: Settings = { paused: false, sources: { fixture: { enabled: true, config: {} } },
      policy: { rules: [{ id: 'fixture', name: 'Fixture', enabled: true, instruction: 'One fixed string' }],
        sources: { fixture: { allowed: [{ id: 'person' }], admission: { all: { listedUnaddressed: 'inferred', unlistedUnaddressed: 'inferred' } } } } },
      eval: { mode, timeoutSeconds: 120, model: null },
      executor: { model: null, maxWorkers: 1, directory: '', prepare: '', blockedCommands: [] } };
    const repo = new api.MemoryRepositories();
    const ports = { assessments: [] as Core.Candidate[], starts: [] as string[], deliveries: [] as string[], stops: [] as string[], events: [] as Core.DomainEvent[] };
    const scope: Core.SourceScope = { scope: () => ({ listened: true, observed: true, row: 'all' }) };
    let clock = Date.parse('2026-11-07T12:00:00.000Z');
    const now = () => new Date(clock).toISOString();
    const engine = new api.Engine({ repo, scope, policy: () => api.settingsPolicy(settings, scope), now,
      assessor: { request: c => ports.assessments.push(c), release: () => {} },
      executor: { start: (_t, a) => ports.starts.push(a.id), deliver: (_t, a) => ports.deliveries.push(a.id), stop: (_t, a) => ports.stops.push(a.id) },
      outbox: { send: () => { throw new Error('Unexpected outbound message'); }, status: () => undefined, withdraw: () => {} },
      emit: event => ports.events.push(event) });
    const trigger = (id: string, explicit = true, human = true): Core.Trigger => ({ id, source: 'fixture', threads: [{ source: 'fixture', id: 'thread' }],
      actor: { source: 'fixture', id: human ? 'person' : '' }, human, ...(explicit && human ? { addressed: 'mention' as const } : {}), at: now(), text: 'Please fix specified typo', meta: {} });
    const create = () => {
      engine.receive(trigger('origin')); engine.evaluateDue();
      const candidate = engine.candidate('origin');
      assert(candidate, 'Expected the origin candidate');
      const decision = engine.decide('origin', { ...api.assessmentOutcome(assessment, settings, candidate.strength), evalId: candidate.evalId });
      assert.equal(decision.kind, 'accept'); assert.ok(decision.ticketId);
      const id = decision.ticketId;
      const assignment = repo.tickets.get(id)?.assignments[0];
      assert(assignment, 'Expected the first assignment');
      engine.assignmentStarted(id, assignment.id);
      return id;
    };
    return { settings, repo, ports, engine, trigger, create, tick: () => { clock += 1000; }, now };
  };
  const errorCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === code);

  check('C01-observe-still-evaluates-and-projects-would-accept', () => {
    const f = fixture(); f.engine.receive(f.trigger('inferred', false)); f.engine.evaluateDue();
    assert.equal(f.ports.assessments.length, 1);
    const candidate = f.engine.candidate('inferred');
    assert(candidate, 'Expected the inferred candidate');
    assert.equal(candidate.strength, 'inferred');
    const outcome = api.assessmentOutcome(assessment, f.settings, candidate.strength);
    const decision = f.engine.decide('inferred', { ...outcome, evalId: candidate.evalId });
    assert.equal(decision.kind, 'ignore'); assert.equal(decision.audit?.would_accept, true);
    assert.deepEqual(decision.audit?.proposal, { title: assessment.title, scope: assessment.scope, worktree_name: undefined });
    assert.equal(f.repo.tickets.list().length, 0); assert.equal(f.ports.starts.length, 0);
    snapshots.observe = { decision, assessorRequests: f.ports.assessments.length, executorStarts: f.ports.starts.length };
  });
  check('C02-observe-explicit-request-still-executes', () => {
    const f = fixture(); const id = f.create();
    assert.equal(f.repo.tickets.get(id)?.mandate.strength, 'explicit'); assert.equal(f.ports.starts.length, 1);
  });
  check('C03-observe-inferred-direct-accept-refused', () => {
    const f = fixture(); f.engine.receive(f.trigger('inferred', false)); f.engine.evaluateDue();
    errorCode(() => f.engine.decide('inferred', { kind: 'accept', title: 'Bad bypass', scope: 'fixture', reason: 'bypass', rules: ['fixture'] }), 'notExplicit');
    assert.equal(f.repo.tickets.list().length, 0); assert.equal(f.ports.starts.length, 0);
  });
  check('C04-auto-inferred-accept-idempotent', () => {
    const f = fixture('auto'); f.engine.receive(f.trigger('inferred', false)); f.engine.evaluateDue();
    const outcome = api.assessmentOutcome(assessment, f.settings, 'inferred');
    const one = f.engine.decide('inferred', outcome), two = f.engine.decide('inferred', outcome);
    assert.equal(one.id, two.id); assert.equal(f.repo.tickets.list().length, 1); assert.equal(f.ports.starts.length, 1);
  });
  check('C05-stale-policy-unavailable-without-execution', () => {
    const f = fixture(); f.engine.receive(f.trigger('origin')); f.engine.evaluateDue();
    const candidate = f.engine.candidate('origin');
    assert(candidate, 'Expected the origin candidate');
    const rule = f.settings.policy.rules[0];
    assert(rule, 'Expected the fixture rule');
    rule.instruction = 'New scope';
    const d = f.engine.decide('origin', { ...api.assessmentOutcome(assessment, f.settings, 'explicit'), evalId: candidate.evalId });
    assert.equal(d.kind, 'unavailable'); assert.equal(d.reason[0]?.code, 'policyChanged'); assert.equal(f.ports.starts.length, 0);
  });
  check('C06-stale-eval-id-refused', () => {
    const f = fixture(); f.engine.receive(f.trigger('origin')); f.engine.evaluateDue();
    const candidate = f.engine.candidate('origin');
    assert(candidate, 'Expected the origin candidate');
    f.engine.decide('origin', { kind: 'ignore', reason: 'No action', evalId: candidate.evalId });
    errorCode(() => f.engine.decide('origin', { ...api.assessmentOutcome(assessment, f.settings, 'explicit'), evalId: candidate.evalId }), 'evalFinished');
  });
  check('C07-ready-without-follow-ended-is-not-acceptance', () => {
    const f = fixture(); const id = f.create(); f.tick();
    const t = f.engine.report(id, { state: 'ready', summary: 'Worker claims done' });
    assert.equal(t.ended?.by, 'executor'); assert.equal(t.ended?.outcome, 'completed');
    assert.deepEqual(api.ticketStage(t), { stage: 'ended' }); assert.equal(t.assignments[0]?.state, 'ended');
    assert.equal('acceptance' in t, false); assert.equal(f.ports.stops.length, 1);
    errorCode(() => f.engine.report(id, { state: 'progress', summary: 'late report' }), 'ticketEnded');
    errorCode(() => f.engine.retryTicket(id), 'notRetryable');
    snapshots.readyEnded = t;
  });
  check('C08-ready-follow-review-is-stage-not-human-verdict', () => {
    const f = fixture(); const id = f.create(); const pr = { source: 'fixture', id: 'pr' };
    f.engine.bindThread(id, pr, true); f.tick(); const t = f.engine.report(id, { state: 'ready', summary: 'Await PR review' });
    assert.equal(t.ended, undefined); assert.deepEqual(api.ticketStage(t), { stage: 'person', action: 'review' });
    errorCode(() => f.engine.retryTicket(id), 'notRetryable');
    f.tick(); f.engine.threadClosed(pr, 'merged', f.now());
    assert.equal(f.repo.tickets.get(id)?.ended?.outcome, 'merged');
    snapshots.followReview = { before: t, after: f.repo.tickets.get(id) };
  });
  check('C09-human-followup-resumes-executor-ended-same-ticket', () => {
    const f = fixture(); const id = f.create(); f.tick(); f.engine.report(id, { state: 'ready', summary: 'Done' });
    const old = f.repo.tickets.get(id);
    assert(old, 'Expected the ticket before rework');
    f.tick(); f.engine.receive(f.trigger('human-rework'));
    const current = f.repo.tickets.get(id);
    assert(current, 'Expected the same ticket after rework');
    assert.equal(current.ended, undefined); assert.equal(current.assignments.length, 2); assert.deepEqual(current.mandate, old.mandate);
    assert.equal(f.repo.tickets.list().length, 1); assert.equal(f.repo.decisions.byThread('fixture:thread').length, 1);
    assert.ok(current.inputs.some(i => i.kind === 'resumed')); assert.equal(f.ports.starts.length, 2);
    snapshots.resumed = current;
  });
  check('C10-bot-followup-does-not-resume-ended-ticket', () => {
    const f = fixture(); const id = f.create(); f.tick(); f.engine.report(id, { state: 'ready', summary: 'Done' });
    f.tick(); f.engine.receive(f.trigger('bot-input', false, false));
    assert.ok(f.repo.tickets.get(id)?.ended); assert.equal(f.ports.starts.length, 1);
  });
  check('C11-human-stop-is-not-resumable', () => {
    const f = fixture(); const id = f.create(); f.engine.stopTicket(id, 'Operator stopped'); f.tick(); f.engine.receive(f.trigger('human-followup'));
    assert.equal(f.repo.tickets.get(id)?.ended?.by, 'human'); assert.equal(f.ports.starts.length, 1);
    errorCode(() => f.engine.attach(id, 'human-followup'), 'ticketStopped');
  });
  check('C12-revoked-mandate-cannot-resume', () => {
    const f = fixture(); const id = f.create(); f.tick(); f.engine.report(id, { state: 'ready', summary: 'Done' });
    const source = f.settings.policy.sources.fixture;
    assert(source, 'Expected the fixture source policy');
    source.allowed = []; f.tick(); f.engine.receive(f.trigger('rework'));
    assert.ok(f.repo.tickets.get(id)?.ended); assert.equal(f.ports.starts.length, 1);
  });
  check('C13-ready-follow-can-return-to-progress-without-new-ticket', () => {
    const f = fixture(); const id = f.create(); f.engine.bindThread(id, { source: 'fixture', id: 'pr' }, true);
    f.engine.report(id, { state: 'ready', summary: 'Ready' }); f.tick(); f.engine.receive(f.trigger('correction'));
    const t = f.engine.report(id, { state: 'progress', summary: 'Implement correction' });
    assert.deepEqual(api.ticketStage(t), { stage: 'working' }); assert.equal(t.assignments.length, 1); assert.equal(t.ended, undefined);
  });
  check('C14-blocked-retry-creates-new-assignment-same-ticket', () => {
    const f = fixture(); const id = f.create(); f.engine.report(id, { state: 'blocked', summary: 'Fixture dependency unavailable' });
    const blocked = f.repo.tickets.get(id);
    assert(blocked, 'Expected the blocked ticket');
    assert.deepEqual(api.ticketStage(blocked), { stage: 'person', action: 'blocked' });
    const t = f.engine.retryTicket(id); assert.equal(t.assignments.length, 2); assert.equal(t.assignments[0]?.state, 'ended');
    assert.equal(t.assignments[1]?.state, 'pending'); assert.equal(f.repo.tickets.list().length, 1);
  });
  check('C15-no-public-human-review-or-accept-decision-command', () => {
    for (const name of ['acceptDecision', 'review', 'acceptResult', 'holdForReview', 'rework']) {
      assert.equal(name in api.Engine.prototype, false, `${name} must not be invented as upstream API`);
    }
  });
  check('C16-worker-report-has-no-assignment-fence-adapter-must-check', () => {
    const f = fixture(); const id = f.create(); f.engine.report(id, { state: 'failed', summary: 'Old worker failed' });
    const current = f.engine.retryTicket(id); assert.equal(current.assignments.length, 2);
    // Public report(ticketId, report) has no assignment ID. A caller must fence a stale receipt BEFORE this call.
    const result = f.engine.report(id, { state: 'ready', summary: 'Stale worker can otherwise report on replacement' });
    assert.equal(result.ended?.outcome, 'completed'); assert.equal(result.assignments[1]?.report?.state, 'ready');
    snapshots.missingAssignmentFence = { latestAssignmentId: result.assignments[1]?.id, ended: result.ended };
  });
  check('C17-stop-already-completed-is-noop-does-not-withdraw-resume', () => {
    const f = fixture(); const id = f.create(); f.tick(); f.engine.report(id, { state: 'ready', summary: 'Done' });
    const stopped = f.engine.stopTicket(id, 'Stop after completion'); assert.equal(stopped.ended?.by, 'executor');
    f.tick(); f.engine.receive(f.trigger('new-human-message'));
    assert.equal(f.repo.tickets.get(id)?.ended, undefined); assert.equal(f.ports.starts.length, 2);
  });
  check('C18-ready-cannot-carry-human-question-as-review-hold', () => {
    const f = fixture(); const id = f.create();
    errorCode(() => f.engine.report(id, { state: 'ready', summary: 'Done', question: 'Please accept this result' }), 'questionWithResult');
    assert.equal(f.repo.tickets.get(id)?.ended, undefined);
  });
  return { layer: 'UNIT' as const, upstreamSha: '8c32a9dc5d72c033816c6a8110b37f40cf94fba4', assertions, snapshots,
    capabilities: [
      { id: 'accept-decision', status: 'FAIL', reason: 'CAPABILITY: no version-fenced human suggestion acceptance command in upstream.' },
      { id: 'independent-human-review', status: 'FAIL', reason: 'CAPABILITY: review stage is a projection; no acceptance spec, evidence digest, reviewer verdict or atomic rework command.' },
    ],
    limitations: ['MemoryRepositories only; no SQLite or Host claims from this fixture.', 'Assessor/executor are substitute counters, not model runs.',
      'Passing a negative capability assertion confirms the gap, not the product feature.', 'No proposed acceptance/review extension is implemented by this audit.'] };
}
