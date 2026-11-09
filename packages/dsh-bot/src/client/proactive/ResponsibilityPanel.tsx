import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { sameBot, type BotKey } from "../../shared/identity.js";
import {
	responsibilityDraftSchema,
	type Responsibility,
	type ResponsibilityAction,
	type ResponsibilityDraft,
	type ResponsibilityLimits,
	type ResponsibilityMutation,
	type ResponsibilityMutationRequest,
	type ResponsibilityMutationResult,
	type ResponsibilitySource,
	type ResponsibilityView,
} from "../../shared/proactive/responsibility.js";
import styles from "./responsibility.module.css";
import styleText from "./responsibility.module.css?inline";

export type {
	ResponsibilityMutationRequest,
	ResponsibilityMutationResult,
} from "../../shared/proactive/responsibility.js";
export interface ResponsibilityActions {
	list(owner: BotKey): Promise<ResponsibilityView[]>;
	mutate(
		input: ResponsibilityMutationRequest,
	): Promise<ResponsibilityMutationResult>;
}
const unresolved = new WeakMap<
	ResponsibilityActions,
	Map<string, ResponsibilityMutationRequest>
>();
function pendingFor(actions: ResponsibilityActions) {
	let pending = unresolved.get(actions);
	if (!pending) {
		pending = new Map();
		unresolved.set(actions, pending);
	}
	return pending;
}

const limitNames = [
	"dailyRequests",
	"dailyTokens",
	"taskTokens",
	"taskAttempts",
	"taskWallTimeMs",
	"concurrency",
] as const;
const modeNames = ["off", "suggest", "auto"] as const;
const localDate = (date: string) => {
	const at = Date.parse(date);
	if (!Number.isFinite(at)) return "";
	return new Date(at - new Date(at).getTimezoneOffset() * 60000)
		.toISOString()
		.slice(0, 16);
};
const splitLines = (value: string) =>
	value
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter(Boolean);

/** CRUD and accounting view over coordinator-owned records. No task creation,
 * local policy authority, hidden polling or automatic sends happen in this view. */
export function ResponsibilityPanel({
	owner,
	target,
	canAuto = true,
	source,
	availableActions,
	availableActionScopes = [],
	actions,
	t,
}: PropsLocale<"dsh-bot"> & {
	owner: BotKey;
	target?: ResponsibilityDraft["target"];
	canAuto?: boolean;
	source?: ResponsibilitySource;
	availableActions: readonly ResponsibilityAction[];
	availableActionScopes?: readonly {
		action: ResponsibilityAction;
		digest: string;
		title: string;
	}[];
	actions: ResponsibilityActions;
}) {
	const uid = useId();
	const ownerKey = `${owner.botId}:${owner.botCreatedAt}`;
	const activeOwner = useRef(ownerKey);
	const sequence = useRef(0);
	const epoch = useRef(0);
	const sending = useRef(false);
	const pendingRequest = useRef<ResponsibilityMutationRequest>();
	const [rows, setRows] = useState<ResponsibilityView[]>([]);
	const [draft, setDraft] = useState<ResponsibilityDraft>();
	const [editing, setEditing] = useState<Responsibility>();
	const [createdId, setCreatedId] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
		"loading",
	);
	const [error, setError] = useState<"invalid" | "stale" | "unknown">();
	const [confirm, setConfirm] = useState<{
		row: Responsibility;
		kind: "remove" | "revoke";
	}>();
	const refresh = useCallback(async () => {
		const current = ++sequence.current;
		const selectedOwner = {
			botId: owner.botId,
			botCreatedAt: owner.botCreatedAt,
		};
		try {
			const result = await actions.list(selectedOwner);
			if (current !== sequence.current || activeOwner.current !== ownerKey)
				return;
			setRows(
				result.filter((item) =>
					sameBot(item.responsibility.owner, selectedOwner),
				),
			);
			setStatus("ready");
		} catch {
			if (current === sequence.current && activeOwner.current === ownerKey)
				setStatus("unavailable");
		}
	}, [actions, owner.botId, owner.botCreatedAt, ownerKey]);
	useEffect(() => {
		++epoch.current;
		activeOwner.current = ownerKey;
		setRows([]);
		setDraft(undefined);
		setEditing(undefined);
		setConfirm(undefined);
		setCreatedId(undefined);
		setError(pendingFor(actions).has(ownerKey) ? "unknown" : undefined);
		setBusy(false);
		setStatus("loading");
		sending.current = false;
		pendingRequest.current = pendingFor(actions).get(ownerKey);
		void refresh();
		return () => {
			++epoch.current;
			++sequence.current;
			activeOwner.current = "";
		};
	}, [ownerKey, refresh, actions]);
	const perform = async (request: ResponsibilityMutationRequest) => {
		if (sending.current || activeOwner.current !== ownerKey) return;
		const startedEpoch = epoch.current;
		sending.current = true;
		setBusy(true);
		setError(undefined);
		pendingRequest.current = request;
		pendingFor(actions).set(ownerKey, request);
		try {
			const result = await actions.mutate(request);
			if (result.kind !== "unknown") pendingFor(actions).delete(ownerKey);
			if (activeOwner.current !== ownerKey || epoch.current !== startedEpoch)
				return;
			if (result.kind === "unknown") {
				setError("unknown");
				return;
			}
			pendingRequest.current = undefined;
			if (result.kind === "rejected") setError("stale");
			else {
				setDraft(undefined);
				setEditing(undefined);
				setCreatedId(undefined);
				setConfirm(undefined);
			}
			await refresh();
		} catch {
			if (activeOwner.current === ownerKey && epoch.current === startedEpoch)
				setError("unknown");
		} finally {
			if (activeOwner.current === ownerKey && epoch.current === startedEpoch) {
				sending.current = false;
				setBusy(false);
			}
		}
	};
	const mutate = (mutation: ResponsibilityMutation) => {
		if (pendingRequest.current) return;
		void perform({ commandId: crypto.randomUUID(), mutation });
	};
	const startNew = () => {
		if (!source || !target || !sameBot(target.bot, owner)) return;
		const action = availableActions.includes("inspect-ci-result")
			? "inspect-ci-result"
			: availableActions[0];
		if (!action) return;
		const actionScopeDigest = availableActionScopes.find(
			(scope) => scope.action === action,
		)?.digest;
		if (action !== "inspect-ci-result" && !actionScopeDigest) {
			setError("invalid");
			return;
		}
		setCreatedId(crypto.randomUUID());
		setEditing(undefined);
		setError(undefined);
		setConfirm(undefined);
		setDraft(
			responsibilityDraftSchema.parse({
				name: t("responsibility.defaultName"),
				mode: "off",
				source,
				target,
				action,
				actionScopeDigest,
				conditions: {},
				limits: {},
				expiresAt: new Date(Date.now() + 86400000).toISOString(),
				acceptance: {
					goal: t("responsibility.defaultGoal"),
					deliverables: [t("responsibility.defaultDeliverable")],
					checks: [
						{
							id: "owner-review",
							title: t("responsibility.defaultCheck"),
							kind: "both",
						},
					],
				},
			}),
		);
	};
	const edit = (row: Responsibility) => {
		setEditing(row);
		setDraft(
			responsibilityDraftSchema.parse({
				name: row.name,
				mode: row.mode,
				source: row.source,
				conditions: row.conditions,
				action: row.action,
				actionScopeDigest: row.actionScopeDigest,
				target: row.target,
				acceptance: row.acceptance,
				limits: row.limits,
				expiresAt: row.expiresAt,
			}),
		);
		setCreatedId(undefined);
		setConfirm(undefined);
		setError(undefined);
	};
	const change = (patch: Partial<ResponsibilityDraft>) =>
		setDraft((current) => (current ? { ...current, ...patch } : current));
	const changeLimit = (key: keyof ResponsibilityLimits, value: string) => {
		if (draft) change({ limits: { ...draft.limits, [key]: Number(value) } });
	};
	const disabled = busy || !!pendingRequest.current || status !== "ready";
	return (
		<section className={styles.panel} aria-label={t("responsibility.title")}>
			<style>{styleText}</style>
			<div className={styles.actions}>
				<h2>{t("responsibility.title")}</h2>
				<Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
					{t("responsibility.refresh")}
				</Button>
				<Button
					variant="ghost"
					disabled={
						disabled || !source || !target || availableActions.length === 0
					}
					onClick={startNew}
				>
					{t("responsibility.create")}
				</Button>
			</div>
			{status !== "ready" && (
				<p role="status">{t(`responsibility.${status}`)}</p>
			)}
			{error && <p role="alert">{t(`responsibility.${error}`)}</p>}
			{pendingRequest.current && error === "unknown" && (
				<Button
					disabled={busy}
					onClick={() => {
						if (pendingRequest.current) void perform(pendingRequest.current);
					}}
				>
					{t("responsibility.reconcile")}
				</Button>
			)}
			{status === "ready" && rows.length === 0 && (
				<p>{t("responsibility.empty")}</p>
			)}
			{rows.map(({ responsibility: row, usage }) => (
				<article
					key={row.id}
					data-responsibility-id={row.id}
					className={styles.record}
				>
					<h3>{row.name}</h3>
					<p>
						{t(`responsibility.mode.${row.mode}`)} ·{" "}
						{t(`responsibility.action.${row.action}`)}
					</p>
					<p>
						{row.source.repository} · {row.source.branch} ·{" "}
						{t("responsibility.sourceGeneration", {
							generation: row.source.generation,
						})}
					</p>
					<p>
						{t("responsibility.requestsUsage", {
							used: usage.requestsUsed,
							available: usage.requestsAvailable,
						})}
					</p>
					<p>
						{t("responsibility.tokensUsage", {
							known: usage.knownTokens,
							reserved: usage.reservedTokens,
							unknown: usage.unknownTokens,
							available: usage.tokensAvailable,
						})}
					</p>
					<p>
						{t("responsibility.reset", {
							at: new Date(usage.resetsAt).toLocaleString(),
						})}
					</p>
					{!usage.measurementComplete && (
						<p role="status">{t("responsibility.incomplete")}</p>
					)}
					{usage.clockSkew && (
						<p role="alert">{t("responsibility.clockSkew")}</p>
					)}
					<div className={styles.actions}>
						<Button
							variant="ghost"
							disabled={disabled}
							onClick={() => edit(row)}
						>
							{t("responsibility.edit")}
						</Button>
						{row.mode !== "off" && (
							<Button
								variant="ghost"
								disabled={disabled}
								onClick={() =>
									mutate({
										kind: "mode",
										id: row.id,
										owner,
										expectedRevision: row.revision,
										mode: "off",
									})
								}
							>
								{t("responsibility.pause")}
							</Button>
						)}
						<Button
							variant="ghost"
							disabled={disabled}
							onClick={() => setConfirm({ row, kind: "revoke" })}
						>
							{t("responsibility.revoke")}
						</Button>
						<Button
							variant="ghost"
							disabled={disabled}
							onClick={() => setConfirm({ row, kind: "remove" })}
						>
							{t("responsibility.remove")}
						</Button>
					</div>
				</article>
			))}
			{confirm && (
				<fieldset
					className={styles.record}
					aria-label={t(`responsibility.${confirm.kind}`)}
				>
					<p>
						{t(`responsibility.confirm.${confirm.kind}`, {
							name: confirm.row.name,
						})}
					</p>
					<Button
						disabled={disabled}
						onClick={() =>
							mutate({
								kind: confirm.kind,
								id: confirm.row.id,
								owner,
								expectedRevision: confirm.row.revision,
							})
						}
					>
						{t("responsibility.confirm")}
					</Button>
					<Button
						variant="ghost"
						disabled={busy}
						onClick={() => setConfirm(undefined)}
					>
						{t("responsibility.cancel")}
					</Button>
				</fieldset>
			)}
			{draft && (
				<form
					className={styles.editor}
					onSubmit={(event) => {
						event.preventDefault();
						const parsed = responsibilityDraftSchema.safeParse({
							...draft,
							target: target ?? draft.target,
							conditions: {
								...draft.conditions,
								jobs: draft.conditions.jobs.filter(Boolean),
								excludedJobs: draft.conditions.excludedJobs.filter(Boolean),
							},
							acceptance: {
								...draft.acceptance,
								deliverables: splitLines(
									draft.acceptance.deliverables.join("\n"),
								),
							},
						});
						if (
							!parsed.success ||
							(draft.mode === "auto" && !canAuto) ||
							!availableActions.includes(draft.action) ||
							(draft.action !== "inspect-ci-result" &&
								!availableActionScopes.some(
									(scope) =>
										scope.action === draft.action &&
										scope.digest === draft.actionScopeDigest,
								))
						) {
							setError("invalid");
							return;
						}
						if (editing)
							mutate({
								kind: "update",
								id: editing.id,
								owner,
								expectedRevision: editing.revision,
								draft: parsed.data,
							});
						else if (createdId)
							mutate({
								kind: "create",
								id: createdId,
								owner,
								draft: parsed.data,
							});
					}}
				>
					<fieldset disabled={disabled}>
						<legend>
							{t(editing ? "responsibility.edit" : "responsibility.create")}
						</legend>
						<label htmlFor={`${uid}-name`}>
							{t("responsibility.name")}
							<Input
								id={`${uid}-name`}
								value={draft.name}
								required
								maxLength={120}
								onChange={(event) => change({ name: event.target.value })}
							/>
						</label>
						<label>
							{t("responsibility.mode")}
							<select
								value={draft.mode}
								onChange={(event) =>
									change({
										mode: event.target.value as ResponsibilityDraft["mode"],
									})
								}
							>
								{modeNames.map((mode) => (
									<option key={mode} value={mode} disabled={mode === "auto" && !canAuto}>
										{t(`responsibility.mode.${mode}`)}
									</option>
								))}
							</select>
						</label>
						<p>{t("responsibility.pauseHint")}</p>
						{canAuto ? (draft.mode === "auto" && <p>{t("responsibility.autoHint")}</p>)
							: <p>{t("responsibility.autoUnavailable")}</p>}
						<p>
							{t("responsibility.source")}: {draft.source.repository} ·{" "}
							{draft.source.branch} · {draft.source.generation}
						</p>
						<p>
							{t("responsibility.target")}: {draft.target.bot.botId}
							{"provider" in draft.target && ` · ${draft.target.provider} / ${draft.target.model}`}
						</p>
						{source && target && (
							<Button
								variant="ghost"
								onClick={() =>
									change({
										source,
										target,
										actionScopeDigest: availableActionScopes.find(
											(scope) => scope.action === draft.action,
										)?.digest,
									})
								}
							>
								{t("responsibility.bindCurrent")}
							</Button>
						)}
						<label>
							{t("responsibility.action")}
							<select
								value={draft.action}
								onChange={(event) =>
									change({
										action: event.target.value as ResponsibilityAction,
										actionScopeDigest: availableActionScopes.find(
											(scope) => scope.action === event.target.value,
										)?.digest,
									})
								}
							>
								{!availableActions.includes(draft.action) && (
									<option value={draft.action} disabled>
										{t(`responsibility.action.${draft.action}`)}
									</option>
								)}
								{availableActions.map((action) => (
									<option key={action} value={action}>
										{t(`responsibility.action.${action}`)}
									</option>
								))}
							</select>
						</label>
						{draft.action !== "inspect-ci-result" && (
							<label>
								{t("responsibility.scope")}
								<select
									value={draft.actionScopeDigest ?? ""}
									onChange={(event) =>
										change({ actionScopeDigest: event.target.value })
									}
								>
									{!availableActionScopes.some(
										(scope) =>
											scope.action === draft.action &&
											scope.digest === draft.actionScopeDigest,
									) && (
										<option value={draft.actionScopeDigest ?? ""} disabled>
											{t("responsibility.scopeUnavailable")}
										</option>
									)}
									{availableActionScopes
										.filter((scope) => scope.action === draft.action)
										.map((scope) => (
											<option key={scope.digest} value={scope.digest}>
												{scope.title}
											</option>
										))}
								</select>
							</label>
						)}
						{draft.actionScopeDigest && (
							<p>
								{t("responsibility.actionScope", {
									title:
										availableActionScopes.find(
											(scope) =>
												scope.action === draft.action &&
												scope.digest === draft.actionScopeDigest,
										)?.title ?? t("responsibility.scopeUnavailable"),
								})}
							</p>
						)}
						<label htmlFor={`${uid}-jobs`}>
							{t("responsibility.jobs")}
							<Input
								id={`${uid}-jobs`}
								value={draft.conditions.jobs.join(", ")}
								onChange={(event) =>
									change({
										conditions: {
											...draft.conditions,
											jobs: event.target.value
												.split(",")
												.map((value) => value.trim()),
										},
									})
								}
							/>
						</label>
						<label htmlFor={`${uid}-exclude`}>
							{t("responsibility.excludedJobs")}
							<Input
								id={`${uid}-exclude`}
								value={draft.conditions.excludedJobs.join(", ")}
								onChange={(event) =>
									change({
										conditions: {
											...draft.conditions,
											excludedJobs: event.target.value
												.split(",")
												.map((value) => value.trim()),
										},
									})
								}
							/>
						</label>
						<fieldset>
							<legend>{t("responsibility.conclusions")}</legend>
							{(["failure", "success", "cancelled"] as const).map(
								(conclusion) => (
									<label key={conclusion}>
										<input
											type="checkbox"
											checked={draft.conditions.conclusions.includes(
												conclusion,
											)}
											onChange={(event) =>
												change({
													conditions: {
														...draft.conditions,
														conclusions: event.target.checked
															? [...draft.conditions.conclusions, conclusion]
															: draft.conditions.conclusions.filter(
																	(value) => value !== conclusion,
																),
													},
												})
											}
										/>
										{t(`responsibility.conclusion.${conclusion}`)}
									</label>
								),
							)}
						</fieldset>
						<label htmlFor={`${uid}-attempt`}>
							{t("responsibility.minAttempt")}
							<Input
								id={`${uid}-attempt`}
								type="number"
								min={1}
								max={1000}
								required
								value={draft.conditions.minAttempt}
								onChange={(event) =>
									change({
										conditions: {
											...draft.conditions,
											minAttempt: Number(event.target.value),
										},
									})
								}
							/>
						</label>
						<label htmlFor={`${uid}-age`}>
							{t("responsibility.maxAgeSeconds")}
							<Input
								id={`${uid}-age`}
								type="number"
								min={60}
								max={604800}
								required
								value={draft.conditions.maxAgeSeconds}
								onChange={(event) =>
									change({
										conditions: {
											...draft.conditions,
											maxAgeSeconds: Number(event.target.value),
										},
									})
								}
							/>
						</label>
						<label htmlFor={`${uid}-expires`}>
							{t("responsibility.expires", {
								timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
							})}
							<Input
								id={`${uid}-expires`}
								type="datetime-local"
								required
								value={localDate(draft.expiresAt)}
								onChange={(event) => {
									const at = Date.parse(event.target.value);
									change({
										expiresAt: Number.isFinite(at)
											? new Date(at).toISOString()
											: "",
									});
								}}
							/>
						</label>
						<fieldset>
							<legend>{t("responsibility.budgets")}</legend>
							<p>{t("responsibility.tokenHint")}</p>
							{limitNames.map((key) => (
								<label key={key} htmlFor={`${uid}-${key}`}>
									{t(`responsibility.limit.${key}`)}
									<Input
										id={`${uid}-${key}`}
										type="number"
										min={1}
										required
										value={draft.limits[key]}
										onChange={(event) => changeLimit(key, event.target.value)}
									/>
								</label>
							))}
						</fieldset>
						<fieldset>
							<legend>{t("responsibility.acceptance")}</legend>
							<label htmlFor={`${uid}-goal`}>
								{t("responsibility.goal")}
								<Input
									id={`${uid}-goal`}
									value={draft.acceptance.goal}
									required
									maxLength={1000}
									onChange={(event) =>
										change({
											acceptance: {
												...draft.acceptance,
												goal: event.target.value,
											},
										})
									}
								/>
							</label>
							<label>
								{t("responsibility.deliverables")}
								<textarea
									value={draft.acceptance.deliverables.join("\n")}
									onChange={(event) =>
										change({
											acceptance: {
												...draft.acceptance,
												deliverables: event.target.value.split("\n"),
											},
										})
									}
								/>
							</label>
							{draft.acceptance.checks.map((check, index) => (
								<div className={styles.check} key={check.id}>
									<label htmlFor={`${uid}-check-${index}`}>
										{t("responsibility.check", { index: index + 1 })}
										<Input
											id={`${uid}-check-${index}`}
											value={check.title}
											required
											onChange={(event) =>
												change({
													acceptance: {
														...draft.acceptance,
														checks: draft.acceptance.checks.map((row, at) =>
															at === index
																? { ...row, title: event.target.value }
																: row,
														),
													},
												})
											}
										/>
									</label>
									<label>
										{t("responsibility.checkKind")}
										<select
											value={check.kind}
											onChange={(event) =>
												change({
													acceptance: {
														...draft.acceptance,
														checks: draft.acceptance.checks.map((row, at) =>
															at === index
																? {
																		...row,
																		kind: event.target.value as typeof row.kind,
																	}
																: row,
														),
													},
												})
											}
										>
											{(["tool", "human", "both"] as const).map((kind) => (
												<option key={kind} value={kind}>
													{t(`responsibility.checkKind.${kind}`)}
												</option>
											))}
										</select>
									</label>
									<Button
										variant="ghost"
										disabled={draft.acceptance.checks.length < 2}
										onClick={() =>
											change({
												acceptance: {
													...draft.acceptance,
													checks: draft.acceptance.checks.filter(
														(_, at) => at !== index,
													),
												},
											})
										}
									>
										{t("responsibility.removeCheck")}
									</Button>
								</div>
							))}
							<Button
								variant="ghost"
								disabled={draft.acceptance.checks.length >= 20}
								onClick={() =>
									change({
										acceptance: {
											...draft.acceptance,
											checks: [
												...draft.acceptance.checks,
												{
													id: crypto.randomUUID(),
													title: t("responsibility.defaultCheck"),
													kind: "both",
												},
											],
										},
									})
								}
							>
								{t("responsibility.addCheck")}
							</Button>
						</fieldset>
						<div className={styles.actions}>
							<Button type="submit" variant="primary">
								{t("responsibility.save")}
							</Button>
							<Button
								variant="ghost"
								onClick={() => {
									setDraft(undefined);
									setEditing(undefined);
									setCreatedId(undefined);
								}}
							>
								{t("responsibility.cancel")}
							</Button>
						</div>
					</fieldset>
				</form>
			)}
		</section>
	);
}
