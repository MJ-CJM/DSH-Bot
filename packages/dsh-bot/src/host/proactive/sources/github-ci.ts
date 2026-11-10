import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ciPageSchema, type CiScope } from './ci.js';
import { digest } from '../wire.js';
import type { ProactiveService } from '../service.js';

export const githubCiSchema = z.strictObject({
  credentialRef: z.string().trim().min(1).max(512),
  since: z.iso.datetime(),
  maxRuns: z.number().int().min(1).max(1000).default(256),
  timeoutMs: z.number().int().min(1000).max(60000).default(15000),
});
export type GithubCi = z.output<typeof githubCiSchema>;
const runSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  run_attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workflow_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  head_branch: z.string(), head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.string(), conclusion: z.string().nullable(),
  updated_at: z.iso.datetime(), created_at: z.iso.datetime(),
  repository: z.object({ full_name: z.string() }),
});
const responseSchema = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(runSchema).max(32) });
type Service = Pick<ProactiveService, 'ciCheckpoint' | 'observeCi'>;

async function boundedJson(response: Response) {
  if (!response.ok || !response.body) throw new Error('CI provider unavailable');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('CI response too large');
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

/** A bounded complete sweep precedes ingestion. Only fixed GitHub GET endpoints
 * are reachable; native Credentials is resolved again before each request/commit.
 * No log, PR body, executable text or credential enters the task core. */
export async function observeGithubCi(scope: CiScope, config: GithubCi, service: Service,
  signal: AbortSignal, credential: () => Promise<string | undefined>, request: typeof fetch = fetch) {
  const initial = await service.ciCheckpoint(scope);
  const assertSource = async () => {
    signal.throwIfAborted();
    const current = await service.ciCheckpoint(scope);
    if (current && (current.generation > scope.generation || (current.generation === scope.generation && current.revoked))) throw new Error('CI source revoked');
    return current?.generation === scope.generation ? current.checkpoint : null;
  };
  const secret = await credential();
  if (!secret) throw new Error('CI credential unavailable');
  const check = async () => {
    await assertSource();
    if (await credential() !== secret) throw new Error('CI credential changed');
    signal.throwIfAborted();
  };
  const runs = new Map<number, z.output<typeof runSchema>>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    await check();
    const url = new URL(`https://api.github.com/repos/${scope.repository}/actions/runs`);
    url.searchParams.set('branch', scope.branch);
    url.searchParams.set('created', `>=${config.since}`);
    url.searchParams.set('per_page', '32'); url.searchParams.set('page', String(page));
    const response = await request(url, { method: 'GET', redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${secret}`, 'X-GitHub-Api-Version': '2026-03-10' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    });
    const body = responseSchema.parse(await boundedJson(response));
    if (body.total_count > config.maxRuns || (total !== undefined && total !== body.total_count)) throw new Error('CI sweep incomplete; narrow source window');
    total = body.total_count;
    for (const run of body.workflow_runs) {
      if (run.repository.full_name.toLowerCase() !== scope.repository.toLowerCase() || run.head_branch !== scope.branch || Date.parse(run.created_at) < Date.parse(config.since) || runs.has(run.id)) throw new Error('CI sweep scope or pagination changed');
      runs.set(run.id, run);
    }
    if (runs.size === total) break;
    if (body.workflow_runs.length !== 32 || page >= Math.ceil(config.maxRuns / 32)) throw new Error('CI sweep incomplete');
  }
  const rows = [...runs.values()].filter(run => run.status === 'completed' && ['failure','success','cancelled','timed_out','action_required','startup_failure','stale'].includes(run.conclusion ?? '')).map(run => ({
    repository: scope.repository, branch: scope.branch, runId: String(run.id),
    job: `workflow-${run.workflow_id}`, commit: run.head_sha, observedAt: run.updated_at,
    attempt: run.run_attempt,
    conclusion: run.conclusion === 'success' ? 'success' as const : run.conclusion === 'cancelled' ? 'cancelled' as const : 'failure' as const,
  })).sort((a,b) => a.observedAt.localeCompare(b.observedAt) || a.runId.localeCompare(b.runId));
  // Stable bodies retain native revision identity across reruns/restarts.
  const sweep = digest([scope, config.since, rows]);
  let checkpoint = initial?.generation === scope.generation ? initial.checkpoint : null;
  if (checkpoint === `github:${sweep}:done`) return;
  for (let offset = 0; offset < Math.max(rows.length, 1); offset += 32) {
    await check();
    const after = `github:${sweep}:${offset + 32 >= rows.length ? 'done' : offset + 32}`;
    // Replaying a partial sweep is safe: native IDs/revisions deduplicate in the existing core.
    if (checkpoint === after) continue;
    const page = ciPageSchema.parse({ complete: true, before: checkpoint, after, rows: rows.slice(offset, offset + 32) });
    const result = await service.observeCi(randomUUID(), scope, page);
    if (result.kind !== 'receipt' || !result.receipt || result.receipt.status !== 'committed' && result.receipt.status !== 'duplicate') throw new Error('CI page not committed');
    checkpoint = after;
  }
}
