# Wave 3 submission — Akindo WaveHack

The portal answers live as **plain text files**, one per form field, in
[`wave-3/`](./wave-3/). Each file contains exactly what goes in the box and
nothing else — no headings, no code fences, no commentary. Open it, select all,
paste. There is nothing to strip afterwards.

| Form field | File | Length |
|---|---|---|
| Updates in this Wave | [`wave-3/01-updates-in-this-wave.txt`](./wave-3/01-updates-in-this-wave.txt) | 2,910 of 3,000 |
| Milestone → 4th Wave | [`wave-3/02-milestone-4th-wave.txt`](./wave-3/02-milestone-4th-wave.txt) | 894 of 900 |
| Milestone → 5th Wave | [`wave-3/03-milestone-5th-wave.txt`](./wave-3/03-milestone-5th-wave.txt) | 886 of 900 |

Copy one to the clipboard without opening an editor:

```bash
cd docs/wave-3
xclip -selection clipboard < 01-updates-in-this-wave.txt   # X11
wl-copy                    < 01-updates-in-this-wave.txt   # Wayland
```

The text is UTF-8 and contains no control characters, smart quotes or
non-breaking spaces — only em dashes, which any HTML textarea accepts. It is
safe to paste as-is.

---

## Check the numbers before pasting

Two things in field 1 go stale as work continues: the npm version and the test
counts. These commands re-check every factual claim the text makes. If one
disagrees, edit the text — not the command.

```bash
# npm: latest version, and that the SDK is genuinely callable (not just importable)
npm view agentgate-0g version
node -e "import('agentgate-0g').then(async m=>{
  const c=m.createChainClient(m.loadConfig({AGENTGATE_MODE:'live'},{requireStrongAdminToken:false}));
  console.log(await m.listServices({chain:c}));})"

# chain: the registry holds the service the text describes
npx agentgate-0g@latest list

# gateway: a real 402, not a placeholder
curl -sS -o /dev/null -w '%{http_code}\n' https://0g-gateway.mdloglabs.org/svc/1

# repo: CI state on the tip of main
curl -sS "https://api.github.com/repos/agentgate-0g/0g-gate/actions/runs?per_page=1" \
  | python3 -c "import json,sys;r=json.load(sys.stdin)['workflow_runs'][0];print(r['head_sha'][:8],r['status'],r['conclusion'])"

# the test counts quoted in the text
npx vitest run 2>&1 | tail -3
(cd contracts-evm && forge test 2>&1 | tail -1)
```

Last verified 2026-08-31: npm `1.0.3`, gateway `402`, CI green on `5d97595`,
`463` vitest, `77` forge. Field 1 quotes exactly those.

Re-measure a field's length after editing it:

```bash
wc -m docs/wave-3/01-updates-in-this-wave.txt   # must stay under 3,000
```

`wc -m` counts the trailing newline, so it reports one more than the figures
above, which are the pasted text alone. That one character matters here: the
milestone fields sit 6 and 14 under their 900 cap, so re-measure with

```bash
python3 -c "print(len(open('docs/wave-3/02-milestone-4th-wave.txt').read().rstrip()))"
```

after any edit, rather than trusting `wc`.

---

## Why the answers are written this way

**Every claim is clickable.** Three transaction hashes, three contract
addresses, and two commands a judge can run with no setup and no keys. A judge
who verifies one claim in ten seconds tends to believe the rest; a page of
adjectives earns nothing.

**Two gaps are stated outright** — the hosted dashboard still serves the
pre-migration build, and the shipped `.d.ts` still needs ambient DOM or node
types. Hiding either is the worse bet: a judge who runs `npx agentgate-0g list`
and then opens agentgate.mdloglabs.org finds the mismatch anyway, and being
caught costs more than the admission. Both appear as Wave 4 deliverables, which
turns each gap into a plan.

**No x402 compliance is claimed.** The envelope is x402 V1, but settlement is
deliberately a different scheme (`exact-settled`, not `exact`) because 0G has no
x402 facilitator. Saying so first is stronger than being corrected.

**The publishing defects are included on purpose.** The package once shipped an
entry point into source it did not ship, and later exported SDK functions no
consumer could call. Both passed a green suite and were caught only by
installing the tarball into an empty directory. Reporting that shows the project
tests what it ships rather than only what it wrote — a more credible claim than
an unblemished one, and one most submissions cannot make.

**Each milestone states its acceptance test**, because "done" is otherwise a
matter of opinion and a milestone nobody can falsify is not a commitment.
