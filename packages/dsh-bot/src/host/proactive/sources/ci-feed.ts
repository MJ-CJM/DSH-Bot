import { githubCiSchema, observeGithubCi } from './github-ci.js';
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ProactiveService } from "../service.js";
import { ciScopeSchema, ciPageSchema, ciSourceId } from "./ci.js";

export const ciFeedSchema = z.strictObject({
	scope: ciScopeSchema,
  github: githubCiSchema.optional(),
	intervalMs: z.number().int().min(1000).max(3600000).default(60000),
});
export type CiFeed = z.output<typeof ciFeedSchema>;
export type FeedStatus =
	| "waiting"
	| "ready"
	| "invalid"
	| "unavailable"
	| "revoked";
const maxBytes = 64 * 1024;

async function readPage(path: string) {
	const handle = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
			throw new Error("Invalid CI page file");
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== stat.size) throw new Error("CI page changed during read");
		return ciPageSchema.parse(
			JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
		);
	} finally {
		await handle.close();
	}
}

/** One configured source with one stable checkpoint. The publisher atomically
 * replaces the file with its next complete page after seeing the cursor advance. */
export async function pollCiFeed(
	root: string,
	feed: CiFeed,
	service: ProactiveService,
	signal: AbortSignal,
	setStatus: (status: FeedStatus) => void,
  credential?: () => Promise<string | undefined>,
) {
	const dir = join(root, "ci-inbox");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	if ((await realpath(dir)) !== dir)
		throw new Error("Invalid CI inbox directory");
	const path = join(dir, `${ciSourceId(feed.scope).slice(3)}.json`);
	while (!signal.aborted) {
		try {
			if ((await realpath(dir)) !== dir)
				throw new Error("CI inbox directory changed");
			const current = await service.ciCheckpoint(feed.scope);
			signal.throwIfAborted();
			if (current?.generation === feed.scope.generation && current.revoked) {
				setStatus("revoked");
				return;
			}
			if (current && current.generation > feed.scope.generation)
				setStatus("invalid");
      else if (feed.github) {
        await observeGithubCi(feed.scope, feed.github, service, signal, credential ?? (async () => undefined));
        setStatus('ready');
      }
			else {
				const page = await readPage(path);
				const cursor =
					current?.generation === feed.scope.generation
						? current.checkpoint
						: null;
				if (
					current?.generation === feed.scope.generation &&
					page.after === cursor
				)
					setStatus("ready");
				else if (
					page.before !== cursor ||
					page.after === null ||
					page.after === page.before
				)
					setStatus("invalid");
				else {
					const reply = await service.observeCi(randomUUID(), feed.scope, page);
					setStatus(reply.kind === "receipt" ? "ready" : "unavailable");
				}
			}
		} catch (error) {
			if (!signal.aborted)
				setStatus(
					(error as NodeJS.ErrnoException).code === "ENOENT"
						? "waiting"
						: feed.github ? "unavailable" : "invalid",
				);
		}
		await delay(feed.intervalMs, undefined, { signal }).catch((error) => {
			if (!signal.aborted) throw error;
		});
	}
}
