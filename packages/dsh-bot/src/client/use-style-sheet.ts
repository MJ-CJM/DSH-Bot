import { useEffect, useLayoutEffect } from 'react';

interface SheetEntry {
  element: HTMLStyleElement;
  count: number;
}

const sheets = new Map<string, SheetEntry>();

/** Ref-counted document.head stylesheet registry. Creates a single `<style>`
 * per stylesheet ID when the first consumer mounts and removes it when the
 * last consumer unmounts (including on plugin unload / hot reload).
 */
export function acquireStyleSheet(id: string, css: string): () => void {
  if (typeof document === 'undefined' || !document.head) return () => {};
  let entry = sheets.get(id);
  if (!entry) {
    const element = document.createElement('style');
    element.dataset.dshBotStyle = id;
    element.textContent = css;
    document.head.append(element);
    entry = { element, count: 0 };
    sheets.set(id, entry);
  } else if (entry.element.textContent !== css) {
    entry.element.textContent = css;
  }
  entry.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = sheets.get(id);
    if (current !== entry) return;
    entry.count--;
    if (entry.count <= 0) {
      entry.element.remove();
      sheets.delete(id);
    }
  };
}

const useIsomorphicLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

export function useStyleSheet(id: string, css: string, active = true): void {
  useIsomorphicLayoutEffect(() => {
    if (!active) return;
    return acquireStyleSheet(id, css);
  }, [id, css, active]);
}
