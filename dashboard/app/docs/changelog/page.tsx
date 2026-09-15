import { docMeta } from '@/lib/seo';
import { DocHeader, H2, M, P, DocLink, NextLinks } from '@/components/docs';

export const metadata = docMeta(
  '/docs/changelog',
  'Changelog',
  'Notable changes to AgentGate — the CLI, gateway, smart contracts and docs — newest first.',
);

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="REFERENCE"
        title="Changelog"
        lede="Notable changes to AgentGate — the CLI, gateway, smart contracts and docs — newest first."
      />

      <H2 id="2026-09-15-v200">2026-09-15 — v2.0.0: the default network is 0G Mainnet</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">Breaking: zero-config now means mainnet.</strong> The
          three contracts are deployed on 0G Mainnet (blocks 44406357–44406358, source verified on
          chainscan.0g.ai) and the hosted gateway and dashboard serve that deployment, so{' '}
          <M>ZG_NETWORK_PROFILE</M> defaults to <M>mainnet</M>. <M>wrap</M> spends real OG. The
          Galileo testnet set is one variable away — <M>ZG_NETWORK_PROFILE=galileo</M> — and its
          gateway lives at <M>0g-gateway.mdloglabs.org</M>.
        </li>
        <li>
          <strong className="text-white">1.x cannot read the current registries at all.</strong>{' '}
          Every 1.x release shipped the first Galileo deployment (registry <M>0x73bf79e3…</M>),
          whose <M>Service</M> struct predates the 17-field shape this package decodes. Against
          the mainnet gateway a 1.x <M>buy</M> fails closed with <M>BAD_INVOICE</M> (the invoice
          names a PaymentRouter the old client does not settle through); no money moves.
        </li>
        <li>
          <strong className="text-white">A profile switch actually switched.</strong> The CLI
          injected the Galileo registry address as a &ldquo;default&rdquo; on top of whatever
          profile was selected, so <M>ZG_NETWORK_PROFILE=mainnet</M> read the Galileo address on
          mainnet and found no code. The registry now comes from the profile like every other
          chain value.
        </li>
        <li>
          <strong className="text-white">History reads start at the deploy block.</strong>{' '}
          <M>listRecentActivity</M> and the attestation tx-hash join used a rolling{' '}
          <M>head − N</M> window that went blank whenever a service idled longer than it (twice in
          production). Each profile records its <M>deployBlock</M>; <M>ACTIVITY_LOOKBACK_BLOCKS</M>{' '}
          is now an opt-in cap.
        </li>
        <li>
          <strong className="text-white">The public hosts moved.</strong> The gateway is{' '}
          <M>https://0g-gateway.equiflow.xyz</M> and the dashboard{' '}
          <M>https://agentgate.equiflow.xyz</M> — both serve mainnet, and both are the compiled-in
          defaults (<M>DEFAULT_GATEWAY_URL</M>, <M>DEFAULT_DASHBOARD_URL</M>). The previous
          dashboard host, <M>agentgate-0g.mdloglabs.org</M>, no longer resolves. The dashboard
          now reads its network per request from <M>ZG_NETWORK_PROFILE</M> — one build serves
          both instances — so every badge, explorer link and docs address describes the chain that
          instance actually reads.
        </li>
        <li>
          <strong className="text-white">Docs corrected against the shipped code.</strong> Wei
          examples that still carried 9-decimal amounts now use 18 decimals (a copied{' '}
          <M>maxPriceWei</M> would otherwise have capped every real invoice); the self-map body is{' '}
          <M>{'{ upstreamUrl, timestamp, signatureHex }'}</M> (the signer is recovered from the
          EIP-191 signature, there is no public-key field); <M>--attestor</M> and{' '}
          <M>--payment-target</M> take EVM addresses (<M>INVALID_ADDRESS</M>); and the Foundry
          suite is 143 tests across nine files.
        </li>
      </ul>

      <H2 id="2026-09-01-v105">2026-09-01 — v1.0.5: the dashboard link pointed at a different chain</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">
            <M>wrap</M> sent every seller to the Casper app.
          </strong>{' '}
          <M>DEFAULT_DASHBOARD_URL</M> was <M>agentgate.mdloglabs.org</M> — no <M>0g-</M> — which
          is the older Casper deployment, not this one. It is the only link the wrap flow prints,
          and the failure was silent rather than loud: that host answers <M>200</M> for the same
          numeric service ids in CSPR, so a seller who had just paid gas on 0G opened it and read
          a confident, entirely unrelated page. The constant travels inside the npm tarball, so
          the fix only reaches anyone through this release.
        </li>
        <li>
          <strong className="text-white">This dashboard told crawlers it lived somewhere else.</strong>{' '}
          <M>lib/seo.ts</M> fell back to the same Casper host, so every page here served{' '}
          <M>&lt;link rel=&quot;canonical&quot;&gt;</M> and <M>og:url</M> pointing at the other
          app. Five docs pages printed it in examples too.
        </li>
        <li>
          <strong className="text-white">Library callers could burn gas and then be stuck.</strong>{' '}
          <M>wrapService</M> and <M>mapService</M> defaulted the signed network name to{' '}
          <M>&apos;&apos;</M>. The CLI always passed it, so only SDK users were exposed — but they
          were exposed badly: <M>registerService</M> spends gas and cannot be undone, and only
          then does the gateway reject the owner signature it can never rebuild, reporting{' '}
          <M>not_service_owner</M> — a message pointing at key ownership, which is the wrong
          diagnosis. <M>mapService</M>, the documented recovery, failed identically. Wrap now
          derives the network from the chain client it already holds; map falls back to the live
          network in live mode.
        </li>
        <li>
          <strong className="text-white">The npm README demoed a paused service.</strong>{' '}
          <M>buy 1</M> and <M>status 1</M> pointed at service 1, deactivated when the attestor
          topology was corrected. A reader who funded a wallet from the faucet got{' '}
          <M>SERVICE_INACTIVE</M> on the one command that shows the product working. The examples
          now use an active id and say that any id <M>list</M> reports as ACTIVE will do.
        </li>
        <li>
          <strong className="text-white">Guarded, not just fixed.</strong> Two tests now fail if a
          Casper host reappears: one over the exported URL constants, one over every file{' '}
          <M>files</M> actually ships. The second requires a URL scheme, so the JSDoc that warns
          readers off the host is still allowed to name it.
        </li>
      </ul>

      <H2 id="2026-09-01-v104">2026-09-01 — v1.0.4: the audited set is the live one</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">Cut over to the audited contracts.</strong> The CLI, the
          gateway and this dashboard now all read{' '}
          <M>0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1</M>. The ABIs differ from the first
          deployment, so the three had to switch together — a client on the new ABI reading the old
          registry decodes a shifted <M>Service</M> struct and fails on a field it never asks about.
          The new registry started from empty state, so the catalog was re-seeded rather than
          migrated: no reputation carries across a redeploy, by design.
        </li>
        <li>
          <strong className="text-white">The attestor is the gateway, not the seller.</strong> The
          first services registered here named the gate key as <em>owner</em> and a standalone
          address as attestor, while the gateway signs attestations with the gate key — so every
          attestation reverted <M>NotAuthorized</M> and nothing could score. Services 1 and 2 are
          deactivated and 3 and 4 replace them with the seller owning and being paid, and the
          gateway&rsquo;s signer as the registered attestor. No test caught this: the topology is
          deployment configuration, not code.
        </li>
        <li>
          <strong className="text-white">Escrowed debits settle through the router.</strong>{' '}
          <M>SpendGuard.debit</M> paid the payee directly, which meant a guard-funded call produced
          no <M>settledAmount</M> entry and therefore could never be attested. It now settles via{' '}
          <M>PaymentRouter.pay</M>, so an escrow payment scores exactly like a direct one.
        </li>
        <li>
          <strong className="text-white">The activity ledger stopped going blank.</strong> The
          lookback was 50,000 blocks, which reads as a comfortable window until you measure 0G
          Galileo at roughly half a second a block — 6.9 hours, so a demo recorded the previous
          evening showed an empty page. The default is now 1,000,000 blocks, and the empty state
          says which window it searched instead of claiming there is no activity at all.
        </li>
        <li>
          <strong className="text-white">A new seller can no longer register an unscorable
          service.</strong> Registering with the seller&rsquo;s own key as attestor produces a
          service whose every attestation is barred as a self-payment — served forever, scored
          never. The path now refuses it at registration rather than at the first sale.
        </li>
      </ul>

      <H2 id="2026-08-31-v103">2026-08-31 — v1.0.3: the library half of the package actually works</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">
            <M>createChainClient</M> is exported.
          </strong>{' '}
          Every exported function takes an injected <M>chain: ChainClient</M>, and until now the
          factory that builds one was bundled but never exported — so the whole library surface
          imported cleanly and then could not be called. The public types go with it
          (<M>ChainClient</M>, <M>ServiceRecord</M>, <M>ServiceScore</M>, <M>AttestationRecord</M>,{' '}
          <M>AnySigner</M>, <M>TrustTier</M>, <M>Wei</M>, <M>AgentGateConfig</M>), along with{' '}
          <M>loadConfig</M>, the OG/wei helpers, and <M>AgentGateError</M> / <M>isAgentGateError</M>{' '}
          so failures can be handled by code instead of by matching message text.
        </li>
        <li>
          <strong className="text-white">
            <M>wrapService</M> no longer demands an admin token it never sends.
          </strong>{' '}
          Live mode maps by signing an ownership challenge, so no token is involved — but one was
          required unconditionally, rejecting the documented default path. It is still required on
          the admin path, and still <em>before</em> the on-chain write: <M>registerService</M> costs
          gas and cannot be undone, so a missing token must not be discovered after the service
          already exists.
        </li>
        <li>
          <strong className="text-white">Help and README corrections.</strong> Invoked as{' '}
          <M>agentgate-0g</M> the usage line said <M>agentgate</M>; the package README&rsquo;s only{' '}
          <M>buy</M> example targeted a service id that does not exist; and the <M>--key</M> row
          omitted <M>map</M>, the command where getting a key in without retyping it matters most.
        </li>
      </ul>

      <H2 id="2026-08-31-v102">2026-08-31 — v1.0.2: the CLI can say what version it is</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">
            <M>--version</M> / <M>-v</M>
          </strong>{' '}
          now exist. The bug-report template had been telling people to run them on a CLI that
          registered no such flag. The value is read from the manifest, so it cannot drift from the
          version that was actually published, and the MCP server&rsquo;s readiness banner now names
          it too — which is what the docs had already claimed it did.
        </li>
        <li>
          <strong className="text-white">
            <M>wrap --help</M> stopped contradicting the README.
          </strong>{' '}
          It advertised a <M>localhost:4021</M> default for <M>--gateway</M>. The published CLI
          defaults to live mode and resolves the hosted gateway; the localhost default only ever
          applied in mock mode. <M>map</M>&rsquo;s identical flag was corrected during the migration
          and <M>wrap</M> was missed.
        </li>
        <li>
          <strong className="text-white">
            <M>map</M> is documented on npm.
          </strong>{' '}
          The package README listed every command except the one that recovers a half-failed{' '}
          <M>wrap</M> — where the on-chain registration lands but the gateway mapping does not.
          Re-running <M>wrap</M> there registers a second service and spends gas again, and the
          first registration cannot be undone.
        </li>
      </ul>

      <H2 id="2026-08-31-v101">2026-08-31 — v1.0.1: package metadata points at this repo</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">Repository, homepage and issues.</strong> v1.0.0 shipped
          with <M>repository</M>, <M>homepage</M> and <M>bugs</M> still naming the Casper-era
          GitHub repo, so the npm page linked to a repository that does not contain this code and
          sent bug reports to the wrong tracker. They now name{' '}
          <M>github.com/agentgate-0g/0g-gate</M>. Those fields travel inside the tarball, so a
          release is the only thing that can correct them — nothing else in the package changed.
        </li>
      </ul>

      <H2 id="2026-08-31-v100">2026-08-31 — v1.0.0: AgentGate on 0G Galileo Testnet</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">Chain.</strong> AgentGate runs on{' '}
          <strong className="text-white">0G Galileo Testnet</strong> — chain id <M>16602</M>, native{' '}
          <M>OG</M>, 18 decimals. <M>AGENTGATE_MODE</M> reads <M>mock | live</M>; <M>live</M> is 0G.
        </li>
        <li>
          <strong className="text-white">Three Solidity contracts</strong> under{' '}
          <M>contracts-evm/</M>, pinned to <M>0.8.28</M> and tested with Foundry (42 tests).{' '}
          <M>AgentGateRegistry</M> holds services, scores and a 100-entry attestation ring buffer;{' '}
          <M>PaymentRouter</M> binds each payment to its invoice; <M>SpendGuard</M> is an escrow
          spend firewall, implemented and tested but not yet wired into the request path. Ids are
          1-based, auth is attestor-or-owner, and every contract timestamp is in{' '}
          <strong className="text-white">milliseconds</strong>.
        </li>
        <li>
          <strong className="text-white">Payments settle through a router.</strong> A plain value
          transfer carries no reference to the invoice that asked for it, so{' '}
          <M>PaymentRouter.pay(serviceId, nonce, payTo)</M> is what binds the two: it forwards the
          whole value to the seller, emits <M>Paid</M> with <M>serviceId</M> and <M>nonce</M>{' '}
          indexed, and rejects a repeat of that pair <em>on-chain</em>. The gateway verifies from
          the transaction receipt — one exact log match, no scanning. The invoice store burns the
          nonce too, so a replay is stopped twice over.
        </li>
        <li>
          <strong className="text-white">No indexer, no API key.</strong> Reads are contract view
          calls, history is <M>eth_getLogs</M>. Nothing in the read path needs a key to provision
          or rate-limit you — <M>agentgate status</M> shows attestation history with zero
          configuration.
        </li>
        <li>
          <strong className="text-white">Native OG only, but multi-asset on-chain.</strong> Each
          service stores an <M>accepts[]</M> price list in the contract, so an ERC-20 rail later is
          a client change rather than a contract change. The floor is{' '}
          <M>MIN_PRICE_WEI</M> = 1e12 wei (0.000001 OG) and there is no network minimum above it,
          so per-call micropricing genuinely works.
        </li>
        <li>
          <strong className="text-white">Keys and signatures.</strong> Signers are{' '}
          <M>0x</M>-prefixed 32-byte hex private keys in <M>GATE_SIGNER_KEY</M>,{' '}
          <M>BUYER_SIGNER_KEY</M> and <M>SELLER_SIGNER_KEY</M>; upstream mapping is authenticated
          by an EIP-191 <M>personal_sign</M> challenge, with the signer recovered from the
          signature. Mock mode uses the same <M>0x&lt;40 hex&gt;</M> address shape as live, so one
          address code path is exercised everywhere.
        </li>
        <li>
          <strong className="text-white">CLI v1.0.0.</strong> <M>--key &lt;0xhex&gt;</M>,{' '}
          <M>--rpc-url</M>, <M>--registry &lt;address&gt;</M>, prices and caps in OG.{' '}
          <strong className="text-white">Note the security shape:</strong> <M>--key</M> carries the
          private key itself, so it lands in shell history and <M>ps</M> — the <M>*_SIGNER_KEY</M>{' '}
          env vars are the documented path, and no error ever echoes a key value.
        </li>
        <li>
          <strong className="text-white">Audited contract set deployed.</strong> Three rounds of
          security review closed sixteen findings across the registry, router and spend guard — a
          settlement now proves the service was paid its listed price to its registered payout
          address, a service owner can no longer witness its own score or erase a failure, and the
          guard binds both the payee and the amount. The set is live at{' '}
          <M>0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1</M> (registry),{' '}
          <M>0xE7C2C116869c0838Fd6dcD5FFE49F4Ac93fe1B8F</M> (router) and{' '}
          <M>0xBb79CaB7b02f6C0301E7E87bdDC10D4F9F5DC781</M> (spend guard), block 52458928.{' '}
          <strong className="text-white">Cut over in v1.0.4</strong> — at the time of this release
          the CLI, the gateway and this dashboard still read the original set below.
        </li>
        <li>
          <strong className="text-white">Deployed and exercised on Galileo.</strong>{' '}
          <M>AgentGateRegistry</M> at <M>0x2f5b7AaD7bffcEc5B6cda95Af4439494C1D576dA</M>,{' '}
          <M>PaymentRouter</M> at <M>0xfA5e4CC796390Cdca78C6E34664FE77Be1475FBB</M>,{' '}
          <M>SpendGuard</M> at <M>0x08b4049802999245888E72D0C31Fb4cA55C30E1B</M>. The full seller
          and buyer paths were run against them end to end — register, map, 402 invoice, pay,
          replay with the payment proof, attest. Superseded by the audited set in v1.0.4; these
          addresses are kept as history and nothing reads them now.
        </li>
        <li>
          <strong className="text-white">Published as <M>agentgate-0g</M>.</strong> The 0G line is a
          separate npm package, not a new version of the Casper-era one: the two target different
          chains, and a shared version history would make the older releases look like something you
          could upgrade from.
        </li>
      </ul>

      <div className="mt-10 border-l-2 border-line/60 pl-4 text-sm leading-6 text-mut">
        <strong className="text-white">Earlier releases are archived.</strong> AgentGate ran on a
        different chain before v1.0.0, and those release notes describe a system that no longer
        exists — dead contract addresses, retired CLI flags, env vars nothing reads. They are kept
        verbatim in the repository at{' '}
        <M>docs/archive/pre-0g/CHANGELOG.md</M> rather than shown here,
        so that nothing on this page is something you could act on and be wrong.
      </div>

      <NextLinks
        links={[
          { href: '/docs/quickstart', label: 'Quickstart' },
          { href: '/docs/contract', label: 'Smart contracts' },
        ]}
      />
    </>
  );
}
