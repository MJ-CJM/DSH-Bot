// Test process guard. This is an outbound endpoint allowlist, not an OS sandbox.
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const port = process.env.DP_MOCK_PORT;
const receipt = process.env.DP_NETWORK_RECEIPT;
function deny(target) {
  if (receipt) appendFileSync(receipt, `${JSON.stringify({ target, blocked: true })}\n`);
  throw Error('DP_NETWORK_BLOCKED');
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const normalized = typeof first === 'object' ? first : typeof first === 'number'
    ? { port: first, host: typeof values[1] === 'string' ? values[1] : undefined } : { path: first };
  const host = normalized.host ?? 'localhost';
  if (normalized.path || host !== '127.0.0.1' || String(normalized.port) !== port) deny({ host, port: normalized.port });
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== port) deny({ url: url.origin });
  return fetch(input, { ...init, redirect: 'error' });
};
syncBuiltinESMExports();

globalThis[Symbol.for('dp.loopback.guard')] = true;
