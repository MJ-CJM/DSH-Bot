import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useCallback, useEffect, useRef, useState } from "react";
import { sameBot, type BotKey } from "../../shared/identity.js";
import type { FeedbackCandidate, FeedbackContext, FeedbackWorkflowView } from "../../shared/proactive/feedback.js";
import { FeedbackPanel } from "./FeedbackPanel.js";
import type { FeedbackWorkspaceActions } from "./feedback-api.js";
import type { FeedbackWorkflowRequest } from "../../shared/proactive/remote-contract.js";

// Keep the exact operation when navigating between Bots within this Client.
// This holds no task state; the core receipt remains the authority.
const unresolved = new WeakMap<FeedbackWorkspaceActions, Map<string, FeedbackWorkflowRequest>>();
function pendingFor(actions: FeedbackWorkspaceActions) {
	let pending = unresolved.get(actions);
	if (!pending) { pending = new Map(); unresolved.set(actions, pending); }
	return pending;
}

interface Props extends PropsLocale<"dsh-bot"> {
	owner: BotKey;
	actions: FeedbackWorkspaceActions;
	onSettings?(setting: "tools" | "workspace" | "model" | "notifications" | "proactive"): void;
}
export function FeedbackWorkspace({ owner, actions, onSettings, t }: Props) {
	const [view, setView] = useState<FeedbackWorkflowView>({ candidates: [], datasets: [] });
	const [contexts, setContexts] = useState<FeedbackContext[]>([]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState(false);
	const [unknown, setUnknown] = useState<FeedbackWorkflowRequest>();
	const generation = useRef(0);
	const lifecycle = useRef(0);
	const alive = useRef(false);
	const botId = owner.botId, botCreatedAt = owner.botCreatedAt;
	const ownerKey = `${botId}:${botCreatedAt}`;
	const refresh = useCallback(async (cursor?: string) => {
		const request = ++generation.current;
		setPending(true); setError(false);
		try {
			const [page, nextContexts] = await Promise.all([actions.overview(cursor), actions.contexts({ botId, botCreatedAt })]);
			if (!alive.current || request !== generation.current) return;
			const rows = page.candidates.filter(row => sameBot(row.proposal.origin.bot, { botId, botCreatedAt }));
			setView(current => ({ ...page, datasets: page.datasets.filter(row => sameBot(row.owner, { botId, botCreatedAt })),
				candidates: cursor ? [...current.candidates, ...rows.filter(row => !current.candidates.some(previous => previous.id === row.id))] : rows }));
			setContexts(nextContexts);
		} catch {
			if (alive.current && request === generation.current) setError(true);
		} finally { if (alive.current && request === generation.current) setPending(false); }
	}, [actions, botId, botCreatedAt]);
	useEffect(() => {
		alive.current = true; setUnknown(pendingFor(actions).get(ownerKey));
		setView({ candidates: [], datasets: [] }); setContexts([]); void refresh();
		return () => { alive.current = false; generation.current++; lifecycle.current++; };
	}, [refresh, actions, ownerKey]);
	async function submit(request: FeedbackWorkflowRequest) {
		const epoch = lifecycle.current;
		pendingFor(actions).set(ownerKey, request);
		setPending(true); setError(false);
		try {
			const result = await actions.change(request);
			if (result.kind !== "unknown") pendingFor(actions).delete(ownerKey);
			if (!alive.current || epoch !== lifecycle.current) return;
			if (result.kind === "unknown") { setUnknown(request); return; }
			setUnknown(undefined);
			await refresh();
			if (result.kind !== "receipt") throw new Error("Feedback was rejected");
		} catch {
			if (!alive.current || epoch !== lifecycle.current) return;
			if (pendingFor(actions).has(ownerKey)) setUnknown(request); else setError(true);
		} finally { if (alive.current && epoch === lifecycle.current) setPending(false); }
	}
	return <div>
		<Button variant="ghost" disabled={pending} onClick={() => { void refresh(); }}>{t("proactive.feedbackRefresh")}</Button>
		{error && <p role="alert">{t("proactive.feedbackFailed")}</p>}
		{unknown && <div><p role="alert">{t("proactive.feedbackUnknown")}</p>
			<Button variant="ghost" disabled={pending} onClick={() => { void submit(unknown); }}>{t("proactive.feedbackReconcile")}</Button></div>}
		<FeedbackPanel key={ownerKey} view={view} contexts={contexts} pending={pending || !!unknown} t={t} onSettings={onSettings}
			onMore={cursor => refresh(cursor)} onReadSkill={actions.readSkill}
			onHistory={async id => {
				const request = generation.current, rows: FeedbackCandidate[] = [];
				let after: number | undefined;
				do {
					const page = await actions.history(id, after);
					if (!alive.current || request !== generation.current) throw new Error("Feedback page is no longer active");
					rows.push(...page.rows); after = page.nextRevision;
				} while (after !== undefined);
				return rows;
			}}
			onAction={async input => {
				if (pendingFor(actions).has(ownerKey)) throw new Error("Reconcile the pending feedback command first");
				await submit({ commandId: crypto.randomUUID(), input: structuredClone(input) });
			}}
		/>
	</div>;
}
