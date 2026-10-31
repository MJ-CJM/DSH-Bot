import { rm } from 'node:fs/promises';
// tsc does not remove output for retired source files. Never ship an old scheduler.
await rm(new URL('../lib/', import.meta.url), { recursive: true, force: true });
