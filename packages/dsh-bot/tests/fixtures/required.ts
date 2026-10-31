export function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Expected initialized test resource');
  return value;
}
