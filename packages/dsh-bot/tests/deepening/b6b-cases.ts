import type { Outlet } from '../../src/shared/managed-flow.js';
export const outlets: Outlet[] = ['message', 'group-input', 'group-result', 'delegate-input', 'delegate-result',
  'notify-record', 'notify-send', 'mcp-copy', 'connector', 'auto-share'];
export const attacks = ['private', 'secret', 'epoch', 'birth', 'payload', 'unknown'] as const;
export const pairs = outlets.flatMap((outlet, route) => attacks.map((attack, index) => ({
  id: `B6B-${String(route * 6 + index + 1).padStart(2, '0')}`, outlet, attack,
  attackExpectation: 'blocked', controlExpectation: outlet === 'auto-share' ? 'FAIL(capability)' : 'delivered',
  evidenceLevel: 'UNIT', source: 'synthetic',
})));
