// @vitest-environment jsdom
import { fireEvent, getByLabelText, getByRole } from "@testing-library/dom";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { ResponsibilityWorkspace } from "../../src/client/proactive/ResponsibilityWorkspace.js";
import { botCreateSchema, botSchema } from "../../src/shared/schema.js";
import {
	capabilities,
	type ProactiveStatus,
} from "../../src/shared/proactive/protocol.js";
import type {
	ResponsibilityMutationRequest,
	ResponsibilityMutationResult,
} from "../../src/shared/proactive/responsibility.js";

type Props = ComponentProps<typeof ResponsibilityWorkspace>;
const currentBot = botSchema.parse({
	...botCreateSchema.parse({ id: "selected-bot", name: "Selected Bot" }),
	schemaVersion: 1,
	createdAt: 1,
	updatedAt: 8,
});
const status: ProactiveStatus = {
	state: "ready",
	capabilities: { ...capabilities, directExecution: true },
	directRoute: { provider: "approved-provider", model: "approved-model" },
	localFeed: "ready",
	localFeedScope: {
		id: `ci:${"a".repeat(64)}`,
		generation: 7,
		repository: "approved/repository",
		branch: "approved-branch",
	},
	actionScopes: [
		{
			action: "repair-workspace",
			digest: "b".repeat(64),
			title: "Native repair",
		},
		{
			action: "repair-workspace",
			digest: "c".repeat(64),
			title: "Approved external repair",
		},
	],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});
async function mount(
	response: () => Promise<ProactiveStatus> = async () => status,
) {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const list = vi.fn(async () => []);
	const mutate = vi.fn(
		async (
			_request: ResponsibilityMutationRequest,
		): Promise<ResponsibilityMutationResult> => ({
			kind: "rejected",
			code: "stale",
		}),
	);
	const props: Props = {
		bot: currentBot,
		actions: { list, mutate },
		proactive: { status: vi.fn(response) },
		t: ((key: string) => key) as Props["t"],
	};
	await act(async () => {
		root.render(<ResponsibilityWorkspace {...props} />);
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

test("workspace binds the selected Bot generation and only Host supplied source, model and repair configuration", async () => {
	const { container, list, mutate } = await mount();
	expect(list).toHaveBeenCalledWith({ botId: currentBot.id, botCreatedAt: 1 });
	await click(container, "responsibility.create");
	await change(container, "responsibility.action", "repair-workspace");
	expect(
		[
			...getByLabelText<HTMLSelectElement>(container, "responsibility.action")
				.options,
		].map((option) => option.value),
	).toEqual(["inspect-ci-result", "repair-workspace"]);
	await change(container, "responsibility.scope", "c".repeat(64));
	await click(container, "responsibility.save");
	expect(mutate).toHaveBeenCalledTimes(1);
	expect(mutate.mock.calls[0]?.[0].mutation).toMatchObject({
		kind: "create",
		owner: { botId: currentBot.id, botCreatedAt: 1 },
		draft: {
			source: status.localFeedScope,
			actionScopeDigest: "c".repeat(64),
			target: {
				bot: { botId: currentBot.id, botCreatedAt: 1 },
				botUpdatedAt: 8,
				provider: "approved-provider",
				model: "approved-model",
			},
		},
	});
});

test("unavailable or revoked Host context keeps management visible and blocks new responsibility creation", async () => {
	const { container, list } = await mount(async () => ({
		...status,
		localFeed: "revoked",
	}));
	expect(list).toHaveBeenCalled();
	expect(
		getByRole<HTMLButtonElement>(container, "button", {
			name: "responsibility.create",
		}).disabled,
	).toBe(true);
	expect(container.textContent).toContain("responsibility.contextUnavailable");
});

test("a late previous Bot refresh cannot replace the current unavailable source context", async () => {
	let complete: (value: ProactiveStatus) => void = () => {};
	let count = 0;
	const { container, root, props } = await mount(async () =>
		++count === 1
			? new Promise<ProactiveStatus>((resolve) => {
					complete = resolve;
				})
			: { ...status, localFeed: "revoked" },
	);
	await act(async () => {
		root.render(
			<ResponsibilityWorkspace
				{...props}
				bot={{ ...currentBot, id: "replacement-bot", createdAt: 9 }}
			/>,
		);
	});
	await act(async () => {
		complete(status);
	});
	expect(
		getByRole<HTMLButtonElement>(container, "button", {
			name: "responsibility.create",
		}).disabled,
	).toBe(true);
	expect(props.actions.list).toHaveBeenLastCalledWith({
		botId: "replacement-bot",
		botCreatedAt: 9,
	});
});
