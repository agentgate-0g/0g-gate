/**
 * Versions the docs describe. Bump `cli`/`sdk` when the package publishes a new
 * version. The network and registry badges next to these are NOT here: they
 * describe the running instance and are resolved per request in
 * lib/server/chain.ts (getNetworkInfo), because one build serves both the
 * Galileo and the mainnet dashboard.
 */
export const DOCS_VERSION = {
  cli: '2.0.0', // agentgate-0g
  // Same package: agentgate-0g ships the CLI and the SDK from one tarball.
  // @agentgate/client is an internal workspace package and is never published,
  // so its version means nothing to a reader — this must track the published one.
  sdk: '2.0.0', // agentgate-0g (same package as the CLI)
} as const;
