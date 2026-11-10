import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

function fileIdentity(path: string) {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return undefined;
	if (!stat.isFile() || stat.nlink !== 1)
		throw new Error("Unsafe proactive database path");
	return `${stat.dev}:${stat.ino}`;
}

export function ownState(path: string) {
	const root = resolve(path);
	if (realpathSync(dirname(root)) !== dirname(root))
		throw new Error("Unsafe proactive state parent");
	mkdirSync(root, { mode: 0o700, recursive: true });
	return lockState(root);
}

function lockState(root: string) {
	const directory = lstatSync(root);
	if (
		!directory.isDirectory() ||
		realpathSync(root) !== root ||
		(directory.mode & 0o077) !== 0
	)
		throw new Error("Unsafe proactive state directory");
	const lockPath = join(root, "ownership.sqlite");
	const before = fileIdentity(lockPath);
	const lock = new DatabaseSync(lockPath);
	try {
		lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    // Reserved maintenance copies belong to this store. A killed rehearsal must
    // not leave a body outside the next forget/normal-start lifecycle.
    const rehearsal = join(root, '.maintenance-rehearsal');
    const savedRehearsal = lstatSync(rehearsal, { throwIfNoEntry: false });
    if (savedRehearsal) {
      if (!savedRehearsal.isDirectory() || savedRehearsal.isSymbolicLink() || realpathSync(rehearsal) !== rehearsal) throw new Error('Unsafe maintenance snapshot');
      rmSync(rehearsal, { recursive: true });
    }
		const identity = fileIdentity(lockPath);
		if (!identity || (before && before !== identity))
			throw new Error("Proactive ownership path changed");
		const storePath = join(root, "core.sqlite");
		const prior = fileIdentity(storePath);
		for (const suffix of ["-wal", "-shm", "-journal"])
			fileIdentity(`${storePath}${suffix}`);
		const assertPaths = (storeIdentity: string | undefined) => {
			const now = lstatSync(root);
			if (
				now.dev !== directory.dev ||
				now.ino !== directory.ino ||
				realpathSync(root) !== root ||
				fileIdentity(lockPath) !== identity ||
				fileIdentity(storePath) !== storeIdentity
			)
				throw new Error("Proactive state ownership lost");
		};
		assertPaths(prior);
		return {
			storePath,
			storeExists: prior !== undefined,
			bindStore() {
				const current = fileIdentity(storePath);
				if (!current || (prior && current !== prior))
					throw new Error("Proactive store path changed");
				return () => assertPaths(current);
			},
			close: () => lock.close(),
		};
	} catch (error) {
		lock.close();
		throw error;
	}
}
