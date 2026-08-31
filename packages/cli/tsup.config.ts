import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Inline the private workspace packages so the published artifact is self-contained.
  noExternal: ['@agentgate/shared', '@agentgate/chain', '@agentgate/client'],
  // Real npm packages stay external — every entry here must also appear in
  // `dependencies`, or the published package resolves an import it never
  // declared. (tsup externals `dependencies` by default; this list is explicit
  // so a drift between the two is visible in review.)
  external: [
    '@modelcontextprotocol/sdk',
    'commander',
    'viem',
    'zod',
  ],
  clean: true,
  // Ship declarations: this package is consumed programmatically (wrapService,
  // mapService, buyService …), and `types` in package.json must point at a file
  // that exists.
  // `resolve` INLINES the types of the private workspace packages. Without it
  // the emitted .d.ts re-exports `@agentgate/shared` / `@agentgate/client`,
  // which are never published — the runtime JS works (they are bundled) while
  // every TypeScript consumer fails on "Cannot find module".
  dts: {
    resolve: [/^@agentgate\//],
    compilerOptions: {
      paths: {
        '@agentgate/shared': ['../shared/src/index.ts'],
        '@agentgate/client': ['../client/src/index.ts'],
        '@agentgate/chain': ['../chain/src/index.ts'],
      },
    },
  },
  sourcemap: false,
  shims: false,
});
