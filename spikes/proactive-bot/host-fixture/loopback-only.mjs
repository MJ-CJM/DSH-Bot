// Loaded before the fresh CLI starts. Block TCP outside the fixture's IPv4
// loopback and prevent Unix socket and UDP egress in the Host process.
import net from 'node:net';
import dgram from 'node:dgram';
import { appendFileSync } from 'node:fs';

const file = process.env.PB00_EGRESS_LOG;
function denied(protocol) {
  if (file) appendFileSync(file, `${protocol}\n`);
  throw new Error('PB00 fixture blocks non-loopback egress');
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === 'object' && first !== null
    ? (first.path === undefined ? first.host : undefined)
    : typeof first === 'number' ? args[1] : undefined;
  if (host !== '127.0.0.1') denied('tcp-or-local-socket');
  return Reflect.apply(connect, this, args);
};
dgram.Socket.prototype.send = () => denied('udp');
dgram.Socket.prototype.connect = () => denied('udp');
