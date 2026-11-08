import { openGovernance } from "./governance.js";
import type { GovernanceConfig } from "../src/shared/proactive/governance.js";
import { openDeferredNotices } from "./notices.js";
import type { NoticeConfig } from "../src/shared/proactive/notices.js";
import { randomUUID } from "node:crypto";
import { Store, Engine } from "./core.mjs";
import {
	type CommandEnvelope,
	type AutoCiRule,
	type Receipt,
	receiptSchema,
	sourceCheckpointSchema,
	suggestionsSchema,
	suggestionSchema,
} from "../src/shared/proactive/protocol.js";
import { digest } from "../src/host/proactive/wire.js";
import { ownState } from "./ownership.js";
import { Rejection } from "./rejection.js";
import { openFeedback } from "./feedback.js";
import { openWork } from "./work.js";
import { openResponsibilities } from "./responsibilities.js";
import type { BotKey } from "../src/shared/identity.js";
import type { ResponsibilityBinding } from "../src/shared/proactive/responsibility.js";
import type { WorkHistoryRequest } from "../src/shared/proactive/work.js";

const suggestionLifetimeMs = 24 * 60 * 60 * 1000;
const observeMs = 60 * 60 * 1000;

export function openCoordinator(
	path: string,
	installationId: string,
	expectedStoreId: string | null,
	budget: number,
	externalBudget: number,
	notices: boolean,
	autoRule?: AutoCiRule,
	feedbackSource?: string,
	noticeConfig?: NoticeConfig,
	governanceConfig?: GovernanceConfig,
) {
	const ownership = ownState(path);
	let store: Store | undefined;
	try {
		if (expectedStoreId !== null && !ownership.storeExists)
			throw new Rejection("forbidden");
		store = new Store(ownership.storePath);
		const assertOwner = ownership.bindStore();
		const repository = store;
		const db = repository.db;
		const {
			storeId,
			work,
			feedback,
			responsibilities,
			deferredNotices,
			governance,
		} = repository.atomic(() => {
			db.exec(`CREATE TABLE IF NOT EXISTS pb_meta (singleton INTEGER PRIMARY KEY CHECK (singleton=1),
        schema_version INTEGER NOT NULL, installation TEXT NOT NULL, store TEXT NOT NULL, seq INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pb_inbox (id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pb_source (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, checkpoint TEXT);
        CREATE TABLE IF NOT EXISTS pb_source_revocation (id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pb_event (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pb_ci_head (source TEXT NOT NULL, generation INTEGER NOT NULL,
          thread TEXT NOT NULL, attempt INTEGER NOT NULL, observed_at TEXT NOT NULL, conclusion TEXT NOT NULL,
          decision TEXT NOT NULL, PRIMARY KEY(source,generation,thread));
        CREATE TABLE IF NOT EXISTS pb_ci_labels (decision TEXT PRIMARY KEY, job TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pb_suggestion_adjustment (decision TEXT PRIMARY KEY, revision INTEGER NOT NULL,title TEXT NOT NULL,at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pb_ci_context (decision TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pb_suggestion_action (
          decision TEXT PRIMARY KEY, revision INTEGER NOT NULL, dismissed INTEGER NOT NULL,
          observe_until INTEGER
        );`);
			const feedback = openFeedback(db, feedbackSource);
			const responsibilities = openResponsibilities(db);
			const deferredNotices = openDeferredNotices(db, noticeConfig);
			const work = openWork(
				db,
				repository,
				findSuggestion,
				budget,
				externalBudget,
				notices,
				autoRule,
			);
			const governance = openGovernance(repository, governanceConfig);
			const saved = db.prepare("SELECT * FROM pb_meta WHERE singleton=1").get();
			if (saved) {
				if (
					![1, 2, 3, 4, 5, 6, 7].includes(Number(saved.schema_version)) ||
					saved.installation !== installationId ||
					(expectedStoreId !== null && saved.store !== expectedStoreId)
				)
					throw new Rejection("forbidden");
				if (Number(saved.schema_version) < 6) {
					// Preserve the old conservative model charge and copy each external
					// reservation into its new ledger so an upgrade never creates credit.
					db.exec(`INSERT INTO pb_external_budget
						SELECT b.assignment,b.utc_day FROM pb_execution_budget b
						JOIN pb_work w ON w.assignment=b.assignment
						WHERE json_extract(w.payload,'$.repair.executor')='external'`);
					db.prepare(
						"UPDATE pb_meta SET schema_version=6 WHERE singleton=1",
					).run();
				}
				db.prepare(
					"UPDATE pb_meta SET schema_version=7 WHERE singleton=1",
				).run();
				return {
					storeId: String(saved.store),
					work,
					feedback,
					responsibilities,
					deferredNotices,
					governance,
				};
			}
			if (expectedStoreId !== null) throw new Rejection("forbidden");
			const id = randomUUID();
			db.prepare("INSERT INTO pb_meta VALUES (1,7,?,?,0)").run(
				installationId,
				id,
			);
			return {
				storeId: id,
				work,
				feedback,
				responsibilities,
				deferredNotices,
				governance,
			};
		});
		const unavailable = () => {
			throw new Rejection("unsupported");
		};
		const engine = new Engine({
			repo: repository,
			scope: { scope: () => ({ listened: true, observed: true }) },
			policy: () => ({
				version: "pb01-observation",
				paused: true,
				evalTimeoutMs: 0,
				gate: (trigger) =>
					trigger.source.startsWith("ci:") && trigger.meta.ci
						? {
								admissible: true,
								strength: "inferred",
								basis: {
									via: "bot",
									observation: {
										mode: work.admits(trigger.id) ? "auto" : "observe",
									},
								},
							}
						: { admissible: false, reason: "observation-only" },
				revalidate: () => false,
				admitsInferred: work.admitsRules,
			}),
			assessor: { request: unavailable },
			// This adapter persists the dispatch receipt in the same command
			// transaction. Only the Host can claim and deliver the exact assignment.
			executor: { start() {}, deliver() {}, stop() {} },
			outbox: {
				send: unavailable,
				withdraw: unavailable,
				status: () => undefined,
			},
		});
		const lookup = db.prepare("SELECT digest,receipt FROM pb_inbox WHERE id=?");
		function receipt(id: string): Receipt | null {
			assertOwner();
			const row = lookup.get(id);
			return row ? receiptSchema.parse(JSON.parse(String(row.receipt))) : null;
		}
		const openSuggestions = `FROM pb_ci_head h
      JOIN pb_source s ON s.id=h.source AND s.generation=h.generation
      LEFT JOIN pb_suggestion_action a ON a.decision=h.decision
      LEFT JOIN pb_ci_labels l ON l.decision=h.decision
      WHERE NOT EXISTS (SELECT 1 FROM pb_source_revocation r WHERE r.id=h.source AND r.generation>=h.generation)
      AND h.conclusion='failure' AND COALESCE(a.dismissed,0)=0 AND h.observed_at>?`;
		function oldestSuggestion(now: number) {
			return new Date(now - suggestionLifetimeMs).toISOString();
		}
		function command(request: CommandEnvelope): Receipt {
			assertOwner();
			if (request.storeId !== storeId) throw new Rejection("forbidden");
			const { body, commandId } = request;
			if (digest(body) !== request.payloadDigest)
				throw new Rejection("invalid");
			const existing = lookup.get(commandId);
			if (existing) {
				if (existing.digest !== request.payloadDigest)
					throw new Rejection("conflict");
				return {
					...receiptSchema.parse(JSON.parse(String(existing.receipt))),
					status: "duplicate",
				};
			}
			return repository.atomic(() => {
				let stored: number;
				switch (body.kind) {
					case "ingest-batch":
						stored = ingest(body);
						break;
					case "revoke-source": {
						const source = db
							.prepare("SELECT generation FROM pb_source WHERE id=?")
							.get(body.sourceId);
						if (source && Number(source.generation) > body.generation)
							throw new Rejection("stale");
						db.prepare(`INSERT INTO pb_source VALUES (?,?,NULL) ON CONFLICT(id)
							DO UPDATE SET generation=excluded.generation,checkpoint=NULL
							WHERE pb_source.generation<excluded.generation`).run(
							body.sourceId,
							body.generation,
						);
						db.prepare(`INSERT INTO pb_source_revocation VALUES (?,?) ON CONFLICT(id)
              DO UPDATE SET generation=excluded.generation`).run(
							body.sourceId,
							body.generation,
						);
						stored = 1;
						break;
					}
					case "adjust-suggestion": {
						const current = findSuggestion(body.decisionId);
						if (
							!current ||
							current.revision !== body.expectedRevision ||
							work.has(body.decisionId)
						)
							throw new Rejection("stale");
						db.prepare(
							`INSERT INTO pb_suggestion_adjustment VALUES(?,?,?,?) ON CONFLICT(decision) DO UPDATE SET revision=excluded.revision,title=excluded.title,at=excluded.at`,
						).run(
							body.decisionId,
							body.expectedRevision + 1,
							body.title,
							Date.now(),
						);
						db.prepare(
							`INSERT INTO pb_suggestion_action VALUES(?,?,0,NULL) ON CONFLICT(decision) DO UPDATE SET revision=excluded.revision,observe_until=NULL`,
						).run(body.decisionId, body.expectedRevision + 1);
						stored = 1;
						break;
					}
					case "suggestion-action": {
						const now = Date.now();
						const current = db
							.prepare(`SELECT COALESCE(a.revision,0) AS revision
              ${openSuggestions} AND h.decision=?`)
							.get(oldestSuggestion(now), body.decisionId);
						if (
							!current ||
							current.revision !== body.expectedRevision ||
							work.has(body.decisionId)
						)
							throw new Rejection("stale");
						db.prepare(`INSERT INTO pb_suggestion_action VALUES (?,?,?,?)
              ON CONFLICT(decision) DO UPDATE SET revision=excluded.revision,
              dismissed=excluded.dismissed, observe_until=excluded.observe_until`).run(
							body.decisionId,
							body.expectedRevision + 1,
							body.action === "dismiss" ? 1 : 0,
							body.action === "observe" ? now + observeMs : null,
						);
						stored = 1;
						break;
					}
					case "execution-drained": {
						const row = work.getAssignment(body.assignmentId);
						if (
							!row ||
							row.ticketId !== body.ticketId ||
							row.revision !== body.expectedRevision ||
							!["cancelled", "unknown", "denied", "failed"].includes(row.state)
						)
							throw new Rejection("stale");
						if (row.responsibility)
							responsibilities.settle({
								reservationId: row.assignmentId,
								outcome: "unknown",
								finished: true,
							});
						stored = 1;
						break;
					}
					case "settle-group-budget": {
						const row = work.getAssignment(body.assignmentId);
						const allocation = [
							row?.groupReview?.budget,
							row?.groupReview?.followUp?.budget,
						].find((budget) => budget?.reservationId === body.reservationId);
						if (
							!row?.responsibility ||
							row.ticketId !== body.ticketId ||
							!allocation
						)
							throw new Rejection("stale");
						if (
							body.outcome === "known" &&
							(body.tokens === undefined ||
								body.tokens > allocation.totalTokens)
						)
							throw new Rejection("invalid");
						try {
							responsibilities.settle(
								body.outcome === "known"
									? {
											reservationId: body.reservationId,
											outcome: "known",
											tokens: body.tokens ?? 0,
										}
									: {
											reservationId: body.reservationId,
											outcome: "unknown",
											finished: true,
										},
							);
						} catch (error) {
							if (!(error instanceof Rejection) || error.code !== "conflict")
								throw error;
							responsibilities.settle({
								reservationId: body.reservationId,
								outcome: "unknown",
								finished: true,
							});
						}
						stored = 1;
						break;
					}
					case "governance-sweep":
						governance.sweep();
						stored = 1;
						break;
					case "forget-block":
						governance.blockForget(body.operationId, body.reason);
						stored = 1;
						break;
					case "forget-begin":
						governance.beginForget(body.input);
						responsibilities.sourceFence(
							body.input.sourceId,
							body.input.generation,
						);
						deferredNotices.cancelSource(
							body.input.sourceId,
							body.input.generation,
						);
						stored = 1;
						break;
					case "forget-finish": {
						const previous = governance.forget(body.input.operationId);
						if (!previous) throw new Rejection("stale");
						const scope = governance.sourceContext(
							previous.sourceId,
							previous.generation,
						);
						const result = governance.finishForget(body.input);
						if (result.phase === "complete" || result.phase === "purging") {
							feedback.purgeSourceBody(
								previous.sourceId,
								previous.generation,
								scope.ticketIds,
								scope.decisionIds,
							);
							for (const id of scope.decisionIds)
								db.prepare(
									"DELETE FROM pb_suggestion_adjustment WHERE decision=?",
								).run(id);
							responsibilities.purgeSourceBody(
								previous.sourceId,
								previous.generation,
							);
							for (const id of scope.decisionIds)
								db.prepare("DELETE FROM pb_ci_context WHERE decision=?").run(
									id,
								);
						}
						stored = 1;
						break;
					}
					case "governance-purge":
						governance.recordPurge(body.input.planId, body.input.result);
						stored = 1;
						break;
					case "notice-schedule": {
						const row = work.getAssignment(body.input.assignmentId),
							head = checkpoint(body.input.sourceId);
						if (
							!row?.notice ||
							row.notice.operationId !== body.input.operationId ||
							row.ticketId !== body.input.ticketId ||
							!work.permitted(row.assignmentId, undefined, row.revision) ||
							head?.revoked ||
							head?.generation !== body.input.sourceGeneration
						)
							throw new Rejection("stale");
						deferredNotices.schedule(body.input);
						stored = 1;
						break;
					}
					case "notice-revise":
						deferredNotices.revise(body.input);
						stored = 1;
						break;
					case "notice-cancel": {
						const row = deferredNotices.cancel(
							body.operationId,
							body.expectedRevision,
						);
						work.settleNotice(row.assignmentId, "suppressed");
						stored = 1;
						break;
					}
					case "notice-claim": {
						const result = deferredNotices.claim(body.input);
						if (!result.fresh) throw new Rejection("conflict");
						stored = 1;
						break;
					}
					case "notice-settle": {
						const batch = deferredNotices.settle(body.input);
						for (const item of batch.items)
							work.settleNotice(item.assignmentId, body.input.state);
						stored = 1;
						break;
					}
					case "responsibility-mutation":
						responsibilities.apply(body.input);
						stored = 1;
						break;
					case "feedback-workflow":
						feedback.workflow(body.input);
						stored = 1;
						break;
					case "feedback-rule":
						stored = feedback.apply(body.input, findSuggestion);
						break;
					case "accept-decision":
					case "auto-accept": {
						if (
							body.kind === "auto-accept" &&
							work.hasGroupFollowUp(body.decisionId)
						)
							throw new Rejection("conflict");
						const row = findSuggestion(body.decisionId);
						if (row && feedback.suppressed(row, body.target.bot))
							throw new Rejection("forbidden");
						stored = work.apply(engine, body);
						if (body.responsibility && row) {
							const saved = work.get(body.decisionId);
							if (!saved) throw new Rejection("stale");
							const policy = responsibilities.get(body.responsibility.id);
							if (!policy) throw new Rejection("stale");
							const binding: ResponsibilityBinding = {
								bot: body.target.bot,
								source: {
									...policy.source,
									id: row.sourceId,
									generation: row.sourceGeneration ?? -1,
									...(row.context
										? {
												repository: row.context.repository,
												branch: row.context.branch,
											}
										: {}),
								},
								...((saved.workspaceRepair?.specDigest ??
								saved.repair?.specDigest)
									? {
											actionScopeDigest:
												saved.workspaceRepair?.specDigest ??
												saved.repair?.specDigest,
										}
									: {}),
								action: saved.workspaceRepair
									? "repair-workspace"
									: saved.repair
										? saved.repair.executor === "external"
											? "repair-external"
											: "repair-fixture"
										: "inspect-ci-result",
								target: body.target,
								job: row.job ?? "unknown",
								attempt: row.attempt,
								conclusion: "failure",
								observedAt: row.observedAt,
							};
							const grant = responsibilities.admit({
								grantId: digest([saved.ticketId, "grant"]),
								ticketId: saved.ticketId,
								responsibilityId: policy.id,
								expectedRevision: body.responsibility.revision,
								binding,
								automatic: body.kind === "auto-accept",
							});
							work.bindGrant(saved.assignmentId, {
								acceptance: grant.acceptance,
								responsibility: {
									id: policy.id,
									revision: policy.revision,
									grantId: grant.id,
									binding,
								},
								taskLimits: {
									maxAttempts: Math.min(
										grant.limits.taskAttempts,
										body.taskLimits?.maxAttempts ?? 20,
									),
									maxTokens: Math.min(
										32768,
										grant.limits.taskTokens,
										body.taskLimits?.maxTokens ?? 32768,
									),
									deadlineAt: new Date(
										Math.min(
											Date.parse(grant.expiresAt),
											Date.parse(
												body.taskLimits?.deadlineAt ?? grant.expiresAt,
											),
										),
									).toISOString(),
								},
							});
						}
						break;
					}
					default: {
						const prior =
							"ticketId" in body ? work.getTicket(body.ticketId) : null;
						if (body.kind === "dispatch-claim" && prior?.responsibility) {
							responsibilities.assertGrant(
								prior.responsibility.grantId,
								prior.responsibility.binding,
							);
							const remaining = responsibilities.remaining(
								prior.responsibility.grantId,
							);
							const tokens = Math.min(
								32768,
								prior.taskLimits?.maxTokens ?? 1024,
								remaining.tokens,
							);
							if (tokens < 128) throw new Rejection("forbidden");
							work.updatePendingLimits(prior.assignmentId, tokens);
							responsibilities.reserve({
								reservationId: prior.assignmentId,
								grantId: prior.responsibility.grantId,
								assignmentId: prior.assignmentId,
								requestCount: prior.groupRepair ? 3 : 1,
								tokens,
							});
						}
						let groupBudget: NonNullable<
							NonNullable<ReturnType<typeof work.getTicket>>["groupReview"]
						>["budget"];
						if (
							prior?.responsibility &&
							(body.kind === "claim-group-review" ||
								body.kind === "claim-group-follow-up")
						) {
							responsibilities.assertGrant(
								prior.responsibility.grantId,
								prior.responsibility.binding,
							);
							const requestCount = body.kind === "claim-group-review" ? 2 : 1,
								available = responsibilities.remaining(
									prior.responsibility.grantId,
								);
							const perCallTokens = Math.floor(
								Math.min(32768, available.tokens) / requestCount,
							);
							if (perCallTokens < 128) throw new Rejection("forbidden");
							const reservationId = `${prior.assignmentId}:${requestCount === 2 ? "review" : "follow-up"}`;
							responsibilities.reserve({
								reservationId,
								grantId: prior.responsibility.grantId,
								assignmentId: prior.assignmentId,
								tokens: perCallTokens * requestCount,
								requestCount,
							});
							groupBudget = {
								reservationId,
								perCallTokens,
								totalTokens: perCallTokens * requestCount,
								requestCount,
								deadlineAt: prior.taskLimits?.deadlineAt ?? prior.expiresAt,
							};
						}
						stored = work.apply(engine, body);
						if (groupBudget && prior)
							work.bindGroupBudget(
								prior.assignmentId,
								groupBudget,
								body.kind === "claim-group-follow-up",
							);
						if (
							body.kind === "report-result" &&
							prior?.responsibility &&
							["claimed", "sent", "unknown"].includes(prior.state)
						) {
							responsibilities.settle(
								body.result.state === "delivered" &&
									body.result.usage &&
									prior.state !== "unknown"
									? {
											reservationId: prior.assignmentId,
											outcome: "known",
											tokens:
												body.result.usage.inputTokens +
												body.result.usage.outputTokens,
										}
									: {
											reservationId: prior.assignmentId,
											outcome: "unknown",
											finished: true,
										},
							);
						}
					}
				}
				const committedSeq = Number(
					db.prepare("UPDATE pb_meta SET seq=seq+1 RETURNING seq").get()?.seq,
				);
				const result = receiptSchema.parse({
					scope: "core",
					status: "committed",
					commandId,
					receiptId: randomUUID(),
					committedSeq,
					stored,
				});
				db.prepare("INSERT INTO pb_inbox VALUES (?,?,?)").run(
					commandId,
					request.payloadDigest,
					JSON.stringify(result),
				);
				return result;
			});
		}
		function ingest(
			body: Extract<CommandEnvelope["body"], { kind: "ingest-batch" }>,
		) {
			const revoked = db
				.prepare("SELECT generation FROM pb_source_revocation WHERE id=?")
				.get(body.sourceId);
			if (revoked && Number(revoked.generation) >= body.generation)
				throw new Rejection("forbidden");
			const current = db
				.prepare("SELECT generation,checkpoint FROM pb_source WHERE id=?")
				.get(body.sourceId);
			if (current && Number(current.generation) > body.generation)
				throw new Rejection("stale");
			const previous =
				current?.generation === body.generation ? current.checkpoint : null;
			if (previous !== body.expectedCheckpoint) throw new Rejection("stale");
			let stored = 0;
			for (const event of body.events) {
				const id = digest([
					body.sourceId,
					body.generation,
					event.nativeId,
					event.nativeRevision,
				]);
				const payload = digest(event);
				const known = db
					.prepare("SELECT digest FROM pb_event WHERE id=?")
					.get(id);
				if (known) {
					if (known.digest !== payload) {
						const ci = event.ci;
						if (
							!ci?.job ||
							known.digest !==
								digest({
									...event,
									ci: { attempt: ci.attempt, conclusion: ci.conclusion },
								})
						)
							throw new Rejection("conflict");
					}
					continue;
				}
				const outcome = engine.receive({
					id,
					source: body.sourceId,
					human: false,
					actor: { source: body.sourceId, id: "automation" },
					threads: [
						{
							source: body.sourceId,
							id: digest([body.generation, event.threadId]),
						},
					],
					text: event.summary,
					at: event.occurredAt,
					meta: {
						nativeId: event.nativeId,
						nativeRevision: event.nativeRevision,
						generation: body.generation,
						...(event.ci ? { ci: event.ci } : {}),
					},
				});
				if (outcome !== "stored") throw new Rejection("conflict");
				db.prepare("INSERT INTO pb_event VALUES (?,?)").run(id, payload);
				if (event.ci && body.sourceId.startsWith("ci:")) {
					const key = [body.sourceId, body.generation, event.threadId] as const;
					const previous = db
						.prepare(`SELECT attempt,observed_at,conclusion FROM pb_ci_head
              WHERE source=? AND generation=? AND thread=?`)
						.get(...key);
					const observedAt = new Date(event.occurredAt).toISOString();
					const sameAttempt = previous?.attempt === event.ci.attempt;
					if (
						sameAttempt &&
						previous.observed_at === observedAt &&
						previous.conclusion !== event.ci.conclusion
					)
						throw new Rejection("conflict");
					if (
						!previous ||
						Number(previous.attempt) < event.ci.attempt ||
						(sameAttempt && String(previous.observed_at) < observedAt)
					) {
						const failure = event.ci.conclusion === "failure";
						const decision = engine.decide(id, {
							kind: "ignore",
							reason: {
								code: failure ? "ciFailureObserved" : "ciObservationSuperseded",
							},
							audit: {
								would_accept: failure,
								...(failure
									? {
											proposal: {
												title: event.summary,
												scope: "inspect-ci-result",
											},
										}
									: {}),
							},
						});
						if (event.ci.job)
							db.prepare("INSERT INTO pb_ci_labels VALUES (?,?)").run(
								decision.id,
								event.ci.job,
							);
						if (event.context)
							db.prepare("INSERT INTO pb_ci_context VALUES (?,?)").run(
								decision.id,
								JSON.stringify(event.context),
							);
						db.prepare(`INSERT INTO pb_ci_head VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,generation,thread)
                DO UPDATE SET attempt=excluded.attempt, observed_at=excluded.observed_at,
                conclusion=excluded.conclusion, decision=excluded.decision`).run(
							...key,
							event.ci.attempt,
							observedAt,
							event.ci.conclusion,
							decision.id,
						);
					} else
						engine.decide(id, {
							kind: "ignore",
							reason: { code: "ciOutOfOrder" },
						});
				}
				stored++;
			}
			db.prepare(`INSERT INTO pb_source VALUES (?,?,?) ON CONFLICT(id)
          DO UPDATE SET generation=excluded.generation, checkpoint=excluded.checkpoint`).run(
				body.sourceId,
				body.generation,
				body.nextCheckpoint,
			);
			if (
				autoRule &&
				body.sourceId === autoRule.sourceId &&
				body.generation === autoRule.sourceGeneration
			) {
				const context = body.events.find((event) => event.context)?.context;
				if (context)
					responsibilities.migrateLegacy(
						autoRule,
						{
							id: body.sourceId,
							generation: body.generation,
							repository: context.repository,
							branch: context.branch,
						},
						{
							dailyRequests: budget,
							dailyTokens: budget * 32768,
							taskTokens: 32768,
							taskAttempts: 3,
							taskWallTimeMs: 300000,
							concurrency: 1,
						},
					);
			}
			return stored;
		}
		function snapshot() {
			assertOwner();
			return {
				storeId,
				executionControl: work.control(),
				...(feedback.sourceId
					? {
							feedbackSource: feedback.sourceId,
							feedbackRules: feedback.list(),
						}
					: {}),
				committedSeq: Number(db.prepare("SELECT seq FROM pb_meta").get()?.seq),
				triggerCount: Number(
					db.prepare("SELECT count(*) AS n FROM pb_event").get()?.n,
				),
				ticketCount: repository.tickets.list().length,
				suggestionCount: Number(
					db
						.prepare(
							`SELECT count(*) AS n ${openSuggestions} AND NOT EXISTS (SELECT 1 FROM pb_work w WHERE w.decision=h.decision) ${feedback.exclusion}`,
						)
						.get(oldestSuggestion(Date.now()), feedback.sourceId ?? null)?.n,
				),
			};
		}
		function checkpoint(sourceId: string) {
			assertOwner();
			const row = db
				.prepare(`SELECT s.generation,s.checkpoint,r.generation AS revoked_generation
					FROM pb_source s LEFT JOIN pb_source_revocation r ON r.id=s.id WHERE s.id=?`)
				.get(sourceId);
			return row
				? sourceCheckpointSchema.parse({
						generation: row.generation,
						checkpoint: row.checkpoint,
						...(row.revoked_generation === row.generation
							? { revoked: true }
							: {}),
					})
				: null;
		}
		const suggestionColumns = `h.source,h.generation,h.observed_at,h.decision,h.attempt,l.job,
      COALESCE(a.revision,0) AS revision,a.observe_until`;
		function project(row: Record<string, unknown>, now: number) {
			const decision = repository.decisions.get(String(row.decision));
			const proposal = decision?.audit?.proposal;
			if (
				!decision ||
				!proposal ||
				typeof proposal !== "object" ||
				!("title" in proposal)
			)
				throw new Error("Proactive proposal projection is invalid");
			const observing = Number(row.observe_until) > now;
			return suggestionSchema.parse({
				id: decision.id,
				sourceId: row.source,
				sourceGeneration: row.generation,
				...(() => {
					const c = db
						.prepare("SELECT payload FROM pb_ci_context WHERE decision=?")
						.get(String(row.decision));
					return c ? { context: JSON.parse(String(c.payload)) } : {};
				})(),
				title:
					db
						.prepare(
							"SELECT title FROM pb_suggestion_adjustment WHERE decision=?",
						)
						.get(String(row.decision))?.title ?? proposal.title,
				adjusted: !!db
					.prepare("SELECT 1 FROM pb_suggestion_adjustment WHERE decision=?")
					.get(String(row.decision)),
				observedAt: row.observed_at,
				expiresAt: new Date(
					Date.parse(String(row.observed_at)) + suggestionLifetimeMs,
				).toISOString(),
				revision: row.revision,
				state: observing ? "observing" : "open",
				...(observing
					? { observeUntil: new Date(Number(row.observe_until)).toISOString() }
					: {}),
				policyVersion: decision.policyVersion,
				triggerId: decision.triggerIds[0],
				attempt: row.attempt,
				...(row.job ? { job: row.job } : {}),
				scope: "inspect-ci-result",
			});
		}
		function findSuggestion(id: string) {
			const now = Date.now();
			const row = db
				.prepare(
					`SELECT ${suggestionColumns} ${openSuggestions} AND h.decision=?`,
				)
				.get(oldestSuggestion(now), id);
			return row && project(row, now);
		}
		function suggestions(owner?: BotKey, includeFiltered = false) {
			assertOwner();
			const now = Date.now();
			const rows = db
				.prepare(`SELECT ${suggestionColumns} ${openSuggestions}
        AND NOT EXISTS (SELECT 1 FROM pb_work w WHERE w.decision=h.decision) ${owner || includeFiltered ? "" : feedback.exclusion}
        ORDER BY h.observed_at DESC,h.decision ASC LIMIT 100`)
				.all(
					...(owner || includeFiltered
						? [oldestSuggestion(now)]
						: [oldestSuggestion(now), feedback.sourceId ?? null]),
				);
			const policies =
				owner && !includeFiltered
					? responsibilities.list(owner).map((row) => row.responsibility)
					: [];
			return suggestionsSchema.parse(
				rows
					.map((row) => project(row, now))
					.filter((row) => includeFiltered || !feedback.suppressed(row, owner))
					.flatMap((row) => {
						if (!owner || includeFiltered || !policies.length) return [row];
						const matched = policies
							.filter((policy) => {
								if (!row.context) return false;
								const binding: ResponsibilityBinding = {
									bot: owner,
									source: {
										id: row.sourceId,
										generation: row.sourceGeneration ?? -1,
										repository: row.context.repository,
										branch: row.context.branch,
									},
									action: policy.action,
									...(policy.actionScopeDigest
										? { actionScopeDigest: policy.actionScopeDigest }
										: {}),
									target: policy.target,
									job: row.job ?? "unknown",
									attempt: row.attempt,
									conclusion: "failure",
									observedAt: row.observedAt,
								};
								return responsibilities
									.match(binding, false)
									.some((item) => item.id === policy.id);
							})
							.slice(0, 8);
						return matched.length
							? [
									{
										...row,
										matchedResponsibilities: matched.map(
											({ id, revision, name, action, actionScopeDigest }) => ({
												id,
												revision,
												name,
												action,
												...(actionScopeDigest ? { actionScopeDigest } : {}),
											}),
										),
									},
								]
							: [];
					}),
			);
		}
		repository.atomic(() => {
			work.recover(engine);
			responsibilities.recover();
			deferredNotices.recover();
		});
		return {
			storeId,
			sourceCleanupScope: (sourceId: string, generation: number) => {
				assertOwner();
				const { assignmentIds, notificationOperationIds } =
					governance.sourceContext(sourceId, generation);
				return { assignmentIds, notificationOperationIds };
			},
			forgetReceipt: (id: string) => {
				assertOwner();
				return governance.forget(id) ?? null;
			},
			governancePending: () => {
				assertOwner();
				return governance.pendingPurges().slice(0, 16);
			},
			workAssignment: (id: string) => {
				assertOwner();
				return work.getAssignment(id);
			},
			noticeCandidates: () => {
				assertOwner();
				return work.noticeCandidates();
			},
			noticeDue: () => {
				assertOwner();
				return deferredNotices.due(
					Math.min(1000, noticeConfig?.maxPending ?? 1000),
				);
			},
			noticeBatch: (id: string) => {
				assertOwner();
				return deferredNotices.batch(id) ?? null;
			},
			command,
			receipt,
			snapshot,
			suggestions,
			checkpoint,
			responsibilities: (owner: BotKey) => {
				assertOwner();
				return responsibilities.list(owner);
			},
			feedbackView: (cursor?: string) => {
				assertOwner();
				return feedback.view(cursor);
			},
			feedbackCandidate: (id: string) => {
				assertOwner();
				return feedback.candidate(id) ?? null;
			},
			feedbackHistory: (id: string, afterRevision?: number) => {
				assertOwner();
				return feedback.historyPage(id, afterRevision);
			},
			autoCandidates: () => {
				assertOwner();

				const result = [];
				for (const policy of responsibilities.all()) {
					if (policy.mode !== "auto") continue;
					for (const row of suggestions(policy.owner)) {
						if (
							row.adjusted ||
							row.state !== "open" ||
							feedback.suppressed(row, policy.owner)
						)
							continue;
						const binding: ResponsibilityBinding = {
							bot: policy.owner,
							source: {
								...policy.source,
								id: row.sourceId,
								generation: row.sourceGeneration ?? -1,
								...(row.context
									? {
											repository: row.context.repository,
											branch: row.context.branch,
										}
									: {}),
							},
							action: policy.action,
							target: policy.target,
							...(policy.actionScopeDigest
								? { actionScopeDigest: policy.actionScopeDigest }
								: {}),
							job: row.job ?? "unknown",
							attempt: row.attempt,
							conclusion: "failure",
							observedAt: row.observedAt,
						};
						if (
							responsibilities
								.match(binding, true)
								.some((m) => m.id === policy.id)
						)
							result.push({ suggestion: row, responsibility: policy });
						if (result.length === 100) return result;
					}
				}
				return result;
			},
			workHistory: (input: WorkHistoryRequest) => {
				assertOwner();
				return work.history(input);
			},
			work: (id: string) => {
				assertOwner();
				return work.get(id);
			},
			workTicket: (ticketId: string) => {
				assertOwner();
				return work.getTicket(ticketId);
			},
			permitted: (
				assignmentId: string,
				groupReviewDigest?: string,
				noticeRevision?: number,
				groupFactId?: string,
			) => {
				assertOwner();
				const row = work.getAssignment(assignmentId);
				if (row?.responsibility) {
					try {
						responsibilities.assertGrant(
							row.responsibility.grantId,
							row.responsibility.binding,
						);
					} catch {
						return false;
					}
				}
				return work.permitted(
					assignmentId,
					groupReviewDigest,
					noticeRevision,
					groupFactId,
				);
			},
			groupFollowUps: () => {
				assertOwner();
				return work.followUps();
			},
			workList: () => {
				assertOwner();
				return work.list();
			},
			close() {
				try {
					repository.close();
				} finally {
					ownership.close();
				}
			},
		};
	} catch (error) {
		try {
			store?.close();
		} finally {
			ownership.close();
		}
		throw error;
	}
}
