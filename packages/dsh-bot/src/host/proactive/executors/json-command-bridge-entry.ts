import { runJsonCommandBridge } from "./json-command-bridge.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, realpathSync } from "node:fs";

// Host version checks may import every shipped module. Execute only as the CLI.
if (
	process.argv[1] &&
	existsSync(resolve(process.argv[1])) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	const stop = new AbortController();
	const cancel = () => stop.abort(new Error("JSON command bridge cancelled"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		if (process.argv.length !== 3)
			throw new Error("Expected one JSON configuration argument");
		const result = await runJsonCommandBridge(
			JSON.parse(process.argv[2] ?? ""),
			process.stdin,
			stop.signal,
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch {
		process.stderr.write(
			"DSH JSON command bridge failed: invalid input, incomplete output, cancellation or command error.\n",
		);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}
