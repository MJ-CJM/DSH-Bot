// @vitest-environment jsdom
import {
	fireEvent,
	getByLabelText,
	getByRole,
	queryByRole,
} from "@testing-library/dom";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import {
	ResponsibilityPanel,
	type ResponsibilityActions,
} from "../../src/client/proactive/ResponsibilityPanel.js";
import {
	responsibilitySchema,
	type ResponsibilityView,
	type ResponsibilityMutationResult,
} from "../../src/shared/proactive/responsibility.js";

const owner = { botId: "fixture-bot", botCreatedAt: 1 };
const source = {
	id: `ci:${"a".repeat(64)}`,
	generation: 1,
	repository: "fixture/repo",
	branch: "main",
};
const target = {
	bot: owner,
	botUpdatedAt: 1,
	provider: "fixture",
	model: "fixture",
};
const row = responsibilitySchema.parse({
	id: "rule-one",
	owner,
	name: "Current responsibility",
	mode: "auto",
	source,
	target,
	action: "inspect-ci-result",
	conditions: {},
	limits: {},
	expiresAt: "2099-01-01T00:00:00.000Z",
	revision: 3,
	denyEpoch: 0,
	deleted: false,
	createdAt: 1,
	updatedAt: 2,
	acceptance: {
		goal: "Analyse",
		deliverables: ["Evidence"],
		checks: [{ id: "test", title: "Check result", kind: "both" }],
	},
});
const view: ResponsibilityView = {
	responsibility: row,
	usage: {
		utcDay: "2026-11-08",
		resetsAt: "2026-11-09T00:00:00.000Z",
		requestsUsed: 2,
		requestsAvailable: 6,
		knownTokens: 200,
		reservedTokens: 300,
		unknownTokens: 400,
		tokensAvailable: 31868,
		activeTasks: 1,
		measurementComplete: false,
		clockSkew: false,
	},
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function mount(
	initial: ResponsibilityView[] = [],
	overrides: Partial<ResponsibilityActions> = {},
) {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const list = vi.fn(async () => initial);
	const mutate = vi.fn(
		async (): Promise<ResponsibilityMutationResult> => ({
			kind: "applied",
			responsibility: row,
		}),
	);
	const props: ComponentProps<typeof ResponsibilityPanel> = {
		owner,
		source,
		target,
		availableActions: ["inspect-ci-result"],
		actions: { list, mutate, ...overrides },
		t: ((key: string, params?: Record<string, unknown>) =>
			`${key}${params ? ` ${JSON.stringify(params)}` : ""}`) as ComponentProps<
			typeof ResponsibilityPanel
		>["t"],
	};
	await act(async () => {
		root.render(<ResponsibilityPanel {...props} />);
	});
	cleanups.push(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	return { container, root, props, list, mutate };
}
const click = async (container: HTMLElement, name: string) =>
	act(async () => {
		fireEvent.click(getByRole(container, "button", { name }));
	});
const change = async (container: HTMLElement, label: string, value: string) =>
	act(async () => {
		fireEvent.change(getByLabelText(container, label), { target: { value } });
	});

test("new responsibility defaults off, exposes only available actions, and sends full validated configuration", async () => {
	const { container, mutate } = await mount();
	await click(container, "responsibility.create");
	expect(
		(getByLabelText(container, "responsibility.mode") as HTMLSelectElement)
			.value,
	).toBe("off");
	expect(
		[
			...(
				getByLabelText(container, "responsibility.action") as HTMLSelectElement
			).options,
		].map((option) => option.value),
	).toEqual(["inspect-ci-result"]);
	await change(container, "responsibility.name", "Build analysis");
	await change(container, "responsibility.jobs", "build,");
	expect(
		(getByLabelText(container, "responsibility.jobs") as HTMLInputElement)
			.value,
	).toBe("build, ");
	await change(container, "responsibility.jobs", "build, test");
	await change(container, "responsibility.limit.taskTokens", "2500");
	const form = container.querySelector("form");
	if (!form) throw new Error("Missing form");
	await act(async () => {
		fireEvent.submit(form);
	});
	expect(mutate).toHaveBeenCalledOnce();
	expect(mutate).toHaveBeenCalledWith(
		expect.objectContaining({
			commandId: expect.any(String),
			mutation: expect.objectContaining({
				kind: "create",
				owner,
				draft: expect.objectContaining({
					name: "Build analysis",
					mode: "off",
					source,
					target,
					conditions: expect.objectContaining({ jobs: ["build", "test"] }),
					limits: expect.objectContaining({ taskTokens: 2500 }),
				}),
			}),
		}),
	);
});

test("pause and explicit revoke use separate commands and retain the exact record revision", async () => {
	const { container, mutate } = await mount([view]);
	expect(container.textContent).toContain("responsibility.incomplete");
	expect(container.textContent).toContain('"unknown":400');
	await click(container, "responsibility.pause");
	expect(mutate).toHaveBeenLastCalledWith(
		expect.objectContaining({
			mutation: {
				kind: "mode",
				id: row.id,
				owner,
				expectedRevision: 3,
				mode: "off",
			},
		}),
	);
	await click(container, "responsibility.revoke");
	expect(mutate).toHaveBeenCalledTimes(1);
	expect(container.textContent).toContain("responsibility.confirm.revoke");
	await click(container, "responsibility.confirm");
	expect(mutate).toHaveBeenLastCalledWith(
		expect.objectContaining({
			mutation: { kind: "revoke", id: row.id, owner, expectedRevision: 3 },
		}),
	);
});

test("an unknown write blocks new edits and reconciles with the same operation ID", async () => {
	const mutate = vi.fn(
		async (): Promise<ResponsibilityMutationResult> => ({ kind: "unknown" }),
	);
	const { container } = await mount([view], { mutate });
	await click(container, "responsibility.pause");
	expect(getByRole(container, "alert").textContent).toBe(
		"responsibility.unknown",
	);
	expect(
		(
			getByRole(container, "button", {
				name: "responsibility.edit",
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
	const first = mutate.mock.calls[0];
	await click(container, "responsibility.reconcile");
	expect(mutate).toHaveBeenCalledTimes(2);
	expect(mutate.mock.calls[1]).toEqual(first);
});

test("invalid token limits never reach the mutation boundary", async () => {
	const { container, mutate } = await mount();
	await click(container, "responsibility.create");
	await change(container, "responsibility.limit.taskTokens", "0");
	const form = container.querySelector("form");
	if (!form) throw new Error("Missing form");
	await act(async () => {
		fireEvent.submit(form);
	});
	expect(mutate).not.toHaveBeenCalled();
	expect(getByRole(container, "alert").textContent).toBe(
		"responsibility.invalid",
	);
});

test("late responses cannot overwrite another Bot and unresolved operations survive an A-B-A visit", async () => {
	let finish: ((result: ResponsibilityMutationResult) => void) | undefined;
	const mutate = vi.fn(
		() =>
			new Promise<ResponsibilityMutationResult>((resolve) => {
				finish = resolve;
			}),
	);
	const { container, root, props } = await mount([view], { mutate });
	await click(container, "responsibility.pause");
	const other = { botId: "other-bot", botCreatedAt: 2 };
	await act(async () => {
		root.render(
			<ResponsibilityPanel
				{...props}
				owner={other}
				target={{ ...target, bot: other }}
			/>,
		);
	});
	expect(container.textContent).not.toContain("Current responsibility");
	await act(async () => {
		root.render(<ResponsibilityPanel {...props} />);
	});
	expect(
		(
			getByRole(container, "button", {
				name: "responsibility.create",
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
	expect(getByRole(container, "alert").textContent).toBe(
		"responsibility.unknown",
	);
	const first = mutate.mock.calls[0];
	await act(async () => {
		finish?.({ kind: "applied", responsibility: row });
	});
	expect(getByRole(container, "alert").textContent).toBe(
		"responsibility.unknown",
	);
	mutate.mockImplementation(async () => ({
		kind: "applied",
		responsibility: row,
	}));
	await click(container, "responsibility.reconcile");
	expect(mutate.mock.calls[1]).toEqual(first);
	expect(queryByRole(container, "alert")).toBeNull();
});
