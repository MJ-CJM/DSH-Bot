import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const root = new URL('../', import.meta.url), lib = new URL('lib/', root);
const { version } = JSON.parse(await readFile(new URL('package.json', root)));
const entry = await readFile(new URL('index.js', lib), 'utf8');
assert.ok(entry.includes(`VERSION = '${version}'`), 'Bootstrap/manifest version mismatch');
assert.ok((await readFile(new URL('shared/version.js', lib), 'utf8')).includes(`'${version}'`));
const files = {};
async function visit(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, item.name);
    if (item.isDirectory()) await visit(path);
    else if (item.name.endsWith('.js') && item.name !== 'client.js') {
      const name = relative(new URL('.', lib).pathname, path);
      if (name === 'index.js') continue;
      let source = await readFile(path, 'utf8');
      source += `\nexport const DSH_BOT_MODULE_VERSION = '${version}';\n`;
      await writeFile(path, source);
      files[name] = createHash('sha256').update(source).digest('hex');
    }
  }
}
await visit(new URL('.', lib).pathname);
await writeFile(new URL('module-manifest.json', lib), `${JSON.stringify({ version, files }, null, 2)}\n`);
console.log(`Stamped ${Object.keys(files).length} Host modules (${version})`);
