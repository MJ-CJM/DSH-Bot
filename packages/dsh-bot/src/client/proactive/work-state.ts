import type { Context } from "@deepseek-ai/cordis";
import { useSyncExternalStore } from "react";
import { sameBot, type BotKey } from "../../shared/identity.js";
import type { ActivityPage, ProactiveStatus, Suggestion } from "../../shared/proactive/protocol.js";
import type { ResponsibilityView } from "../../shared/proactive/responsibility.js";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import { createPollingCatalog, type BotCatalogOptions, type PollingCatalog } from "../state.js";
import { structuralEqual } from "../structural-equal.js";

interface WorkPayload {
	status?: ProactiveStatus;
	nextWork?: string;
	nextSuggestions?: string;
	responsibilities?: readonly ResponsibilityView[];
	suggestions: readonly Suggestion[];
	work: readonly ProactiveWork[];
	refreshedAt?: number;
}
type WorkCatalog = PollingCatalog<WorkPayload>;
export type ProactiveWorkSource = (owner: BotKey) => WorkCatalog;
export type ProactiveWorkSnapshot = ReturnType<WorkCatalog["getSnapshot"]>;
const empty: ProactiveWorkSnapshot = {
	suggestions: [], work: [], loading: true, loaded: false, pollIntervalMs: 0,
};
const noSubscribe = () => () => {};
const emptySnapshot = () => empty;
const getVisible = () => document.visibilityState !== "hidden";
const subscribeVisibility = (listener: () => void) => {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
};

/** Both Bot views use the same catalog keyed by the Bot incarnation. */
export function createProactiveWorkSource(ctx: Context, reads: {
	status(): Promise<ProactiveStatus>;
	page?(owner: BotKey, collection: 'work' | 'suggestions'): Promise<ActivityPage>;
	responsibilities?(owner: BotKey): Promise<ResponsibilityView[]>;
	suggestions(owner: BotKey): Promise<Suggestion[]>;
	work(owner: BotKey): Promise<ProactiveWork[]>;
}, options: BotCatalogOptions): ProactiveWorkSource {
	const catalogs = new Map<string, WorkCatalog>();
	ctx.effect(() => () => catalogs.clear(), "dsh-bot: proactive work sources");
	return (owner) => {
		const key = `${owner.botId}:${owner.botCreatedAt}`;
		const existing = catalogs.get(key);
		if (existing) return existing;
		const catalog: WorkCatalog = createPollingCatalog<WorkPayload>(ctx, empty, async signal => {
			const status = await reads.status();
			signal.throwIfAborted();
			if (status.state === "unavailable") throw new Error("Proactive coordinator unavailable");
			const [suggestionsPage, workPage, duties] = status.state === "ready"
        ? await Promise.all([
          reads.page ? reads.page(owner, 'suggestions') : reads.suggestions(owner).then(rows => ({ rows, next: undefined })),
          reads.page ? reads.page(owner, 'work') : reads.work(owner).then(rows => ({ rows, next: undefined })),
          reads.responsibilities?.(owner) ?? [],
        ]) : [{ rows: [], next: undefined }, { rows: [], next: undefined }, []];
      const suggestions = suggestionsPage.rows as Suggestion[];
      const work = workPage.rows as ProactiveWork[];
			const responsibilities = duties.filter(row => sameBot(row.responsibility.owner, owner));
			const scopedWork = work.filter(row => sameBot(row.target.bot, owner));
			const previous = catalog.getSnapshot();
			// Preserve scheduler backoff when only the clock has changed.
			const changed = previous.error || !structuralEqual(
				[status, suggestions, scopedWork, responsibilities],
				[previous.status, previous.suggestions, previous.work, previous.responsibilities],
			);
			return { status, nextWork: workPage.next, nextSuggestions: suggestionsPage.next, suggestions, responsibilities, work: scopedWork, refreshedAt: changed ? Date.now() : previous.refreshedAt };
		}, options);
		catalogs.set(key, catalog);
		return catalog;
	};
}

export function useProactiveWork(source: ProactiveWorkSource | undefined, owner: BotKey | undefined, active: boolean) {
	const visible = useSyncExternalStore(subscribeVisibility, getVisible);
	const catalog = owner && source?.(owner);
	const snapshot = useSyncExternalStore(
		active && visible && catalog ? catalog.subscribe : noSubscribe,
		catalog?.getSnapshot ?? emptySnapshot,
	);
	return { snapshot, refresh: active && visible ? catalog?.refresh : undefined };
}
