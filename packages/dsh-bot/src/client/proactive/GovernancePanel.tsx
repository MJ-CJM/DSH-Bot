import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useEffect, useRef, useState } from "react";
import type { ProactiveStatus } from "../../shared/proactive/protocol.js";
import type {
	BeginForget,
	ForgetReceipt,
} from "../../shared/proactive/governance.js";

export interface GovernanceActions {
	forget(input: BeginForget & { commandId: string }): Promise<ForgetReceipt>;
}
const pendingCommands = new WeakMap<
	GovernanceActions,
	BeginForget & { commandId: string }
>();
export function GovernancePanel({
	actions,
	source,
	refresh,
	t,
}: PropsLocale<"dsh-bot"> & {
	actions: GovernanceActions;
	source?: ProactiveStatus["localFeedScope"];
	refresh?: () => Promise<void>;
}) {
	const [previewKey, setPreviewKey] = useState<string>(),
		[pending, setPending] = useState(false),
		[unknown, setUnknown] = useState(pendingCommands.has(actions));
	const sourceKey = source && `${source.id}:${source.generation}`;
	const preview = !!sourceKey && sourceKey === previewKey;
	const [receipt, setReceipt] = useState<ForgetReceipt>();
	const generation = useRef(0);
	useEffect(() => {
		return () => { generation.current++; };
	}, []);
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
			setPreviewKey(undefined);
			if (result.phase === "complete") pendingCommands.delete(actions);
			void refresh?.();
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
									? receipt.blockedReason === "group-copy-unknown"
										? "proactive.governanceGroupCopyBlocked"
										: "proactive.governanceBlocked"
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
							else setPreviewKey(sourceKey);
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
