import { expect, test } from 'vitest';

// Dynamic public-root import preserves the real published-package failure if
// its own transitive imports are unavailable to external consumers.
test('published client runtime creates and disposes a production slot bench', async () => {
  const { SlotTestRuntime } = await import('@deepseek-ai/dsh-client-test-runtime');
  const runtime = await SlotTestRuntime.create();
  try {
    expect(runtime.ctx.get('slots')).toBe(runtime.slots);
  } finally {
    await runtime.dispose();
  }
});
