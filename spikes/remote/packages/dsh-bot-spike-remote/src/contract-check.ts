/** Compile-time signatures plus real service/descriptor codec parity. */
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import { DshBots } from './index.js';
import { listResult, type ListMethod, type ListResult } from './contract.js';
import remote from './typert.remote-client.js';
import { TYPERT } from './typert.host.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const hostSignature: Equal<DshBots['list'], ListMethod> = true;
const clientSignature: Equal<TypertRemoteNamespaceMap['dshBot']['list'], () => Promise<RemoteResult<ListResult>>> = true;
assert.ok(hostSignature && clientSignature);
const ctx = new Context();
try {
  const service = new DshBots(ctx);
  const rows = await service.list();
  const descriptor = TYPERT.invocations[0];
  assert.ok(descriptor);
  assert.equal(descriptor, remote.descriptors[0]);
  assert.equal(descriptor.service, 'dshBots');
  assert.equal(descriptor.namespace, 'dshBot');
  assert.equal(descriptor.method, 'list');
  assert.deepEqual(descriptor.parameters, []);
  const codec = descriptor.result;
  assert.equal(codec.mode, 'strict');
  if (codec.mode !== 'strict') throw new Error('Expected strict codec');
  assert.deepEqual(codec.create().parse(rows), listResult.parse(rows));
  assert.throws(() => codec.create().parse([{ id: 1, name: 'invalid' }]));
  assert.throws(() => codec.create().parse([{ id: 'x', name: 'x', unexpected: true }]));
  console.log('PASS shared spec: Host signature, Client signature, descriptor, valid result, invalid result rejection');
} finally { await ctx.fiber.dispose(); }
