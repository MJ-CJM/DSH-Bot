import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Suggestion } from "../src/shared/proactive/protocol.js";
import {
	feedbackRule,
	type FeedbackAction,
	type FeedbackRule,
	feedbackWorkflowAction,
	feedbackCandidate,
	frozenFeedbackDataset,
	type FeedbackCandidate,
	type FeedbackDataset,
	type FrozenFeedbackDataset,
	type FeedbackComparison,
	type FeedbackWorkflowAction,
} from "../src/shared/proactive/feedback.js";
import { digest } from "../src/host/proactive/wire.js";
import { Rejection } from "./rejection.js";
import { sameBot, type BotKey } from "../src/shared/identity.js";

// Frozen before running candidate evaluation. V1 remains a separate negative
// control for the original broader job-only rule. These labels are synthetic.
const heldOut = [
	{
		id: "build",
		rows: [
			{ job: "docs", attempt: 1, needsSuggestion: false },
			{ job: "test", attempt: 1, needsSuggestion: true },
		],
	},
	{
		id: "publication",
		rows: [
			{ job: "docs", attempt: 1, needsSuggestion: false },
			{ job: "lint", attempt: 1, needsSuggestion: true },
		],
	},
	{
		id: "retry",
		rows: [
			{ job: "docs", attempt: 2, needsSuggestion: true },
			{ job: "package", attempt: 1, needsSuggestion: true },
		],
	},
] as const;

export function openFeedback(db: DatabaseSync, sourceId?: string) {
	const workflow = openWorkflow(db);
	db.exec(`CREATE TABLE IF NOT EXISTS pb_feedback (
		id TEXT PRIMARY KEY, source TEXT NOT NULL, job TEXT NOT NULL, attempt INTEGER NOT NULL,
		state TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(source,job,attempt)
	);
	CREATE TABLE IF NOT EXISTS pb_feedback_revision (
		id TEXT NOT NULL, revision INTEGER NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,revision)
	);`);
	const decode = (row: Record<string, unknown>) =>
		feedbackRule.parse(JSON.parse(String(row.payload)));
	const save = (rule: FeedbackRule) => {
		const payload = JSON.stringify(rule);
		db.prepare(`INSERT INTO pb_feedback VALUES (?,?,?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload`).run(
			rule.id,
			rule.sourceId,
			rule.job,
			rule.attempt,
			rule.state,
			payload,
		);
		db.prepare("INSERT INTO pb_feedback_revision VALUES (?,?,?,?)").run(
			rule.id,
			rule.revision,
			new Date().toISOString(),
			payload,
		);
	};
	const active = db.prepare(
		"SELECT 1 FROM pb_feedback WHERE source=? AND job=? AND attempt=? AND state='adopted'",
	);
	const suppressed = (row: Suggestion, owner?: BotKey) =>
		workflow.visibility(row, owner) ?? (row.sourceId === sourceId &&
		!!row.job && !!active.get(row.sourceId, row.job, row.attempt));
	return {
		...workflow,
		suppressed,
		// Only the configured synthetic source can be filtered. In-flight
		// assignments continue to use their original authorization.
		exclusion: ` AND NOT EXISTS (
			SELECT 1 FROM pb_feedback f WHERE f.source=? AND f.source=h.source AND f.job=l.job
				AND f.attempt=h.attempt AND f.state='adopted'
		)`,
		sourceId,
		list() {
			return sourceId
				? db
						.prepare(
							"SELECT payload FROM pb_feedback WHERE source=? ORDER BY rowid DESC LIMIT 30",
						)
						.all(sourceId)
						.map(decode)
				: [];
		},
		apply(input: FeedbackAction, find: (id: string) => Suggestion | undefined) {
			if (!sourceId) throw new Rejection("forbidden");
			if (input.action === "propose") {
				const row = find(input.decisionId);
				if (
					!row?.job ||
					row.sourceId !== sourceId ||
					row.revision !== input.expectedRevision
				)
					throw new Rejection("stale");
				if (
					db
						.prepare(
							"SELECT id FROM pb_feedback WHERE source=? AND job=? AND attempt=?",
						)
						.get(sourceId, row.job, row.attempt)
				)
					throw new Rejection("conflict");
				if (
					Number(
						db
							.prepare("SELECT count(*) AS n FROM pb_feedback WHERE source=?")
							.get(sourceId)?.n,
					) >= 30
				)
					throw new Rejection("forbidden");
				save({
					id: randomUUID(),
					sourceId,
					job: row.job,
					attempt: row.attempt,
					revision: 0,
					state: "candidate",
				});
				return 1;
			}
			const found = db
				.prepare("SELECT payload FROM pb_feedback WHERE id=? AND source=?")
				.get(input.ruleId, sourceId);
			if (!found) throw new Rejection("stale");
			const rule = decode(found);
			if (rule.revision !== input.expectedRevision)
				throw new Rejection("stale");
			const revision = rule.revision + 1;
			if (input.action === "evaluate" && rule.state === "candidate") {
				const batches = heldOut.map(({ id, rows }) => {
					const suppress = rows.filter(
						(row) => row.job === rule.job && row.attempt === rule.attempt,
					);
					const beforeFalsePositives = rows.filter(
						(row) => !row.needsSuggestion,
					).length;
					return {
						id,
						beforeFalsePositives,
						afterFalsePositives:
							beforeFalsePositives -
							suppress.filter((row) => !row.needsSuggestion).length,
						beforeMissed: 0,
						afterMissed: suppress.filter((row) => row.needsSuggestion).length,
					};
				});
				const passed =
					batches.some(
						(batch) => batch.afterFalsePositives < batch.beforeFalsePositives,
					) && batches.every((batch) => batch.afterMissed === 0);
				save({
					...rule,
					revision,
					state: passed ? "eligible" : "rejected",
					evaluation: {
						dataset: "synthetic-ci-v2",
						digest: digest(heldOut),
						batches,
						passed,
					},
				});
			} else if (
				input.action === "adopt" &&
				["eligible", "revoked"].includes(rule.state) &&
				rule.evaluation?.passed
			) {
				save({ ...rule, revision, state: "adopted" });
			} else if (input.action === "revoke" && rule.state === "adopted") {
				save({ ...rule, revision, state: "revoked" });
			} else {
				throw new Rejection("forbidden");
			}
			return 1;
		},
	};
}

function compareCandidate(rule: FeedbackCandidate, dataset: FrozenFeedbackDataset): FeedbackComparison {
	if (!("change" in rule.proposal) || !sameBot(rule.proposal.origin.bot, dataset.owner)) throw new Rejection("forbidden");
	const change = rule.proposal.change;
	const batches = dataset.batches.map(batch => {
		const counts = {
			id: batch.id, samples: batch.rows.length, disputed: 0,
			beforeFalsePositives: 0, afterFalsePositives: 0, beforeMissed: 0, afterMissed: 0,
			beforeUnwantedNotices: 0, afterUnwantedNotices: 0, beforeMissedNotices: 0, afterMissedNotices: 0,
		};
		for (const row of batch.rows) {
			if (row.labelAgreement === "disputed") counts.disputed++;
			const matches = row.sourceId === change.sourceId && row.sourceGeneration === change.sourceGeneration && row.job === change.job && row.attempt === change.attempt;
			const after = matches && change.mode !== "mute" ? change.mode === "include" : row.baselineSuggested;
			const notify = matches && change.mode === "mute" ? false : row.baselineNotified;
			counts.beforeFalsePositives += Number(row.baselineSuggested && !row.needed);
			counts.afterFalsePositives += Number(after && !row.needed);
			counts.beforeMissed += Number(!row.baselineSuggested && row.needed);
			counts.afterMissed += Number(!after && row.needed);
			counts.beforeUnwantedNotices += Number(row.baselineNotified && !row.attentionNeeded);
			counts.afterUnwantedNotices += Number(notify && !row.attentionNeeded);
			counts.beforeMissedNotices += Number(!row.baselineNotified && row.attentionNeeded);
			counts.afterMissedNotices += Number(!notify && row.attentionNeeded);
		}
		return counts;
	});
	const sum = (key: keyof Omit<(typeof batches)[number], "id">) => batches.reduce((total, row) => total + row[key], 0);
	const improved = change.mode === "suppress"
		? sum("afterFalsePositives") < sum("beforeFalsePositives")
		: change.mode === "include" ? sum("afterMissed") < sum("beforeMissed")
			: sum("afterUnwantedNotices") < sum("beforeUnwantedNotices");
	return {
		datasetId: dataset.id, datasetVersion: dataset.version, digest: dataset.digest,
		maxAddedMisses: dataset.maxAddedMisses, evaluatedAt: Date.now(), batches,
		passed: improved && sum("disputed") === 0 &&
			sum("afterMissed") - sum("beforeMissed") <= dataset.maxAddedMisses &&
			sum("afterFalsePositives") <= sum("beforeFalsePositives") &&
			sum("afterMissedNotices") <= sum("beforeMissedNotices"),
	};
}

/** One durable authority, including the claim before memory/skill side effects. */
function openWorkflow(db: DatabaseSync) {
	db.exec(`CREATE TABLE IF NOT EXISTS pb_feedback_dataset (
		id TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL UNIQUE,
		payload TEXT NOT NULL, PRIMARY KEY(id,version));
	CREATE TABLE IF NOT EXISTS pb_feedback_candidate (
		id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS pb_feedback_candidate_revision (
		id TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL,
		payload TEXT NOT NULL, PRIMARY KEY(id,revision));
	CREATE TABLE IF NOT EXISTS pb_feedback_dataset_tombstone (
		id TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL UNIQUE,
		purged_at INTEGER NOT NULL, PRIMARY KEY(id,version));`);
	const decode = (row: Record<string, unknown>) => feedbackCandidate.parse(JSON.parse(String(row.payload)));
	const candidates = () => db.prepare("SELECT payload FROM pb_feedback_candidate ORDER BY rowid DESC LIMIT 200").all().map(decode);
	const datasets = () => db.prepare("SELECT payload FROM pb_feedback_dataset ORDER BY rowid DESC LIMIT 30").all()
		.map(row => frozenFeedbackDataset.parse(JSON.parse(String(row.payload))));
	const candidate = (id: string) => {
		const row = db.prepare("SELECT payload FROM pb_feedback_candidate WHERE id=?").get(id);
		return row ? decode(row) : undefined;
	};
	const save = (row: FeedbackCandidate) => {
		const payload = JSON.stringify(feedbackCandidate.parse(row));
		db.prepare("INSERT INTO pb_feedback_candidate VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload")
			.run(row.id, row.state, payload);
		db.prepare("INSERT INTO pb_feedback_candidate_revision VALUES (?,?,?,?)").run(row.id, row.revision, Date.now(), payload);
	};
	for (const row of candidates()) {
		if (row.state === "applying" || row.state === "revoking")
			save({ ...row, state: "unknown", revision: row.revision + 1, unknownAction: row.state === "applying" ? "adopt" : "revoke" });
	}
	const activeFor = (row: Pick<Suggestion, "sourceId" | "job" | "attempt"> & { sourceGeneration?: number }, owner?: BotKey) => {
		if (!owner) return [];
		const sourceGeneration = row.sourceGeneration ?? Number(db.prepare("SELECT generation FROM pb_source WHERE id=?").get(row.sourceId)?.generation);
		if (!Number.isSafeInteger(sourceGeneration) || !row.job) return [];
		return db.prepare(`SELECT payload FROM pb_feedback_candidate WHERE state='adopted'
			AND json_extract(payload,'$.proposal.origin.bot.botId')=?
			AND json_extract(payload,'$.proposal.origin.bot.botCreatedAt')=?
			AND json_extract(payload,'$.proposal.change.sourceId')=?
			AND json_extract(payload,'$.proposal.change.sourceGeneration')=?
			AND json_extract(payload,'$.proposal.change.job')=?
			AND json_extract(payload,'$.proposal.change.attempt')=? ORDER BY rowid DESC`)
			.all(owner.botId, owner.botCreatedAt, row.sourceId, sourceGeneration, row.job, row.attempt).map(decode);
	};
	return {
		candidates, candidate, datasets,
		purgeSourceBody(sourceId: string, generation: number, ticketIds: string[], decisionIds: string[] = []) {
			const taskIds = new Set([...ticketIds, ...decisionIds]);
			let removedCandidates = 0, removedDatasets = 0;
			const at = Date.now();
			db.exec("SAVEPOINT feedback_purge");
			try {
				for (const row of candidates()) {
					const p = row.proposal;
					const matches = p.origin.source?.id === sourceId && p.origin.source.generation === generation ||
						"change" in p && p.change.sourceId === sourceId && p.change.sourceGeneration === generation ||
						taskIds.has(p.origin.taskId) || p.kind === "rework" && taskIds.has(p.ticketId);
					if (!matches || row.bodyPurgedAt !== undefined) continue;
					// Applied changes retain their review/withdrawal evidence. They are
					// separate user-owned memory/skill records and are not source data.
					const applied = db.prepare("SELECT 1 FROM pb_feedback_candidate_revision WHERE id=? AND json_extract(payload,'$.state') IN ('adopted','revoked','applying','revoking','unknown') LIMIT 1").get(row.id);
					if (applied) continue;
					const redact = (value: FeedbackCandidate): FeedbackCandidate => ({ ...value, bodyPurgedAt: at,
						proposal: { ...value.proposal, reason: "[source body forgotten]",
							...(value.proposal.kind === "preference" ? { content: "[source body forgotten]" } : {}),
							...(value.proposal.kind === "skill" ? { content: "[source body forgotten]", before: null, beforeHash: null } : {}),
						} as FeedbackCandidate["proposal"] });
					for (const old of db.prepare("SELECT payload FROM pb_feedback_candidate_revision WHERE id=?").all(row.id).map(decode))
						db.prepare("UPDATE pb_feedback_candidate_revision SET payload=? WHERE id=? AND revision=?").run(JSON.stringify(redact(old)), row.id, old.revision);
					save({ ...redact(row), state: "rejected", revision: row.revision + 1 });
					removedCandidates++;
				}
				for (const dataset of datasets()) {
					if (!dataset.batches.some(batch => batch.rows.some(row => row.sourceId === sourceId && row.sourceGeneration === generation))) continue;
					db.prepare("INSERT INTO pb_feedback_dataset_tombstone VALUES (?,?,?,?)").run(dataset.id, dataset.version, dataset.digest, at);
					db.prepare("DELETE FROM pb_feedback_dataset WHERE id=? AND version=?").run(dataset.id, dataset.version);
					removedDatasets++;
				}
				db.exec("RELEASE feedback_purge");
				return { candidates: removedCandidates, datasets: removedDatasets };
			} catch (error) { db.exec("ROLLBACK TO feedback_purge; RELEASE feedback_purge"); throw error; }
		},
		view(after?: string) {
			const all = candidates();
			const index = after ? all.findIndex(row => row.id === after) : -1;
			if (after && index < 0) throw new Rejection("stale");
			const page: FeedbackCandidate[] = [];
			let bytes = 0;
			const remaining = all.slice(index + 1);
			for (const row of remaining) {
				const size = Buffer.byteLength(JSON.stringify(row));
				if (page.length && bytes + size > 64 * 1024) break;
				page.push(row); bytes += size;
			}
			return { candidates: page, datasets: datasets().map(row => ({ id: row.id, version: row.version, owner: row.owner,
				digest: row.digest, frozenAt: row.frozenAt, samples: row.batches.reduce((n, batch) => n + batch.rows.length, 0),
				disputed: row.batches.reduce((n, batch) => n + batch.rows.filter(sample => sample.labelAgreement === "disputed").length, 0),
				exceptions: row.exceptions.length })),
				...(remaining.length > page.length ? { nextCursor: page.at(-1)?.id } : {}) };
		},
		history(id: string) { return db.prepare("SELECT payload FROM pb_feedback_candidate_revision WHERE id=? ORDER BY revision").all(id).map(decode); },
		historyPage(id: string, afterRevision = -1) {
			const rows = db.prepare("SELECT payload FROM pb_feedback_candidate_revision WHERE id=? AND revision>? ORDER BY revision LIMIT 101")
				.all(id, afterRevision).map(decode);
			const page: FeedbackCandidate[] = [];
			let bytes = 0;
			for (const row of rows) {
				if (page.length >= 100) break;
				const size = Buffer.byteLength(JSON.stringify(row));
				if (page.length && bytes + size > 64 * 1024) break;
				page.push(row); bytes += size;
			}
			return { rows: page, ...(rows.length > page.length ? { nextRevision: page.at(-1)?.revision } : {}) };
		},
		revokeBotFence(owner: BotKey) {
			let count = 0;
			for (const row of candidates()) if (sameBot(row.proposal.origin.bot, owner) && "change" in row.proposal && row.state === "adopted") {
				save({ ...row, state: "revoked", revision: row.revision + 1 }); count++;
			}
			return count;
		},
		visibility(row: Pick<Suggestion, "sourceId" | "job" | "attempt">, owner?: BotKey): boolean | undefined {
			const changes = activeFor(row, owner).filter(candidate => "change" in candidate.proposal && candidate.proposal.change.mode !== "mute");
			const selected = changes[0];
			return selected && "change" in selected.proposal ? selected.proposal.change.mode === "suppress" : undefined;
		},
		muted(row: Pick<Suggestion, "sourceId" | "job" | "attempt">, owner?: BotKey) {
			return activeFor(row, owner).some(candidate => "change" in candidate.proposal && candidate.proposal.change.mode === "mute");
		},
		workflow(raw: FeedbackWorkflowAction) {
			const input = feedbackWorkflowAction.parse(raw);
			db.exec("SAVEPOINT feedback_workflow");
			try {
				if (input.action === "import-dataset") {
					const value: FeedbackDataset = input.dataset;
					if (datasets().length >= 30) throw new Rejection("forbidden");
					if (db.prepare("SELECT 1 FROM pb_feedback_dataset WHERE id=? AND version=?").get(value.id, value.version))
						throw new Rejection("conflict");
					if (db.prepare("SELECT 1 FROM pb_feedback_dataset_tombstone WHERE (id=? AND version=?) OR digest=?").get(value.id, value.version, digest(value)))
						throw new Rejection("conflict");
					const frozen = { ...value, digest: digest(value), frozenAt: Date.now() };
					db.prepare("INSERT INTO pb_feedback_dataset VALUES (?,?,?,?)").run(value.id, value.version, frozen.digest, JSON.stringify(frozen));
				} else if (input.action === "propose-candidate") {
					if (candidates().length >= 200) throw new Rejection("forbidden");
					save({ id: randomUUID(), revision: 0, createdAt: Date.now(), proposal: input.proposal,
						proposalDigest: digest(input.proposal), datasetDigests: datasets().map(row => row.digest), state: "candidate" });
				} else {
					const row = candidate(input.candidateId);
					if (!row || row.revision !== input.expectedRevision) throw new Rejection("stale");
					if (row.bodyPurgedAt !== undefined) throw new Rejection("forbidden");
					const next = { ...row, revision: row.revision + 1 };
					if (input.action === "evaluate-candidate") {
						if (row.state !== "candidate" || row.evaluation) throw new Rejection("forbidden");
						const dataset = datasets().find(item => item.id === input.datasetId && item.version === input.datasetVersion);
						if (!dataset || !row.datasetDigests.includes(dataset.digest) ||
							dataset.batches.some(batch => batch.rows.some(sample => sample.taskId === row.proposal.origin.taskId)))
							throw new Rejection("forbidden");
						const evaluation = compareCandidate(row, dataset);
						save({ ...next, evaluation, state: evaluation.passed ? "eligible" : "rejected" });
					} else if (input.action === "adopt-candidate") {
						if (input.reviewedDigest !== row.proposalDigest || row.proposal.kind === "permission") throw new Rejection("forbidden");
						if ("change" in row.proposal) {
							if (row.state !== "eligible" && row.state !== "revoked" || !row.evaluation?.passed) throw new Rejection("forbidden");
							const change = row.proposal.change;
							const conflicting = activeFor(change, row.proposal.origin.bot).some(item => item.id !== row.id && "change" in item.proposal &&
								(item.proposal.change.mode === "mute") === (change.mode === "mute"));
							if (conflicting) throw new Rejection("conflict");
							save({ ...next, state: "adopted" });
						} else {
							if (row.state !== "candidate") throw new Rejection("forbidden");
							save({ ...next, state: "applying", operationId: randomUUID() });
						}
					} else if (input.action === "revoke-candidate") {
						if (row.state !== "adopted" || input.reviewedDigest !== row.proposalDigest || row.proposal.kind === "rework") throw new Rejection("forbidden");
						save("change" in row.proposal ? { ...next, state: "revoked" } : { ...next, state: "revoking", operationId: randomUUID() });
					} else {
						if (!row.operationId || input.operationId !== row.operationId || !["applying", "revoking"].includes(row.state)) throw new Rejection("forbidden");
						if (input.outcome === "unknown") save({ ...next, state: "unknown", unknownAction: row.state === "applying" ? "adopt" : "revoke" });
						else {
							const required = row.proposal.kind === "preference" ? "memory" : row.proposal.kind;
							if (!input.receipt || input.receipt.kind !== required) throw new Rejection("invalid");
							save({ ...next, state: row.state === "applying" ? "adopted" : "revoked", application: input.receipt });
						}
					}
				}
				db.exec("RELEASE feedback_workflow");
				return 1;
			} catch (error) {
				db.exec("ROLLBACK TO feedback_workflow; RELEASE feedback_workflow");
				throw error;
			}
		},
	};
}
