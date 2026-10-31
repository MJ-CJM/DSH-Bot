import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { Loader, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader';

const configPath = process.argv[2];
assert.ok(configPath);
const rows = JSON.parse(await readFile(configPath, 'utf8')) as EntryOptions[];
const ctx = new Context();
try {
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(configPath).href });
  for (const row of rows) await ctx.loader.create(row);
  await ctx.loader.await();
  assert.equal([...ctx.loader.entries()].length, 1);
} finally {
  await ctx.fiber.dispose();
}
console.log('T02_LOADER_FIXTURE_OK');
