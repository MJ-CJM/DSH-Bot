import { expect, test } from 'vitest';
import { observeGithubCi, githubCiSchema } from '../src/host/proactive/sources/github-ci.js';
import { observeCiPage } from '../src/host/proactive/sources/ci.js';
import { proactiveWorker } from './proactive-worker-fixture.js';
const scope = { repository: 'fixture/repo', branch: 'main', generation: 1 };
const config = githubCiSchema.parse({ credentialRef: 'fixture-token', since: '2026-01-01T00:00:00Z' });
const observedAt = new Date().toISOString();
const run = (id: number, attempt = 1) => ({ id, run_attempt: attempt, workflow_id: 7,
  head_branch: 'main', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure',
  updated_at: observedAt, created_at: '2026-11-01T00:00:00Z', repository: { full_name: scope.repository } });

test('GitHub pagination, replay, rerun and restart cursor use the existing observation core without work', async () => {
  const worker = await proactiveWorker();
  const requests: string[] = [];
  let attempt = 1;
  const service = {
    ciCheckpoint: async () => { const result = await worker.read({ kind: 'checkpoint', sourceId: observeCiPage(scope, { complete: true, before: null, after: 'x', rows: [] }).sourceId }); if (result.kind !== 'checkpoint') throw new Error(); return result.source; },
    observeCi: (id: string, s: typeof scope, page: Parameters<typeof observeCiPage>[1]) => worker.change(id, observeCiPage(s, page)),
  };
  const request: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); requests.push(url.toString());
    expect(url.origin).toBe('https://api.github.com'); expect(options?.method).toBe('GET'); expect(options?.redirect).toBe('error');
    const page = Number(url.searchParams.get('page'));
    const all = Array.from({ length: 35 }, (_, i) => run(i + 1, i === 0 ? attempt : 1)).reverse();
    return Response.json({ total_count: 35, workflow_runs: all.slice((page - 1) * 32, page * 32) });
  };
  try {
    await observeGithubCi(scope, config, service, new AbortController().signal, async () => 'synthetic-secret', request);
    const cursor = (await service.ciCheckpoint())?.checkpoint;
    const before = await worker.read({ kind: 'snapshot' });
    await observeGithubCi(scope, config, service, new AbortController().signal, async () => 'synthetic-secret', request);
    expect((await service.ciCheckpoint())?.checkpoint).toBe(cursor);
    expect(await worker.read({ kind: 'snapshot' })).toMatchObject({ kind: 'snapshot', snapshot: { ticketCount: 0, triggerCount: 35 } });
    expect(before).toMatchObject({ kind: 'snapshot', snapshot: { ticketCount: 0 } });
    await worker.restart();
    expect((await service.ciCheckpoint())?.checkpoint).toBe(cursor);
    attempt = 2;
    await observeGithubCi(scope, config, { ...service }, new AbortController().signal, async () => 'synthetic-secret', request);
    expect((await service.ciCheckpoint())?.checkpoint).not.toBe(cursor);
    expect(requests).toHaveLength(6);
    const suggestions = await worker.read({ kind: 'suggestions' });
    expect(suggestions.kind === 'suggestions' && suggestions.suggestions.some(row => row.attempt === 2)).toBe(true);
    expect(await worker.read({ kind: 'work-list' })).toMatchObject({ kind: 'work-list', work: [] });
  } finally { await worker.close(); }
});

test.each(['rate-limit','network','scope','credential','partial','overflow','revoked'] as const)('GitHub %s never advances the cursor', async failure => {
  let commits = 0, calls = 0, credentialReads = 0;
  const service = {
    ciCheckpoint: async () => ({ generation: 1, checkpoint: null, ...(failure === 'revoked' ? { revoked: true as const } : {}) }),
    observeCi: async () => { commits++; throw new Error('unexpected commit'); },
  };
  const request: typeof fetch = async () => {
    calls++;
    if (failure === 'network') throw new Error('synthetic disconnect');
    if (failure === 'rate-limit') return new Response('', { status: 429 });
    const value = run(1); if (failure === 'scope') value.head_branch = 'other';
    return Response.json({ total_count: failure === 'overflow' ? 1001 : failure === 'partial' ? 33 : 1, workflow_runs: [value] });
  };
  await expect(observeGithubCi(scope, config, service, new AbortController().signal,
    async () => { credentialReads++; return failure === 'credential' && credentialReads > 2 ? undefined : 'synthetic'; }, request)).rejects.toThrow();
  expect(commits).toBe(0);
  if (failure === 'revoked') expect(calls).toBe(0);
});
