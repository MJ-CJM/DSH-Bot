// Execute the actual published browser closure; only its platform dependencies are supplied.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as cordis from '@deepseek-ai/cordis';
import * as react from 'react';
import * as jsx from 'react/jsx-runtime';
import * as primitives from './platform-primitives.js';
const require = createRequire(import.meta.url);
let exports: Record<string, unknown> = {};
const store = { createSnapshotStore<T>(initial: T) {
  let value = initial; const listeners = new Set<() => void>();
  return { getSnapshot: () => value, set(next: T) { value = next; for (const listener of listeners) listener(); }, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } };
} };
const platform: Record<string, unknown> = { '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-store': store, react, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-ui-primitives': primitives };
const window = { __ModuleLoader__: { load(entry: { factory(require: (id: string) => unknown): Record<string, unknown> }) { exports = entry.factory(id => { if (!(id in platform)) throw new Error(`Missing platform: ${id}`); return platform[id]; }); } } };
new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-input-trigger/client'), 'utf8'))(window);
export const InputTriggerController = exports.InputTriggerController;

export const InputTriggerService = exports.InputTriggerService;
