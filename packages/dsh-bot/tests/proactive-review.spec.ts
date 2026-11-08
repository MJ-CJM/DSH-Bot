import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import type {
	CommandBody,
	Suggestion,
} from "../src/shared/proactive/protocol.js";
import {
	reworkFeedbackSchema,
	workSchema,
	type ProactiveWork,
	type WorkHistory,
	type WorkHistoryRequest,
} from "../src/shared/proactive/work.js";
import { executionPrompt } from "../src/host/proactive/execution-prompt.js";
import { runExternalRepair } from "../src/host/proactive/executors/loopback.js";
import {
	formatRepairReview,
	readRepairReview,
} from "../src/host/proactive/repair.js";

// The coordinator has its own tsconfig for the pinned vendor's .ts imports.
// Load its real implementation through Vitest without adding the vendor tree
// to the Host application's TypeScript compilation unit.
const coordinatorUrl = new URL("../coordinator/work.ts", import.meta.url).href;
const { openWork } = (await import(coordinatorUrl)) as {
	openWork(
		db: DatabaseSync,
		store: object,
		suggestion: () => Suggestion,
		dailyBudget: number,
		externalBudget: number,
		notices: boolean,
	): {
		apply(engine: object, body: CommandBody): number;
		getTicket(id: string): ProactiveWork | null;
		history(input: WorkHistoryRequest): WorkHistory;
	};
};

const roots: string[] = [];
function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing test fixture");
	return value;
}
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
async function scratch() {
	const root = await mkdtemp(resolve("../../.dsh-dev/proactive-review-"));
	roots.push(root);
	return root;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const feedback = {
	failures: [
		{
			criterion: "Feature remains enabled",
			actual: "The repaired feature is still false",
			expected: "Enable it while preserving retained",
		},
	],
	notes: "Keep the retained field unchanged",
};
function work(patch: Partial<ProactiveWork> = {}): ProactiveWork {
	return workSchema.parse({
		ticketId: "ticket-one",
		assignmentId: "assignment-one",
		decisionId: "decision-one",
		triggerId: "trigger-one",
		sourceId: "ci-source",
		title: "Repair the feature",
		target: {
			bot: { botId: "bot-one", botCreatedAt: 1000 },
			botUpdatedAt: 1000,
			provider: "fixture",
			model: "fixture",
		},
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		policyVersion: "v1",
		revision: 3,
		generation: 1,
		state: "delivered",
		evidenceDigest: "a".repeat(64),
		...patch,
	});
}
function open(path: string) {
	const db = new DatabaseSync(path);
	db.exec(`CREATE TABLE IF NOT EXISTS pb_source (id TEXT,generation INTEGER);
		CREATE TABLE IF NOT EXISTS pb_source_revocation (id TEXT,generation INTEGER);
		CREATE TABLE IF NOT EXISTS pb_ci_head (source TEXT,generation INTEGER,thread TEXT,attempt INTEGER,conclusion TEXT,observed_at TEXT,decision TEXT);`);
	const source = {
		state: "open",
		triggerId: "trigger-one",
		observedAt: new Date().toISOString(),
	} as Suggestion;
	const core = openWork(db, {}, () => source, 20, 20, false);
	const seed = (row: ProactiveWork) =>
		db
			.prepare("INSERT INTO pb_work VALUES (?,?,?,?,?)")
			.run(
				row.assignmentId,
				row.ticketId,
				row.decisionId,
				row.generation,
				JSON.stringify(row),
			);
	return { db, core, seed };
}

test("owner findings survive reopening, bind the previous evidence, and appear in the next execution", async () => {
	const root = await scratch(),
		path = join(root, "review.sqlite");
	let connection = open(path);
	const original = work();
	connection.seed(original);
	const engine = {
		report: vi.fn(),
		retryTicket: vi.fn(() => ({ assignments: [{ id: "assignment-two" }] })),
	};
	try {
		connection.core.apply(engine, {
			kind: "review",
			ticketId: original.ticketId,
			expectedRevision: original.revision,
			evidenceDigest: required(original.evidenceDigest),
			approved: true,
			review: "rework",
			feedback,
		});
		const next = required(connection.core.getTicket(original.ticketId));
		expect(next.rework).toMatchObject({
			previousAssignmentId: original.assignmentId,
			previousEvidenceDigest: original.evidenceDigest,
			feedback,
			requestedBy: "owner",
		});
		expect(next.assignmentId).toBe("assignment-two");
		const prompt = executionPrompt(next);
		expect(prompt).toContain(required(feedback.failures[0]).actual);
		expect(prompt).toContain(required(feedback.failures[0]).expected);
		expect(prompt).toContain(original.assignmentId);
		connection.db.close();
		connection = open(path);
		const latest = connection.core.history({
			ticketId: original.ticketId,
			limit: 1,
		});
		expect(latest.versions.map((row) => row.generation)).toEqual([2]);
		expect(latest.nextBeforeGeneration).toBe(2);
		const previous = connection.core.history({
			ticketId: original.ticketId,
			beforeGeneration: latest.nextBeforeGeneration,
			limit: 1,
		});
		expect(previous.nextBeforeGeneration).toBeUndefined();
		expect(previous.versions[0]).toMatchObject({
			assignmentId: original.assignmentId,
			evidenceDigest: original.evidenceDigest,
			reviewFeedback: feedback,
		});
		expect(
			connection.core.history({ ticketId: "unrelated-ticket" }).versions,
		).toEqual([]);
	} finally {
		connection.db.close();
	}
});

test("unknown runs, missing review findings, old evidence and exhausted task attempts cannot be retried", async () => {
	const root = await scratch();
	for (const [suffix, patch, input] of [
		["unknown", { state: "unknown" }, { feedback }],
		["missing", {}, {}],
		["stale", {}, { feedback, evidenceDigest: "b".repeat(64) }],
		[
			"limit",
			{
				generation: 3,
				taskLimits: {
					maxAttempts: 3,
					maxTokens: 1024,
					deadlineAt: new Date(Date.now() + 60000).toISOString(),
				},
			},
			{ feedback },
		],
	] as const) {
		const { db, core, seed } = open(join(root, `${suffix}.sqlite`));
		const original = work(patch);
		seed(original);
		const engine = { report: vi.fn(), retryTicket: vi.fn() };
		try {
			expect(() =>
				core.apply(engine, {
					kind: "review",
					ticketId: original.ticketId,
					expectedRevision: original.revision,
					evidenceDigest: required(original.evidenceDigest),
					approved: true,
					review: "rework",
					...input,
				}),
			).toThrow();
			expect(engine.retryTicket).not.toHaveBeenCalled();
			expect(
				core.history({ ticketId: original.ticketId }).versions,
			).toHaveLength(1);
		} finally {
			db.close();
		}
	}
	expect(
		reworkFeedbackSchema.safeParse({
			failures: [{ criterion: " ", actual: "x", expected: "y" }],
		}).success,
	).toBe(false);
});

test("group reviewers receive the exact verified before and after content, while changed or linked artifacts are rejected", async () => {
	const root = await scratch();
	const original = work({
		repair: {
			fixtureId: "switch",
			executor: "native",
			specDigest: "c".repeat(64),
		},
	});
	const dir = join(root, "repair-artifacts", original.assignmentId);
	await mkdir(dir, { recursive: true });
	const before = JSON.stringify({ enabled: false, retained: "sentinel" });
	const after = JSON.stringify({ enabled: true, retained: "sentinel" });
	await writeFile(join(dir, "before.json"), before);
	await writeFile(join(dir, "after.json"), after);
	original.repairEvidence = {
		specDigest: required(original.repair).specDigest,
		edit: { field: "enabled", value: true },
		baseline: {
			tool: "dsh-bot/verify-json-fixture@1",
			exitCode: 1,
			inputDigest: sha(before),
		},
		verification: {
			tool: "dsh-bot/verify-json-fixture@1",
			exitCode: 0,
			inputDigest: sha(after),
		},
		artifactDigest: sha(after),
	};
	const review = await readRepairReview(root, original);
	expect(review.before).toEqual(JSON.parse(before));
	expect(review.after).toEqual(JSON.parse(after));
	expect(formatRepairReview(original, review)).toContain('"enabled":true');
	expect(formatRepairReview(original, review)).toContain('"exitCode":0');
	await writeFile(
		join(dir, "after.json"),
		JSON.stringify({ enabled: true, retained: "changed" }),
	);
	await expect(readRepairReview(root, original)).rejects.toThrow(/changed/);
	await rm(join(dir, "after.json"));
	await symlink(join(dir, "before.json"), join(dir, "after.json"));
	await expect(readRepairReview(root, original)).rejects.toThrow();
	expect(await readFile(join(dir, "before.json"), "utf8")).toBe(before);
});

test("external repair receives the exact versioned owner findings without the hidden verifier target", async () => {
	const inputId = "c45e2b8e-7834-4ef2-8957-610acda840f4";
	const identity = { runId: "external-run", inputId };
	const requests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			if (request.method === "POST")
				requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify(
					request.url?.endsWith("/artifacts")
						? {
								...identity,
								revision: 1,
								edit: { field: "enabled", value: true },
								units: 1,
								unit: "fixture-operation",
							}
						: request.url?.endsWith("/events")
							? { ...identity, events: [{ seq: 1, state: "completed" }] }
							: { ...identity, state: "completed" },
				),
			);
		})().catch(() => {
			response.statusCode = 500;
			response.end();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing fixture listener");
		const rework = {
			previousAssignmentId: "previous-assignment",
			previousEvidenceDigest: "e".repeat(64),
			feedback,
			requestedAt: new Date().toISOString(),
			requestedBy: "owner" as const,
		};
		const artifact = await runExternalRepair({
			endpoint: `http://127.0.0.1:${address.port}`,
			inputId,
			fixture: {
				id: "switch",
				sourceId: `ci:${"f".repeat(64)}`,
				title: "Switch",
				initial: { enabled: false },
				field: "enabled",
				expected: true,
				hint: "Enable the feature",
			},
			rework,
			signal: AbortSignal.timeout(5000),
			onStarted: async () => {},
		});
		expect(artifact.edit.value).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.rework).toEqual(rework);
		expect(requests[0]?.fixture).toEqual({
			initial: { enabled: false },
			field: "enabled",
			hint: "Enable the feature",
		});
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
