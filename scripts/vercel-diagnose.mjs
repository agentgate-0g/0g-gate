#!/usr/bin/env node
/**
 * TEMPORARY — remove once the Vercel build is green. See the commit that added it.
 *
 * WHY THIS EXISTS
 *
 * Three Vercel builds failed with the same signature: `npm install` reported
 * "audited 79 packages" (the root package.json's own devDependencies and nothing
 * else) and `npm run build -w dashboard` then died with "No workspaces found".
 *
 * That signature was reproduced EXACTLY on a clean clone of origin/main by
 * deleting `packages/` and `dashboard/` — same 79, same npm error. So the build
 * environment does not contain the workspace directories, even though GitHub
 * has them (66 files under dashboard/, 124 under packages/).
 *
 * What could not be determined from the outside is WHY. This prints the one
 * thing no log has shown: what the build machine actually has on disk.
 *
 * It runs from `preinstall`, so it fires before npm resolves anything — which is
 * the only hook available while the configured Build Command is still failing.
 *
 * SAFETY
 *  - Silent unless VERCEL is set, so local installs and CI are unaffected.
 *  - Prints no environment variables except a small non-secret allowlist; a
 *    build log is a shared artifact and dumping env there leaks credentials.
 *  - Never throws and always exits 0. A diagnostic that breaks the build it is
 *    diagnosing is worse than no diagnostic.
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

if (!process.env.VERCEL) process.exit(0);

const line = (s = '') => process.stdout.write(`[agentgate-diagnose] ${s}\n`);

try {
  line('='.repeat(64));
  line('cwd: ' + process.cwd());
  line('node: ' + process.version);

  // Allowlist only. Never dump process.env into a build log.
  for (const k of [
    'VERCEL',
    'VERCEL_ENV',
    'VERCEL_TARGET_ENV',
    'VERCEL_GIT_COMMIT_REF',
    'VERCEL_GIT_COMMIT_SHA',
    'ENABLE_EXPERIMENTAL_COREPACK',
    'NPM_CONFIG_WORKSPACES',
    'npm_config_workspaces',
    'npm_config_production',
  ]) {
    if (process.env[k] !== undefined) line(`env ${k}=${process.env[k]}`);
  }

  const entries = readdirSync(process.cwd(), { withFileTypes: true })
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
    .sort();
  line('');
  line(`cwd contains ${entries.length} entries:`);
  line('  ' + entries.join('  '));

  line('');
  for (const p of [
    'package.json',
    'package-lock.json',
    'dashboard',
    'dashboard/package.json',
    'dashboard/vercel.json',
    'packages',
    'packages/shared/package.json',
    'packages/chain/package.json',
    'vercel.json',
    '.vercelignore',
  ]) {
    const abs = path.join(process.cwd(), p);
    let note = 'MISSING';
    if (existsSync(abs)) {
      const st = statSync(abs);
      note = st.isDirectory() ? `dir (${readdirSync(abs).length} entries)` : `file (${st.size} b)`;
    }
    line(`${p.padEnd(32)} ${note}`);
  }

  // The decisive field: what npm will actually resolve workspaces from.
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    line('');
    line('root package.json name       : ' + pkg.name);
    line('root package.json workspaces : ' + JSON.stringify(pkg.workspaces));
    line('root package.json scripts.build: ' + JSON.stringify(pkg.scripts?.build));
  } catch (err) {
    line('could not read root package.json: ' + err.message);
  }

  line('='.repeat(64));
} catch (err) {
  line('diagnostic failed (ignored): ' + (err && err.message));
}

process.exit(0);
