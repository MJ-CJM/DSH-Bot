#!/usr/bin/env node
// Reuse the formal screenshot implementation and its package-local dependencies.
if (process.argv.includes('--v03')) await import('../packages/dsh-bot/scripts/screenshot-v03.mjs');
else await import('../packages/dsh-bot/scripts/screenshot.mjs');
