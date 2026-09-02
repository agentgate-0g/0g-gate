import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(path.join(REPO, p), 'utf8');

/**
 * The shipped systemd unit pointed at
 * `/home/<someone>/Project-MDlabs/Dorahacks/casper` — the RETIRED Casper
 * project — for its entire life. Anyone who installed it booted a different
 * application, on the same port, answering /healthz cheerfully.
 *
 * It survived because nothing ever looked at deploy/. These assertions are
 * cheap and would have caught it on the commit that introduced it.
 */
describe('deploy artifacts point at THIS repo', () => {
  it('the systemd unit has no absolute path baked into it', () => {
    const unit = read('deploy/agentgate-gateway.service');
    const workingDir = /^WorkingDirectory=(.*)$/m.exec(unit);
    expect(workingDir, 'unit has no WorkingDirectory').not.toBeNull();

    // A placeholder substituted at install time. A unit file is COPIED out of
    // the repo, so unlike the PM2 config it cannot resolve its own location —
    // and an unsubstituted placeholder fails the start loudly, which is the
    // point: systemd refuses a non-absolute WorkingDirectory.
    expect(workingDir![1]).toBe('@REPO@');
  });

  it('no deploy artifact DIRECTIVE references another project', () => {
    for (const file of ['deploy/agentgate-gateway.service', 'deploy/agentgate.ecosystem.config.cjs']) {
      // Comments are exempt on purpose: both files carry a prose warning naming
      // the retired Casper checkout and why it was dangerous, which is the kind
      // of comment this repo wants to keep. Only what systemd/pm2 actually
      // EXECUTES is asserted on.
      const directives = read(file)
        .split('\n')
        .filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line) && line.trim() !== '')
        .join('\n');
      expect(directives.toLowerCase(), `${file} EXECUTES something naming the retired Casper project`)
        .not.toContain('casper');
      expect(directives, `${file} hardcodes an absolute home path`).not.toMatch(/=\s*['\"]?\/home\//);
    }
  });

  it('the PM2 config resolves the repo from its own location', () => {
    const cfg = read('deploy/agentgate.ecosystem.config.cjs');
    // Deriving from __dirname is what makes this file correct wherever it is
    // checked out; the systemd unit could not do the same, which is exactly how
    // the two drifted apart.
    expect(cfg).toMatch(/__dirname/);
    expect(cfg).toMatch(/const REPO\s*=/);
  });

  it('pm2 app names in the docs match the ones the config defines', () => {
    const cfg = read('deploy/agentgate.ecosystem.config.cjs');
    const defined = [...cfg.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(defined.length).toBeGreaterThan(0);

    // The runbook told operators to tail `pm2 logs agentgate-gateway` while the
    // config started `agentgate-0g-gateway`. During an incident that is the
    // difference between reading logs and reading nothing.
    // Only commands inside fenced code blocks — an operator copy-pastes those.
    // Prose that NAMES the wrong app in order to warn about it (and the runbook
    // does exactly that, deliberately) must not trip this.
    const doc = read('docs/DEPLOY-GATEWAY.md');
    const fenced = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!).join('\n');
    for (const m of fenced.matchAll(/pm2 (?:logs|restart|stop|describe) ([a-z0-9-]+)/g)) {
      const named = m[1]!;
      if (named === 'all') continue;
      expect(defined, `docs/DEPLOY-GATEWAY.md tells operators to run pm2 against "${named}", which the config never defines`)
        .toContain(named);
    }
  });
});
