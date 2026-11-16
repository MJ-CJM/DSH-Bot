import { expect, it } from 'vitest';
import { Config, onlySupergroupChanged } from '../src/host/supergroup/config.js';
import { Config as RegistryConfig } from '../src/host/registry-config.js';
it('defaults to disabled and validates finite bounded integer budgets and exact candidate IDs', () => {
  expect(Config({})).toEqual({ enabled: false, maxMembers: 4, maxExperts: 16, maxRequests: 24, timeoutMs: 300000, allowedBotIds: [], taskMaterialMaxCount: 8, taskMaterialMaxChars: 16384, taskMaterialMaxTotalChars: 49152 });
  expect(RegistryConfig({ supergroup: { enabled: true } }).supergroup.enabled).toBe(true);
  for (const value of [{ maxMembers: 1 }, { maxRequests: 1.5 }, { timeoutMs: Infinity }, { allowedBotIds: ['alpha', 'alpha'] },
    { allowedBotIds: ['../private'] }, { maxExperts: 65 }]) expect(() => Config(value)).toThrow();
});
it('hot classification declines simultaneous unrelated edits', () => {
  const previous = { supergroup: Config({}), existing: { enabled: true } };
  expect(onlySupergroupChanged(previous, structuredClone(previous))).toBe(false);
  expect(onlySupergroupChanged(previous, { ...previous, supergroup: Config({ enabled: true }) })).toBe(true);
  expect(onlySupergroupChanged(previous, { ...previous, supergroup: Config({ enabled: true }), existing: { enabled: false } })).toBe(false);
});
