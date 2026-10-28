import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function checkpoint(config, detail) {
  const file = await open(resolve(config.outputDir, 'barrier.json'), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ nonce: config.nonce, pid: process.pid, window: config.window,
      durableCheckpoint: true, ...detail }, null, 2)); await file.sync();
  } finally { await file.close(); }
  console.log(`DP_B7_BARRIER ${config.nonce}`);
  // This must remain suspended until the PARENT sends SIGKILL. No throw, exit or graceful disposal.
  await new Promise(() => { setInterval(() => {}, 1000); });
}
export function afterPut(table, predicate, pause) {
  const put = table.put.bind(table); let armed = true;
  table.put = async (key, value) => {
    await put(key, value);
    if (armed && predicate(key, value)) { armed = false; await pause(key, value); }
  };
  return () => { table.put = put; };
}
