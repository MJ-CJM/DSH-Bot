/** Persistent radix tree: a commit copies at most eight 16-way nodes, never all live records. */
type Node<V> = { readonly children?: readonly (Node<V> | undefined)[]; readonly items?: readonly [string, V][] };
function hash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}
function edit<V>(node: Node<V> | undefined, key: string, value: V | undefined, remove: boolean, h: number, depth = 0): Node<V> {
  if (depth === 8) {
    const items = (node?.items ?? []).filter(([k]) => k !== key);
    if (!remove) items.push([key, value as V]);
    items.sort(([a], [b]) => a.localeCompare(b));
    return Object.freeze({ items: Object.freeze(items.map(item => Object.freeze(item) as [string, V])) });
  }
  const index = (h >>> (depth * 4)) & 15, children = [...(node?.children ?? [])];
  children[index] = edit(children[index], key, value, remove, h, depth + 1);
  return Object.freeze({ children: Object.freeze(children) });
}
function* entries<V>(node?: Node<V>): Generator<[string, V]> {
  if (node?.items) for (const [key, value] of node.items) yield [key, value];
  if (node?.children) for (const child of node.children) yield* entries(child);
}
export class PersistentMap<V> implements ReadonlyMap<string, V> {
  constructor(private readonly root?: Node<V>, readonly size = 0) { Object.freeze(this); }
  get(key: string): V | undefined {
    const h = hash(key); let node = this.root;
    for (let depth = 0; depth < 8 && node; depth++) node = node.children?.[(h >>> (depth * 4)) & 15];
    return node?.items?.find(([k]) => k === key)?.[1];
  }
  has(key: string): boolean { return this.get(key) !== undefined; }
  with(key: string, value: V): PersistentMap<V> {
    return new PersistentMap(edit(this.root, key, value, false, hash(key)), this.size + Number(!this.has(key)));
  }
  without(key: string): PersistentMap<V> {
    return this.has(key) ? new PersistentMap(edit(this.root, key, undefined, true, hash(key)), this.size - 1) : this;
  }
  entries(): MapIterator<[string, V]> { return entries(this.root); }
  *keys(): MapIterator<string> { for (const [key] of this) yield key; }
  *values(): MapIterator<V> { for (const [, value] of this) yield value; }
  [Symbol.iterator](): MapIterator<[string, V]> { return this.entries(); }
  readonly [Symbol.toStringTag] = 'PersistentMap';
  forEach(callback: (value: V, key: string, map: ReadonlyMap<string, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
  set(): never { throw new Error('Published memory snapshot is immutable'); }
  delete(): never { throw new Error('Published memory snapshot is immutable'); }
  clear(): never { throw new Error('Published memory snapshot is immutable'); }
}
export class PersistentSet implements ReadonlySet<string> {
  constructor(private readonly map = new PersistentMap<true>()) { Object.freeze(this); }
  get size(): number { return this.map.size; }
  has(value: string): boolean { return this.map.has(value); }
  with(value: string): PersistentSet { return new PersistentSet(this.map.with(value, true)); }
  values(): SetIterator<string> { return this.map.keys(); }
  keys(): SetIterator<string> { return this.values(); }
  *entries(): SetIterator<[string, string]> { for (const value of this) yield [value, value]; }
  [Symbol.iterator](): SetIterator<string> { return this.values(); }
  readonly [Symbol.toStringTag] = 'PersistentSet';
  forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const value of this) callback.call(thisArg, value, value, this);
  }
  add(): never { throw new Error('Published memory snapshot is immutable'); }
  delete(): never { throw new Error('Published memory snapshot is immutable'); }
  clear(): never { throw new Error('Published memory snapshot is immutable'); }
}
