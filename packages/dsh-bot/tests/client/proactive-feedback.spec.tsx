// @vitest-environment jsdom
import { fireEvent, getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { FeedbackWorkspace } from "../../src/client/proactive/FeedbackWorkspace.js";
import type { FeedbackWorkspaceActions } from "../../src/client/proactive/feedback-api.js";
import type { FeedbackWorkflowRequest, SuggestionActionReply } from "../../src/shared/proactive/remote-contract.js";

const owner = { botId: "feedback-owner", botCreatedAt: 1 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function mount(change: FeedbackWorkspaceActions["change"]) {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container);
	const actions: FeedbackWorkspaceActions = {
		overview: async () => ({ candidates: [], datasets: [] }),
		contexts: async bot => [{ label: "Profile feedback", origin: { bot, taskId: `profile:${bot.botId}`, evidenceDigest: "a".repeat(64) } }],
		change, history: async () => ({ rows: [] }), readSkill: async () => ({ hash: null }),
	};
	const props: ComponentProps<typeof FeedbackWorkspace> = { owner, actions,
		t: (key => key) as ComponentProps<typeof FeedbackWorkspace>["t"] };
	await act(async () => { root.render(<FeedbackWorkspace {...props} />); });
	cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
	return { container, root, props };
}
const click = async (container: HTMLElement, name: string) => act(async () => {
	fireEvent.click(getByRole(container, "button", { name }));
});
async function proposePreference(container: HTMLElement) {
	await act(async () => {
		fireEvent.change(getByLabelText(container, "proactive.feedbackKindLabel"), { target: { value: "preference" } });
	});
	await act(async () => {
		fireEvent.change(getByLabelText(container, "proactive.feedbackReason"), { target: { value: "Owner preference" } });
		fireEvent.change(getByLabelText(container, "proactive.feedbackContent"), { target: { value: "Use concise summaries" } });
	});
	await click(container, "proactive.feedbackCreate");
}

test("unknown feedback keeps the original payload and ID, blocks new writes, and reconciles explicitly", async () => {
	const change = vi.fn(async (request: FeedbackWorkflowRequest): Promise<SuggestionActionReply> => ({ kind: "unknown", commandId: request.commandId }));
	const { container } = await mount(change);
	await proposePreference(container);
	expect(getByRole(container, "alert").textContent).toBe("proactive.feedbackUnknown");
	expect((getByRole(container, "button", { name: "proactive.feedbackCreate" }) as HTMLButtonElement).disabled).toBe(true);
	const original = change.mock.calls[0]?.[0];
	await click(container, "proactive.feedbackReconcile");
	expect(change).toHaveBeenCalledTimes(2);
	expect(change.mock.calls[1]?.[0]).toEqual(original);
});

test("navigation cannot turn an unknown operation into a newly keyed write", async () => {
	const change = vi.fn(async (request: FeedbackWorkflowRequest): Promise<SuggestionActionReply> => ({ kind: "unknown", commandId: request.commandId }));
	const { container, root, props } = await mount(change);
	await proposePreference(container);
	await act(async () => { root.render(<FeedbackWorkspace {...props} owner={{ botId: "other-owner", botCreatedAt: 2 }} />); });
	expect(queryByRole(container, "alert")).toBeNull();
	await act(async () => { root.render(<FeedbackWorkspace {...props} />); });
	expect(getByRole(container, "alert").textContent).toBe("proactive.feedbackUnknown");
	await click(container, "proactive.feedbackReconcile");
	expect(change.mock.calls[1]?.[0]).toEqual(change.mock.calls[0]?.[0]);
});

test("a definitive rejection unlocks editing and does not masquerade as an unknown result", async () => {
	const change = vi.fn(async (): Promise<SuggestionActionReply> => ({ kind: "rejected", code: "forbidden" }));
	const { container } = await mount(change);
	await proposePreference(container);
	expect(getByRole(container, "alert").textContent).toBe("proactive.feedbackFailed");
	expect(queryByRole(container, "button", { name: "proactive.feedbackReconcile" })).toBeNull();
	expect((getByLabelText(container, "proactive.feedbackReason") as HTMLTextAreaElement).closest("fieldset")?.disabled).toBe(false);
});
