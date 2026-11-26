export function resolveLocale(locale: string | undefined): string | undefined {
  if (!locale || locale === 'activity.locale') return undefined;
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

export function formatList(items: readonly string[], locale: string | undefined): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  const resolved = resolveLocale(locale);
  try {
    return new Intl.ListFormat(resolved, { style: 'short', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

export function formatDateTime(value: number | string | Date, locale: string | undefined, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  const resolved = resolveLocale(locale);
  return options ? new Intl.DateTimeFormat(resolved, options).format(date) : date.toLocaleString(resolved);
}

export function formatNumber(value: number, locale: string | undefined, options?: Intl.NumberFormatOptions): string {
  const resolved = resolveLocale(locale);
  return options ? new Intl.NumberFormat(resolved, options).format(value) : value.toLocaleString(resolved);
}
