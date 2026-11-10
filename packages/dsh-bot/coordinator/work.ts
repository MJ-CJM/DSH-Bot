import { workSummarySchema } from '../src/shared/proactive/activity.js';
import type { DatabaseSync } from "node:sqlite";
import { sameBot, type BotKey } from "../src/shared/identity.js";
import type {
	AutoCiRule,
	CommandBody,
	Suggestion,
} from "../src/shared/proactive/protocol.js";
import {
	groupFollowUpFact,
  supportsWorkContinuation,
	type ProactiveWork,
  type WorkContinuation,
	reworkFeedbackSchema,
	workHistoryRequestSchema,
	workHistorySchema,
	type WorkHistoryRequest,
	workListSchema,
	workSchema,
} from "../src/shared/proactive/work.js";
import { digest } from "../src/host/proactive/wire.js";
import type { Engine, Store } from "./core.mjs";
import { Rejection } from "./rejection.js";

const ownerRule = "owner-single-ci-analysis";
type WorkCommand = Exclude<
	CommandBody,
	{
		kind:
			| 'follow-up-policy'
			| 'follow-up-watch-create'
			| 'follow-up-group-watch-propose'
			| 'follow-up-watch-update'
			| 'follow-up-action'
			| 'follow-up-ingest'
			| 'follow-up-work-reconcile'
			| 'follow-up-group-accept'
			| 'follow-up-group-started'
			| 'follow-up-group-abandon'
			| 'follow-up-group-watch-propose'
      | 'work-continuation'
			| "ingest-batch"
			| "suggestion-action"
			| "adjust-suggestion"
			| "revoke-source"
			| "feedback-rule"
			| "feedback-workflow"
			| "governance-sweep"
			| "execution-drained"
			| "settle-group-budget"
			| "forget-begin"
			| "forget-block"
			| "forget-finish"
			| "governance-purge"
			| "responsibility-mutation"
			| "notice-schedule"
			| "notice-revise"
			| "notice-claim"
			| "notice-settle"
			| "notice-cancel";
	}
>;
type WorkerReport = Parameters<Engine["report"]>[1];

export function openWork(
	db: DatabaseSync,
	store: Store,
	suggestion: (id: string) => Suggestion | undefined,
	dailyBudget: number,
	externalBudget: number,
	notices: boolean,
	autoRule?: AutoCiRule,
	onWorkChange?: (row: ProactiveWork) => void,
) {
	db.exec(`CREATE TABLE IF NOT EXISTS pb_work (
    assignment TEXT PRIMARY KEY, ticket TEXT NOT NULL, decision TEXT NOT NULL,
    generation INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(ticket,generation)
  );
  CREATE INDEX IF NOT EXISTS pb_work_decision ON pb_work(decision,generation);
  CREATE INDEX IF NOT EXISTS pb_work_follow_up_bot ON pb_work(
    json_extract(payload,'$.target.bot.botId'),json_extract(payload,'$.target.bot.botCreatedAt'))
    WHERE json_extract(payload,'$.groupRepair') IS NULL;
  CREATE INDEX IF NOT EXISTS pb_work_follow_up_group ON pb_work(
    json_extract(payload,'$.groupRepair.group.groupId'),json_extract(payload,'$.groupRepair.group.groupCreatedAt'));
  CREATE TABLE IF NOT EXISTS pb_execution_clock (singleton INTEGER PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pb_execution_control (
    singleton INTEGER PRIMARY KEY, paused INTEGER NOT NULL, revision INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pb_execution_budget (
    assignment TEXT PRIMARY KEY, utc_day TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pb_execution_day ON pb_execution_budget(utc_day);
  CREATE TABLE IF NOT EXISTS pb_external_budget (
    assignment TEXT PRIMARY KEY, utc_day TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pb_external_day ON pb_external_budget(utc_day);`);
	const control = () => {
		const row = db
			.prepare(
				"SELECT paused,revision FROM pb_execution_control WHERE singleton=1",
			)
			.get();
		return { paused: row?.paused === 1, revision: Number(row?.revision ?? 0) };
	};
	const inFlight = db.prepare(
		"SELECT payload FROM pb_work WHERE json_extract(payload,'$.state') IN ('pending','claimed','sent')",
	);
	const autoAllowed = (
		id: string,
		sourceId: string,
		target: ProactiveWork["target"],
		now: number,
	) => {
		if (
			!autoRule ||
			id !== autoRule.id ||
			sourceId !== autoRule.sourceId ||
			digest(target) !== digest(autoRule.target) ||
			Date.parse(autoRule.expiresAt) <= now
		)
			throw new Rejection("forbidden");
		const source = db
			.prepare("SELECT generation FROM pb_source WHERE id=?")
			.get(sourceId);
		if (source?.generation !== autoRule.sourceGeneration)
			throw new Rejection("stale");
	};
	let rule: { triggerId: string } | undefined;
	const decode = (row: Record<string, unknown> | undefined) =>
		row ? workSchema.parse(JSON.parse(String(row.payload))) : undefined;
	const byDecision = db.prepare(
		"SELECT payload FROM pb_work WHERE decision=? ORDER BY generation DESC LIMIT 1",
	);
	const byAssignment = db.prepare(
		"SELECT payload FROM pb_work WHERE assignment=?",
	);
	const byTicket = db.prepare(
		"SELECT payload FROM pb_work WHERE ticket=? ORDER BY generation DESC LIMIT 1",
	);
	const save = (row: ProactiveWork) => {
		db.prepare(`INSERT INTO pb_work VALUES (?,?,?,?,?)
      ON CONFLICT(assignment) DO UPDATE SET payload=excluded.payload`).run(
			row.assignmentId,
			row.ticketId,
			row.decisionId,
			row.generation,
			JSON.stringify(workSchema.parse(row)),
		);
		onWorkChange?.(row);
	};
	const mutate = (row: ProactiveWork, change: Partial<ProactiveWork>) =>
		save({ ...row, ...change, revision: row.revision + 1 });
  const beginAttempt = (current: ProactiveWork, assignmentId: string, patch: Partial<Pick<ProactiveWork, 'rework' | 'continuation' | 'admission'>>) => {
    save({
      ...current,
      assignmentId,
      revision: current.revision + 1,
      generation: current.generation + 1,
      state: 'pending',
      wait: undefined,
      continuation: undefined,
      rework: undefined,
      taskCost: undefined,
      supersededBy: undefined,
      evidence: undefined,
      methodEvidence: undefined,
      repairEvidence: undefined,
      workspaceEvidence: undefined,
      groupRepairEvidence: undefined,
      commandEvidence: undefined,
      usage: undefined,
      recoveryRevision: undefined,
      externalEvidence: undefined,
      externalRunId: undefined,
      evidenceDigest: undefined,
      sessionId: undefined,
      inputId: undefined,
      reviewer: undefined,
      reviewedAt: undefined,
      reviewFeedback: undefined,
      autoRuleId: undefined,
      groupReview: undefined,
      notice: undefined,
      ...patch,
    });
  };
	const activeAssignment = (row: ProactiveWork) => {
		const ticket = store.tickets.get(row.ticketId);
		const assignment = ticket?.assignments.at(-1);
		const running = ticket?.assignments.find(
			(item) => item.state === "running",
		);
		if (
			!ticket ||
			ticket.ended ||
			assignment?.id !== row.assignmentId ||
			assignment.state === "ended" ||
			(running && running.id !== assignment.id)
		)
			throw new Rejection("stale");
		return assignment;
	};
	const report = (engine: Engine, row: ProactiveWork, update: WorkerReport) => {
		activeAssignment(row);
		const ticket = engine.report(row.ticketId, update);
		if (
			update.state === "dropped" &&
			(!ticket.ended || ticket.assignments.at(-1)?.state !== "ended")
		)
			throw new Rejection("conflict");
		return ticket;
	};
	const stopByOwner = (engine: Engine, row: ProactiveWork, reason: string) => {
		activeAssignment(row);
		engine.stopTicket(row.ticketId, reason);
		mutate(row, { state: row.state === "sent" ? "unknown" : "cancelled" });
	};
	function reconcile(engine: Engine) {
		for (const item of db
			.prepare(`SELECT payload FROM pb_work
			WHERE json_extract(payload,'$.state') IN ('failed','denied','delivered','unknown')
			AND json_extract(payload,'$.supersededBy') IS NULL`)
			.all()) {
			const row = decode(item);
			if (!row) continue;
			const ticket = store.tickets.get(row.ticketId);
			if (!ticket) continue;
			const index = ticket.assignments.findIndex(
				(entry) => entry.id === row.assignmentId,
			);
			const assignment = ticket.assignments[index];
			if (!assignment) continue;
			const successor = ticket.assignments[index + 1];
			if (
				successor &&
				assignment.state === "ended" &&
				assignment.endedReason === "retried" &&
				(row.state === "delivered" || row.state === "unknown")
			) {
				const next = decode(byAssignment.get(successor.id));
				if (
					next?.ticketId === row.ticketId &&
					next.generation === row.generation + 1 &&
					next.rework?.previousAssignmentId === row.assignmentId &&
					next.rework.previousEvidenceDigest === row.evidenceDigest
				)
					mutate(row, {
						state: row.state === "unknown" ? "unknown" : "superseded",
						supersededBy: next.assignmentId,
					});
			} else if (
				!ticket.ended &&
				index === ticket.assignments.length - 1 &&
				assignment.state !== "ended" &&
				!ticket.assignments
					.slice(0, index)
					.some((entry) => entry.state === "running") &&
				(row.state === "failed" || row.state === "denied") &&
				assignment.report?.state === "failed" &&
				assignment.report.summary === row.state &&
				row.groupRepairEvidence?.state !== "unknown"
			) {
				report(engine, row, { state: "dropped", summary: row.state });
			}
		}
	}
	const fence = (row: ProactiveWork, advanceClock: boolean) => {
		const now = Date.now();
		if (control().paused) throw new Rejection("forbidden");
		if (row.autoRuleId)
			autoAllowed(row.autoRuleId, row.sourceId, row.target, now);
		if (Date.parse(row.expiresAt) <= now) throw new Rejection("stale");
		if (row.taskLimits && Date.parse(row.taskLimits.deadlineAt) <= now)
			throw new Rejection("stale");
		const last = db
			.prepare("SELECT at FROM pb_execution_clock WHERE singleton=1")
			.get();
		if (last && Number(last.at) > now) throw new Rejection("forbidden");
		if (advanceClock)
			db.prepare(`INSERT INTO pb_execution_clock VALUES (1,?)
      ON CONFLICT(singleton) DO UPDATE SET at=excluded.at`).run(now);
		return now;
	};
  const documentCurrent = (row: ProactiveWork) => {
    if (!row.document) return;
    const source = db.prepare('SELECT generation,checkpoint FROM pb_source WHERE id=?').get(row.sourceId);
    const revoked = db.prepare('SELECT generation FROM pb_source_revocation WHERE id=?').get(row.sourceId);
    if (!source || source.generation !== row.document.sourceVersion || source.checkpoint !== row.sourceDigest || (revoked && Number(revoked.generation) >= row.document.sourceVersion)) throw new Rejection('stale');
  };
	const live = (row: ProactiveWork, advanceClock = true) => {
		const now = fence(row, advanceClock);
    if (row.document) { documentCurrent(row); return; }
		const observation = suggestion(row.decisionId);
		if (
			observation?.state !== "open" ||
			observation.triggerId !== row.triggerId ||
			Date.parse(observation.observedAt) > now + 5 * 60 * 1000
		)
			throw new Rejection("stale");
	};
	const reserve = (ids: string[], kind: "model" | "external" = "model") => {
		const [table, budget] =
			kind === "model"
				? ["pb_execution_budget", dailyBudget]
				: ["pb_external_budget", externalBudget];
		const day = new Date().toISOString().slice(0, 10);
		const used = db
			.prepare(`SELECT count(*) AS n FROM ${table} WHERE utc_day=?`)
			.get(day);
		if (Number(used?.n) + ids.length > budget) throw new Rejection("forbidden");
		const insert = db.prepare(`INSERT INTO ${table} VALUES (?,?)`);
		for (const id of ids) insert.run(id, day);
	};
	const ciHead =
		db.prepare(`SELECT h.attempt,h.conclusion,h.observed_at,h.decision
		FROM pb_ci_head h JOIN pb_source s ON s.id=h.source AND s.generation=h.generation
		WHERE h.source=? AND h.generation=? AND h.thread=?
		AND NOT EXISTS (SELECT 1 FROM pb_source_revocation r WHERE r.id=h.source AND r.generation>=h.generation)`);
	const followUpHead = (row: ProactiveWork, advanceClock: boolean) => {
		const grant = row.groupReview?.followUp;
		if (!grant) throw new Rejection("stale");
		const now = fence(row, advanceClock);
		const head = ciHead.get(row.sourceId, grant.sourceGeneration, grant.thread);
		if (!head || Date.parse(String(head.observed_at)) > now + 5 * 60 * 1000)
			throw new Rejection("stale");
		return { grant, head };
	};
	const followUpFact = (row: ProactiveWork, advanceClock = false) => {
		if (row.state !== "accepted") throw new Rejection("stale");
		const { grant, head } = followUpHead(row, advanceClock);
		const attempt = Number(head.attempt);
		if (
			String(head.observed_at) <= grant.baselineAt ||
			(attempt <= grant.baselineAttempt && head.conclusion === "failure")
		)
			return;
		const decision = store.decisions.get(String(head.decision));
		const trigger =
			decision?.triggerIds[0] && store.triggers.get(decision.triggerIds[0]);
		if (!trigger || trigger.source !== row.sourceId)
			throw new Rejection("stale");
		return groupFollowUpFact.parse({
			id: digest([
				row.sourceId,
				grant.sourceGeneration,
				grant.thread,
				attempt,
				head.conclusion,
				trigger.text,
			]),
			attempt,
			conclusion: head.conclusion,
			text: `${trigger.text} (attempt ${attempt})`,
		});
	};
  type Ticket = NonNullable<ReturnType<Store['tickets']['get']>>;
  function continueWork(
    engine: Engine, input: WorkContinuation, operationId: string,
    attachOwnerInput: (ticket: Ticket, triggerId: string) => Ticket,
  ) {
    const current = decode(byTicket.get(input.ticketId));
    if (!current || !sameBot(current.target.bot, input.owner) || current.revision !== input.expectedRevision ||
      current.assignmentId !== input.assignmentId) throw new Rejection('stale');
    if (!supportsWorkContinuation(current)) throw new Rejection('unsupported');
    const requestedAt = new Date().toISOString();
    if (input.action === 'mark-waiting') {
      if (current.state !== 'delivered' || current.wait || activeAssignment(current).report?.state !== 'waiting')
        throw new Rejection('conflict');
      mutate(current, { wait: { reason: input.reason, request: input.request, operationId, recordedAt: requestedAt } });
      return 1;
    }
    if (inFlight.get() || current.generation >= (current.taskLimits?.maxAttempts ?? 3)) throw new Rejection('forbidden');
    live(current);
    let next: Ticket['assignments'][number] | undefined;
    const audit = { previousAssignmentId: current.assignmentId, operationId, requestedAt };
    let continuation: NonNullable<ProactiveWork['continuation']>;
    if (input.action === 'supplement') {
      if (current.state !== 'delivered' || !current.wait || activeAssignment(current).report?.state !== 'waiting')
        throw new Rejection('conflict');
      continuation = { ...audit, kind: 'supplement', wait: current.wait, text: input.text };
      report(engine, current, { state: 'failed', summary: 'Owner supplied requested information' });
      next = engine.retryTicket(current.ticketId).assignments.at(-1);
    } else {
      const ticket = store.tickets.get(current.ticketId);
      if (current.state !== 'failed' || !ticket || ticket.ended?.by !== 'executor' || ticket.ended.outcome !== 'dropped' ||
        ticket.assignments.at(-1)?.id !== current.assignmentId || ticket.assignments.some(row => row.state !== 'ended'))
        throw new Rejection('conflict');
      const triggerId = digest(['work-continuation', ticket.id, current.assignmentId, operationId]);
      const source = 'dsh-bot-owner-continuation';
      if (engine.receive({
        id: triggerId, source, human: true, actor: { source, id: 'owner' },
        threads: [{ source, id: triggerId }], text: 'Owner approved retry of the same task',
        at: requestedAt, meta: { ticketId: ticket.id, assignmentId: current.assignmentId, operationId },
      }) !== 'stored') throw new Rejection('conflict');
      const reopened = attachOwnerInput(ticket, triggerId);
      if (reopened.ended || reopened.assignments.length !== ticket.assignments.length + 1)
        throw new Rejection('conflict');
      next = reopened.assignments.at(-1);
      continuation = { ...audit, kind: 'retry' };
    }
    if (!next || next.state !== 'pending' || next.id === current.assignmentId) throw new Rejection('conflict');
    mutate(current, { state: 'superseded', supersededBy: next.id });
    beginAttempt(current, next.id, { continuation, admission: 'manual' });
    return 1;
  }
	function apply(engine: Engine, body: WorkCommand): number {
    if (body.kind === 'submit-document') {
      if (body.methodTrial && (body.methodTrial.inputHash !== digest(body.document.content) || body.methodTrial.methodHash !== digest(body.methodTrial.content))) throw new Rejection('invalid');
      if (inFlight.get()) throw new Rejection('conflict');
      const sourceId = `doc:${digest([body.target.bot, body.document.name])}`;
      const sourceDigest = digest(body.document);
      const previous = db.prepare('SELECT generation FROM pb_source WHERE id=?').get(sourceId);
      const revoked = db.prepare('SELECT generation FROM pb_source_revocation WHERE id=?').get(sourceId);
      if ((previous && Number(previous.generation) >= body.document.sourceVersion) || revoked) throw new Rejection('stale');
      const triggerId = digest([sourceId, body.document.sourceVersion, sourceDigest]);
      const title = body.document.name;
      const now = new Date().toISOString();
      if (engine.receive({ id: triggerId, source: sourceId, human: false, actor: { source: sourceId, id: 'owner-submission' }, threads: [{ source: sourceId, id: sourceId }], text: title, at: now, meta: { generation: body.document.sourceVersion, taskKind: 'document-analysis', taskVersion: 1, sourceDigest } }) !== 'stored') throw new Rejection('conflict');
      db.prepare('INSERT INTO pb_event VALUES (?,?)').run(triggerId, sourceDigest);
      db.prepare('INSERT INTO pb_source VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,checkpoint=excluded.checkpoint').run(sourceId, body.document.sourceVersion, sourceDigest);
      rule = { triggerId };
      try {
        const accepted = engine.decide(triggerId, { kind: 'accept', title, scope: 'analyze-document', reason: 'explicit owner approval of frozen document snapshot', rules: [ownerRule], audit: { target: body.target, sourceDigest } });
        const ticketId = accepted.ticketId;
        const assignmentId = ticketId && store.tickets.get(ticketId)?.assignments.at(-1)?.id;
        if (!ticketId || !assignmentId) throw new Rejection('forbidden');
        const next: ProactiveWork = { ticketId, assignmentId, decisionId: accepted.id, triggerId, sourceId, sourceDigest,
          methodTrial: body.methodTrial, document: body.document, admission: 'manual', taskKind: 'document-analysis', title, expiresAt: body.taskLimits.deadlineAt,
          policyVersion: 'pb01-observation', target: body.target, taskLimits: body.taskLimits,
          acceptance: { goal: body.document.question, deliverables: ['Versioned impact report with snapshot citations'], checks: [{ id: 'owner-document-review', title: body.document.acceptance, kind: 'human' }] },
          revision: 0, generation: 1, state: 'pending' };
        live(next); save(next);
      } finally { rule = undefined; }
      return 1;
    }
		if (body.kind === "claim-notice" || body.kind === "settle-notice") {
			const row = decode(byAssignment.get(body.assignmentId));
			if (!row?.notice || row.notice.operationId !== body.operationId)
				throw new Rejection("stale");
			if (body.kind === "claim-notice") {
				if (row.notice.state !== "intent") throw new Rejection("conflict");
				if (!notices || row.state !== "delivered")
					throw new Rejection("forbidden");
				live(row, false);
				save({ ...row, notice: { ...row.notice, state: "claim" } });
			} else {
				if (row.notice.state !== "claim") throw new Rejection("conflict");
				save({ ...row, notice: { ...row.notice, state: body.state } });
			}
			return 1;
		}
		if (body.kind === "pause-execution") {
			const previous = control();
			if (previous.revision !== body.expectedRevision)
				throw new Rejection("stale");
			db.prepare(`INSERT INTO pb_execution_control VALUES (1,?,?)
        ON CONFLICT(singleton) DO UPDATE SET paused=excluded.paused,revision=excluded.revision`).run(
				body.paused ? 1 : 0,
				previous.revision + 1,
			);
			if (body.paused) {
				for (const item of inFlight.all()) {
					const row = decode(item);
					if (!row) continue;
					stopByOwner(engine, row, "owner paused execution");
				}
			}
			return 1;
		}
		if (body.kind === "accept-decision" || body.kind === "auto-accept") {
			if (body.repair && body.workspaceRepair) throw new Rejection("invalid");
			if (
				body.groupRepair &&
				(body.repair ||
					body.workspaceRepair?.executor !== "native" ||
					body.groupRepair.supervisor.bot.botId !== body.target.bot.botId ||
					body.groupRepair.supervisor.bot.botCreatedAt !==
						body.target.bot.botCreatedAt ||
					body.groupRepair.supervisor.botUpdatedAt !== body.target.botUpdatedAt)
			)
				throw new Rejection("forbidden");
			const current = suggestion(body.decisionId);
			if (body.kind === "auto-accept" && current?.adjusted)
				throw new Rejection("forbidden");
			if (
				!current ||
				current.revision !== body.expectedRevision ||
				current.sourceId !== body.sourceId ||
				current.policyVersion !== body.policyVersion
			)
				throw new Rejection("stale");
			if (inFlight.get()) throw new Rejection("conflict");
			if (byDecision.get(body.decisionId)) throw new Rejection("conflict");
			const next = {
				decisionId: current.id,
        admission: body.kind === 'auto-accept' ? 'proactive' : 'manual',
        taskKind: 'ci-analysis',
				triggerId: current.triggerId,
				sourceId: current.sourceId,
				title: current.title,
				expiresAt: current.expiresAt,
				policyVersion: current.policyVersion,
				target: body.target,
				...(body.taskLimits
					? { taskLimits: body.taskLimits }
					: body.groupRepair
						? {
								taskLimits: {
									maxTokens: 32768,
									maxAttempts: 3,
									deadlineAt: new Date(
										Math.min(
											Date.parse(current.expiresAt),
											Date.now() + 300000,
										),
									).toISOString(),
								},
							}
						: {}),
				...(body.repair ? { repair: body.repair } : {}),
				...(body.groupRepair ? { groupRepair: body.groupRepair } : {}),
				...(body.workspaceRepair
					? { workspaceRepair: body.workspaceRepair }
					: {}),
				revision: 0,
				generation: 1,
				state: "pending",
				...(body.kind === "auto-accept" && !body.responsibility
					? { autoRuleId: body.ruleId }
					: {}),
			} as const;
			live({ ...next, ticketId: "", assignmentId: "" });
			rule = { triggerId: current.triggerId };
			try {
				const accepted = engine.decide(current.triggerId, {
					kind: "accept",
					title: current.title,
					scope: current.scope,
					reason:
						body.kind === "auto-accept"
							? "configured scope-specific owner rule"
							: "explicit owner approval for this CI observation",
					rules: [ownerRule],
					audit: {
						proposal: current.id,
						target: body.target,
						autoRuleId: next.autoRuleId,
					},
				});
				const ticketId = accepted.ticketId;
				if (!ticketId) throw new Rejection("forbidden");
				const assignmentId = store.tickets
					.get(ticketId)
					?.assignments.at(-1)?.id;
				if (!assignmentId) throw new Rejection("conflict");
				save({ ...next, ticketId, assignmentId });
			} finally {
				rule = undefined;
			}
			return 1;
		}
		const current = decode(byTicket.get(body.ticketId));
		if (
			!current ||
			(current.revision !== body.expectedRevision &&
				!(
					body.kind === "report-result" &&
					current.state === "unknown" &&
					current.recoveryRevision === body.expectedRevision
				)) ||
			("assignmentId" in body && current.assignmentId !== body.assignmentId)
		)
			throw new Rejection("stale");
		switch (body.kind) {
			case "claim-group-review": {
				const artifactReview =
					current.state === "delivered" &&
					(current.repairEvidence?.verification.exitCode === 0 ||
						current.workspaceEvidence?.verification.exitCode === 0) &&
					body.evidenceDigest !== undefined &&
					body.evidenceDigest === current.evidenceDigest;
				if (
					(current.state !== "accepted" && !artifactReview) ||
					current.groupReview ||
					(!artifactReview && body.evidenceDigest !== undefined)
				)
					throw new Rejection("conflict");
				live(current);
				const baseline =
					body.followUp &&
					db
						.prepare(
							"SELECT thread,generation,attempt,observed_at FROM pb_ci_head WHERE decision=? AND source=?",
						)
						.get(current.decisionId, current.sourceId);
				if (body.followUp && !baseline) throw new Rejection("stale");
				reserve([
					`${current.assignmentId}:group:1`,
					`${current.assignmentId}:group:2`,
				]);
				mutate(current, {
					groupReview: {
						group: body.group,
						digest: body.digest,
						state: "claimed",
						evidenceDigest: body.evidenceDigest,
						...(body.followUp && baseline
							? {
									followUp: {
										...body.followUp,
										thread: String(baseline.thread),
										sourceGeneration: Number(baseline.generation),
										baselineAttempt: Number(baseline.attempt),
										baselineAt: String(baseline.observed_at),
										state: "armed" as const,
									},
								}
							: {}),
					},
				});
				break;
			}
			case "settle-group-review":
				if (
					current.groupReview?.state !== "claimed" ||
					current.groupReview.digest !== body.digest
				)
					throw new Rejection("stale");
				mutate(current, {
					groupReview: {
						...current.groupReview,
						state: body.turnId ? "linked" : "unknown",
						turnId: body.turnId,
					},
				});
				break;
			case "claim-group-follow-up":
			case "settle-group-follow-up":
			case "deny-group-follow-up": {
				const review = current.groupReview;
				const grant = review?.followUp;
				if (review?.state !== "linked" || !review.turnId || !grant)
					throw new Rejection("stale");
				if (body.kind === "claim-group-follow-up") {
					const fact = followUpFact(current, true);
					if (grant.state !== "armed" || !fact || fact.id !== body.factId)
						throw new Rejection("stale");
					reserve([`${current.assignmentId}:group:follow-up`]);
					mutate(current, {
						groupReview: {
							...review,
							followUp: { ...grant, fact, state: "claimed" },
						},
					});
				} else if (body.kind === "settle-group-follow-up") {
					if (grant.state !== "claimed" || grant.fact?.id !== body.factId)
						throw new Rejection("stale");
					mutate(current, {
						groupReview: {
							...review,
							followUp: {
								...grant,
								state: body.turnId ? "linked" : "unknown",
								turnId: body.turnId,
							},
						},
					});
				} else {
					if (grant.state !== "armed") throw new Rejection("stale");
					mutate(current, {
						groupReview: { ...review, followUp: { ...grant, state: "denied" } },
					});
				}
				break;
			}
			case "dispatch-claim": {
				if (current.state !== "pending") throw new Rejection("conflict");
				activeAssignment(current);
				if (
					(current.repair?.executor === "external" ||
						current.workspaceRepair?.executor === "command" ||
						!!current.groupRepair) === !!body.sessionId
				)
					throw new Rejection("invalid");
				live(current);
				reserve(
					current.groupRepair
						? ["plan", "implement", "review"].map(
								(phase) => `${current.assignmentId}:group-repair:${phase}`,
							)
						: [current.assignmentId],
					current.repair?.executor === "external" ||
						current.workspaceRepair?.executor === "command"
						? "external"
						: "model",
				);
				mutate(current, { state: "claimed", sessionId: body.sessionId });
				break;
			}
			case "dispatch-send":
				if (current.state !== "claimed") throw new Rejection("conflict");
				live(current);
				activeAssignment(current);
				engine.assignmentStarted(current.ticketId, current.assignmentId);
				mutate(current, { state: "sent", inputId: body.inputId });
				break;
			case "external-started":
				if (
					(current.repair?.executor !== "external" &&
						current.workspaceRepair?.executor !== "command") ||
					current.state !== "sent" ||
					current.externalRunId
				)
					throw new Rejection("conflict");
				mutate(current, { externalRunId: body.runId });
				break;
			case "report-result":
				if (body.result.state === "delivered") {
					const {
						evidence,
						externalEvidence,
						repairEvidence,
						workspaceEvidence,
						commandEvidence,
						groupRepairEvidence,
					} = body.result;
					if (current.methodTrial ? !body.result.methodEvidence || digest({ ...body.result.methodEvidence, loadedBodyHash: undefined, requestHash: undefined, contextHash: undefined, tools: undefined, permission: undefined }) !== digest({ ...current.methodTrial, content: undefined }) : !!body.result.methodEvidence) throw new Rejection('stale');
          const group = current.groupRepair;
					if (
						group
							? groupRepairEvidence?.state !== "completed" ||
								groupRepairEvidence.grantDigest !== digest(group) ||
								groupRepairEvidence.stages
									.map((stage) => stage.phase)
									.join(",") !== "plan,implement,review" ||
								groupRepairEvidence.stages.some(
									(stage, index) =>
										stage.memberId !==
										(index === 1
											? group.implementer.memberId
											: group.supervisor.memberId),
								) ||
								!workspaceEvidence
							: !!groupRepairEvidence
					)
						throw new Rejection("stale");
					const command = current.workspaceRepair?.executor === "command";
					const external = current.repair?.executor === "external";
					if (
						(current.state !== "sent" &&
							!(
								current.state === "unknown" &&
								current.recoveryRevision === body.expectedRevision
							)) ||
						(group
							? !!evidence || !!externalEvidence || !!commandEvidence
							: command
								? !commandEvidence ||
									commandEvidence.runId !== current.externalRunId ||
									!!evidence ||
									!!externalEvidence
								: external
									? !externalEvidence ||
										externalEvidence.runId !== current.externalRunId ||
										evidence
									: !evidence || externalEvidence) ||
						(!command &&
							!group &&
							(evidence ?? externalEvidence)?.inputId !== current.inputId) ||
						(current.workspaceRepair
							? workspaceEvidence?.specDigest !==
									current.workspaceRepair.specDigest ||
								workspaceEvidence?.baselineDigest !==
									current.workspaceRepair.baselineDigest
							: !!workspaceEvidence) ||
						(current.repair
							? repairEvidence?.specDigest !== current.repair.specDigest
							: !!repairEvidence)
					)
						throw new Rejection("stale");
					report(engine, current, {
						state: "waiting",
						summary: "Execution evidence is available for owner review",
					});
					mutate(current, {
						state: "delivered",
            methodEvidence: body.result.methodEvidence,
						evidence,
						externalEvidence,
						repairEvidence,
						workspaceEvidence,
						commandEvidence,
						groupRepairEvidence,
						usage: body.result.usage,
						recoveryRevision: undefined,
						evidenceDigest: digest([
							current.assignmentId,
							current.sessionId,
							evidence,
							externalEvidence,
							repairEvidence,
							...(groupRepairEvidence ? [groupRepairEvidence] : []),
							...(workspaceEvidence
								? [workspaceEvidence, commandEvidence]
								: []),
						]),
						...(notices
							? {
									notice: {
										operationId: `proactive:${current.assignmentId}`,
										state: "intent",
									},
								}
							: {}),
					});
				} else {
					if (
						body.result.groupRepairEvidence?.state === "unknown" &&
						body.result.state !== "unknown"
					)
						throw new Rejection("invalid");
					if (
						!["pending", "claimed", "sent"].includes(current.state) &&
						!(
							current.state === "unknown" &&
							current.recoveryRevision === body.expectedRevision
						)
					)
						throw new Rejection("conflict");
					if (body.result.state !== "unknown")
						report(engine, current, {
							state: "dropped",
							summary: body.result.state,
						});
					mutate(current, {
						state: body.result.state,
						groupRepairEvidence: body.result.groupRepairEvidence,
						recoveryRevision: undefined,
					});
				}
				break;
			case "cancel":
				if (
					!["pending", "claimed", "sent", "delivered"].includes(current.state)
				)
					throw new Rejection("conflict");
				stopByOwner(engine, current, "owner cancelled");
				break;
			case "review":
        // Reviewing an existing result grants no execution budget. Rework still calls live below.
        if (current.document) documentCurrent(current);
				if (
					current.state !== "delivered" ||
					current.evidenceDigest !== body.evidenceDigest
				)
					throw new Rejection("stale");
        if (current.wait) throw new Rejection('conflict');
				if (body.review === "accept") {
					if (body.feedback) throw new Rejection("invalid");
					if (
						current.groupRepair &&
						(current.groupRepairEvidence?.review?.verdict !== "pass" ||
							current.groupRepairEvidence.review.checks.some(
								(check) => check.status !== "PASS",
							))
					)
						throw new Rejection("forbidden");
					if (
						current.repair &&
						current.repairEvidence?.verification.exitCode !== 0
					)
						throw new Rejection("forbidden");
					if (
						current.workspaceRepair &&
						(current.workspaceEvidence?.verification.exitCode !== 0 ||
							current.workspaceEvidence.verification.timedOut ||
							current.workspaceEvidence.verification.outputTruncated)
					)
						throw new Rejection("forbidden");
					report(engine, current, {
						state: "ready",
						summary: "Owner accepted this evidence version",
					});
					mutate(current, {
						state: "accepted",
						reviewer: "owner",
						reviewedAt: new Date().toISOString(),
					});
				} else {
					if (
						current.generation >= (current.taskLimits?.maxAttempts ?? 3) ||
						current.groupReview?.state === "claimed" ||
						inFlight.get()
					)
						throw new Rejection("forbidden");
					// Old clients can only request an unambiguous failed-verifier
					// retry. New clients always provide the owner's specific findings.
					const feedback =
						body.feedback ??
						(current.repairEvidence?.verification.exitCode === 1
							? {
									failures: [
										{
											criterion: current.repairEvidence.verification.tool,
											actual: "The independent verifier exited with code 1.",
											expected:
												"The approved repair must pass the same verifier with exit code 0.",
										},
									],
								}
							: undefined);
					if (!feedback) throw new Rejection("invalid");
					const checkedFeedback = reworkFeedbackSchema.parse(feedback);
					const requestedAt = new Date().toISOString();
					live(current);
					if (activeAssignment(current).report?.state !== "waiting")
						throw new Rejection("stale");
					report(engine, current, {
						state: "failed",
						summary: "Owner requested rework",
					});
					const next = engine.retryTicket(current.ticketId).assignments.at(-1);
					if (!next) throw new Rejection("conflict");
					mutate(current, {
						state: "superseded",
						supersededBy: next.id,
						reviewer: "owner",
						reviewedAt: requestedAt,
						reviewFeedback: checkedFeedback,
					});
          beginAttempt(current, next.id, {
            rework: {
							previousAssignmentId: current.assignmentId,
							...(current.groupRepairEvidence
								? { previousGroupRepairEvidence: current.groupRepairEvidence }
								: {}),
							...(current.workspaceEvidence
								? { previousWorkspaceEvidence: current.workspaceEvidence }
								: {}),
							previousEvidenceDigest: body.evidenceDigest,
							feedback: checkedFeedback,
							requestedAt,
							requestedBy: "owner",
							...(current.repairEvidence
								? { previousRepairEvidence: current.repairEvidence }
								: {}),
						},
          });
				}
				break;
		}
		return 1;
	}
	// Native Tickets and Assignments remain canonical. This table keeps their
	// exact launch and review receipts and never creates an independent ticket.
	return {
		apply,
    continueWork,
		control,
		reconcile,
		permitted(
			assignmentId: string,
			groupReviewDigest?: string,
			noticeRevision?: number,
			groupFactId?: string,
			dispatchRevision?: number,
		) {
			const row = decode(byAssignment.get(assignmentId));
			if (!row) return false;
			if (groupReviewDigest) {
				const review = row.groupReview;
				if (
					review?.digest !== groupReviewDigest ||
					review.state === "unknown" ||
					(row.state !== "accepted" &&
						(row.state !== "delivered" || !review.evidenceDigest)) ||
					(review.evidenceDigest &&
						(review.evidenceDigest !== row.evidenceDigest ||
							decode(byTicket.get(row.ticketId))?.assignmentId !==
								row.assignmentId))
				)
					return false;
			} else if (noticeRevision !== undefined) {
				if (
					!["accepted", "delivered"].includes(row.state) ||
					row.revision !== noticeRevision
				)
					return false;
			} else if (dispatchRevision !== undefined) {
				if (
					!["claimed", "sent"].includes(row.state) ||
					row.revision !== dispatchRevision
				)
					return false;
			} else if (row.state !== "sent") return false;
			try {
				if (groupFactId !== undefined) {
					const grant = row.groupReview?.followUp;
					return (
						!!groupReviewDigest &&
						grant?.fact?.id === groupFactId &&
						(grant.state === "claimed" || grant.state === "linked") &&
						followUpFact(row)?.id === groupFactId
					);
				}
				if (groupReviewDigest && row.groupReview?.followUp)
					followUpHead(row, false);
				else live(row, false);
				return true;
			} catch (error) {
				if (error instanceof Rejection) return false;
				throw error;
			}
		},
		followUps() {
			const candidates = [];
			for (const item of db
				.prepare(`SELECT payload FROM pb_work
				WHERE json_extract(payload,'$.groupReview.state')='linked'
				AND json_extract(payload,'$.groupReview.followUp.state')='armed' ORDER BY rowid`)
				.iterate()) {
				const work = decode(item);
				if (!work) continue;
				try {
					const fact = followUpFact(work);
					if (fact) candidates.push({ work, fact });
				} catch (error) {
					if (!(error instanceof Rejection)) throw error;
				}
				if (candidates.length >= 16) break;
			}
			return candidates;
		},
		hasGroupFollowUp(decisionId: string) {
			return !!db
				.prepare(`SELECT 1 FROM pb_ci_head h JOIN pb_work w
				ON h.source=json_extract(w.payload,'$.sourceId')
				AND h.generation=json_extract(w.payload,'$.groupReview.followUp.sourceGeneration')
				AND h.thread=json_extract(w.payload,'$.groupReview.followUp.thread')
				WHERE h.decision=? AND json_extract(w.payload,'$.groupReview.state') IN ('claimed','linked')
				AND w.generation=(SELECT max(p.generation) FROM pb_work p WHERE p.ticket=w.ticket)
				AND json_extract(w.payload,'$.expiresAt')>? LIMIT 1`)
				.get(decisionId, new Date().toISOString());
		},
		admits(triggerId: string) {
			return rule?.triggerId === triggerId;
		},
		admitsRules(rules: string[]) {
			return !!rule && rules.length === 1 && rules[0] === ownerRule;
		},
		get(id: string) {
			return decode(byDecision.get(id)) ?? null;
		},
		getAssignment(id: string) {
			return decode(byAssignment.get(id)) ?? null;
		},
		getTicket(id: string) {
			return decode(byTicket.get(id)) ?? null;
		},
		bindGroupBudget(
			assignmentId: string,
			budget: NonNullable<ProactiveWork["groupReview"]>["budget"],
			followUp: boolean,
		) {
			const row = decode(byAssignment.get(assignmentId));
			if (!row?.groupReview) throw new Rejection("stale");
			const review = row.groupReview;
			if (followUp) {
				if (!review.followUp) throw new Rejection("stale");
				save({
					...row,
					groupReview: { ...review, followUp: { ...review.followUp, budget } },
				});
			} else save({ ...row, groupReview: { ...review, budget } });
		},
		updatePendingLimits(assignmentId: string, maxTokens: number) {
			const row = decode(byAssignment.get(assignmentId));
			if (!row?.taskLimits || row.state !== "pending")
				throw new Rejection("stale");
			save({ ...row, taskLimits: { ...row.taskLimits, maxTokens } });
		},
		bindGrant(
			assignmentId: string,
			grant: Pick<
				ProactiveWork,
				"responsibility" | "taskLimits" | "acceptance"
			>,
		) {
			const row = decode(byAssignment.get(assignmentId));
			if (!row) throw new Rejection("stale");
			if (row.state !== "pending") throw new Rejection("conflict");
			save({ ...row, ...grant });
		},
		history(input: WorkHistoryRequest) {
			const {
				ticketId,
				beforeGeneration,
				limit = 3,
			} = workHistoryRequestSchema.parse(input);
			const rows = db
				.prepare(`SELECT payload FROM pb_work
				WHERE ticket=? AND generation<? ORDER BY generation DESC LIMIT ?`)
				.all(ticketId, beforeGeneration ?? Number.MAX_SAFE_INTEGER, limit + 1)
				.map(decode)
				.filter((row): row is ProactiveWork => !!row);
			const versions = rows.slice(0, limit);
			const last = versions.at(-1);
			return workHistorySchema.parse({
				versions,
				...(rows.length > limit && last
					? { nextBeforeGeneration: last.generation }
					: {}),
			});
		},
		has(id: string) {
			return byDecision.get(id) !== undefined;
		},
		page(owner: BotKey, offset: number, sourceId?: string) {
      const rows = db.prepare(`SELECT json_object(
        'admission',json_extract(w.payload,'$.admission'), 'taskKind',json_extract(w.payload,'$.taskKind'),
        'ticketId',json_extract(w.payload,'$.ticketId'), 'assignmentId',w.assignment,
        'decisionId',w.decision, 'triggerId',json_extract(w.payload,'$.triggerId'),
        'sourceId',json_extract(w.payload,'$.sourceId'), 'title',json_extract(w.payload,'$.title'),
        'target',json_extract(w.payload,'$.target'), 'expiresAt',json_extract(w.payload,'$.expiresAt'),
        'policyVersion',json_extract(w.payload,'$.policyVersion'), 'revision',json_extract(w.payload,'$.revision'),
        'generation',w.generation, 'state',json_extract(w.payload,'$.state'),
        'evidenceDigest',json_extract(w.payload,'$.evidenceDigest'), 'sessionId',json_extract(w.payload,'$.sessionId'),
        'notice',json_extract(w.payload,'$.notice'), 'usage',json_extract(w.payload,'$.usage'),
        'groupReview',json_extract(w.payload,'$.groupReview'),
        'reviewedAt',json_extract(w.payload,'$.reviewedAt')) AS summary
        FROM pb_work w WHERE w.generation=(SELECT max(p.generation) FROM pb_work p WHERE p.ticket=w.ticket)
        AND json_extract(w.payload,'$.methodTrial') IS NULL
        AND json_extract(w.payload,'$.target.bot.botId')=? AND json_extract(w.payload,'$.target.bot.botCreatedAt')=?
        ${sourceId ? "AND json_extract(w.payload,'$.sourceId')=?" : ''}
        ORDER BY w.rowid DESC LIMIT 21 OFFSET ?`).all(owner.botId, owner.botCreatedAt, ...(sourceId ? [sourceId] : []), offset);
      return { rows: rows.slice(0, 20).map(row => {
        const value = JSON.parse(String(row.summary));
        for (const key of Object.keys(value)) if (value[key] === null) delete value[key];
        return workSummarySchema.parse(value);
      }), more: rows.length > 20 };
    },
		list(owner?: BotKey) {
			return workListSchema.parse(
				db
					.prepare(`SELECT w.payload FROM pb_work w
        WHERE w.generation=(SELECT max(p.generation) FROM pb_work p WHERE p.ticket=w.ticket)
        ${owner ? "AND json_extract(w.payload,'$.target.bot.botId')=? AND json_extract(w.payload,'$.target.bot.botCreatedAt')=?" : ""}
        ORDER BY w.rowid DESC LIMIT 30`)
					.all(...(owner ? [owner.botId, owner.botCreatedAt] : []))
					.map(decode),
			);
		},
		noticeCandidates() {
			return db
				.prepare(
					`SELECT w.payload FROM pb_work w LEFT JOIN pb_deferred_notice n ON w.assignment=n.assignment WHERE n.assignment IS NULL AND json_extract(w.payload,'$.notice.state')='intent' AND json_extract(w.payload,'$.state') IN ('delivered','accepted') ORDER BY w.rowid LIMIT 16`,
				)
				.all()
				.map(decode)
				.filter((row): row is ProactiveWork => !!row);
		},
		settleNotice(
			assignmentId: string,
			state: "recorded" | "suppressed" | "unknown",
		) {
			const row = decode(byAssignment.get(assignmentId));
			if (row?.notice) save({ ...row, notice: { ...row.notice, state } });
		},
		recover(engine: Engine) {
			for (const item of db
				.prepare(
					`SELECT payload FROM pb_work WHERE json_extract(payload,'$.groupReview.state')='claimed'
						OR json_extract(payload,'$.groupReview.followUp.state')='claimed'`,
				)
				.all()) {
				const row = decode(item);
				const group = row?.groupReview;
				if (row && group) {
					const followUp = group.followUp;
					mutate(row, {
						groupReview:
							group.state === "claimed"
								? { ...group, state: "unknown" }
								: {
										...group,
										...(followUp
											? { followUp: { ...followUp, state: "unknown" } }
											: {}),
									},
					});
				}
			}
			for (const item of db
				.prepare(
					"SELECT payload FROM pb_work WHERE json_extract(payload,'$.notice.state') IN ('intent','claim')",
				)
				.all()) {
				const row = decode(item);
				if (row?.notice)
					save({
						...row,
						notice: {
							...row.notice,
							state: row.notice.state === "claim" ? "unknown" : "intent",
						},
					});
			}
			for (const row of inFlight.all()) {
				const work = decode(row);
				if (!work || (work.state === "pending" && !work.methodTrial)) continue;
				mutate(work, { state: "unknown", recoveryRevision: work.revision });
			}
			reconcile(engine);
		},
	};
}
