#!/usr/bin/env node
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(args.length, 3); assert.equal(args[0], '--suite'); assert.equal(args[2], '--mock-only');
if (['release-upgrade', 'lifecycle'].includes(args[1])) await import('./release.mjs');
else if (args[1] === 'spike') await import('./host-spike.mjs');
else if (['trusted-ingress', 'confirm'].includes(args[1])) await import('./host-b6a.mjs');
else if (['message-egress', 'group-egress', 'delegate-egress', 'notify-egress', 'mcp-egress', 'auto-share', 'redteam']
  .includes(args[1])) await import('./host-b6b.mjs');
else if (args[1] === 'performance') await import('./performance.mjs');
else if (['history', 'copy-cleanup', 'forget', 'forget-matrix'].includes(args[1])) await import('./host-b4.mjs');
else {
  assert.ok(['fence', 'admission', 'migration', 'migration-rollback'].includes(args[1]), 'Unknown mock Host suite');
  await import('./host-b3.mjs');
}
