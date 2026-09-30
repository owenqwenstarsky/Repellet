import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/ui/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    pool: 'forks',
  },
});
