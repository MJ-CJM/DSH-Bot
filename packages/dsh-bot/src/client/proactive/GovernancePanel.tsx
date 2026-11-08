import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useEffect, useRef, useState } from "react";
import type { ProactiveStatus } from "../../shared/proactive/protocol.js";
import type {
	BeginForget,
	ForgetReceipt,
} from "../../shared/proactive/governance.js";

export interface GovernanceActions {
	status(): Promise<ProactiveStatus>;
	forget(input: BeginForget & { commandId: string }): Promise<ForgetReceipt>;
}
const pendingCommands = new WeakMap<
	GovernanceActions,
	BeginForget & { commandId: string }
>();
export function GovernancePanel({
	actions,
	t,
}: PropsLocale<"dsh-bot"> & { actions: GovernanceActions }) {
	const [source, setSource] = useState<ProactiveStatus["localFeedScope"]>();
	const [preview, setPreview] = useState(false),
		[pending, setPending] = useState(false),
		[unknown, setUnknown] = useState(pendingCommands.has(actions));
	const [receipt, setReceipt] = useState<ForgetReceipt>();
	const generation = useRef(0);
	useEffect(() => {
		const request = ++generation.current;
		void actions
			.status()
			.then((value) => {
				if (request === generation.current) setSource(value.localFeedScope);
			})
			.catch(() => {});
		return () => {
			generation.current++;
		};
	}, [actions]);
	if (!source && !unknown) return null;
	const run = async () => {
		const request = generation.current;
		let input = pendingCommands.get(actions);
		if (!input) {
			if (!source) return;
			input = {
				commandId: crypto.randomUUID(),
				operationId: crypto.randomUUID(),
				sourceId: source.id,
				generation: source.generation,
			};
			pendingCommands.set(actions, input);
		}
		setPending(true);
		try {
			const result = await actions.forget(input);
			if (request !== generation.current) return;
			setReceipt(result);
			setUnknown(false);
			setPreview(false);
			if (result.phase === "complete") pendingCommands.delete(actions);
		} catch {
			if (request === generation.current) setUnknown(true);
		} finally {
			if (request === generation.current) setPending(false);
		}
	};
	return (
		<section>
			<h3>{t("proactive.governanceTitle")}</h3>
			{source && (
				<p>
					{source.repository} · {source.branch}
				</p>
			)}
			{unknown ? (
				<p role="alert">{t("proactive.governanceUnknown")}</p>
			) : (
				receipt && (
					<p role="status">
						{t(
							receipt.phase === "complete"
								? "proactive.governanceComplete"
								: receipt.phase === "blocked"
									? "proactive.governanceBlocked"
									: "proactive.governancePending",
						)}
					</p>
				)
			)}
			{preview && <p>{t("proactive.governanceScope")}</p>}
			{unknown || (receipt && receipt.phase !== "complete") ? (
				<Button
					disabled={pending}
					onClick={() => {
						void run();
					}}
				>
					{t("proactive.governanceRetry")}
				</Button>
			) : (
				receipt?.phase !== "complete" && (
					<Button
						disabled={pending}
						onClick={() => {
							if (preview) void run();
							else setPreview(true);
						}}
					>
						{t(
							preview
								? "proactive.governanceConfirm"
								: "proactive.governancePreview",
						)}
					</Button>
				)
			)}
		</section>
	);
}
