import Link from 'next/link';
import { StatsStrip } from '@/components/stats-strip';
import { CommandBlock } from '@/components/copy';
import { getNetworkInfo } from '@/lib/server/chain';

const LIST_CMD = 'npx agentgate-0g@latest list';
const WRAP_CMD =
  'npx agentgate-0g@latest wrap https://api.example.com/gold --price 2.5 --name "Gold Spot Feed"';

const STEPS = [
  {
    n: '01',
    title: 'Wrap',
    body: 'One command registers your API on the 0G registry contract and drops a 402 paywall in front of it. No billing code, no accounts, no keys to issue.',
    code: 'npx agentgate-0g@latest wrap <url> --price 2.5',
  },
  {
    n: '02',
    title: 'Discover',
    body: 'Agents read the on-chain catalog — price, endpoint, trust score — pick a service, and get an HTTP 402 invoice with a one-time payment nonce.',
    code: 'GET /svc/1 → 402 { maxAmountRequired, nonce, router }',
  },
  {
    n: '03',
    title: 'Get paid',
    body: 'The agent pays through PaymentRouter, which binds the invoice nonce to the payment on-chain, then retries with proof. Every served call writes a reputation attestation back on-chain.',
    code: '200 OK · attestation recorded ✓',
  },
] as const;

const ROADMAP = [
  {
    tag: 'SHIPPED',
    title: 'Router settlement on 0G Galileo and 0G Mainnet',
    body: 'Native OG payments carrying HTTP 402 semantics, bound to their invoice by the PaymentRouter contract and verified straight from the transaction receipt. Registry + reputation contract in Solidity, no indexer and no API key in the read path. The same contract set is deployed and source-verified on both networks.',
    done: true,
  },
  {
    tag: 'SHIPPED',
    title: 'MCP server for any agent framework',
    body: 'npx agentgate-0g mcp exposes discover / inspect / invoice / pay as native Model Context Protocol tools, so Claude Desktop and any MCP-capable agent can read the registry and pay for a call from a conversation. The read tools need no key at all.',
    done: true,
  },
  {
    tag: 'SHIPPED',
    title: 'Hosted mainnet catalog',
    body: 'The public gateway and this dashboard serve the 0G Mainnet deployment by default — a live catalog of real, paid data services settling in OG — with the Galileo testnet set kept behind ZG_NETWORK_PROFILE=galileo for free rehearsal.',
    done: true,
  },
  {
    tag: 'NEXT',
    title: 'External audit and open seller onboarding',
    body: 'The contracts on mainnet today are self-reviewed only. An external audit before real volume, then onboarding for the first indie data providers.',
    done: false,
  },
  {
    tag: 'NEXT',
    title: 'ERC-20 rail',
    body: 'Stablecoin pricing over the accepts[] price list the registry already stores on-chain — a client change, not a contract change.',
    done: false,
  },
  {
    tag: 'LATER',
    title: 'SpendGuard in the request path',
    body: 'Wire the deployed escrow spend firewall into the buyer loop: per-policy budget, per-call cap, rate window and trust floor enforced atomically on-chain — then staking-weighted attestations with slashing.',
    done: false,
  },
] as const;

export default function Home() {
  const { label } = getNetworkInfo();
  return (
    <div className="mx-auto max-w-6xl px-5 sm:px-8">
      {/* ── hero ─────────────────────────────────────────────── */}
      <section className="pb-16 pt-20 sm:pb-24 sm:pt-28">
        <p
          className="microlabel animate-fade-up text-accent"
          style={{ animationDelay: '0ms' }}
        >
          {label.toLowerCase()} · http 402 · on-chain reputation
        </p>
        <h1
          className="mt-5 max-w-3xl animate-fade-up font-display text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-6xl"
          style={{ animationDelay: '90ms' }}
        >
          Stripe for AI agents
          <br />
          on 0G<span className="text-accent">.</span>
        </h1>
        <p
          className="mt-6 max-w-2xl animate-fade-up text-base leading-7 text-mut sm:text-lg"
          style={{ animationDelay: '180ms' }}
        >
          AgentGate turns any API into a paid x402 service in one command — machine-to-machine
          micropayments in native OG, with on-chain discovery and reputation. No cards, no KYC,
          no API keys.
        </p>
        <div
          className="mt-9 animate-fade-up"
          style={{ animationDelay: '270ms' }}
        >
          <CommandBlock text={WRAP_CMD} wrap typewriter />
          <p className="mt-3 font-mono text-[11px] text-mut">
            one line, only your funded wallet key. Or read the live{' '}
            <Link href="/catalog" className="text-accent underline underline-offset-4">
              on-chain catalog
            </Link>{' '}
            with zero setup: <span className="text-white">{LIST_CMD}</span>
          </p>
        </div>
        <div
          className="mt-7 flex flex-wrap items-center gap-3 animate-fade-up"
          style={{ animationDelay: '360ms' }}
        >
          <Link
            href="/catalog"
            className="bg-accent px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-white shadow-glow-sm transition-colors hover:bg-accent-dim"
          >
            browse the catalog →
          </Link>
          <Link
            href="/activity"
            className="border border-line px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-mut transition-colors hover:border-accent/60 hover:text-white"
          >
            live activity
          </Link>
          <a
            href="https://github.com/agentgate-0g/0g-gate"
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-mut transition-colors hover:text-accent"
          >
            github ↗
          </a>
        </div>
      </section>

      {/* ── live stats ───────────────────────────────────────── */}
      <section aria-label="Live network stats" className="pb-20 sm:pb-28">
        <StatsStrip />
      </section>

      {/* ── how it works ─────────────────────────────────────── */}
      <section className="pb-20 sm:pb-28">
        <p className="microlabel">how it works</p>
        <h2 className="mt-3 max-w-xl font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Wrap an API. Agents find it, pay it, and rate it — all on-chain.
        </h2>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {STEPS.map((step) => (
            <div key={step.n} className="panel flex flex-col p-6">
              <span className="font-mono text-4xl font-bold text-accent/85">{step.n}</span>
              <h3 className="mt-4 font-display text-xl font-semibold text-white">{step.title}</h3>
              <p className="mt-3 flex-1 text-sm leading-6 text-mut">{step.body}</p>
              <code className="mt-6 block overflow-x-auto whitespace-nowrap border border-line bg-[#070A0F] px-3 py-2 font-mono text-[11px] text-zinc-300">
                {step.code}
              </code>
            </div>
          ))}
        </div>
      </section>

      {/* ── why on-chain ─────────────────────────────────────── */}
      <section className="pb-20 sm:pb-28">
        <div className="panel grid gap-px overflow-hidden bg-line md:grid-cols-3">
          {[
            {
              k: '402',
              t: 'Native HTTP semantics',
              d: 'The paywall speaks the web’s own “Payment Required” status — any agent that can fetch can pay.',
            },
            {
              k: '< 1¢',
              t: 'True micropayments',
              d: 'Per-call pricing in wei, down to 0.000001 OG. No minimum fees, no monthly plans — price a call at half a cent if you want.',
            },
            {
              k: 'TX×2',
              t: 'Verifiable reputation',
              d: 'Every paid call leaves two on-chain transactions: the payment and the attestation that scores the service.',
            },
          ].map((f) => (
            <div key={f.k} className="bg-panel p-6">
              <span className="font-mono text-sm text-accent">{f.k}</span>
              <h3 className="mt-2 font-display text-lg font-semibold text-white">{f.t}</h3>
              <p className="mt-2 text-sm leading-6 text-mut">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── roadmap ──────────────────────────────────────────── */}
      <section className="pb-20 sm:pb-28">
        <p className="microlabel">roadmap</p>
        <h2 className="mt-3 font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Built to outlive the hackathon.
        </h2>
        <ol className="mt-10 space-y-0">
          {ROADMAP.map((item, i) => (
            <li key={item.title} className="relative flex gap-6 pb-10 last:pb-0">
              {/* timeline rail */}
              <div className="flex flex-col items-center">
                <span
                  aria-hidden
                  className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${
                    item.done
                      ? 'border-accent bg-accent shadow-glow-sm'
                      : 'border-line bg-ink'
                  }`}
                />
                {i < ROADMAP.length - 1 ? (
                  <span aria-hidden className="mt-1 w-px flex-1 bg-line" />
                ) : null}
              </div>
              <div className="-mt-0.5 pb-2">
                <span
                  className={`font-mono text-[10px] uppercase tracking-[0.22em] ${
                    item.done ? 'text-accent' : 'text-mut'
                  }`}
                >
                  {item.tag}
                </span>
                <h3 className="mt-1 font-display text-lg font-semibold text-white">{item.title}</h3>
                <p className="mt-1.5 max-w-2xl text-sm leading-6 text-mut">{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── closing CTA ──────────────────────────────────────── */}
      <section id="get-started" className="pb-24 sm:pb-32">
        <div className="panel relative overflow-hidden p-8 sm:p-12">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-accent/10 blur-3xl"
          />
          <p className="microlabel">get started</p>
          <h2 className="mt-3 max-w-lg font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Wrap your first API in under five minutes.
          </h2>
          <div className="mt-7 max-w-2xl">
            <CommandBlock text={WRAP_CMD} wrap />
          </div>
          <p className="mt-4 font-mono text-[11px] text-mut">
            then open{' '}
            <Link href="/catalog" className="text-accent underline underline-offset-4">
              /catalog
            </Link>{' '}
            and watch agents find you.
          </p>
        </div>
      </section>
    </div>
  );
}
