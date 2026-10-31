// Process-level defense in depth, not an OS sandbox. Installed before any evaluation adapter is imported.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import dgram from 'node:dgram';
import child from 'node:child_process';
import workers from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
export const counters = { network: 0, dns: 0, subprocess: 0, blocked: { network: 0, dns: 0, subprocess: 0 } };
function deny(kind) { return () => { counters.blocked[kind]++; throw Error(`EVAL_OFFLINE_BLOCKED:${kind}`); }; }
net.Socket.prototype.connect = deny('network'); net.connect = net.createConnection = deny('network');
net.Server.prototype.listen = deny('network');
for (const module of [http, https]) for (const name of ['request', 'get']) module[name] = deny('network');
http2.connect = deny('network'); dgram.createSocket = deny('network');
for (const module of [dns, dnsPromises]) for (const name of Object.keys(module))
  if (/^(lookup|resolve|reverse)/.test(name) && typeof module[name] === 'function') module[name] = deny('dns');
for (const Resolver of [dns.Resolver, dnsPromises.Resolver]) for (const name of Object.getOwnPropertyNames(Resolver.prototype))
  if (/^(resolve|reverse)/.test(name)) Resolver.prototype[name] = deny('dns');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[name] = deny('subprocess');
globalThis.fetch = deny('network'); globalThis.WebSocket = deny('network');
workers.Worker = deny('subprocess');
syncBuiltinESMExports();
