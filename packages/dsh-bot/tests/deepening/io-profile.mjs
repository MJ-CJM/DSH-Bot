import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
const active = process.env.DSH_BOT_PERF_PROFILE === '1';
export const ioProfile = { fileSync: [], directorySync: [], leaseSync: [], payloadPut: [], opPut: [] };
if (active) {
  const open = fs.open;
  // Diagnostic only: retain native file handles, writes, fsyncs, rename and directory fsync ordering.
  fs.open = async (...args) => {
    const handle = await open(...args), sync = handle.sync.bind(handle);
    handle.sync = async () => {
      const start = performance.now();
      try { return await sync(); }
      finally {
        const field = String(args[0]).endsWith('.tmp') ? 'fileSync' : args[1] === 'r' ? 'directorySync' : 'leaseSync';
        ioProfile[field].push(performance.now() - start);
      }
    };
    return handle;
  };
  syncBuiltinESMExports();
}
export function profileTables(kernel) {
  if (!active) return;
  for (const [name, field] of [['payloads', 'payloadPut'], ['ops', 'opPut']]) {
    const table = kernel.domain.table(name), put = table.put.bind(table);
    table.put = async (...args) => {
      const start = performance.now();
      try { return await put(...args); } finally { ioProfile[field].push(performance.now() - start); }
    };
  }
}
