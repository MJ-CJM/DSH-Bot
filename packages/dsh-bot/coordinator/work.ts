import type { DatabaseSync } from "node:sqlite";
import type {
	AutoCiRule,
	CommandBody,
	Suggestion,
} from "../src/shared/proactive/protocol.js";
import {
	groupFollowUpFact,
	type ProactiveWork,
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

export function openWork(
	db: DatabaseSync,
	store: Store,
	suggestion: (id: string) => Suggestion | undefined,
	dailyBudget: number,
	externalBudget: number,
	notices: boolean,
	autoRule?: AutoCiRule,
) {
	db.exec(`CREATE TABLE IF NOT EXISTS pb_work (
    assignment TEXT PRIMARY KEY, ticket TEXT NOT NULL, decision TEXT NOT NULL,
    generation INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(ticket,generation)
  );
  CREATE INDEX IF NOT EXISTS pb_work_decision ON pb_work(decision,generation);
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
	};
	const mutate = (row: ProactiveWork, change: Partial<ProactiveWork>) =>
		save({ ...row, ...change, revision: row.revision + 1 });
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
	const live = (row: ProactiveWork, advanceClock = true) => {
		const now = fence(row, advanceClock);
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
	function apply(engine: Engine, body: WorkCommand): number {
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
					engine.stopTicket(row.ticketId, "owner paused execution");
					mutate(row, {
						state: row.state === "sent" ? "unknown" : "cancelled",
					});
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
					engine.report(current.ticketId, {
						state: "waiting",
						summary: "Execution evidence is available for owner review",
					});
					mutate(current, {
						state: "delivered",
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
						!["pending", "claimed", "sent"].includes(current.state) &&
						!(
							current.state === "unknown" &&
							current.recoveryRevision === body.expectedRevision
						)
					)
						throw new Rejection("conflict");
					engine.report(current.ticketId, {
						state: "failed",
						summary: body.result.state,
					});
					mutate(current, {
						state: body.result.state,
						groupRepairEvidence: body.result.groupRepairEvidence,
					});
				}
				break;
			case "cancel":
				if (
					!["pending", "claimed", "sent", "delivered"].includes(current.state)
				)
					throw new Rejection("conflict");
				engine.stopTicket(current.ticketId, "owner cancelled");
				mutate(current, {
					state: current.state === "sent" ? "unknown" : "cancelled",
				});
				break;
			case "review":
				if (
					current.state !== "delivered" ||
					current.evidenceDigest !== body.evidenceDigest
				)
					throw new Rejection("stale");
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
					engine.report(current.ticketId, {
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
					engine.report(current.ticketId, {
						state: "failed",
						summary: "Owner requested rework",
					});
					const next = engine.retryTicket(current.ticketId).assignments.at(-1);
					if (!next) throw new Rejection("conflict");
					mutate(current, {
						reviewer: "owner",
						reviewedAt: requestedAt,
						reviewFeedback: checkedFeedback,
					});
					save({
						...current,
						assignmentId: next.id,
						revision: current.revision + 1,
						generation: current.generation + 1,
						state: "pending",
						evidence: undefined,
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
						autoRuleId: undefined,
						groupReview: undefined,
						notice: undefined,
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
		control,
		permitted(
			assignmentId: string,
			groupReviewDigest?: string,
			noticeRevision?: number,
			groupFactId?: string,
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
		list() {
			return workListSchema.parse(
				db
					.prepare(`SELECT w.payload FROM pb_work w
        WHERE w.generation=(SELECT max(p.generation) FROM pb_work p WHERE p.ticket=w.ticket)
        ORDER BY w.rowid DESC LIMIT 30`)
					.all()
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
		recover(_engine: Engine) {
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
				if (!work || work.state === "pending") continue;
				mutate(work, { state: "unknown", recoveryRevision: work.revision });
			}
		},
	};
}
