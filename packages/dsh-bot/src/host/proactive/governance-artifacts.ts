import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	open,
	readdir,
	realpath,
	rmdir,
	unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
	artifactPurgePlanSchema,
	type ArtifactPurgePlan,
	type ArtifactPurgeResult,
} from "../../shared/proactive/governance.js";
import { digest } from "./wire.js";

/** Only call after coordinator approval and writer drain. Native session and
 * user workspace paths are intentionally not accepted by this boundary. */
export async function purgeManagedArtifacts(
	root: string,
	input: ArtifactPurgePlan,
	limits: { maxFiles?: number; maxBytes?: number; now?: () => number } = {},
): Promise<ArtifactPurgeResult> {
	const plan = artifactPurgePlanSchema.parse(input);
	const maxFiles = limits.maxFiles ?? 10000;
	const maxBytes = limits.maxBytes ?? 512 * 1024 * 1024;
	const now = limits.now ?? Date.now;
	const manifest: Array<{
		path: string;
		bytes: number;
		digest: string;
		ino: number;
		dev: number;
		mtimeMs: number;
	}> = [];
	const directories: Array<{ path: string; ino: number; dev: number }> = [];
	let changed = false;
	let bytes = 0;
	let removed = 0;
	const result = (
		state: ArtifactPurgeResult["state"],
		reason?: string,
	): ArtifactPurgeResult => ({
		planId: plan.id,
		state,
		files: removed,
		bytes,
		manifestDigest: digest(
			manifest.map(({ path, bytes, digest: hash }) => ({
				path,
				bytes,
				digest: hash,
			})),
		),
		at: now(),
		...(reason ? { reason } : {}),
	});
	const missing = (error: unknown) =>
		(error as NodeJS.ErrnoException).code === "ENOENT";
	const base = resolve(root);
	const canonical = async (path: string) => {
		const stat = await lstat(path);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(await realpath(path)) !== path
		)
			throw new Error("unsafe-directory");
		return stat;
	};
	try {
		if (
			!Number.isSafeInteger(maxFiles) ||
			maxFiles < 1 ||
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 1
		)
			throw new Error("invalid-limits");
		await canonical(base);
		const walk = async (path: string) => {
			const stat = await canonical(path);
			directories.push({ path, ino: stat.ino, dev: stat.dev });
			if (directories.length > maxFiles) throw new Error("artifact-limit");
			for (const name of (await readdir(path)).sort()) {
				const file = join(path, name);
				const before = await lstat(file);
				if (before.isDirectory() && !before.isSymbolicLink()) {
					await walk(file);
					continue;
				}
				if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
					throw new Error("unsafe-artifact");
				if (manifest.length >= maxFiles || bytes + before.size > maxBytes)
					throw new Error("artifact-limit");
				const handle = await open(
					file,
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const first = await handle.stat();
					if (
						first.ino !== before.ino ||
						first.dev !== before.dev ||
						first.nlink !== 1
					)
						throw new Error("artifact-changed");
					const hash = createHash("sha256");
					const buffer = Buffer.alloc(65536);
					let read = 0;
					while (true) {
						const chunk = await handle.read(buffer, 0, buffer.length, read);
						if (!chunk.bytesRead) break;
						read += chunk.bytesRead;
						if (bytes + read > maxBytes || read > first.size)
							throw new Error("artifact-changed");
						hash.update(buffer.subarray(0, chunk.bytesRead));
					}
					const after = await handle.stat();
					if (
						read !== first.size ||
						after.size !== first.size ||
						after.mtimeMs !== first.mtimeMs ||
						after.nlink !== 1
					)
						throw new Error("artifact-changed");
					bytes += read;
					manifest.push({
						path: relative(base, file),
						bytes: read,
						digest: hash.digest("hex"),
						ino: first.ino,
						dev: first.dev,
						mtimeMs: first.mtimeMs,
					});
				} finally {
					await handle.close();
				}
			}
		};
		for (const namespace of new Set(plan.namespaces)) {
			const parent = join(base, namespace);
			try {
				await canonical(parent);
			} catch (error) {
				if (missing(error)) continue;
				throw error;
			}
			const assignment = join(parent, plan.assignmentId);
			try {
				await walk(assignment);
			} catch (error) {
				if (
					missing(error) &&
					!directories.some((dir) => dir.path === assignment)
				)
					continue;
				throw error;
			}
		}
		// Validate every entry before the first removal. A symlink/hardlink leaves
		// the entire plan untouched and returns a blocked receipt.
		for (const dir of directories) {
			const stat = await canonical(dir.path);
			if (stat.ino !== dir.ino || stat.dev !== dir.dev)
				throw new Error("artifact-changed");
		}
		for (const entry of manifest) {
			const file = join(base, entry.path);
			await canonical(dirname(file));
			const stat = await lstat(file);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1 ||
				stat.ino !== entry.ino ||
				stat.dev !== entry.dev ||
				stat.size !== entry.bytes ||
				stat.mtimeMs !== entry.mtimeMs
			)
				throw new Error("artifact-changed");
		}
		for (const entry of manifest) {
			const file = join(base, entry.path);
			await canonical(dirname(file));
			const stat = await lstat(file);
			if (
				!stat.isFile() ||
				stat.nlink !== 1 ||
				stat.ino !== entry.ino ||
				stat.dev !== entry.dev ||
				stat.mtimeMs !== entry.mtimeMs
			)
				throw new Error("artifact-changed");
			await unlink(file);
			changed = true;
			removed++;
		}
		for (const dir of directories.reverse()) {
			const stat = await canonical(dir.path);
			if (stat.ino !== dir.ino || stat.dev !== dir.dev)
				throw new Error("artifact-changed");
			await rmdir(dir.path);
			changed = true;
		}
		return result(changed ? "purged" : "missing");
	} catch (error) {
		const allowed = new Set([
			"unsafe-directory",
			"unsafe-artifact",
			"invalid-limits",
			"artifact-limit",
			"artifact-changed",
		]);
		const message = error instanceof Error ? error.message : "";
		return result(
			changed ? "unknown" : "blocked",
			allowed.has(message) ? message : "artifact-io-error",
		);
	}
}
