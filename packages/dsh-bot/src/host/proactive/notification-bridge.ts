import type { Context } from "@deepseek-ai/cordis";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import { sameBot } from "../../shared/identity.js";
import { quietAt } from "../notifications/time.js";

export async function recordProactiveNotice(
	ctx: Context,
	work: ProactiveWork,
	policyId: string,
	operationId: string,
	signal: AbortSignal,
) {
	const notifications = ctx.get("dshBotNotifications");
	const sessionId = work.sessionId ?? work.groupRepair?.rootSessionId;
	if (!notifications || !sessionId || signal.aborted) return "suppressed";
	const policy = notifications.policy(policyId);
	if (
		!policy.enabled ||
		policy.channel !== "in-app" ||
		!sameBot(policy.owner, work.target.bot) ||
		policy.dailyLimit === 0 ||
		quietAt(Date.now(), policy)
	)
		return "suppressed";
	const row = await notifications.record(
		work.target.bot,
		{
			operationId,
			policyId,
			text: work.title,
			relatedId: work.ticketId,
		},
		{ kind: "proactive", id: work.assignmentId, sessionId },
		signal,
	);
	if (row.state !== "recorded") return "unknown";
	return "recorded";
}
