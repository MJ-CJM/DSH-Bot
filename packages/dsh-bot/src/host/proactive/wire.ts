import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { maxFrameBytes } from "../../shared/proactive/protocol.js";

/** Commands are parsed to strict JSON data before hashing. Sort keys at every depth. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
export function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

export function frame(value: unknown): string {
	const data = JSON.stringify(value);
	if (Buffer.byteLength(data) > maxFrameBytes)
		throw new Error("Proactive IPC frame exceeds limit");
	return `${data}\n`;
}

/** Bound bytes before parsing and keep complete UTF-8 characters across chunks. */
export async function* frames(stream: Readable): AsyncGenerator<unknown> {
	let pending = Buffer.alloc(0);
	for await (const part of stream) {
		const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
		let start = 0;
		for (
			let end = chunk.indexOf(10, start);
			end !== -1;
			end = chunk.indexOf(10, start)
		) {
			const line = chunk.subarray(start, end);
			if (pending.length + line.length > maxFrameBytes)
				throw new Error("Proactive IPC frame exceeds limit");
			yield JSON.parse(Buffer.concat([pending, line]).toString("utf8"));
			pending = Buffer.alloc(0);
			start = end + 1;
		}
		const rest = chunk.subarray(start);
		if (pending.length + rest.length > maxFrameBytes)
			throw new Error("Proactive IPC frame exceeds limit");
		pending = Buffer.concat([pending, rest]);
	}
	if (pending.length) throw new Error("Proactive IPC frame ended early");
}
