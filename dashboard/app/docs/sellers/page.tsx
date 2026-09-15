import { CommandBlock } from '@/components/copy';
import {
  Callout,
  CodeBlock,
  DocHeader,
  DocLink,
  DocTable,
  H2,
  H3,
  M,
  NextLinks,
  P,
  PropList,
  StepFlow,
} from '@/components/docs';

export const metadata = {
  title: 'Wrap an API',
  description:
    'Put an HTTP 402 paywall in front of your upstream API in one command: set a per-call price in OG, register the service on-chain, and collect native OG payments straight to your account.',
  alternates: { canonical: '/docs/sellers' },
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="FOR SELLERS"
        title="Wrap an API"
        lede="Turn any HTTP API into a pay-per-call service: register it on-chain and map it to your private upstream on the gateway with a single agentgate wrap command."
      />

      <H2 id="what-wrapping-does">What wrapping does</H2>
      <P>
        Wrapping an API performs two distinct side effects, in order. First it{' '}
        <strong className="text-white">registers the service on-chain</strong> in the 0G
        registry contract via a <M>registerService</M> transaction. The registry stores your
        service&apos;s name, description, price (in wei), payment target, attestor, owner, and
        an active flag — and crucially the <em>gateway base URL</em>, not your real upstream.
        Second it <strong className="text-white">maps the upstream on the gateway</strong> by
        signing an ownership challenge with your seller key and POSTing the mapping{' '}
        (<M>{'{ upstreamUrl, timestamp, signatureHex }'}</M>) to{' '}
        <M>POST &lt;gateway&gt;/services/&lt;serviceId&gt;/map</M> — no shared admin token. The
        gateway verifies the signature against the on-chain <M>owner</M> before storing it.
        (That is the live flow; a mock-mode wrap instead POSTs{' '}
        <M>{'{ serviceId, upstreamUrl }'}</M> to <M>/admin/services</M> with the dev admin
        token, which defaults to the same value on both sides.)
      </P>
      <P>
        Your upstream URL is never written on-chain. It is sent only to the gateway and
        lives only in the gateway&apos;s private mapping. Everyone reading the registry sees the
        canonical public endpoint computed as <M>&lt;gateway&gt;/svc/&lt;serviceId&gt;</M> — the
        paywall facade buyers actually call: unknown ids <M>404</M>, unmapped services{' '}
        <M>503</M>, paused services <M>403</M>, everything else gets the <M>402</M> challenge or
        the proxied response.
      </P>
      <DocTable
        head={['Side effect', 'Where', 'What is stored']}
        rows={[
          [
            <M key="a">registerService</M>,
            '0G registry (on-chain)',
            'name, description, gateway base URL, priceWei, paymentTarget, attestor, owner, active=true. Readers compute the public endpoint as <base>/svc/<id>.',
          ],
          [
            <M key="b">POST /services/&lt;id&gt;/map</M>,
            'gateway (private map)',
            'The owner-signed serviceId -> upstreamUrl mapping. This is the only place your real upstream URL exists.',
          ],
        ]}
      />

      <H2 id="prerequisites">Prerequisites</H2>
      <P>
        Wrapping signs an on-chain transaction, so you need a <strong className="text-white">seller
        signer</strong>. Which one depends on <M>AGENTGATE_MODE</M>. The published CLI defaults
        to <M>live</M>; mock mode is for the cloned-repo dev loop and needs{' '}
        <M>AGENTGATE_MODE=mock</M> plus a running local devnet (<M>npm run dev</M>) — outside it,{' '}
        <M>demo-accounts</M> fails with <M>MOCK_ONLY</M>.
      </P>
      <DocTable
        head={['Mode', 'Signer env var', 'How to get one']}
        rows={[
          [
            <M key="d">live</M>,
            <M key="e">SELLER_SIGNER_KEY</M>,
            'Your funded 0G private key — 0x + 64 hex — holding OG on the network you register on (Mainnet by default; Galileo under ZG_NETWORK_PROFILE=galileo).',
          ],
          [
            <M key="a">mock</M>,
            <M key="b">MOCK_SELLER_ACCOUNT</M>,
            <span key="c">
              A devnet public key. Run <DocLink href="/docs/cli">agentgate demo-accounts</DocLink>{' '}
              and paste the printed export lines into your shell.
            </span>,
          ],
        ]}
      />
      <P>
        If the required variable is unset, <M>agentgate wrap</M> aborts before any side effect with{' '}
        <M>SIGNER_MISSING</M>. The mock-mode message points you at{' '}
        <M>agentgate demo-accounts</M>; the live-mode message tells you to set{' '}
        <M>SELLER_SIGNER_KEY</M> (or pass <M>--key</M>). In live mode the upstream-mapping
        step authenticates by{' '}
        <strong className="text-white">signing with that same seller key</strong>, so no admin
        token is needed; mock mode uses the shared dev admin token instead (<M>AGENTGATE_ADMIN_TOKEN</M>,
        same default on CLI and gateway). In live mode the gateway defaults to the hosted{' '}
        <M>https://0g-gateway.equiflow.xyz</M>, so you don&apos;t need to run one yourself — pass{' '}
        <M>--gateway</M> to target a self-hosted gateway instead (mock mode defaults to{' '}
        <M>http://localhost:4021</M>).
      </P>
      <P>
        No key yet? Generate one with <M>cast wallet new</M> (or export the private key from any
        EVM wallet). On Mainnet — the default — fund it with real OG; at 0G&apos;s ~4 gwei a
        registration, a pause and a resume together cost well under 0.01 OG. To rehearse for free
        first, set <M>ZG_NETWORK_PROFILE=galileo</M> and fund the same key at{' '}
        <M>https://faucet.0g.ai</M> (0.1 OG per wallet per day) — the Galileo catalog is served by
        its own gateway, <M>https://0g-gateway.mdloglabs.org</M>, which <M>wrap</M> then needs as{' '}
        <M>--gateway</M>.
      </P>

      <H2 id="wrap-your-api">Wrap your API</H2>
      <P>
        Run wrap with <M>npx</M> (or <M>npm run agentgate --</M> from a cloned repo). The only
        positional argument is your upstream URL; everything else is a flag. The only thing you must
        supply besides the service metadata is your funded wallet key, via{' '}
        <M>SELLER_SIGNER_KEY</M>.
      </P>
      <CommandBlock
        wrap
        text={
          'npx agentgate-0g@latest wrap https://api.example.com/gold ' +
          '--price 2.5 --name "Gold Spot Feed" ' +
          '--description "Live gold spot price, refreshed every 10s"'
        }
      />
      <P>Arguments and flags:</P>
      <PropList
        items={[
          {
            name: '<upstreamUrl>',
            type: 'positional',
            required: true,
            desc: (
              <>
                The upstream API URL to wrap. Must be a valid <M>http://</M> or <M>https://</M>{' '}
                URL. Kept private — only ever sent to the gateway, never written
                on-chain.
              </>
            ),
          },
          {
            name: '--price <og>',
            type: 'string',
            required: true,
            desc: (
              <>
                Price per call in OG as a decimal string (e.g. <M>0.5</M>). Must be{' '}
                <strong className="text-white">greater than 0</strong> (the contract additionally
                requires ≥ <M>MIN_PRICE_WEI</M> = 1e12 wei, i.e. 0.000001 OG) and at most 18
                decimal places; it is converted to wei and stored on-chain. A non-positive price
                is rejected with <M>INVALID_PRICE</M>. There is no network minimum above that —
                see Pricing below.
              </>
            ),
          },
          {
            name: '--name <name>',
            type: 'string',
            required: true,
            desc: (
              <>
                Human-readable service name shown in the catalog. Non-empty, no control
                characters, at most 128 characters (<M>MAX_NAME_LENGTH</M>).
              </>
            ),
          },
          {
            name: '--key <0xhex>',
            type: 'string',
            required: false,
            default: 'SELLER_SIGNER_KEY',
            desc: (
              <>
                Your funded seller private key (<M>0x</M> + 64 hex).{' '}
                <strong className="text-white">Required in live mode</strong> — it signs the
                on-chain registration and the owner-signed gateway mapping.{' '}
                <strong className="text-white">Prefer the env var</strong>{' '}
                <M>SELLER_SIGNER_KEY</M>: unlike the old file path, <M>--key</M> carries the key
                itself and lands in shell history and <M>ps</M>. Empty &rarr;{' '}
                <M>SIGNER_MISSING</M>. (Mock mode uses <M>MOCK_SELLER_ACCOUNT</M> instead.)
              </>
            ),
          },
          {
            name: '--description <d>',
            type: 'string',
            required: false,
            default: "'' (empty)",
            desc: (
              <>
                Optional description for catalog listings. When provided: no control characters,
                at most 512 characters (<M>MAX_DESCRIPTION_LENGTH</M>).
              </>
            ),
          },
          {
            name: '--gateway <url>',
            type: 'url',
            required: false,
            default: 'https://0g-gateway.equiflow.xyz (live) / http://localhost:4021 (mock)',
            desc: (
              <>
                Gateway base URL, defaulting to the hosted{' '}
                <M>https://0g-gateway.equiflow.xyz</M> in live mode and{' '}
                <M>http://localhost:&lt;MIDDLEWARE_PORT|4021&gt;</M> in mock mode. This — not the
                upstream — is the{' '}
                <M>endpointUrl</M> stored on-chain; the public endpoint becomes{' '}
                <M>&lt;gateway&gt;/svc/&lt;id&gt;</M>. Must be a base URL with no query string or
                fragment. In live mode a non-loopback host{' '}
                <strong className="text-white">must</strong> use <M>https://</M> (your signed
                mapping is POSTed here).
              </>
            ),
          },
          {
            name: '--payment-target <address>',
            type: 'string',
            required: false,
            default: 'derived from the seller signer',
            desc: (
              <>
                Address that receives buyer payments, in <M>0x&lt;40 hex&gt;</M> form. Defaults
                to the address of your signer. Invalid formats are rejected with{' '}
                <M>INVALID_ADDRESS</M>.
              </>
            ),
          },
          {
            name: '--attestor <address>',
            type: 'string',
            required: false,
            default: "the gateway's advertised attestor",
            desc: (
              <>
                EVM address allowed to record attestations for this service. By default{' '}
                <M>wrap</M> asks the gateway who it signs as (<M>GET /healthz</M> advertises{' '}
                <M>attestor</M>) and registers that, so the gateway that serves your calls can
                score them; an explicit value that differs from it is accepted with a warning,
                because the registry then rejects that gateway&apos;s attestations and the score
                stays 0/0. Falls back to your signer&apos;s address only if the gateway advertises
                none. Must be <M>0x</M>+40 hex, else <M>INVALID_ADDRESS</M>.
              </>
            ),
          },
        ]}
      />
      <P>On success the CLI prints the service id, public endpoint, dashboard link and tx hash:</P>
      <CodeBlock
        code={[
          'service id:      5',
          'public endpoint: https://0g-gateway.equiflow.xyz/svc/5',
          'dashboard:       https://agentgate.equiflow.xyz/services/5',
          'register tx:     <txHash>',
        ].join('\n')}
      />

      <H2 id="verify">Verify it works</H2>
      <P>
        An unpaid request to the public endpoint must answer <M>HTTP 402</M> with an x402
        challenge — that is the paywall working, not an error:
      </P>
      <CommandBlock text="curl -i https://0g-gateway.equiflow.xyz/svc/5" />
      <CodeBlock
        label="expected (trimmed)"
        code={[
          'HTTP/2 402',
          '',
          '{"x402Version":1,"error":"X-PAYMENT header is required",',
          ' "accepts":[{"scheme":"exact-settled","network":"0g-mainnet","maxAmountRequired":"2500000000000000000",',
          '   "asset":"OG","payTo":"0x…","resource":"https://0g-gateway.equiflow.xyz/svc/5",',
          '   …,"extra":{"nonce":"…","serviceId":5,"router":"0x5102…45eF",…}}]}',
        ].join('\n')}
      />
      <P>
        Then confirm the registration transaction on the explorer at{' '}
        <M>https://chainscan.0g.ai/tx/&lt;txHash&gt;</M> (<M>chainscan-galileo.0g.ai</M> on the
        testnet) and read the record back from the chain with{' '}
        <M>npx agentgate-0g@latest status 5</M> (substitute the id wrap printed).
      </P>

      <H2 id="under-the-hood">What happens under the hood</H2>
      <StepFlow
        steps={[
          {
            title: 'Validate everything first',
            body: (
              <>
                Name, description, upstream URL, gateway base and price are all checked before any
                side effect. Fail-fast: nothing is registered if an input is bad.
              </>
            ),
          },
          {
            title: 'Register the service on-chain',
            body: (
              <>
                A <M>registerService</M> transaction is signed with your seller signer. The{' '}
                <M>endpointUrl</M> written to the registry is the gateway base URL; the contract
                assigns a sequential <M>serviceId</M> and returns it plus the transaction hash.
              </>
            ),
          },
          {
            title: 'Map the upstream on the gateway',
            body: (
              <>
                The CLI signs an ownership challenge with your seller key and POSTs{' '}
                <M>{'{ upstreamUrl, timestamp, signatureHex }'}</M> to{' '}
                <M>&lt;gateway&gt;/services/&lt;id&gt;/map</M>. The gateway checks the signature
                against the on-chain owner (plus freshness and SSRF) — this is the only step that
                knows your real upstream.
              </>
            ),
          },
          {
            title: 'Report the result',
            body: (
              <>
                On success it prints the id, public endpoint{' '}
                (<M>&lt;gateway&gt;/svc/&lt;id&gt;</M>), dashboard URL and tx hash. If the mapping
                step failed, the on-chain registration is <strong className="text-white">not</strong>{' '}
                rolled back and you&apos;ll need to re-create the mapping (see Troubleshooting).
              </>
            ),
          },
        ]}
      />

      <H2 id="manage-a-service">Manage a service</H2>
      <P>
        After wrapping, manage the service with the other CLI commands. <M>list</M> and{' '}
        <M>status</M> read the chain (no signer needed); <M>pause</M> and <M>resume</M> sign a{' '}
        <M>setActive</M> transaction and require the same seller signer as wrap. The examples
        reuse service id <M>1</M> from the wrap output above — substitute your own id.
      </P>
      <DocTable
        head={['Command', 'What it does']}
        rows={[
          [
            <M key="a">agentgate list</M>,
            'Prints the on-chain catalog: id, name, price, trust tier, score (success/total), active flag and endpoint.',
          ],
          [
            <M key="b">agentgate status &lt;id&gt;</M>,
            <span key="b2">
              Shows one service in depth: record, score, trust tier and recent attestations —
              all of it with no keys and no API key, since attestation history is a contract view
              call. Id must be a positive integer.
            </span>,
          ],
          [
            <M key="c">agentgate pause &lt;id&gt;</M>,
            'setActive(false) on a service you own — the paywall then answers 403.',
          ],
          [
            <M key="d">agentgate resume &lt;id&gt;</M>,
            'setActive(true) — calls flow again. The score is untouched by pause/resume.',
          ],
        ]}
      />
      <CommandBlock text="npx agentgate-0g@latest list" />
      <CommandBlock text="npx agentgate-0g@latest status 1" />
      <CommandBlock text="npx agentgate-0g@latest pause 1" />
      <CommandBlock text="npx agentgate-0g@latest resume 1" />
      <P>
        <M>pause</M> and <M>resume</M> re-fetch the record and print the service, its new active
        state and the <M>setActive</M> tx hash. Full reference in{' '}
        <DocLink href="/docs/cli">CLI reference</DocLink>.
      </P>

      <H2 id="pricing-payment-attestor">Pricing, payment target and attestor</H2>
      <P>
        <M>--price</M> is a decimal OG string converted to wei (1 OG = 1e18 wei). It must be
        strictly positive and use at most 18 decimal places; all comparisons use bigint math,
        never floats. Buyers pay in <strong className="text-white">native OG</strong> by calling{' '}
        <M>PaymentRouter.pay</M>, which forwards the whole amount straight to your{' '}
        <M>paymentTarget</M> — the gateway never holds or forwards funds, it only verifies the
        payment happened on-chain before proxying.
      </P>
      <Callout tone="ok" title="No network floor — price as small as you like">
        The only minimum is the contract&apos;s <M>MIN_PRICE_WEI</M> (0.000001 OG), so genuine
        per-call micropricing works. The gateway accepts any amount at or above your price, and
        the bundled buyers (<M>agentgate buy</M>, the SDK, the LLM agent) pay{' '}
        <em>exactly</em> the invoice. The practical floor is your buyer&apos;s gas: price above
        what it costs them to pay you, or paying is irrational.
      </Callout>
      <P>
        <M>paymentTarget</M> defaults to the address derived from your signer, so by default
        revenue lands in your own account. Override it with <M>--payment-target</M> to route
        payments elsewhere. The <M>attestor</M> is the address permitted to record
        success/failure attestations that build your trust score; it defaults to your signer&apos;s
        public key but <strong className="text-white">must be set to the gateway&apos;s signer</strong>{' '}
        with <M>--attestor</M> for the gateway to record attestations on your behalf.
      </P>
      <Callout tone="warn" title="Trust score needs the gateway's key">
        <P>
          On the hosted gateway, attestations are signed by the gateway&apos;s own signer key,
          and the registry contract only accepts them when the caller is your service&apos;s{' '}
          <M>attestor</M> (or its <M>owner</M>). If you keep the default — your own key — the
          hosted gateway cannot record attestations for you and your score stays <M>0/0</M>.
          Pass <M>--attestor &lt;gateway signer public key&gt;</M> at wrap time (ask the gateway
          operator for that key; on a self-hosted gateway it is the public key of your{' '}
          <M>GATE_SIGNER_KEY</M>).
        </P>
      </Callout>

      <H2 id="going-live">Going live</H2>
      <P>
        Live mode (<M>AGENTGATE_MODE=live</M>) targets 0G — Mainnet by default, real OG — and adds
        two hard requirements:
      </P>
      <DocTable
        head={['Requirement', 'Why']}
        rows={[
          [
            <span key="a">
              <M>SELLER_SIGNER_KEY</M> set to a 0x-prefixed 32-byte hex key
            </span>,
            'wrap, pause and resume must sign real transactions. A malformed key fails at config load, reported by variable name — the value is never echoed.',
          ],
          [
            <span key="b">
              <M>--gateway</M> uses <M>https://</M> for any non-localhost host
            </span>,
            'Your signed upstream mapping is POSTed to the gateway; cleartext http would expose it. Non-loopback http is rejected with INSECURE_URL.',
          ],
        ]}
      />
      <Callout tone="warn" title="Your signer key is a secret in the environment">
        <P>
          This changed with 0G: the seller signer is a raw private key, not a path to a key file.
          A <M>--key</M> argument lands in shell history and is visible in <M>ps</M>; an env var
          is readable through <M>docker inspect</M>, <M>/proc/&lt;pid&gt;/environ</M> and crash
          dumps. Neither is as contained as a mode-600 file was, so:
        </P>
        <P>
          Use <M>SELLER_SIGNER_KEY</M> rather than <M>--key</M>, load it from your shell&apos;s
          secret store or a mode-600 env file you source, and keep the key funded but thin.
          Anyone who reads it can register, pause and resume services as you — and move your
          funds.
        </P>
      </Callout>
      <P>
        The <M>--payment-target</M> and <M>--attestor</M> defaults are derived from that key&apos;s
        address. A malformed key fails with <M>invalid_signer</M> —{' '}
        <em>private key must be 0x + 64 hex within the secp256k1 range</em> — and the value itself
        never appears in the message.
      </P>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <H3 id="ts-non-idempotent">Wrap is not idempotent</H3>
      <P>
        Each successful wrap registers a <strong className="text-white">new</strong> service with a
        new id. Re-running it does not update an existing service — it creates a duplicate. On a
        self-hosted admin-token gateway you can fix a broken mapping directly (see below); on the
        hosted gateway a failed mapping currently means wrapping again and pausing the orphan.
      </P>
      <H3 id="ts-admin-map-failed">Gateway upstream mapping failed</H3>
      <P>
        If step 2 fails (gateway unreachable, signature rejected, timeout), the on-chain
        registration is <strong className="text-white">not rolled back</strong> —{' '}
        <M>/svc/&lt;id&gt;</M> answers <M>503 service_unavailable</M> until the mapping exists.
        On the hosted gateway there is currently no standalone re-map command, and the
        owner-signed challenge the CLI POSTed expires after two minutes, so it cannot be replayed
        later. The practical recovery is to run <M>wrap</M> again once the gateway is reachable —
        it registers a fresh id and maps it atomically — then{' '}
        <M>agentgate pause &lt;old id&gt;</M> to retire the orphaned registration.
      </P>
      <H3 id="ts-selfhosted-remap">Self-hosted (admin-token) gateways</H3>
      <P>
        On a self-hosted gateway using the shared admin token (the mock-mode wrap path), the
        CLI&apos;s stderr warning prints the exact retry curl, so you can re-create the mapping
        directly with the admin endpoint (the curl references <M>$AGENTGATE_ADMIN_TOKEN</M> from
        your environment so no secret is printed):
      </P>
      <CodeBlock
        label="retry curl (re-create the upstream mapping)"
        code={[
          "curl -X POST 'http://localhost:4021/admin/services' \\",
          '  -H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN" \\',
          "  -H 'Content-Type: application/json' \\",
          '  -d \'{"serviceId":1,"upstreamUrl":"https://api.example.com/gold"}\'',
        ].join('\n')}
      />
      <Callout tone="info" title="Make sure the token is exported">
        The retry curl expects <M>AGENTGATE_ADMIN_TOKEN</M> in your shell environment. Export it
        (the same value the gateway runs with) before pasting the command.
      </Callout>
      <H3 id="ts-name-limits">Name / description rejected</H3>
      <P>
        On-chain text fields are validated before registration. <M>--name</M> must be non-empty
        and at most 128 characters; <M>--description</M>, when provided, at most 512 characters.
        Neither may contain control characters (the C0 range and DEL) — these are rejected with{' '}
        <M>INVALID_INPUT</M> and the message names the offending field. Leading and trailing
        whitespace is trimmed before the length check.
      </P>

      <NextLinks
        links={[
          { href: '/docs/cli', label: 'CLI reference' },
          { href: '/docs/buyers', label: 'Build an agent' },
        ]}
      />
    </>
  );
}
