import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

// Check whitespace without rewriting historical source or Markdown hard breaks.
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0'))]
  // Vendored upstream bytes are separately verified against pin.json during
  // the coordinator build; local whitespace normalization would break that pin.
  .filter(file => file && !file.startsWith('.codex/') && !file.startsWith('packages/dsh-bot/coordinator/vendor/') && (/\.(?:[cm]?[jt]sx?|json|ya?ml|css|sh|md)$/.test(file) || ['scripts/pnpm', 'scripts/dsh'].includes(file)));
const issues = [];
for (const file of files) {
  let content;
  try { content = readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') continue; // A staged deletion has no worktree text.
    throw error;
  }
  const markdown = extname(file) === '.md';
  content.split('\n').forEach((line, index) => {
    const trailing = line.match(/[ \t\r]+$/)?.[0];
    if (trailing && !(markdown && trailing === '  ' && line.trim().length)) {
      issues.push(`${file}:${index + 1}: trailing whitespace`);
    }
  });
  if (content && !content.endsWith('\n')) issues.push(`${file}: missing final newline`);
  if (content.endsWith('\n\n')) issues.push(`${file}: extra blank line at end of file`);
}
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`PASS: whitespace checks (${files.length} text files; Markdown hard breaks preserved)`);
}
