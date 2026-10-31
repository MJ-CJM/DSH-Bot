import { expect, it } from 'vitest';
import { PersistentMap } from '../../src/host/memory/persistent-map.js';

it('shares immutable snapshots without losing replacement, removal, iteration or hash collisions', () => {
  let tree = new PersistentMap<number>(); const expected = new Map<string, number>();
  for (let i = 0; i < 5000; i++) { tree = tree.with(`memory-${i}`, i); expected.set(`memory-${i}`, i); }
  const before = tree;
  for (let i = 0; i < 5000; i += 3) { tree = tree.without(`memory-${i}`); expected.delete(`memory-${i}`); }
  for (let i = 1; i < 5000; i += 3) { tree = tree.with(`memory-${i}`, -i); expected.set(`memory-${i}`, -i); }
  expect(before.size).toBe(5000); expect(before.get('memory-3')).toBe(3); expect(before.get('memory-4')).toBe(4);
  expect(tree.size).toBe(expected.size); expect(new Map(tree)).toEqual(expected);
  // FNV-1a collision; neither the collision bucket nor a replaced key may lose its neighbour.
  const collision = new PersistentMap().with('costarring', 1).with('liquid', 2);
  expect(collision.get('costarring')).toBe(1); expect(collision.get('liquid')).toBe(2);
  expect(collision.without('costarring').get('liquid')).toBe(2); expect(collision.size).toBe(2);
  expect(() => collision.clear()).toThrow('immutable');
});
