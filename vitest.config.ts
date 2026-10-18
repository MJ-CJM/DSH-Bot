import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Each workspace package runs this shared config from its own directory.
  root: process.cwd(),
  test: {
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{ts,tsx}'],
  },
});
