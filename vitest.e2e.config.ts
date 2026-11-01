import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@rr/schema': r('./packages/schema/src/index.ts'),
      '@rr/recorder': r('./packages/recorder/src/index.ts'),
      '@rr/resolver': r('./packages/resolver/src/index.ts'),
      '@rr/executor': r('./packages/executor/src/index.ts'),
      '@rr/ai': r('./packages/ai/src/index.ts'),
      '@rr/harness': r('./packages/harness/src/index.ts'),
      '@rr/studio': r('./packages/studio/src/index.ts'),
    },
  },
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
