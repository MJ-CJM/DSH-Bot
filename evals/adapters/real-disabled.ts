export function realDisabled(): never {
  throw new Error('Real evaluation is disabled; no endpoint or authorization is read');
}
