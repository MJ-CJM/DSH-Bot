import type { DatabaseSync } from "node:sqlite";
import { sameBot, type BotKey } from "../src/shared/identity.js";
import {
	responsibilityAdmissionSchema,
	responsibilityBindingSchema,
	responsibilityDraftSchema,
	responsibilityGrantSchema,
	responsibilityLimitsSchema,
	responsibilityMatchSchema,
	responsibilityMutationSchema,
	responsibilityReservationInputSchema,
	responsibilitySchema,
	responsibilitySettlementSchema,
	responsibilitySourceSchema,
	type Responsibility,
	type ResponsibilityAdmission,
	type ResponsibilityBinding,
	type ResponsibilityGrant,
	type ResponsibilityLimits,
	type ResponsibilityMatch,
	type ResponsibilityMutation,
	type ResponsibilityReservationInput,
	type ResponsibilitySettlement,
	type ResponsibilitySource,
	type ResponsibilityTarget,
	type ResponsibilityUsage,
} from "../src/shared/proactive/responsibility.js";
import { digest } from "../src/host/proactive/wire.js";
import { Rejection } from "./rejection.js";

type Row = Record<string, unknown>;
type Reservation = {
	reservationId: string;
	grantId: string;
	assignmentId: string;
	responsibilityId: string;
	tokens: number;
	chargedTokens: number;
	utcDay: string;
	state: "reserved" | "known" | "unknown";
	active: boolean;
	requestCount?: number;
};

/** Authorization and budget extensions of the coordinator's existing database.
 * This module never creates tasks, opens another DB, or starts side effects.
 * Call admit/reserve in the same outer Store.atomic transaction as Work changes.
 * SAVEPOINTs also make standalone calls atomic, including during migrations. */
export function openResponsibilities(
	db: DatabaseSync,
	options: {
		now?: () => number;
		maxRulesPerBot?: number;
		maxRules?: number;
	} = {},
) {
	const now = options.now ?? Date.now;
	const maxRules = options.maxRulesPerBot ?? 100;
	const globalMaxRules = options.maxRules ?? 500;
	if (!Number.isInteger(maxRules) || maxRules < 1 || maxRules > 100)
		throw new Rejection("invalid");
	if (
		!Number.isInteger(globalMaxRules) ||
		globalMaxRules < 1 ||
		globalMaxRules > 500
	)
		throw new Rejection("invalid");
	db.exec(`CREATE TABLE IF NOT EXISTS pb_responsibility (
		id TEXT PRIMARY KEY, bot TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS pb_responsibility_owner ON pb_responsibility(bot,generation);
	CREATE TABLE IF NOT EXISTS pb_responsibility_history (
		id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,revision)
	);
	CREATE TABLE IF NOT EXISTS pb_responsibility_grant (
		id TEXT PRIMARY KEY, ticket TEXT NOT NULL UNIQUE, responsibility TEXT NOT NULL,
		request_digest TEXT NOT NULL, payload TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS pb_responsibility_reservation (
		id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, assignment TEXT NOT NULL,
		responsibility TEXT NOT NULL, utc_day TEXT NOT NULL, payload TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS pb_responsibility_reservation_day
		ON pb_responsibility_reservation(responsibility,utc_day);
	CREATE TABLE IF NOT EXISTS pb_responsibility_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), at INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS pb_responsibility_migration (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS pb_source_revocation (id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
	CREATE TABLE IF NOT EXISTS pb_responsibility_redaction (kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(kind,id,revision));`);
	let serial = 0;
	const atomic = <T>(fn: () => T): T => {
		const savepoint = `pb_responsibilities_${++serial}`;
		db.exec(`SAVEPOINT ${savepoint}`);
		try {
			const result = fn();
			db.exec(`RELEASE ${savepoint}`);
			return result;
		} catch (error) {
			db.exec(`ROLLBACK TO ${savepoint}`);
			db.exec(`RELEASE ${savepoint}`);
			throw error;
		}
	};
	const highWater = () =>
		Number(
			db
				.prepare("SELECT at FROM pb_responsibility_clock WHERE singleton=1")
				.get()?.at ?? 0,
		);
	const clock = () => {
		const at = now();
		if (!Number.isSafeInteger(at) || at < highWater())
			throw new Rejection("forbidden");
		db.prepare(
			"INSERT INTO pb_responsibility_clock VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET at=excluded.at",
		).run(at);
		return at;
	};
	const decode = (row: Row | undefined) =>
		row
			? responsibilitySchema.parse(JSON.parse(String(row.payload)))
			: undefined;
	const get = (id: string) =>
		decode(
			db.prepare("SELECT payload FROM pb_responsibility WHERE id=?").get(id),
		);
	const need = (id: string) => {
		const row = get(id);
		if (!row) throw new Rejection("stale");
		return row;
	};
	const save = (row: Responsibility) => {
		const parsed = responsibilitySchema.parse(row);
		const payload = JSON.stringify(parsed);
		db.prepare(`INSERT INTO pb_responsibility VALUES (?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(
			row.id,
			row.owner.botId,
			row.owner.botCreatedAt,
			payload,
		);
		db.prepare("INSERT INTO pb_responsibility_history VALUES (?,?,?)").run(
			row.id,
			row.revision,
			payload,
		);
		return parsed;
	};
	const normalizeSource = (input: ResponsibilitySource) => {
		const source = responsibilitySourceSchema.parse(input);
		source.repository = source.repository.toLowerCase();
		if (source.id !== `ci:${digest([source.repository, source.branch])}`)
			throw new Rejection("invalid");
		return source;
	};
	const sourceRevoked = (
		source: Pick<ResponsibilitySource, "id" | "generation">,
	) => {
		const row = db
			.prepare("SELECT generation FROM pb_source_revocation WHERE id=?")
			.get(source.id);
		return !!row && Number(row.generation) >= source.generation;
	};
	const normalizeBinding = (input: ResponsibilityBinding) => {
		const binding = responsibilityBindingSchema.parse(input);
		return normalizeMatch(binding);
	};
	const normalizeMatch = <T extends ResponsibilityMatch>(binding: T): T => {
		binding.source = normalizeSource(binding.source);
		if (!sameBot(binding.bot, binding.target.bot))
			throw new Rejection("forbidden");
		return binding;
	};
	function apply(input: ResponsibilityMutation) {
		const mutation = responsibilityMutationSchema.parse(input);
		return atomic(() => {
			const at = clock();
			const existing = get(mutation.id);
			if (mutation.kind === "create") {
				if (existing) throw new Rejection("conflict");
				const count = db
					.prepare(
						"SELECT count(*) AS n FROM pb_responsibility WHERE bot=? AND generation=? AND json_extract(payload,'$.deleted')=0",
					)
					.get(mutation.owner.botId, mutation.owner.botCreatedAt);
				if (Number(count?.n) >= maxRules) throw new Rejection("forbidden");
				if (
					Number(
						db
							.prepare(
								"SELECT count(*) AS n FROM pb_responsibility WHERE json_extract(payload,'$.deleted')=0",
							)
							.get()?.n,
					) >= globalMaxRules
				)
					throw new Rejection("forbidden");
			} else if (
				!existing ||
				existing.deleted ||
				!sameBot(existing.owner, mutation.owner) ||
				existing.revision !== mutation.expectedRevision
			)
				throw new Rejection("stale");
			if (mutation.kind === "create" || mutation.kind === "update") {
				const draft = responsibilityDraftSchema.parse(mutation.draft);
				if (sourceRevoked(draft.source)) throw new Rejection("forbidden");
				if (!sameBot(mutation.owner, draft.target.bot))
					throw new Rejection("forbidden");
				if (draft.mode !== "off" && Date.parse(draft.expiresAt) <= at)
					throw new Rejection("stale");
				return save({
					...draft,
					source: normalizeSource(draft.source),
					id: mutation.id,
					owner: mutation.owner,
					revision: existing ? existing.revision + 1 : 0,
					denyEpoch: existing?.denyEpoch ?? 0,
					deleted: false,
					createdAt: existing?.createdAt ?? at,
					updatedAt: at,
				});
			}
			if (!existing) throw new Rejection("stale");
			if (mutation.kind === "mode") {
				if (mutation.mode === "auto" && !("provider" in existing.target))
					throw new Rejection("forbidden");
				if (mutation.mode !== "off" && sourceRevoked(existing.source))
					throw new Rejection("forbidden");
				if (mutation.mode !== "off" && Date.parse(existing.expiresAt) <= at)
					throw new Rejection("stale");
				// Pausing affects only future intake/admission. A TaskGrant is independent.
				return save({
					...existing,
					mode: mutation.mode,
					revision: existing.revision + 1,
					updatedAt: at,
				});
			}
			return save({
				...existing,
				mode: "off",
				deleted: mutation.kind === "remove",
				denyEpoch: existing.denyEpoch + 1,
				revision: existing.revision + 1,
				updatedAt: at,
			});
		});
	}
	const matches = (
		row: Responsibility,
		binding: ResponsibilityMatch,
		automatic: boolean,
		at: number,
	) => {
		const age = at - Date.parse(binding.observedAt);
		return (
			!row.deleted &&
			!sourceRevoked(binding.source) &&
			row.mode !== "off" &&
			(!automatic || row.mode === "auto") &&
			Date.parse(row.expiresAt) > at &&
			sameBot(row.owner, binding.bot) &&
			digest(row.source) === digest(binding.source) &&
			row.action === binding.action &&
			row.actionScopeDigest === binding.actionScopeDigest &&
			sameBot(row.target.bot, binding.target.bot) &&
			row.target.botUpdatedAt === binding.target.botUpdatedAt &&
			("provider" in row.target
				? digest(row.target) === digest(binding.target)
				: !automatic) &&
			(row.conditions.jobs.length === 0 ||
				row.conditions.jobs.includes(binding.job)) &&
			!row.conditions.excludedJobs.includes(binding.job) &&
			row.conditions.conclusions.includes(binding.conclusion) &&
			binding.attempt >= row.conditions.minAttempt &&
			age >= -300000 &&
			age <= row.conditions.maxAgeSeconds * 1000
		);
	};
	const grantById = (id: string) => {
		const row = db
			.prepare("SELECT payload FROM pb_responsibility_grant WHERE id=?")
			.get(id);
		if (!row) throw new Rejection("stale");
		return responsibilityGrantSchema.parse(JSON.parse(String(row.payload)));
	};
	const assertCurrentGrant = (grant: ResponsibilityGrant, at: number) => {
		const row = need(grant.responsibilityId);
		if (
			row.deleted ||
			sourceRevoked(grant.binding.source) ||
			row.denyEpoch !== grant.denyEpoch ||
			Date.parse(grant.expiresAt) <= at
		)
			throw new Rejection("forbidden");
		// Current mode/revision may change without revoking the frozen TaskGrant.
		return grant;
	};
	function admit(input: ResponsibilityAdmission) {
		const request = responsibilityAdmissionSchema.parse(input);
		request.binding = normalizeBinding(request.binding);
		return atomic(() => {
			const at = clock();
			const known = db
				.prepare(
					"SELECT request_digest FROM pb_responsibility_grant WHERE id=?",
				)
				.get(request.grantId);
			if (known) {
				if (known.request_digest !== digest(request))
					throw new Rejection("conflict");
				return assertCurrentGrant(grantById(request.grantId), at);
			}
			if (
				db
					.prepare("SELECT id FROM pb_responsibility_grant WHERE ticket=?")
					.get(request.ticketId)
			)
				throw new Rejection("conflict");
			const row = need(request.responsibilityId);
			if (row.revision !== request.expectedRevision)
				throw new Rejection("stale");
			if (!matches(row, request.binding, request.automatic, at))
				throw new Rejection("forbidden");
			const grant = responsibilityGrantSchema.parse({
				id: request.grantId,
				ticketId: request.ticketId,
				responsibilityId: row.id,
				responsibilityRevision: row.revision,
				denyEpoch: row.denyEpoch,
				binding: request.binding,
				acceptance: row.acceptance,
				limits: row.limits,
				admittedAt: at,
				expiresAt: new Date(
					Math.min(Date.parse(row.expiresAt), at + row.limits.taskWallTimeMs),
				).toISOString(),
			});
			db.prepare("INSERT INTO pb_responsibility_grant VALUES (?,?,?,?,?)").run(
				grant.id,
				grant.ticketId,
				row.id,
				digest(request),
				JSON.stringify(grant),
			);
			return grant;
		});
	}
	const reservations = (id: string) =>
		db
			.prepare(
				"SELECT payload FROM pb_responsibility_reservation WHERE responsibility=?",
			)
			.all(id)
			.map((row) => JSON.parse(String(row.payload)) as Reservation);
	const reservationById = (id: string) => {
		const row = db
			.prepare("SELECT payload FROM pb_responsibility_reservation WHERE id=?")
			.get(id);
		return row ? (JSON.parse(String(row.payload)) as Reservation) : undefined;
	};
	const saveReservation = (row: Reservation) => {
		db.prepare(`INSERT INTO pb_responsibility_reservation VALUES (?,?,?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(
			row.reservationId,
			row.grantId,
			row.assignmentId,
			row.responsibilityId,
			row.utcDay,
			JSON.stringify(row),
		);
		return row;
	};
	function reserve(input: ResponsibilityReservationInput) {
		const request = responsibilityReservationInputSchema.parse(input);
		return atomic(() => {
			const at = clock();
			const grant = assertCurrentGrant(grantById(request.grantId), at);
			const known = reservationById(request.reservationId);
			if (known) {
				if (
					known.grantId !== request.grantId ||
					known.assignmentId !== request.assignmentId ||
					known.tokens !== request.tokens ||
					(known.requestCount ?? 1) !== request.requestCount
				)
					throw new Rejection("conflict");
				return known;
			}
			const rule = need(grant.responsibilityId);
			const rows = reservations(rule.id);
			const day = new Date(at).toISOString().slice(0, 10);
			const daily = rows.filter((row) => row.utcDay === day);
			const task = rows.filter((row) => row.grantId === grant.id);
			const attempts = new Set(task.map((row) => row.assignmentId));
			const active = new Set(
				rows.filter((row) => row.active).map((row) => row.grantId),
			);
			// A config change can tighten future reservations, never enlarge a grant.
			const min = (key: keyof ResponsibilityLimits) =>
				Math.min(rule.limits[key], grant.limits[key]);
			if (
				daily.reduce((sum, row) => sum + (row.requestCount ?? 1), 0) +
					request.requestCount >
					min("dailyRequests") ||
				daily.reduce((sum, row) => sum + row.chargedTokens, 0) +
					request.tokens >
					min("dailyTokens") ||
				task.reduce((sum, row) => sum + row.chargedTokens, 0) + request.tokens >
					min("taskTokens") ||
				(!attempts.has(request.assignmentId) &&
					attempts.size >= min("taskAttempts")) ||
				(!active.has(grant.id) && active.size >= min("concurrency"))
			)
				throw new Rejection("forbidden");
			return saveReservation({
				...request,
				responsibilityId: rule.id,
				utcDay: day,
				chargedTokens: request.tokens,
				state: "reserved",
				active: true,
			});
		});
	}
	function settle(input: ResponsibilitySettlement) {
		const request = responsibilitySettlementSchema.parse(input);
		return atomic(() => {
			// A late final receipt is allowed after expiry/revoke and can only settle
			// already-reserved cost. It cannot authorize another action.
			clock();
			const row = reservationById(request.reservationId);
			if (!row) throw new Rejection("stale");
			if (row.state !== "reserved") {
				if (row.state === "unknown" && request.outcome === "unknown") {
					// Completion may become known while metering stays unknown. Release
					// concurrency only; never turn uncertain token charges into credit.
					return request.finished && row.active
						? saveReservation({ ...row, active: false })
						: row;
				}
				if (
					row.state === request.outcome &&
					request.outcome === "known" &&
					row.chargedTokens === request.tokens
				)
					return row;
				throw new Rejection("conflict");
			}
			return saveReservation({
				...row,
				state: request.outcome,
				chargedTokens:
					request.outcome === "known" ? request.tokens : row.tokens,
				active: request.outcome === "unknown" && !request.finished,
			});
		});
	}
	function usage(id: string): ResponsibilityUsage {
		const rule = need(id);
		const at = now();
		const day = new Date(Math.max(at, highWater())).toISOString().slice(0, 10);
		const all = reservations(id);
		const daily = all.filter((row) => row.utcDay === day);
		const tokens = (state: Reservation["state"]) =>
			daily
				.filter((row) => row.state === state)
				.reduce((sum, row) => sum + row.chargedTokens, 0);
		return {
			utcDay: day,
			resetsAt: new Date(
				Date.parse(`${day}T00:00:00.000Z`) + 86400000,
			).toISOString(),
			requestsUsed: daily.reduce(
				(sum, row) => sum + (row.requestCount ?? 1),
				0,
			),
			requestsAvailable: Math.max(
				0,
				rule.limits.dailyRequests -
					daily.reduce((sum, row) => sum + (row.requestCount ?? 1), 0),
			),
			knownTokens: tokens("known"),
			reservedTokens: tokens("reserved"),
			unknownTokens: tokens("unknown"),
			tokensAvailable: Math.max(
				0,
				rule.limits.dailyTokens -
					daily.reduce((sum, row) => sum + row.chargedTokens, 0),
			),
			activeTasks: new Set(
				all.filter((row) => row.active).map((row) => row.grantId),
			).size,
			measurementComplete: all.every((row) => row.state === "known"),
			clockSkew: at < highWater(),
		};
	}
	return {
		apply,
		get,
		admit,
		reserve,
		settle,
		usage,
		/** A conservative read projection for sizing the next reservation.
		 * reserve() still rechecks these values atomically with dispatch claim. */
		remaining(grantId: string) {
			const at = now();
			if (at < highWater()) throw new Rejection("forbidden");
			const grant = assertCurrentGrant(grantById(grantId), at);
			const rule = need(grant.responsibilityId);
			const rows = reservations(rule.id);
			const daily = rows.filter(
				(row) => row.utcDay === new Date(at).toISOString().slice(0, 10),
			);
			const task = rows.filter((row) => row.grantId === grant.id);
			const charged = (items: Reservation[]) =>
				items.reduce((sum, row) => sum + row.chargedTokens, 0);
			const taskTokens = Math.max(
				0,
				Math.min(rule.limits.taskTokens, grant.limits.taskTokens) -
					charged(task),
			);
			const dailyTokens = Math.max(
				0,
				Math.min(rule.limits.dailyTokens, grant.limits.dailyTokens) -
					charged(daily),
			);
			return {
				taskTokens,
				dailyTokens,
				tokens: Math.min(taskTokens, dailyTokens),
				requests: Math.max(
					0,
					Math.min(rule.limits.dailyRequests, grant.limits.dailyRequests) -
						daily.reduce((sum, row) => sum + (row.requestCount ?? 1), 0),
				),
				attempts: Math.max(
					0,
					Math.min(rule.limits.taskAttempts, grant.limits.taskAttempts) -
						new Set(task.map((row) => row.assignmentId)).size,
				),
			};
		},
		/** Called in beginForget's transaction; this never refunds old usage. */
		sourceFence(sourceId: string, generation: number) {
			return atomic(() => {
				if (!Number.isSafeInteger(generation) || generation < 0)
					throw new Rejection("invalid");
				const at = clock();
				db.prepare(
					`INSERT INTO pb_source_revocation VALUES (?,?) ON CONFLICT(id) DO UPDATE SET generation=MAX(pb_source_revocation.generation,excluded.generation)`,
				).run(sourceId, generation);
				let changed = 0;
				for (const item of db
					.prepare("SELECT payload FROM pb_responsibility")
					.all()) {
					const row = decode(item);
					if (
						!row ||
						row.source.id !== sourceId ||
						row.source.generation > generation ||
						row.deleted
					)
						continue;
					save({
						...row,
						mode: "off",
						deleted: true,
						denyEpoch: row.denyEpoch + 1,
						revision: row.revision + 1,
						updatedAt: at,
					});
					changed++;
				}
				return changed;
			});
		},
		/** Only after all source writers are drained. Grant/record hashes and all
		 * reservations stay for audit; forgotten records remain revoked tombstones. */
		purgeSourceBody(sourceId: string, generation: number) {
			return atomic(() => {
				if (!sourceRevoked({ id: sourceId, generation }))
					throw new Rejection("forbidden");
				const at = clock();
				const inScope = (source: ResponsibilitySource) =>
					source.id === sourceId && source.generation <= generation;
				const source = (value: ResponsibilitySource) => ({
					...value,
					repository: "redacted/redacted",
					branch: "redacted",
				});
				const acceptance = {
					goal: "[redacted]",
					deliverables: ["[redacted]"],
					checks: [
						{ id: "redacted", title: "[redacted]", kind: "human" as const },
					],
				};
				const record = (value: Responsibility) =>
					responsibilitySchema.parse({
						...value,
						name: "[redacted]",
						mode: "off",
						deleted: true,
						source: source(value.source),
						conditions: { ...value.conditions, jobs: [], excludedJobs: [] },
						acceptance,
					});
				const mark = (
					kind: string,
					id: string,
					revision: number,
					value: unknown,
				) =>
					db
						.prepare(
							"INSERT OR IGNORE INTO pb_responsibility_redaction VALUES (?,?,?,?,?)",
						)
						.run(kind, id, revision, digest(value), at);
				let records = 0;
				let grants = 0;
				for (const item of db
					.prepare("SELECT payload FROM pb_responsibility")
					.all()) {
					const value = decode(item);
					if (!value || !inScope(value.source)) continue;
					if (!value.deleted) throw new Rejection("forbidden");
					mark("record", value.id, value.revision, value);
					db.prepare("UPDATE pb_responsibility SET payload=? WHERE id=?").run(
						JSON.stringify(record(value)),
						value.id,
					);
					records++;
				}
				for (const item of db
					.prepare("SELECT payload FROM pb_responsibility_history")
					.all()) {
					const value = decode(item);
					if (!value || !inScope(value.source)) continue;
					mark("history", value.id, value.revision, value);
					db.prepare(
						"UPDATE pb_responsibility_history SET payload=? WHERE id=? AND revision=?",
					).run(JSON.stringify(record(value)), value.id, value.revision);
				}
				for (const item of db
					.prepare("SELECT payload FROM pb_responsibility_grant")
					.all()) {
					const value = responsibilityGrantSchema.parse(
						JSON.parse(String(item.payload)),
					);
					if (!inScope(value.binding.source)) continue;
					mark("grant", value.id, value.responsibilityRevision, value);
					const clean = responsibilityGrantSchema.parse({
						...value,
						binding: {
							...value.binding,
							source: source(value.binding.source),
							job: "redacted",
						},
						acceptance,
					});
					db.prepare(
						"UPDATE pb_responsibility_grant SET payload=? WHERE id=?",
					).run(JSON.stringify(clean), value.id);
					grants++;
				}
				return { records, grants };
			});
		},
		/** Startup-only companion to Work.recover, in the same transaction.
		 * Old pending Work never reserved. A previously claimed request keeps its
		 * full cost and cannot be replayed, but is no longer locally executing. */
		recover() {
			return atomic(() => {
				clock();
				let recovered = 0;
				for (const item of db
					.prepare(
						"SELECT payload FROM pb_responsibility_reservation WHERE json_extract(payload,'$.active')=1",
					)
					.all()) {
					const row = JSON.parse(String(item.payload)) as Reservation;
					saveReservation({ ...row, state: "unknown", active: false });
					recovered++;
				}
				return recovered;
			});
		},
		all() {
			return db
				.prepare(
					"SELECT payload FROM pb_responsibility WHERE json_extract(payload,'$.deleted')=0 ORDER BY id LIMIT ?",
				)
				.all(globalMaxRules)
				.map((row) =>
					responsibilitySchema.parse(JSON.parse(String(row.payload))),
				);
		},
		list(owner: BotKey) {
			return db
				.prepare(
					"SELECT payload FROM pb_responsibility WHERE bot=? AND generation=? AND json_extract(payload,'$.deleted')=0 ORDER BY id",
				)
				.all(owner.botId, owner.botCreatedAt)
				.map((row) => {
					const responsibility = decode(row);
					if (!responsibility) throw new Rejection("stale");
					return { responsibility, usage: usage(responsibility.id) };
				});
		},
		history(id: string) {
			return db
				.prepare(
					"SELECT payload FROM pb_responsibility_history WHERE id=? ORDER BY revision",
				)
				.all(id)
				.map((row) =>
					responsibilitySchema.parse(JSON.parse(String(row.payload))),
				);
		},
		match(input: ResponsibilityMatch, automatic = false) {
			const binding = normalizeMatch(responsibilityMatchSchema.parse(input));
			const at = now();
			if (at < highWater()) return [];
			return db
				.prepare(
					"SELECT payload FROM pb_responsibility WHERE bot=? AND generation=? ORDER BY id",
				)
				.all(binding.bot.botId, binding.bot.botCreatedAt)
				.map(decode)
				.filter(
					(row): row is Responsibility =>
						!!row && matches(row, binding, automatic, at),
				);
		},
		assertGrant(id: string, input: ResponsibilityBinding) {
			const binding = normalizeBinding(input);
			return atomic(() => {
				const grant = assertCurrentGrant(grantById(id), clock());
				if (digest(grant.binding) !== digest(binding))
					throw new Rejection("stale");
				return grant;
			});
		},
		grant(id: string) {
			return grantById(id);
		},
		grantForTicket(ticketId: string) {
			const row = db
				.prepare("SELECT payload FROM pb_responsibility_grant WHERE ticket=?")
				.get(ticketId);
			return row
				? responsibilityGrantSchema.parse(JSON.parse(String(row.payload)))
				: undefined;
		},
		migrateLegacy(
			rule: {
				id: string;
				sourceId: string;
				sourceGeneration: number;
				expiresAt: string;
				target: ResponsibilityTarget;
			},
			sourceInput: ResponsibilitySource,
			limitsInput: ResponsibilityLimits,
		) {
			return atomic(() => {
				const source = normalizeSource(sourceInput);
				const limits = responsibilityLimitsSchema.parse(limitsInput);
				if (
					source.id !== rule.sourceId ||
					source.generation !== rule.sourceGeneration
				)
					throw new Rejection("stale");
				const migrationId = `legacy:${digest([rule.id, rule.target.bot])}`;
				const id = `legacy-${digest([rule.id, rule.target.bot]).slice(0, 32)}`;
				// A later legacy config change never overwrites a user-edited record.
				if (
					db
						.prepare("SELECT id FROM pb_responsibility_migration WHERE id=?")
						.get(migrationId)
				)
					return need(id);
				const record = apply({
					kind: "create",
					id,
					owner: rule.target.bot,
					draft: {
						name: rule.id,
						mode: Date.parse(rule.expiresAt) > now() ? "auto" : "off",
						source,
						conditions: {
							jobs: [],
							excludedJobs: [],
							conclusions: ["failure"],
							minAttempt: 1,
							maxAgeSeconds: 86400,
						},
						action: "inspect-ci-result",
						target: rule.target,
						limits,
						expiresAt: rule.expiresAt,
						acceptance: {
							goal: "inspect-ci-result",
							deliverables: ["native-session-evidence"],
							checks: [
								{ id: "owner-review", title: "owner-review", kind: "human" },
							],
						},
					},
				});
				// Preserve legacy day charges conservatively. Existing assignments keep
				// their original authorization path; these rows are accounting only.
				const tables = db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pb_work','pb_execution_budget')",
					)
					.all();
				if (tables.length === 2) {
					const rows = db
						.prepare(`SELECT w.assignment,w.ticket,w.payload,b.utc_day FROM pb_work w
						JOIN pb_execution_budget b ON b.assignment=w.assignment
						WHERE json_extract(w.payload,'$.autoRuleId')=? AND json_extract(w.payload,'$.sourceId')=?`)
						.all(rule.id, rule.sourceId);
					for (const row of rows) {
						const work = JSON.parse(String(row.payload)) as {
							target: ResponsibilityTarget;
						};
						if (digest(work.target) !== digest(rule.target)) continue;
						saveReservation({
							reservationId: `legacy-${digest([id, row.assignment])}`,
							grantId: `legacy-ticket-${digest([id, row.ticket])}`,
							assignmentId: String(row.assignment),
							responsibilityId: id,
							utcDay: String(row.utc_day),
							tokens: limits.taskTokens,
							chargedTokens: limits.taskTokens,
							state: "unknown",
							active: false,
						});
					}
				}
				db.prepare("INSERT INTO pb_responsibility_migration VALUES (?,?)").run(
					migrationId,
					digest({ rule, source, limits }),
				);
				return record;
			});
		},
	};
}

export type Responsibilities = ReturnType<typeof openResponsibilities>;
