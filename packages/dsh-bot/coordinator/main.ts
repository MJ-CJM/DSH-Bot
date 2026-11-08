import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import {
	capabilities,
	digestSchema,
	protocolVersion,
	replySchema,
	requestSchema,
	type Reply,
} from "../src/shared/proactive/protocol.js";
import { frame, frames } from "../src/host/proactive/wire.js";
import { openCoordinator } from "./commands.js";
import { Rejection } from "./rejection.js";

type Payload<T> = T extends Reply
	? Omit<T, "protocolVersion" | "correlationId">
	: never;
async function serve() {
	const channel = digestSchema.parse(process.env.DSH_BOT_IPC_KEY);
	delete process.env.DSH_BOT_IPC_KEY;
	const path = z.string().min(1).parse(process.argv[2]);
	const secret = Buffer.from(channel, "hex");
	let core: ReturnType<typeof openCoordinator> | undefined;
	let poison = false;
	try {
		for await (const input of frames(process.stdin)) {
			const parsed = requestSchema.safeParse(input);
			if (!parsed.success) {
				const identifiable = z
					.object({ correlationId: z.uuid() })
					.safeParse(input);
				if (!identifiable.success) break;
				const invalid = frame({
					protocolVersion,
					correlationId: identifiable.data.correlationId,
					kind: "rejected",
					code: "invalid",
				});
				if (!process.stdout.write(invalid)) await once(process.stdout, "drain");
				continue;
			}
			const request = parsed.data;
			const respond = async (payload: Payload<Reply>) => {
				const encoded = frame(
					replySchema.parse({
						protocolVersion,
						correlationId: request.correlationId,
						...payload,
					}),
				);
				if (!process.stdout.write(encoded)) await once(process.stdout, "drain");
			};
			try {
				if (!timingSafeEqual(secret, Buffer.from(request.channel, "hex")))
					throw new Rejection("forbidden");
				if (request.kind === "hello") {
					if (core) throw new Rejection("conflict");
					core = openCoordinator(
						path,
						request.installationId,
						request.expectedStoreId,
						request.budget ?? 8,
						request.externalBudget ?? 8,
						request.notice ?? false,
						request.autoRule,
						request.feedbackSource,
						request.noticeConfig,
						request.governanceConfig,
					);
					await respond({
						kind: "hello",
						storeId: core.storeId,
						bootId: randomUUID(),
						capabilities,
					});
					continue;
				}
				if (
					!core ||
					(request.kind !== "command" && request.storeId !== core.storeId)
				)
					throw new Rejection("forbidden");
				switch (request.kind) {
 case "source-cleanup-scope":await respond({kind:"source-cleanup-scope",scope:core.sourceCleanupScope(request.sourceId,request.generation)});break;
					case "forget-receipt":
						await respond({
							kind: "forget-receipt",
							receipt: core.forgetReceipt(request.operationId),
						});
						break;
					case "governance-pending":
						await respond({
							kind: "governance-pending",
							plans: core.governancePending(),
						});
						break;
					case "work-assignment":
						await respond({
							kind: "work",
							work: core.workAssignment(request.assignmentId),
						});
						break;
					case "notice-due":
						await respond({ kind: "notice-due", items: core.noticeDue() });
						break;
					case "notice-candidates":
						await respond({
							kind: "notice-candidates",
							work: core.noticeCandidates(),
						});
						break;
					case "notice-batch":
						await respond({
							kind: "notice-batch",
							batch: core.noticeBatch(request.id),
						});
						break;
					case "auto-candidates":
						await respond({
							kind: "auto-candidates",
							rows: core.autoCandidates(),
						});
						break;
					case "feedback-candidate":
						await respond({
							kind: "feedback-candidate",
							candidate: core.feedbackCandidate(request.id),
						});
						break;
					case "feedback-history":
						await respond({
							kind: "feedback-history",
							history: core.feedbackHistory(request.id, request.afterRevision),
						});
						break;
					case "responsibilities":
						await respond({
							kind: "responsibilities",
							rows: core.responsibilities(request.owner),
						});
						break;
					case "feedback-overview":
						await respond({
							kind: "feedback-overview",
							view: core.feedbackView(request.cursor),
						});
						break;
					case "work-history":
						await respond({
							kind: "work-history",
							history: core.workHistory(request.input),
						});
						break;
					case "command":
						await respond({
							kind: "receipt",
							receipt: core.command(request.command),
						});
						break;
					case "receipt":
						await respond({
							kind: "receipt",
							receipt: core.receipt(request.commandId),
						});
						break;
					case "snapshot":
						await respond({ kind: "snapshot", snapshot: core.snapshot() });
						break;
					case "checkpoint":
						await respond({
							kind: "checkpoint",
							source: core.checkpoint(request.sourceId),
						});
						break;
					case "suggestions":
						await respond({
							kind: "suggestions",
							suggestions: core.suggestions(
								request.owner,
								request.includeFiltered,
							),
						});
						break;
					case "work":
						await respond({
							kind: "work",
							work: core.work(request.decisionId),
						});
						break;
					case "dispatch-permitted":
						await respond({
							kind: "dispatch-permitted",
							permitted: core.permitted(
								request.assignmentId,
								request.groupReviewDigest,
								request.noticeRevision,
								request.groupFactId,
							),
						});
						break;
					case "group-follow-ups":
						await respond({
							kind: "group-follow-ups",
							candidates: core.groupFollowUps(),
						});
						break;
					case "work-ticket":
						await respond({
							kind: "work",
							work: core.workTicket(request.ticketId),
						});
						break;
					case "work-list":
						await respond({ kind: "work-list", work: core.workList() });
						break;
					case "shutdown":
						core.close();
						core = undefined;
						await respond({ kind: "shutdown" });
						return;
				}
			} catch (error) {
				if (error instanceof Rejection)
					await respond({ kind: "rejected", code: error.code });
				else {
					poison = true;
					if (request.kind === "command")
						await respond({
							kind: "unknown",
							commandId: request.command.commandId,
						});
					else await respond({ kind: "rejected", code: "unsupported" });
					break;
				}
			}
		}
	} finally {
		core?.close();
	}
	if (poison) process.exitCode = 1;
}
serve().catch(() => {
	process.exitCode = 1;
});
