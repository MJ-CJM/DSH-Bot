#!/usr/bin/env node
// Reuse the formal screenshot implementation and its package-local dependencies.
if (process.argv.includes('--v032')) {
  process.argv[2] = 'release';
  process.env.B2B_SCREENSHOTS = '1';
  const { resolve } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  process.env.DSH_BOT_E2E_DIR ??= resolve('.dsh-dev/b2b', `screenshots-${Date.now()}-${process.pid}`);
  await import('./b2b-runtime.mjs');
  if (!process.exitCode) {
    const result = JSON.parse(await readFile(resolve(process.env.DSH_BOT_E2E_DIR, 'screenshots.json'), 'utf8'));
    console.log(`v032 screenshots: ${result.status}${result.environment ? ' (environment)' : ''}`);
    if (result.status !== 'PASS') process.exitCode = 1;
  }
} else if (process.argv.includes('--v03')) await import('../packages/dsh-bot/scripts/screenshot-v03.mjs');
else await import('../packages/dsh-bot/scripts/screenshot.mjs');
