// @vitest-environment jsdom
import { fireEvent, getByLabelText, getByRole } from "@testing-library/dom";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { ReviewPanel } from "../../src/client/proactive/ReviewPanel.js";
import { WorkspaceOffer } from "../../src/client/proactive/WorkspaceOffer.js";
import { workspaceReviewSchema } from "../../src/shared/proactive/workspace-repair.js";
import {
	workSchema,
	type WorkHistory,
} from "../../src/shared/proactive/work.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const row = workSchema.parse({
	ticketId: "ticket",
	assignmentId: "assignment-2",
	decisionId: "decision",
	triggerId: "trigger",
	sourceId: "ci-source",
	title: "CI task",
	target: {
		bot: { botId: "bot", botCreatedAt: 1 },
		botUpdatedAt: 1,
		provider: "fixture",
		model: "fixture",
	},
	expiresAt: "2099-01-01T00:00:00.000Z",
	policyVersion: "v1",
	revision: 4,
	generation: 2,
	state: "delivered",
	evidenceDigest: "a".repeat(64),
});
async function mount(patch: Partial<ComponentProps<typeof ReviewPanel>> = {}) {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container),
		onReview = vi.fn(),
		onOpen = vi.fn(async () => {});
	const props: ComponentProps<typeof ReviewPanel> = {
		row,
		pending: false,
		canRework: true,
		onReview,
		onOpen,
		onCancel: vi.fn(),
		t: ((key: string, values?: Record<string, unknown>) =>
			`${key}${values ? ` ${JSON.stringify(values)}` : ""}`) as ComponentProps<
			typeof ReviewPanel
		>["t"],
		...patch,
	};
	await act(async () => {
		root.render(<ReviewPanel {...props} />);
	});
	cleanups.push(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	return { container, onReview, onOpen, root, props };
}
async function click(container: HTMLElement, name: string) {
	await act(async () => {
		fireEvent.click(getByRole(container, "button", { name }));
	});
}

test("supplements the current assignment and rechecks an unknown response with the same approval", async () => {
  const run = vi.fn<NonNullable<ComponentProps<typeof ReviewPanel>['continuationControls']>['run']>()
    .mockImplementationOnce(async input => ({ kind: 'unknown', commandId: input.commandId }))
    .mockResolvedValueOnce({ kind: 'rejected', code: 'stale' });
  const waiting = workSchema.parse({ ...row, wait: {
    reason: 'Which client?', request: 'Name the client', operationId: '15269bb4-45c8-4d2b-9b63-6e3ee5ef2639',
    recordedAt: '2026-11-01T00:00:00Z',
  } });
  const { container } = await mount({ row: waiting, continuationControls: { policyRevision: 7, canLaunch: true, run } });
  expect(container.textContent).toContain('proactive.workWaiting');
  expect(container.textContent).toContain('Name the client');
  await act(async () => {
    fireEvent.change(getByLabelText(container, 'proactive.workSupplement'), { target: { value: 'Mobile app' } });
  });
  await click(container, 'proactive.workContinue');
  expect(run).toHaveBeenCalledExactlyOnceWith({
    action: 'supplement', text: 'Mobile app', approved: true, commandId: expect.any(String),
    owner: row.target.bot, ticketId: row.ticketId, assignmentId: row.assignmentId,
    expectedRevision: row.revision, expectedPolicyRevision: 7,
  });
  const original = run.mock.calls[0]?.[0];
  await click(container, 'followUp.recheck');
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0]).toEqual(original);
});

test("a parent refresh and remount exposes reconciliation on the durably accepted attempt", async () => {
  const run = vi.fn<NonNullable<ComponentProps<typeof ReviewPanel>['continuationControls']>['run']>()
    .mockImplementation(async input => ({ kind: 'unknown', commandId: input.commandId }));
  const onReconcile = vi.fn(async () => {});
  const failed = workSchema.parse({ ...row, state: 'failed', evidenceDigest: undefined });
  const { container, root, props } = await mount({
    row: failed, continuationControls: { policyRevision: 7, canLaunch: true, run }, onReconcile,
  });
  await click(container, 'proactive.workRetry');
  const operation = run.mock.calls[0]?.[0];
  if (!operation) throw new Error('Approval was not submitted');
  const accepted = workSchema.parse({ ...failed, assignmentId: 'assignment-3', state: 'pending', admission: 'manual',
    taskLimits: { maxAttempts: 3, maxTokens: 1024, deadlineAt: failed.expiresAt },
    generation: failed.generation + 1, revision: failed.revision + 1, continuation: {
      kind: 'retry', previousAssignmentId: failed.assignmentId, operationId: operation.commandId, requestedAt: '2026-11-01T00:00:00Z',
    } });
  await act(async () => {
    root.render(<ReviewPanel key={accepted.assignmentId} {...props} row={accepted} continuationControls={undefined} />);
  });
  expect(container.querySelector('[data-work-progress]')?.textContent).toBe('proactive.reconcileAccepted');
  await click(container, 'proactive.reconcileAccepted');
  expect(run).toHaveBeenCalledOnce();
  expect(onReconcile).toHaveBeenCalledExactlyOnceWith({
    owner: failed.target.bot, ticketId: failed.ticketId, expectedRevision: accepted.revision,
  });
});

test("opens the persisted group review after polling replaces a previous revision", async () => {
	const group = { groupId: "group-fixture", groupCreatedAt: 1 };
	const accepted = { ...row, state: "accepted" as const };
	const request = vi.fn<NonNullable<ComponentProps<typeof ReviewPanel>["onGroupReview"]>>()
		.mockResolvedValueOnce({
			kind: "preview", choice: { group, title: "CI review", rootSessionId: "preview-root", memberIds: ["one", "two"], memberBotIds: ["one", "two"] },
			text: "Review the result", digest: "b".repeat(64), followUpAvailable: false,
		})
		.mockResolvedValueOnce({ kind: "linked", rootSessionId: "latest-root", turnId: "turn" });
	const { container, onOpen, root, props } = await mount({ row: accepted, onGroupReview: request });
	await click(container, "proactive.groupReview");
	expect(container.textContent).toContain("proactive.groupConfirm");
	await act(async () => {
		root.render(<ReviewPanel {...props} row={workSchema.parse({
			...accepted, revision: 6,
			groupReview: { state: "linked", group, digest: "b".repeat(64), turnId: "turn" },
		})} />);
	});
	expect(container.textContent).not.toContain("proactive.groupConfirm");
	await click(container, "proactive.groupOpen");
	expect(request).toHaveBeenLastCalledWith({ ticketId: "ticket", expectedRevision: 6 });
	expect(onOpen).toHaveBeenCalledExactlyOnceWith("latest-root");
});

test("inspect and successful JSON repair evidence can be accepted without workspace evidence", async () => {
	const hash = "d".repeat(64);
	const repair = { fixtureId: "switch", specDigest: hash, executor: "native" };
	const check = {
		tool: "dsh-bot/verify-json-fixture@1",
		inputDigest: hash,
		exitCode: 0,
	};
	const repairEvidence = {
		specDigest: hash,
		edit: { field: "enabled", value: true },
		baseline: { ...check, exitCode: 1 },
		verification: check,
		artifactDigest: hash,
	};
	for (const [patch, disabled] of [
		[{}, false],
		[{ repair, repairEvidence }, false],
		[{ repair }, true],
		[
			{
				repair,
				repairEvidence: {
					...repairEvidence,
					verification: { ...check, exitCode: 1 },
				},
			},
			true,
		],
	] as const) {
		const app = await mount({ row: workSchema.parse({ ...row, ...patch }) });
		expect(
			(
				getByRole(app.container, "button", {
					name: "proactive.approve",
				}) as HTMLButtonElement
			).disabled,
		).toBe(disabled);
		await click(app.container, "proactive.approve");
		if (disabled) expect(app.onReview).not.toHaveBeenCalled();
		else
			expect(app.onReview).toHaveBeenCalledWith(
				expect.objectContaining({
					review: "accept",
					approved: true,
					evidenceDigest: row.evidenceDigest,
				}),
			);
	}
});

test("rework requires concrete owner findings and sends them with the current evidence fence", async () => {
	const { container, onReview } = await mount();
	await click(container, "proactive.rework");
	const form = container.querySelector("form");
	if (!form) throw new Error("Missing rework form");
	await act(async () => {
		fireEvent.submit(form);
	});
	expect(onReview).not.toHaveBeenCalled();
	expect(getByRole(container, "alert").textContent).toBe(
		"proactive.reworkInvalid",
	);
	await act(async () => {
		fireEvent.change(getByLabelText(container, "proactive.reworkCriterion"), {
			target: { value: "Retained field" },
		});
		fireEvent.change(getByLabelText(container, "proactive.reworkActual"), {
			target: { value: "The prior output dropped the sentinel" },
		});
		fireEvent.change(getByLabelText(container, "proactive.reworkExpected"), {
			target: { value: "Preserve the sentinel value" },
		});
		fireEvent.submit(form);
	});
	expect(onReview).toHaveBeenCalledWith(
		expect.objectContaining({
			ticketId: row.ticketId,
			expectedRevision: row.revision,
			evidenceDigest: row.evidenceDigest,
			review: "rework",
			feedback: {
				failures: [
					{
						criterion: "Retained field",
						actual: "The prior output dropped the sentinel",
						expected: "Preserve the sentinel value",
					},
				],
			},
		}),
	);
});

test("history displays prior evidence and feedback without offering mutations on an older version", async () => {
	const earlier = {
		...row,
		assignmentId: "assignment-1",
		generation: 1,
		evidenceDigest: "b".repeat(64),
		reviewFeedback: {
			failures: [{ criterion: "Verifier", actual: "Failed", expected: "Pass" }],
		},
	};
	const request = vi.fn(
		async (): Promise<WorkHistory> => ({ versions: [earlier] }),
	);
	const { container } = await mount({ onHistory: request });
	await click(container, "proactive.history");
	expect(request).toHaveBeenCalledWith({ ticketId: row.ticketId });
	const history = container.querySelector("[data-proactive-history]");
	if (!history) throw new Error("Missing history panel");
	expect(history.textContent).toContain(earlier.evidenceDigest);
	expect(history.textContent).toContain("Verifier");
	expect(history.textContent).toContain("Pass");
	expect(history.querySelectorAll("button")).toHaveLength(1);
});

test("history replies from a closed task do not replace a newly mounted task", async () => {
	let resolvePage!: (page: WorkHistory) => void;
	const request = () =>
		new Promise<WorkHistory>((resolve) => {
			resolvePage = resolve;
		});
	const app = await mount({ onHistory: request });
	await click(app.container, "proactive.history");
	await act(async () =>
		app.root.render(
			<ReviewPanel {...app.props} row={{ ...row, ticketId: "other-ticket" }} />,
		),
	);
	await act(async () => {
		resolvePage({ versions: [{ ...row, title: "Old evidence marker" }] });
	});
	expect(
		app.container
			.querySelector("[data-proactive-history]")
			?.querySelectorAll("details"),
	).toHaveLength(0);
});

function workspaceFixture() {
	const hash = "c".repeat(64);
	const check = {
		tool: "dsh-bot/verify-workspace@1" as const,
		verifierId: "test",
		commandDigest: hash,
		inputDigest: hash,
		exitCode: 0,
		timedOut: false,
		stdoutDigest: hash,
		stderrDigest: hash,
		stdoutPreview: "",
		stderrPreview: "",
		outputTruncated: false,
	};
	const workspaceRepair = {
		workspaceId: "project",
		specDigest: hash,
		baselineDigest: hash,
		executor: "native" as const,
	};
	const workspaceEvidence = {
		version: 1 as const,
		specDigest: hash,
		baselineDigest: hash,
		artifactDigest: hash,
		manifestDigest: hash,
		diffDigest: hash,
		changedPaths: ["math.cjs"],
		baseline: { ...check, exitCode: 1 },
		verification: check,
	};
	const work = workSchema.parse({ ...row, workspaceRepair, workspaceEvidence });
	const manifest = [
		{ path: "math.cjs", digest: hash, bytes: 12, editable: true },
	];
	const review = workspaceReviewSchema.parse({
		assignmentId: work.assignmentId,
		evidenceDigest: hash,
		manifests: { before: manifest, after: manifest },
		files: [
			{
				path: "math.cjs",
				editable: true,
				before: "before exact code",
				after: "after exact code",
			},
		],
		diff: [
			{
				path: "math.cjs",
				before: "before exact code",
				after: "after exact code",
			},
		],
		checks: { baseline: workspaceEvidence.baseline, verification: check },
		logs: {
			baseline: { stdout: "", stderr: "baseline failure trace" },
			verification: { stdout: "complete verification output", stderr: "" },
		},
	});
	return { work, review, workspaceRepair };
}

test("workspace acceptance still requires present, successful, complete verification", async () => {
	const { work } = workspaceFixture();
	for (const [patch, disabled] of [
		[{}, false],
		[{ workspaceEvidence: undefined }, true],
		...[{ exitCode: 1 }, { timedOut: true }, { outputTruncated: true }].map(
			(change) =>
				[
					{
						workspaceEvidence: {
							...work.workspaceEvidence,
							verification: {
								...work.workspaceEvidence?.verification,
								...change,
							},
						},
					},
					true,
				] as const,
		),
	] as const) {
		const app = await mount({ row: workSchema.parse({ ...work, ...patch }) });
		expect(
			(
				getByRole(app.container, "button", {
					name: "proactive.approve",
				}) as HTMLButtonElement
			).disabled,
		).toBe(disabled);
	}
});

test("group workspace acceptance additionally requires the supervisor pass verdict", async () => {
	const { work } = workspaceFixture(),
		hash = "e".repeat(64);
	const groupRepair = {
		group: { groupId: "review-group", groupCreatedAt: 1 },
		rootSessionId: "root",
		membershipRevision: 1,
		supervisor: {
			memberId: "supervisor",
			bot: { botId: "supervisor", botCreatedAt: 1 },
			botUpdatedAt: 1,
		},
		implementer: {
			memberId: "implementer",
			bot: work.target.bot,
			botUpdatedAt: work.target.botUpdatedAt,
		},
		maxCalls: 3,
	};
	const review = {
		verdict: "pass",
		summary: "Checks pass",
		checks: [
			{ criterion: "Verifier", status: "PASS", evidence: "Verifier exit 0" },
		],
	};
	const evidence = {
		version: 1,
		grantDigest: hash,
		state: "completed",
		stages: ["plan", "implement", "review"].map((phase) => ({
			phase,
			memberId: phase === "implement" ? "implementer" : "supervisor",
			turnId: `turn-${phase}`,
			deliveryId: `delivery-${phase}`,
			sessionId: `session-${phase}`,
			inputId: `input-${phase}`,
			inputDigest: hash,
			outputId: `output-${phase}`,
			assistantId: `assistant-${phase}`,
			outputDigest: hash,
			state: "completed",
		})),
		plan: {
			goal: "Repair",
			collaborationReason: "Independent review",
			implementation: "Fix math",
			files: ["math.cjs"],
			checks: ["Verifier"],
		},
		review,
	};
	for (const [groupRepairEvidence, disabled] of [
		[undefined, true],
		[{ ...evidence, review: { ...review, verdict: "fail" } }, true],
		[evidence, false],
	] as const) {
		const app = await mount({
			row: workSchema.parse({ ...work, groupRepair, groupRepairEvidence }),
		});
		expect(
			(
				getByRole(app.container, "button", {
					name: "proactive.approve",
				}) as HTMLButtonElement
			).disabled,
		).toBe(disabled);
	}
});

test("workspace review requests an exact version, displays complete verified content, and rejects mismatched artifact replies", async () => {
	const { work, review } = workspaceFixture();
	const request = vi.fn(async () => review);
	const app = await mount({ row: work, onWorkspaceReview: request });
	await click(app.container, "proactive.workspaceLoadEvidence");
	expect(request).toHaveBeenCalledWith({
		ticketId: work.ticketId,
		assignmentId: work.assignmentId,
		evidenceDigest: work.evidenceDigest,
	});
	expect(
		app.container.querySelector("[data-workspace-content]")?.textContent,
	).toContain("after exact code");
	expect(app.container.textContent).toContain("baseline failure trace");
	expect(app.container.textContent).toContain("complete verification output");
	request.mockResolvedValue({ ...review, evidenceDigest: "d".repeat(64) });
	await click(app.container, "proactive.workspaceLoadEvidence");
	expect(app.container.querySelector("[data-workspace-content]")).toBeNull();
	expect(getByRole(app.container, "alert").textContent).toBe(
		"proactive.workspaceEvidenceFailed",
	);
});

test("failed workspace verification disables acceptance and workspace authorization previews exact scope first", async () => {
	const { work, workspaceRepair } = workspaceFixture();
	const failed = workSchema.parse({
		...work,
		workspaceEvidence: {
			...work.workspaceEvidence,
			verification: { ...work.workspaceEvidence?.verification, exitCode: 1 },
		},
	});
	const app = await mount({ row: failed });
	expect(
		(
			getByRole(app.container, "button", {
				name: "proactive.approve",
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
	const onAccept = vi.fn();
	const offer = {
		...workspaceRepair,
		executor: "command" as const,
		title: "Project",
		sourceId: work.sourceId,
		executorLabel: "JSON CLI",
		files: [
			{ path: "math.cjs", digest: "a".repeat(64), bytes: 123, editable: true },
			{
				path: "verify.cjs",
				digest: "b".repeat(64),
				bytes: 456,
				editable: false,
			},
		],
		verifier: {
			id: "test",
			command: "node",
			args: ["verify.cjs"],
			timeoutMs: 1000,
			maxOutputBytes: 2048,
		},
	};
	await act(async () =>
		app.root.render(
			<WorkspaceOffer
				offer={offer}
				pending={false}
				onAccept={onAccept}
				t={app.props.t}
			/>,
		),
	);
	expect(app.container.textContent).not.toContain("proactive.workspaceConfirm");
	await click(app.container, "proactive.workspacePreview");
	expect(app.container.textContent).toContain("verify.cjs");
	expect(app.container.textContent).toContain(
		"proactive.workspaceExternalBudget",
	);
	expect(app.container.textContent).toContain('"bytes":579');
	expect(onAccept).not.toHaveBeenCalled();
	await click(app.container, "proactive.workspaceConfirm");
	expect(onAccept).toHaveBeenCalledWith(
		{
			...workspaceRepair,
			executor: "command",
		},
		undefined,
	);
});
