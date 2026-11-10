#!/usr/bin/env node
// Check repository file links, without network access or generated/local evidence.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicPath = (name) => !name.startsWith('.') || name.startsWith('.github/');
const list = (args) => execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean).filter(publicPath);
// Include new, non-ignored public files so the check works before staging a PR.
const files = new Set([...list([]), ...list(['--others', '--exclude-standard'])]);
// Vendored prompt templates carry placeholder links, not repository navigation.
const markdown = [...files].filter((name) => /\.md$/i.test(name) &&
  !name.startsWith('packages/dsh-bot/coordinator/vendor/')).sort();
const failures = [];
let checked = 0;

function check(file, destination, offset, source) {
  destination = destination.replace(/^<|>$/g, '');
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) return;
  let target;
  try {
    target = decodeURIComponent(destination.split(/[?#]/, 1)[0]);
  } catch {
    target = destination;
  }
  if (!target) return;
  checked += 1;
  const resolved = path.resolve(root, path.dirname(file), target);
  const relative = path.relative(root, resolved).split(path.sep).join('/');
  const exists = existsSync(resolved) && !relative.startsWith('../') && !path.isAbsolute(relative)
    && (relative === '' || files.has(relative) || [...files].some((name) => name.startsWith(`${relative}/`)));
  if (!exists) {
    const line = source.slice(0, offset).split('\n').length;
    failures.push(`${file}:${line}: ${destination} (not a public repository file)`);
  }
}

for (const file of markdown) {
  const source = readFileSync(path.join(root, file), 'utf8');
  // Preserve offsets for diagnostics while skipping examples in fenced/inline code.
  const prose = source.replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm,
    (value) => value.replace(/[^\n]/g, ' '))
    .replace(/(`+)[^\n]*?\1/g, (value) => ' '.repeat(value.length));
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)\n]+)(?:\s+['"][^\n]*?['"])?\s*\)/g)) {
    check(file, match[1], match.index, source);
  }
  for (const match of prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm)) {
    check(file, match[1], match.index, source);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`FAIL: ${failures.length} invalid local links; ${checked} checked in ${markdown.length} Markdown files.`);
  process.exitCode = 1;
} else {
  console.log(`PASS: ${checked} local links in ${markdown.length} public Markdown files. External URLs and anchors are not checked.`);
}
