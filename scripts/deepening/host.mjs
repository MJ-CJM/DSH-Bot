#!/usr/bin/env node
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(args.length, 3); assert.equal(args[0], '--suite'); assert.equal(args[2], '--mock-only');
if (args[1] === 'spike') await import('./host-spike.mjs');
else if (['history', 'copy-cleanup', 'forget', 'forget-matrix'].includes(args[1])) await import('./host-b4.mjs');
else {
  assert.ok(['fence', 'admission', 'migration', 'migration-rollback'].includes(args[1]), 'Unknown mock Host suite');
  await import('./host-b3.mjs');
}
