import type { GroupRepairGrant } from "../../shared/proactive/group-repair.js";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useState } from "react";
import styles from "./workspace.module.css";
import type { ProactiveStatus } from "../../shared/proactive/protocol.js";
import type { WorkspaceRepairGrant } from "../../shared/proactive/workspace-repair.js";

export function WorkspaceOffer({
	offer,
	pending,
	onAccept,
	groups = [],
	t,
}: PropsLocale<"dsh-bot"> & {
	offer: NonNullable<ProactiveStatus["workspaceOffers"]>[number];
	pending: boolean;
	onAccept(grant: WorkspaceRepairGrant, groupRepair?: GroupRepairGrant): void;
	groups?: NonNullable<ProactiveStatus["groupRepairOffers"]>;
}) {
	const [open, setOpen] = useState(false);
	const [selection, setSelection] = useState("");
	const group =
		offer.executor === "native"
			? groups.find((item) => JSON.stringify(item.grant) === selection)
			: undefined;
	return (
		<section className={styles.content} data-workspace-offer={offer.specDigest}>
			<h4>
				{offer.title} · {offer.executorLabel}
			</h4>
			{!open ? (
				<Button
					variant="ghost"
					disabled={pending}
					onClick={() => setOpen(true)}
				>
					{t("proactive.workspacePreview")}
				</Button>
			) : (
				<>
					<p>{t("proactive.workspaceScope")}</p>
					{offer.executor === "native" && groups.length > 0 && (
						<div>
							<label>
								{t("proactive.groupRepairMode")}
								<select
									aria-label={t("proactive.groupRepairMode")}
									value={selection}
									disabled={pending}
									onChange={(event) => setSelection(event.currentTarget.value)}
								>
									<option value="">{t("proactive.groupRepairSolo")}</option>
									{groups.map((item) => (
										<option
											key={item.grant.group.groupId}
											value={JSON.stringify(item.grant)}
										>
											{item.title}
										</option>
									))}
								</select>
							</label>
							{group && (
								<>
									<p>{t("proactive.groupRepairScope")}</p>
									<p>
										{t("proactive.groupRepairRoles", {
											supervisor: group.grant.supervisor.bot.botId,
											implementer: group.grant.implementer.bot.botId,
										})}
									</p>
								</>
							)}
						</div>
					)}

					{offer.executor === "command" && (
						<p>{t("proactive.workspaceExternalBudget")}</p>
					)}
					<p>
						{t("proactive.workspaceInputBytes", {
							files: offer.files.length,
							bytes: offer.files.reduce((sum, file) => sum + file.bytes, 0),
						})}
					</p>
					<ul>
						{offer.files.map((file) => (
							<li key={file.path}>
								<code>{file.path}</code> ·{" "}
								{t(
									file.editable
										? "proactive.workspaceEditable"
										: "proactive.workspaceReadonly",
								)}{" "}
								· {file.bytes}
								<br />
								<code>{file.digest}</code>
							</li>
						))}
					</ul>
					<p>{t("proactive.workspaceFixedCommand")}</p>
					<pre>
						{JSON.stringify([offer.verifier.command, ...offer.verifier.args])}
					</pre>
					<p>
						{t("proactive.workspaceTestLimits", {
							milliseconds: offer.verifier.timeoutMs,
							bytes: offer.verifier.maxOutputBytes,
						})}
					</p>
					<p>
						{t("proactive.workspaceBaselineDigest")}{" "}
						<code>{offer.baselineDigest}</code>
					</p>
					<p>
						{t("proactive.workspaceSpecDigest")} <code>{offer.specDigest}</code>
					</p>
					<Button
						variant="primary"
						disabled={pending}
						onClick={() =>
							onAccept(
								{
									workspaceId: offer.workspaceId,
									specDigest: offer.specDigest,
									baselineDigest: offer.baselineDigest,
									executor: offer.executor,
								},
								group?.grant,
							)
						}
					>
						{t("proactive.workspaceConfirm")}
					</Button>
					<Button
						variant="ghost"
						disabled={pending}
						onClick={() => setOpen(false)}
					>
						{t("actions.close")}
					</Button>
				</>
			)}
		</section>
	);
}
