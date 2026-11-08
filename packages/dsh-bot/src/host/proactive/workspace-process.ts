import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-sandbox-policy";

/** Fixed owner-approved argv, confined by the native Host provider. */
export async function runManagedCommand(
	ctx: Context,
	input: {
		command: string;
		args: string[];
		cwd: string;
		timeoutMs: number;
		signal: AbortSignal;
		stdin?: string;
		maxOutputBytes: number;
		started?(): Promise<void>;
	},
) {
	const runtime = ctx.get("subprocess"),
		sandbox = ctx.get("sandbox");
	if (!runtime || !sandbox)
		throw new Error("Native process confinement unavailable");
	input.signal.throwIfAborted();
	const timeout = AbortSignal.timeout(input.timeoutMs);
	const signal = AbortSignal.any([input.signal, timeout]);
	const executable = await runtime.resolveExecutable(
		input.command,
		undefined,
		signal,
	);
	const confined = await sandbox.confine(
		[executable, ...input.args],
		{
			mode: "workspace-write",
			workspaceRoot: input.cwd,
		},
		signal,
	);
	if (confined.enforcement !== "full")
		throw new Error("Complete native file confinement required");
	signal.throwIfAborted();
	await input.started?.();
	signal.throwIfAborted();
	const handle = runtime.spawn({
		argv: confined.argv,
		cwd: input.cwd,
		signal,
		graceMs: 500,
		env: {
			...Object.fromEntries(
				Object.keys(process.env).map((key) => [key, undefined]),
			),
			LANG: "C",
		},
		stdio: {
			stdin: input.stdin === undefined ? "ignore" : { data: input.stdin },
			stdout: { maxBytes: input.maxOutputBytes },
			stderr: { maxBytes: input.maxOutputBytes },
		},
	});
	let stopped = false;
	let failure: unknown;
	let failed = false;
	let output:
		| {
				exitCode: number | null;
				signal: NodeJS.Signals | null;
				stdout: string;
				stderr: string;
				outputTruncated: boolean;
				timedOut: boolean;
				cancelled: boolean;
		  }
		| undefined;
	try {
		const result = await handle.done;
		const stdout = handle.collected.stdout?.readFrom(0),
			stderr = handle.collected.stderr?.readFrom(0);
		if (!stdout || !stderr) throw new Error("Process evidence unavailable");
		output = {
			exitCode: result.exitCode,
			signal: result.signal,
			stdout: stdout.text,
			stderr: stderr.text,
			outputTruncated: stdout.lossy || stderr.lossy,
			timedOut: timeout.aborted,
			cancelled: input.signal.aborted,
		};
	} catch (error) {
		failed = true;
		failure = error;
	} finally {
		handle.terminate();
		stopped = await handle
			.waitForExit(AbortSignal.timeout(2000))
			.catch(() => false);
	}
	if (!stopped) throw new Error("Native process range is still active");
	if (failed) throw failure;
	if (!output) throw new Error("Process outcome unavailable");
	return output;
}
