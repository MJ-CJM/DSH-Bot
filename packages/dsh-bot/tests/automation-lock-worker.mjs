import { acquireHostLease } from '../lib/host/automation/lock.js';
const lease = await acquireHostLease(process.argv[2]);
process.send({ writable: lease.writable, reason: lease.reason, identity: lease.identity });
if (!lease.writable) process.disconnect();
else process.on('message', async message => {
  if (message === 'release') { await lease.release(); process.disconnect(); }
});
