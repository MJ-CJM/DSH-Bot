import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	digestSchema,
	protocolVersion,
	replySchema,
	type Reply,
	type RequestBody,
} from "../../shared/proactive/protocol.js";
import { frame, frames } from "./wire.js";

const bundle = new URL("../../proactive-coordinator/", import.meta.url);
const provenanceSchema = z.strictObject({
	revision: z.string().regex(/^[a-f0-9]{40}$/),
	files: z.strictObject({ "main.mjs": digestSchema, "core.mjs": digestSchema }),
});

async function checkBundle() {
	const manifest = provenanceSchema.parse(
		JSON.parse(await readFile(new URL("provenance.json", bundle), "utf8")),
	);
	for (const [name, expected] of Object.entries(manifest.files)) {
		const actual = createHash("sha256")
			.update(await readFile(new URL(name, bundle)))
			.digest("hex");
		if (actual !== expected)
			throw new Error("Proactive coordinator bundle integrity mismatch");
	}
}

interface Pending {
	resolve(reply: Reply): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export class CoordinatorClient {
	readonly #pending = new Map<string, Pending>();
	#closed = false;
	#closing?: Promise<void>;
	readonly #reader: Promise<void>;

	private constructor(
		readonly process: SubprocessHandle,
		readonly channel: string,
		readonly timeoutMs: number,
	) {
		const { stdin, stdout } = process;
		if (!stdin || !stdout) throw new Error("Proactive IPC unavailable");
		stdin.on("error", this.#onPipeError);
		this.#reader = this.read(stdout);
		void process.done.then(
			() => this.breakChannel(),
			() => this.breakChannel(),
		);
	}

	static async launch(
		runtime: Context["subprocess"],
		node: string,
		stateDir: string,
		cwd: string,
		timeoutMs: number,
	) {
		await checkBundle();
		const executable = await runtime.resolveExecutable(
			node,
			undefined,
			AbortSignal.timeout(timeoutMs),
		);
		const channel = randomBytes(32).toString("hex");
		const unset = Object.fromEntries(
			Object.keys(process.env).map((key) => [key, undefined]),
		);
		const handle = runtime.spawn({
			argv: [executable, fileURLToPath(new URL("main.mjs", bundle)), stateDir],
			cwd,
			env: { ...unset, LANG: "C", DSH_BOT_IPC_KEY: channel },
			stdio: { stdin: "pipe", stdout: "pipe", stderr: { maxBytes: 2048 } },
			graceMs: 500,
		});
		try {
			return new CoordinatorClient(handle, channel, timeoutMs);
		} catch (error) {
			void handle.done.catch(() => {});
			handle.terminate();
			await handle.waitForExit(AbortSignal.timeout(timeoutMs));
			throw error;
		}
	}

	get available() {
		return !this.#closed;
	}

	private async read(stdout: NonNullable<SubprocessHandle["stdout"]>) {
		try {
			for await (const data of frames(stdout)) {
				const reply = replySchema.parse(data);
				const pending = this.#pending.get(reply.correlationId);
				if (!pending) throw new Error("Uncorrelated proactive IPC response");
				clearTimeout(pending.timer);
				this.#pending.delete(reply.correlationId);
				pending.resolve(reply);
			}
		} catch {
			this.process.terminate();
		} finally {
			this.breakChannel();
		}
	}

	readonly #onPipeError = () => {
		this.breakChannel();
		this.process.terminate();
	};
	private breakChannel() {
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Proactive response unknown"));
		}
		this.#pending.clear();
	}

	request(body: RequestBody): Promise<Reply> {
		if (this.#closed || this.#pending.size >= 16)
			return Promise.reject(new Error("Proactive channel unavailable"));
		const correlationId = randomUUID();
		const data = frame({
			...body,
			protocolVersion,
			correlationId,
			channel: this.channel,
		});
		return new Promise((resolve, reject) => {
			const timer = setTimeout(this.#onPipeError, this.timeoutMs);
			this.#pending.set(correlationId, { resolve, reject, timer });
			try {
				this.process.stdin?.write(data, (error) => {
					if (error) this.#onPipeError();
				});
			} catch {
				this.#onPipeError();
			}
		});
	}

	close(storeId?: string): Promise<void> {
		this.#closing ??= (async () => {
			if (storeId && !this.#closed)
				await this.request({ kind: "shutdown", storeId }).catch(
					() => undefined,
				);
			this.breakChannel();
			this.process.stdin?.end();
			if (!(await this.process.waitForExit(AbortSignal.timeout(800)))) {
				this.process.terminate();
				if (
					!(await this.process.waitForExit(AbortSignal.timeout(this.timeoutMs)))
				)
					throw new Error("Proactive coordinator failed to exit");
			}
			await this.#reader;
			this.process.stdin?.off("error", this.#onPipeError);
		})();
		return this.#closing;
	}
}
