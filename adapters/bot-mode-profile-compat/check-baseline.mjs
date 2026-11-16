import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCandidate } from '../../scripts/build-bot-mode-profile-compat.mjs';

/** Read-only check for a frozen compatibility package against an actual app. */
export async function checkBaseline(app, packagePath) {
  const expected = JSON.parse(await readFile(resolve(packagePath, 'compatibility.json'), 'utf8'));
  const actual = (await inspectCandidate(app)).identity;
  const mismatches = [];
  for (const key of ['version', 'archiveSha256']) if (actual[key] !== expected[key]) mismatches.push(key);
  for (const name of ['shortcuts', 'ui-chat', 'ui-workspace']) {
    for (const key of ['clientSha256', 'hostSha256']) if (actual.packages[name][key] !== expected.packages[name][key]) mismatches.push(`${name}.${key}`);
  }
  return { status: mismatches.length ? 'FAIL' : 'PASS', app: resolve(app), package: resolve(packagePath),
    expectedVersion: expected.version, actualVersion: actual.version, mismatches,
    scope: 'read-only baseline check; no deployment or automatic launch integration' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--app', '--package'].includes(args[i]) && args[i + 1], 'Use --app <actual app> --package <frozen package directory>');
    options[args[i].slice(2)] = args[i + 1];
  }
  assert.ok(options.app && options.package, 'Supply app and package');
  const result = await checkBaseline(options.app, options.package);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'FAIL') process.exitCode = 1;
}
