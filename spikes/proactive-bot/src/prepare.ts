import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { upstreamSha, upstreamUrl, verifyUpstream, workspaceRoot } from './core/artifact.js';

const root = workspaceRoot();
const directory = join(root, '.dsh-dev/proactive-bot/upstream');
if (!existsSync(directory)) {
  mkdirSync(join(root, '.dsh-dev/proactive-bot'), { recursive: true });
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', upstreamUrl, directory], {
    cwd: root, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120_000,
  });
  execFileSync('git', ['-C', directory, 'checkout', '--detach', upstreamSha], {
    cwd: root, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120_000,
  });
}
// An existing snapshot is only verified. Never reset or overwrite a changed tree.
const manifest = verifyUpstream();
console.log(JSON.stringify({ upstreamSha: manifest.commit, clean: !manifest.status,
  license: manifest.metadata.license, source: directory }, null, 2));
