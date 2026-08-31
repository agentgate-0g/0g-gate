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
