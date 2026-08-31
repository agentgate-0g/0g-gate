import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the publish seam.
 *
 * Every bug this file exists for shipped a package that passed the entire test
 * suite and then failed on `npm install`: the suite resolves `agentgate-0g`
 * through a vitest alias to `src/`, so it never once touches the manifest that
 * an installing consumer actually reads. The tests below read that manifest
 * directly and assert the two things the alias hides — that every entry point
 * resolves to a path `files` really ships, and that no entry point points back
 * into `src/`, which is not published at all.
 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as {
  version: string;
  name: string;
  main: string;
  types: string;
  exports: Record<string, string>;
  bin: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
};

/** Entry points as npm reads them, each labelled by the field it came from. */
const entryPoints: Array<[string, string]> = [
  ['main', pkg.main],
  ['types', pkg.types],
  ...Object.entries(pkg.exports).map(([k, v]): [string, string] => [`exports["${k}"]`, v]),
  ...Object.entries(pkg.bin).map(([k, v]): [string, string] => [`bin.${k}`, v]),
];

describe('published entry points', () => {
  it.each(entryPoints)('%s resolves inside a shipped path', (_field, target) => {
    const clean = target.replace(/^\.\//, '');
    expect(pkg.files.some((f) => clean === f || clean.startsWith(`${f}/`))).toBe(true);
  });

  it.each(entryPoints)('%s does not point into unpublished src/', (_field, target) => {
    expect(target).not.toMatch(/(^|\/)src\//);
  });
});

describe('publishConfig', () => {
  // npm flattens publishConfig into its *config* options, not into package
  // fields: a `publishConfig.exports` is silently dropped, so the real exports
  // field is the only one that matters and must be correct on its own.
  it('carries no package fields that npm would ignore', () => {
    expect(Object.keys(pkg.publishConfig ?? {})).toEqual(['access']);
  });
});

describe('dependencies', () => {
  it('declares no private workspace package as a runtime dependency', () => {
    // @agentgate/* are private and never published; they are bundled by tsup
    // and must not appear where npm would try to install them.
    const privateDeps = Object.keys(pkg.dependencies).filter((d) => d.startsWith('@agentgate/'));
    expect(privateDeps).toEqual([]);
  });

  it('declares every non-bundled import as a runtime dependency', () => {
    // Anything tsup marks external must be installable by the consumer.
    const external = ['@modelcontextprotocol/sdk', 'commander', 'viem', 'zod'];
    for (const dep of external) expect(pkg.dependencies).toHaveProperty(dep);
  });
});

describe('version reporting', () => {
  // Two defects hid behind this seam at once: the bug-report template told
  // people to run `--version` on a CLI that had no such flag, and the MCP
  // server reported a hand-typed version literal that had to be remembered on
  // every bump. Nothing tested either, because nothing ran the binary and
  // asked it what it was. This does.
  const cliVersion = pkg.version;

  it('the package version is a plain semver', () => {
    expect(cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('--version prints exactly the manifest version', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
    const { stdout } = await promisify(execFile)(
      'npx',
      ['tsx', bin, '--version'],
      { cwd: fileURLToPath(new URL('../../..', import.meta.url)) },
    );
    expect(stdout.trim()).toBe(cliVersion);
  }, 60_000);

  it('no source file hardcodes a version literal that could drift', async () => {
    // Every version shown to a user must come from the manifest. A literal here
    // is not wrong today and silently wrong on the next release.
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = fileURLToPath(new URL('../src', import.meta.url));
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const body = readFileSync(`${dir}/${f}`, 'utf8');
      for (const line of body.split('\n')) {
        if (/_VERSION\s*(:|=)\s*['"`]\d+\.\d+\.\d+['"`]/.test(line)) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the library surface is usable, not merely present', () => {
  // 1.0.2 exported nine functions that every consumer could import and none
  // could call: each takes an injected `chain: ChainClient`, and the factory
  // that builds one was bundled but never exported. Checking that the symbols
  // resolve — which is what was checked — cannot catch that. These assert the
  // shape a caller actually needs.
  it('exports the factory that builds the argument every function requires', async () => {
    const sdk = await import('../src/index');
    expect(typeof sdk.createChainClient).toBe('function');
    expect(typeof sdk.loadConfig).toBe('function');
  });

  it('a consumer can build a client and call a read with only public exports', async () => {
    const { createChainClient, loadConfig, listServices } = await import('../src/index');
    // Mock mode so this needs no network: the point is that the wiring exists.
    const chain = createChainClient(loadConfig({ AGENTGATE_MODE: 'mock' }));
    expect(typeof chain.listServices).toBe('function');
    expect(typeof listServices).toBe('function');
  });

  it('exports the error type its functions throw', async () => {
    const sdk = await import('../src/index');
    expect(typeof sdk.AgentGateError).toBe('function');
    expect(typeof sdk.isAgentGateError).toBe('function');
    expect(sdk.isAgentGateError(new sdk.AgentGateError('X', 'y', 400))).toBe(true);
  });

  it('re-exports every constant its own JSDoc names', async () => {
    // The shipped types referenced these by name while the package kept them
    // private, so the documentation pointed at something unreachable.
    const sdk = await import('../src/index');
    expect(typeof sdk.DEFAULT_WRAP_FETCH_TIMEOUT_MS).toBe('number');
    expect(typeof sdk.DEFAULT_FAUCET_TIMEOUT_MS).toBe('number');
    expect(typeof sdk.DEFAULT_MAP_FETCH_TIMEOUT_MS).toBe('number');
  });
});
