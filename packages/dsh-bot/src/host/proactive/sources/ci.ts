import { z } from "zod";
import {
	ciSignalSchema,
	type CommandBody,
} from "../../../shared/proactive/protocol.js";
import { digest } from "../wire.js";

const repository = z
	.string()
	.regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const branch = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/);
const cursor = z.string().min(1).max(512).nullable();
export const ciScopeSchema = z.strictObject({
	repository,
	branch,
	generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const row = z.strictObject({
	repository,
	branch,
	runId: z.string().regex(/^[1-9][0-9]{0,30}$/),
	job: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
	commit: z.string().regex(/^[a-f0-9]{40}$/),
	observedAt: z.iso.datetime(),
	...ciSignalSchema.omit({ job: true }).shape,
});
export const ciPageSchema = z.strictObject({
	complete: z.literal(true),
	before: cursor,
	after: cursor,
	rows: z.array(row).max(32),
});
export type CiScope = z.input<typeof ciScopeSchema>;
export type CiPage = z.input<typeof ciPageSchema>;

export function ciSourceId(config: CiScope) {
	const parsed = ciScopeSchema.parse(config);
	return `ci:${digest([parsed.repository.toLowerCase(), parsed.branch])}`;
}

/** The first adapter takes a complete, locally provided CI observation page.
 * Native text, credentials, and transport errors are never task instructions.
 */
export function observeCiPage(
	config: CiScope,
	input: CiPage,
): Extract<CommandBody, { kind: "ingest-batch" }> {
	const configured = ciScopeSchema.parse(config);
	const read = ciPageSchema.parse(input);
	const repo = configured.repository.toLowerCase();
	const sourceId = ciSourceId(configured);
	const events = read.rows.map((event) => {
		if (
			event.repository.toLowerCase() !== repo ||
			event.branch !== configured.branch
		)
			throw new Error("CI observation outside configured source scope");
		const threadId = digest([repo, configured.branch, event.runId, event.job]);
		const occurredAt = new Date(event.observedAt).toISOString();
		return {
			nativeId: threadId,
			threadId,
			occurredAt,
			nativeRevision: digest([event.attempt, event.conclusion, occurredAt]),
			summary: `CI ${repo} ${event.job} (${event.commit.slice(0, 12)}): ${event.conclusion}`,
			context: {repository: repo, branch: configured.branch, runId: event.runId, commit:event.commit,
				url:`https://github.com/${repo}/actions/runs/${event.runId}`},
			ci: {
				attempt: event.attempt,
				conclusion: event.conclusion,
				job: event.job,
			},
		};
	});
	return {
		kind: "ingest-batch",
		sourceId,
		generation: configured.generation,
		expectedCheckpoint: read.before,
		nextCheckpoint: read.after,
		events,
	};
}
