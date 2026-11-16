import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const inject = ['clientModules'];

/** Test-only Host observer. No sessions, model calls, or registration overrides. */
export function apply(ctx, config) {
  const repository = process.cwd(), output = resolve(config.output), expected = resolve(config.package);
  assert.ok(output.startsWith(`${repository}/.dsh-dev/`));
  assert.ok(expected.startsWith(`${repository}${sep}`));
  let stopped = false, timer;
  ctx.effect(() => () => { stopped = true; clearTimeout(timer); }, 'profile compatibility provenance');
  let attempts = 0;
  const observe = async () => {
    if (stopped) return;
    try {
      const entries = [...ctx.loader.entries()];
      const paths = {};
      for (const name of ['shortcuts', 'ui-chat', 'ui-workspace']) {
        const canonical = `@deepseek-ai/dsh-client-${name}`;
        const entryId = config.canonicalIds || name === 'ui-chat' && config.chatNativeId ? name : `dsh-bot-compat-${name}`;
        const entry = entries.find(row => row.options.id === entryId);
        assert.ok(entry?.fiber && !entry.disabled, `Adapted Host entry inactive: ${name}`);
        const original = entries.find(row => row.options.id === name);
        assert.ok(config.canonicalIds || name === 'ui-chat' && config.chatNativeId || !original || original.disabled, `Original source is still active: ${name}`);
        const actual = ctx.clientModules.clientPath(canonical);
        assert.equal(actual, resolve(expected, 'adapters', name, 'lib/client.js'));
        paths[canonical] = { hostEntry: entry.options.name, clientPath: actual };
      }
      const settings = ctx.get('settings');
      const settingsForms = settings?.describe({ redactSecrets: true }).filter(row => ['ui-chat', 'dsh-bot-compat-ui-chat'].includes(row.ns))
        .map(({ ns, value, user, base }) => ({ ns, value, user, base })) ?? [];
      let settingsRoundtrip;
      if (config.chatNativeId || config.canonicalIds) {
        const before = settings.describe().find(row => row.ns === 'ui-chat');
        assert.ok(before, 'Original Chat settings namespace must be available');
        const original = before.value.performanceUsage;
        const changed = original === 'detailed' ? 'compact' : 'detailed';
        await settings.update('ui-chat', { performanceUsage: changed }, before.revision);
        assert.equal(settings.describe().find(row => row.ns === 'ui-chat').value.performanceUsage, changed);
        await settings.update('ui-chat', { performanceUsage: original });
        assert.equal(settings.describe().find(row => row.ns === 'ui-chat').value.performanceUsage, original);
        settingsRoundtrip = { namespace: 'ui-chat', before: original, changed, restored: original };
      }
      await mkdir(output, { recursive: true });
      await writeFile(resolve(output, 'host-provenance.json'), JSON.stringify({ status: 'PASS', paths, settingsForms, settingsRoundtrip, sessionsCreatedByProbe: 0 }, null, 2));
      console.log('BOT_PROFILE_COMPAT_READY');
    } catch (error) {
      if (++attempts < 80 && !stopped) { timer = setTimeout(() => { void observe(); }, 100); return; }
      await mkdir(output, { recursive: true });
      await writeFile(resolve(output, 'host-provenance.json'), JSON.stringify({ status: 'FAIL', error: String(error) }, null, 2));
      console.error('BOT_PROFILE_COMPAT_FAILED', String(error));
    }
  };
  timer = setTimeout(() => { void observe(); }, 100);
}
