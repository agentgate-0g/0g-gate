import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `agentgate-0g` is the only PUBLISHED package here, so its `exports` must
 * point at `dist` — that is what ships. In-repo consumers (e2e, scripts) would
 * then need a build before every run, so they are aliased back to source.
 * Publishing with `exports` pointing at `src/index.ts` was the actual bug: the
 * file is excluded by `files`, so `import 'agentgate-0g'` failed for every
 * consumer while the CLI binary kept working (bin bypasses exports).
 */
const CLI_SRC = fileURLToPath(new URL('./packages/cli/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: { alias: { 'agentgate-0g': CLI_SRC } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
