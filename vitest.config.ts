import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Each workspace package runs this shared config from its own directory.
  root: process.cwd(),
  test: {
    environment: 'node',
    // Public platform atoms are supplied by DSH in production. The published
    // rc.2 primitives Node entry has undeclared browser-only dependencies.
    setupFiles: ['./tests/client/platform.setup.ts'],
    include: ['{src,tests}/**/*.{test,spec}.{ts,tsx}'],
  },
});
