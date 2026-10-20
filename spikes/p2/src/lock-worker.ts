import { acquireLock } from './lock.js';
const path = process.argv[2];
if (!path) throw new Error('lock path required');
const lock = await acquireLock(path);
process.send?.({ owner: Boolean(lock), identity: lock?.identity });
if (!lock) process.exit(0);
process.on('message', async (message) => {
  if (message === 'release') { await lock.release(); process.exit(0); }
});
