import type { Metadata } from 'next';
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
} from '@/components/docs';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/errors' },
  title: 'Error codes',
  description:
    'Every AgentGate error code: the AgentGateError(code, message, httpStatus) shape, the lowercased JSON error body, and a code-by-code reference grouped by config, chain/live, the 402 paywall + admin API, the client SDK, the buyer agent, the CLI, and internal/mock-devnet codes.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="REFERENCE"
        title="Error codes"
        lede="AgentGate fails loudly with one structured error type. This page lists every code you can hit in normal operation — its HTTP status, what it means, and how to fix it — grouped by the package that raises it, with a closing table for internal and mock-devnet stragglers."
      />

      {/* ════════════════════════════ THE SHAPE ════════════════════════════ */}
      <H2 id="shape">The error shape</H2>
      <P>
        Every package throws a single error class, <M>AgentGateError</M>, defined in{' '}
        <M>packages/shared/src/errors.ts</M>. It carries three fields: a stable machine-readable{' '}
        <M>code</M>, a human <M>message</M>, and the <M>httpStatus</M> a server should respond with
        when the error escapes (defaults to <M>500</M>).
      </P>

      <CodeBlock
        label="packages/shared/src/errors.ts"
        code={
          'export class AgentGateError extends Error {\n' +
          '  readonly code: string;\n' +
          '  readonly httpStatus: number;\n' +
          '  constructor(code: string, message: string, httpStatus = 500) { /* ... */ }\n' +
          '}\n' +
          '\n' +
          '// Type guard used at every catch site:\n' +
          'export function isAgentGateError(err: unknown): err is AgentGateError;'
        }
      />

      <P>
        Codes come in two casing conventions, both intentional. Internal/programmatic codes are{' '}
        <M>SCREAMING_SNAKE_CASE</M> (e.g. <M>CONTRACT_NOT_DEPLOYED</M>, <M>PRICE_EXCEEDED</M>). HTTP-facing
        codes that the gateway sends on the wire are already <M>lowercase_snake_case</M> (e.g.{' '}
        <M>service_not_found</M>, <M>rate_limited</M>).
      </P>

      <H3 id="json-body">JSON error bodies</H3>
      <P>
        The gateway&apos;s final error handler (<M>packages/middleware/src/app.ts</M>) serializes
        any escaping <M>AgentGateError</M> as a JSON object whose single <M>error</M> field is the{' '}
        <em>lowercased</em> code, and responds with the error&apos;s <M>httpStatus</M>:
      </P>

      <CodeBlock
        label="middleware error handler (simplified)"
        code={
          "if (err instanceof AgentGateError) {\n" +
          "  res.status(err.httpStatus).json({ error: err.code.toLowerCase() });\n" +
          "}\n" +
          "// any other (non-AgentGateError) throw:\n" +
          "res.status(500).json({ error: 'internal_error' });"
        }
      />

      <P>
        So a <M>CONFIG_INVALID</M> thrown deep inside a request becomes{' '}
        <M>{'{ "error": "config_invalid" }'}</M> over HTTP, while the codes already emitted directly
        by the gateway (the 402 reasons, <M>service_not_found</M>, etc.) are returned verbatim.
        Bodies never leak the upstream URL, stack traces, or token material — only the code.
      </P>

      <Callout tone="info" title="Live-mode-only codes">
        Codes prefixed <M>TX_*</M> and <M>CONTRACT_NOT_DEPLOYED</M> only
        appear in <M>live</M> mode (0G Mainnet or Galileo). In <M>mock</M> mode the chain is the in-process
        devnet and these never fire. See <DocLink href="/docs/configuration">Configuration</DocLink>{' '}
        for the mode switch.
      </Callout>

      {/* ════════════════════════════ CONFIG ════════════════════════════ */}
      <H2 id="config">Configuration errors</H2>
      <P>
        Raised by <M>loadConfig()</M> (<M>packages/shared/src/config.ts</M>) and the money helpers (
        <M>packages/shared/src/money.ts</M>) while reading the environment contract.{' '}
        <M>CONFIG_INVALID</M> is thrown by <M>loadConfig()</M> at startup, so a bad environment
        never half-runs; <M>INVALID_AMOUNT</M> is raised wherever a OG/wei string is first
        parsed — a CLI flag at command run, an SDK option at client construction.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="ci">CONFIG_INVALID</M>,
            '500',
            'An env var is missing, malformed, or an invalid combination: unknown AGENTGATE_MODE; a non-integer port/timeout; a bad URL; a malformed BUYER_BUDGET_OG; a *_SIGNER_KEY that is not 0x + 64 hex; a REGISTRY_CONTRACT_ADDRESS that is not a 0x address; live mode still using the default AGENTGATE_ADMIN_TOKEN; or a live-mode gateway started without GATE_SIGNER_KEY (the attestor signing key — the gateway refuses the mock-signer fallback). A malformed key is reported by variable name; the value is never echoed.',
            'Read the message — it names the exact variable and the constraint it violated. Set a valid value and restart.',
          ],
          [
            <M key="ia">INVALID_AMOUNT</M>,
            '400',
            'A OG/wei value (e.g. --price, maxPriceWei) is not a plain non-negative decimal string within ≤ 18 decimal places. (A malformed BUYER_BUDGET_OG surfaces as CONFIG_INVALID instead.)',
            'Pass a positive decimal string of OG (e.g. "0.5") or an integer wei string — no signs, exponents, or commas.',
          ],
        ]}
      />

      {/* ════════════════════════════ CHAIN / LIVE ════════════════════════════ */}
      <H2 id="chain">Chain / live-mode errors</H2>
      <P>
        Thrown by the live 0G client (<M>packages/chain/src/live-0g.ts</M>) when talking to the
        public RPC or a contract. These are the failures you hit on 0G; in mock mode the
        in-process devnet is used instead.
      </P>

      <Callout tone="ok" title="Contracts are deployed">
        The three Solidity contracts are live on 0G Mainnet and Galileo, and the mainnet set is the CLI and gateway default,
        so <M>CONTRACT_NOT_DEPLOYED</M> (503) now means the addresses were explicitly cleared —{' '}
        <M>REGISTRY_CONTRACT_ADDRESS</M> or <M>PAYMENT_ROUTER_ADDRESS</M> set to an empty value —
        rather than a missing deployment. There is <strong className="text-white">no API key
        anywhere</strong> in the read path, so none of the old indexer error codes exist any more.
      </Callout>

      <H3 id="chain-deploy">Contracts &amp; transactions</H3>
      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="cnd">CONTRACT_NOT_DEPLOYED</M>,
            '503',
            'A registry call ran with REGISTRY_CONTRACT_ADDRESS unset, or a payment/verification ran with PAYMENT_ROUTER_ADDRESS unset. Checked before any IO, so it costs no round-trip.',
            'Deploy the contracts (contracts-evm/README.md) and set the addresses. Reads other than getBalance need the registry; paying and verifying need the router.',
          ],
          [
            <M key="tf">TX_FAILED</M>,
            '502',
            'A write was mined but REVERTED on-chain, or a registerService receipt carried no ServiceRegistered event. Every write waits for its receipt and checks the status rather than reporting success on submission.',
            'Read the revert reason on the explorer: usually a custom error from the contract (NotAuthorized, ServiceInactive, DuplicateAttestation, InvalidPrice, EmptyName, DuplicateNonce). Fix the cause — retrying the identical transaction fails identically.',
          ],
          [
            <M key="is">invalid_signer</M>,
            '400',
            'A signing operation got a signer that is not a key signer, or a private key that is not 0x + 64 hex within the secp256k1 range.',
            'Use a key signer in live mode (only mock mode accepts mock signers) and check the *_SIGNER_KEY value. The error deliberately NEVER quotes the key.',
          ],
          [
            <M key="iq">invalid_query</M>,
            '400',
            'A service id was not a positive integer.',
            'Service ids are 1-based; 0 and negatives are always absent.',
          ],
        ]}
      />

      <H3 id="chain-verify">Payment verification outcomes</H3>
      <P>
        <M>verifyTransfer</M> does not throw for a payment that simply does not satisfy the
        invoice — it returns a typed reason the gateway turns into a <M>402</M>. It{' '}
        <em>does</em> throw on an RPC outage, deliberately: swallowing that would answer
        &ldquo;still settling, retry in 2 s&rdquo; to every buyer for the whole outage, with
        nothing in the logs telling an operator the node is down.
      </P>
      <DocTable
        head={['Reason', 'Meaning']}
        rows={[
          [<M key="p">pending</M>, 'No receipt yet — unmined, or mined but not propagated to this node. RETRYABLE: the gateway keeps the same invoice alive and answers 402 + Retry-After.'],
          [<M key="nf">not_found</M>, 'The tx hash is malformed, the transaction reverted, or its receipt carries no Paid log from the CONFIGURED router. A look-alike event from another contract is ignored by design.'],
          [<M key="wt">wrong_target</M>, "No Paid log in that receipt pays the service's paymentTarget."],
          [<M key="wid">wrong_nonce</M>, 'A Paid log pays the right target but does not carry BOTH this serviceId and this nonce. Both are required: a nonce is unique only per service, and payment targets are shared across services.'],
          [<M key="atl">amount_too_low</M>, 'The matching payment is below the invoiced price. Overpayment is accepted.'],
          [<M key="ex">expired</M>, 'The payment is older than the invoice TTL.'],
        ]}
      />

      <H3 id="chain-state">Mock-mode (devnet) errors</H3>
      <P>
        The in-process devnet mirrors the contract&apos;s rules so mock and live behave
        identically. It uses the same <M>0x&lt;40 hex&gt;</M> address shape as live, so every
        address code path is exercised in both modes.
      </P>
      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="ipk">invalid_public_key</M>,
            '400',
            'A mock signer carried an empty or non-string public key.',
            'Export MOCK_BUYER_ACCOUNT / MOCK_SELLER_ACCOUNT — run `agentgate demo-accounts --mode mock`.',
          ],
          [
            <M key="iq2">invalid_query</M>,
            '400',
            'A read/write argument failed validation: empty account, non-positive serviceId, bad amountWei, or an out-of-range nonce.',
            'Correct the offending argument per the message.',
          ],
          [
            <M key="du">devnet_unreachable / devnet_timeout / devnet_error</M>,
            '502 / 504',
            'The devnet at DEVNET_URL refused the connection, exceeded UPSTREAM_TIMEOUT_MS, or answered non-2xx.',
            'Start the stack with `npm run dev`, and check DEVNET_URL (default http://localhost:4030).',
          ],
          [
            <M key="en">empty_name / invalid_price / duplicate_attestation</M>,
            '400 / 409',
            'The devnet enforced the same rules as the contract: a non-empty name, a price at or above the floor, and one attestation per (service, payment).',
            'Give a non-empty name and a price ≥ MIN_PRICE_WEI (1e12 wei); do not re-attest the same payment.',
          ],
        ]}
      />

      {/* ════════════════════════════ PAYWALL / GATEWAY HTTP ════════════════════════════ */}
      <H2 id="paywall">Paywall &amp; gateway HTTP errors</H2>
      <P>
        These are emitted directly by the middleware (<M>packages/middleware/src/app.ts</M>) and are
        already lowercase on the wire. The 402 reason codes (<M>PaywallErrorCode</M> in{' '}
        <M>packages/middleware/src/types.ts</M>) are attached to the <M>error</M> field of the 402{' '}
        invoice body so a buyer agent can tell <em>why</em> a proof was rejected and decide whether
        to retry or re-pay.
      </P>

      <H3 id="paywall-402">402 reasons (PaywallErrorCode)</H3>
      <P>
        A <M>402</M> response is a JSON <M>PaymentRequiredResponse</M> body with an <M>error</M>{' '}
        field. On the very first request (no <M>X-PAYMENT</M> header yet) the field is the literal
        string <M>{'"X-PAYMENT header is required"'}</M> — that is the normal challenge, not a
        failure. After a proof is presented, the field is one of the rejection codes below. When
        the payment is still settling the error is{' '}
        <M>{'"settlement_pending"'}</M> and a standard <M>Retry-After: 2</M> response header
        (seconds) is set — the same <M>accepts[]</M> entry (same nonce) is kept alive so the
        identical <M>X-PAYMENT</M> proof can be retried. Every other rejection re-issues a fresh{' '}
        <M>accepts[]</M> with a new nonce.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="iph">invalid_payment_header</M>,
            '402',
            'The X-PAYMENT header was not valid base64, not JSON, or the decoded PaymentPayload had wrong x402Version, scheme, or network. A fresh accepts[] is issued.',
            'Re-encode the PaymentPayload correctly (x402Version:1, scheme:"exact-settled", network matching the challenge).',
          ],
          [
            <M key="ue">unknown_nonce</M>,
            '402',
            'The nonce in the X-PAYMENT payload is well-formed but matches no live invoice, or the invoice belongs to a different service. (A syntactically malformed nonce is rejected earlier as invalid_payment_header.) A fresh accepts[] is issued.',
            'Use the nonce from the most recent 402 PaymentRequiredResponse for THIS service.',
          ],
          [
            <M key="iu">invoice_used</M>,
            '402',
            'The nonce was already burned — invoices are single-use. A fresh invoice is issued.',
            'Pay against the new invoice/nonce returned in this 402; never reuse a spent nonce.',
          ],
          [
            <M key="iex">invoice_expired</M>,
            '402',
            'The invoice TTL elapsed before a valid proof arrived (INVOICE_TTL_MS, default 5 min). A fresh invoice is issued.',
            'Pay and present proof within the TTL using the new invoice.',
          ],
          [
            <M key="nf">not_found</M>,
            '402',
            'verifyTransfer found no matching Paid log: the tx hash is malformed, the transaction reverted, or its receipt carries no Paid event from the configured PaymentRouter.',
            'Provide the tx hash of the PaymentRouter.pay call in payload.transaction. A plain value transfer to payTo produces no Paid log and can never be redeemed.',
          ],
          [
            <M key="wt">wrong_target</M>,
            '402',
            "The transfer did not pay the service's paymentTarget.",
            'Transfer to the paymentTarget quoted in the invoice.',
          ],
          [
            <M key="atl">amount_too_low</M>,
            '402',
            "The transfer paid less than the invoice's priceWei.",
            'Pay at least the full priceWei.',
          ],
          [
            <M key="wti">wrong_nonce</M>,
            '402',
            "The native transfer's nonce did not equal the invoice nonce.",
            'Set nonce = nonce on the OG transfer.',
          ],
          [
            <M key="ex">expired</M>,
            '402',
            'The transfer settled but is older than the invoice TTL (replay/stale-proof guard).',
            'Pay fresh against a current invoice; do not reuse an old transfer.',
          ],
          [
            <M key="pe">settlement_pending</M>,
            '402',
            <>The transfer exists but has not settled yet. Same <M>accepts[]</M> nonce is kept; <M>Retry-After: 2</M> response header is set.</>,
            <>Wait the <M>Retry-After</M> seconds and retry the identical <M>X-PAYMENT</M> proof (the SDK does this up to 5×).</>,
          ],
        ]}
      />

      <H3 id="paywall-proxy">After payment: upstream proxy failures</H3>
      <P>
        The nonce is burned <em>before</em> the gateway proxies to the upstream, so these codes
        reach a buyer whose invoice is already spent. The body is a plain{' '}
        <M>{'{ "error": "<code>" }'}</M>; the <M>X-PAYMENT-RESPONSE</M> settlement header is still
        set (the payment itself succeeded). These calls are not attested either way — a
        gateway-level proxy failure is the seller&apos;s backend being unreachable, not a service
        outcome, so it never moves the trust score.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="uur">upstream_unreachable</M>,
            '502',
            "The paid request could not reach the seller's upstream (DNS/connect failure, or the pinned public IP refused the connection).",
            'Seller-side outage — retry with a fresh invoice. Sellers: check the mapped upstream is up and publicly resolvable.',
          ],
          [
            <M key="uto">upstream_timeout</M>,
            '504',
            'The upstream did not answer within UPSTREAM_TIMEOUT_MS (default 30 s).',
            'Retry with a fresh invoice. Sellers: speed up the upstream or raise UPSTREAM_TIMEOUT_MS.',
          ],
          [
            <M key="utl">upstream_request_too_large / upstream_response_too_large</M>,
            '502',
            'The forwarded JSON body or the upstream response exceeded the 1 MiB proxy cap.',
            'Keep proxied bodies under 1 MiB in both directions.',
          ],
        ]}
      />

      <H3 id="paywall-http">Gateway HTTP status codes</H3>
      <P>
        Other gateway outcomes return a plain <M>{'{ "error": "<code>" }'}</M> body with the status
        below.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="snf">service_not_found</M>,
            '404',
            'The :id was not a valid id or no such service is registered on-chain.',
            'Use an existing on-chain service id.',
          ],
          [
            <M key="si">service_inactive</M>,
            '403',
            'The service exists but its on-chain active flag is false (paused by its owner).',
            'Wait for the owner to resume it (agentgate resume <id>).',
          ],
          [
            <M key="su">service_unavailable</M>,
            '503',
            'The service is registered on-chain but has no upstream mapping on this gateway, or (live) its upstream host now resolves to a forbidden/private address. Never charged.',
            'Map the upstream — in live mode the seller `wrap` self-service maps via POST /services/:id/map (owner signature, no admin token); POST /admin/services still exists for admin/mock mapping. In live mode also ensure the upstream resolves to a public host.',
          ],
          [
            <M key="umt">unsupported_media_type</M>,
            '415',
            'A non-JSON request body was sent to the paywalled proxy. The gateway only forwards JSON bodies, so it refuses BEFORE charging.',
            'Send application/json (or no body for GET/HEAD).',
          ],
          [
            <M key="rl">rate_limited</M>,
            '429',
            'Too many requests: /svc/* allows 60/min, /admin/* allows 20/min, and the self-service /services/* map endpoint allows 20/min, keyed by client IP. Includes draft-7 RateLimit-* headers.',
            'Back off and retry after the window; honor the reset value in the draft-7 RateLimit / RateLimit-Policy headers.',
          ],
          [
            <M key="ptl">payload_too_large</M>,
            '413',
            'The JSON request body exceeded the 256 KB limit.',
            'Send a smaller body.',
          ],
          [
            <M key="ij">invalid_json</M>,
            '400',
            'The request declared JSON but the body failed to parse.',
            'Send well-formed JSON.',
          ],
          [
            <M key="un">unauthorized</M>,
            '401',
            'An /admin/* request had a missing or wrong Authorization: Bearer <admin token> (constant-time compared).',
            "Send Authorization: Bearer $AGENTGATE_ADMIN_TOKEN matching the gateway's token.",
          ],
          [
            <M key="ib">invalid_body / invalid_service_id</M>,
            '400',
            'An /admin/services request had a non-object body or a serviceId that was not a non-negative safe integer.',
            'POST { "serviceId": <int>, "upstreamUrl": "<http(s) url>" } with valid types.',
          ],
          [
            <M key="nfx">not_found</M>,
            '404',
            'No route matched (the catch-all fallback).',
            'Check the path; see the HTTP API reference.',
          ],
          [
            <M key="ie">internal_error</M>,
            '500',
            'An unexpected (non-AgentGateError) exception escaped; details are logged, not returned.',
            'Check the gateway logs for the underlying error.',
          ],
        ]}
      />

      <Callout tone="info" title="Admin upstream validation">
        <M>POST /admin/services</M> also returns <M>400</M> with the SSRF-guard&apos;s own reason
        codes (e.g. <M>invalid_upstream_url</M>, <M>forbidden_upstream_host</M>) when the supplied{' '}
        <M>upstreamUrl</M> is not an acceptable public http(s) URL. The same reason codes apply to
        the self-service <M>POST /services/:id/map</M> endpoint below. See{' '}
        <DocLink href="/docs/security">Security</DocLink> for the host policy.
      </Callout>

      <H3 id="paywall-selfmap">Self-service map errors (POST /services/:id/map)</H3>
      <P>
        <M>agentgate wrap</M> in live mode maps the upstream by POSTing an owner-signed request to{' '}
        <M>/services/:id/map</M> — no admin token. Besides <M>invalid_service_id</M> /{' '}
        <M>invalid_body</M> (400), <M>service_not_found</M> (404) and the SSRF reason codes above
        (400), the signature auth can fail with:
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="str">stale_request</M>,
            '401',
            'The signed timestamp is outside the ±2 min freshness window — the wrap request is too old, or the machine clock is skewed.',
            'Re-run agentgate wrap (it signs a fresh timestamp); check the machine clock.',
          ],
          [
            <M key="nso">not_service_owner</M>,
            '401',
            'Either the signature did not verify, OR it verified but the recovered address is not the on-chain owner. The two are DELIBERATELY indistinguishable: telling them apart would let a caller probe whether a given key owns a service.',
            'Sign with the exact key that registered the service (SELLER_SIGNER_KEY).',
          ],
          [
            <M key="rpl">replayed</M>,
            '409',
            'The timestamp is not newer than the last accepted mapping for this service (per-service replay guard).',
            'Re-run wrap to sign a newer timestamp.',
          ],
        ]}
      />

      {/* ════════════════════════════ CLIENT / SDK ════════════════════════════ */}
      <H2 id="client">Client SDK errors</H2>
      <P>
        Thrown by <M>createAgentGateClient().fetchPaid()</M> in the buyer-side SDK (
        <M>packages/client/src/index.ts</M>). These surface as <M>AgentGateError</M> at the call
        site — your agent catches them, not the gateway.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="bu">BAD_URL</M>,
            '400',
            'fetchPaid was given an empty, non-string, or non-http(s) URL.',
            'Pass a valid http(s) endpoint URL.',
          ],
          [
            <M key="fh">FORBIDDEN_HOST</M>,
            '400',
            "SSRF guard: the URL's host is (or resolves to) a private / loopback / link-local address while rejectPrivateHosts is on (default in live mode).",
            'Only fetch public hosts in live mode; the endpointUrl is seller-controlled on-chain data.',
          ],
          [
            <M key="nm">NETWORK_MISMATCH</M>,
            '502',
            'No accepts[] entry in the PaymentRequiredResponse matches the chain client\'s network — refusing to pay on the wrong chain.',
            'Use a client configured for the same network the 402 challenge was issued on.',
          ],
          [
            <M key="px">PRICE_EXCEEDED</M>,
            '402',
            "The invoice priceWei exceeds the caller's maxPriceWei cap. No payment is sent.",
            'Raise maxPriceWei — or agentgate buy --max — if the price is acceptable, or skip the service. (The buyer agent treats this as a budget refusal.)',
          ],
          [
            <M key="bi">BAD_INVOICE</M>,
            '502',
            'The 402 body was not JSON or failed PaymentRequiredResponse validation: wrong x402Version, empty accepts[], no accepts[] entry for scheme "exact-settled", bad maxAmountRequired/payTo/nonce, or an already-expired invoice (extra.expiresAtMs in the past). An entry that matches the scheme but not your network raises NETWORK_MISMATCH instead.',
            'The gateway returned a malformed/expired challenge — investigate the server; do not pay.',
          ],
          [
            <M key="ut">UPSTREAM_TIMEOUT</M>,
            '504',
            'A fetchPaid request (initial or proof retry) timed out (requestTimeoutMs, default 30 s).',
            'Retry; raise requestTimeoutMs if the upstream is legitimately slow.',
          ],
          [
            <M key="iamt">INVALID_AMOUNT</M>,
            '400',
            'A OG/wei string failed to parse (e.g. maxPriceWei, an amount, a transfer id) — raised by parseWei / ogToWei in @agentgate/shared. Also surfaces from the CLI (a malformed --price); a malformed BUYER_BUDGET_OG surfaces as CONFIG_INVALID instead.',
            'Pass a non-negative decimal OG string with at most 18 decimal places (or an integer wei string).',
          ],
          [
            <M key="bo">BAD_OPTS</M>,
            '500',
            'createAgentGateClient was misconfigured: missing options object, a chain without transfer(), or a signer that is neither mock nor key.',
            'Pass { chain, signer } with a valid ChainClient and a mock/key signer.',
          ],
        ]}
      />

      {/* ════════════════════════════ BUYER AGENT ════════════════════════════ */}
      <H2 id="buyer">Buyer-agent errors</H2>
      <P>
        Thrown by <M>runBuyerAgent()</M> and the LLM seam (
        <M>packages/buyer-agent/src/index.ts</M>, <M>llm.ts</M>). They are also appended to the
        JSONL decision trace before being re-thrown.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="bt">BAD_TASK</M>,
            '400',
            'runBuyerAgent was called with a missing or blank task string.',
            'Pass a non-empty natural-language task.',
          ],
          [
            <M key="ns">NO_SERVICES</M>,
            '404',
            'No services are registered on-chain (or none active for the MockLlm to choose from).',
            'Register at least one active service (agentgate wrap …) before running the agent.',
          ],
          [
            <M key="nsg">NO_SIGNER</M>,
            '500',
            'No buyer signer could be derived: mock mode without MOCK_BUYER_ACCOUNT, or live mode without BUYER_SIGNER_KEY.',
            'Mock: run `agentgate demo-accounts` and export the printed MOCK_BUYER_ACCOUNT. Live: set BUYER_SIGNER_KEY.',
          ],
          [
            <M key="lc">LLM_CONFIG</M>,
            '500',
            'AnthropicLlm was constructed without an apiKey or model id.',
            'Set ANTHROPIC_API_KEY and LLM_MODEL (or let the agent fall back to MockLlm).',
          ],
          [
            <M key="lh">LLM_HTTP</M>,
            '502',
            'The Anthropic Messages API responded non-2xx.',
            'Check the API key, model id, and quota; the message includes the status.',
          ],
          [
            <M key="lr">LLM_REFUSED</M>,
            '502',
            'The Anthropic API returned stop_reason "refusal".',
            'Rephrase the task; the model declined to answer.',
          ],
          [
            <M key="lbr">LLM_BAD_RESPONSE</M>,
            '502',
            'The Anthropic reply was non-JSON, had no content/text, or did not yield a valid {serviceId, reason} object even after one retry.',
            'Transient model output issue — retry; the prompt already retries malformed JSON once.',
          ],
          [
            <M key="lbc">LLM_BAD_CHOICE</M>,
            '502',
            'The model chose a serviceId that does not exist in the catalog or that is inactive.',
            'Usually transient; retry. Ensure the intended service is registered and active.',
          ],
          [
            <M key="ff">FETCH_FAILED</M>,
            '—',
            'A fallback code recorded in the decision trace when a non-AgentGateError fetch failure occurs during the paid call. The original error is re-thrown.',
            'Inspect the underlying network/HTTP error in the decision log.',
          ],
        ]}
      />

      {/* ════════════════════════════ CLI ════════════════════════════ */}
      <H2 id="cli">CLI errors</H2>
      <P>
        Thrown by the <M>agentgate</M> CLI (<M>packages/cli/src/*</M>) during input validation and
        the wrap/buy/demo flows. The bin prints them as <M>error: &lt;CODE&gt;: &lt;message&gt;</M> and
        exits <M>1</M>.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="ii">INVALID_INPUT</M>,
            '400',
            'A required on-chain text field was empty/blank, contained control characters, or exceeded its max length (name ≤ 128, description ≤ 512) — or buy was given a --body that is not valid JSON.',
            'Provide printable, bounded text for --name / --description; pass valid JSON to buy --body.',
          ],
          [
            <M key="isi">INVALID_SERVICE_ID</M>,
            '400',
            'A service id argument (buy / status / pause / resume) was not a positive integer.',
            'Pass a positive integer id (ids are 1-based).',
          ],
          [
            <M key="csnf">SERVICE_NOT_FOUND</M>,
            '404',
            'buy / status / pause / resume named a service id that does not exist on-chain.',
            'Run agentgate list to see registered ids (ids are 1-based).',
          ],
          [
            <M key="csi">SERVICE_INACTIVE</M>,
            '403',
            'buy refused to pay: the service is paused by its owner. Checked before any payment — the gateway would answer 403 service_inactive anyway.',
            'Pick an active service from agentgate list, or resume it if you own it.',
          ],
          [
            <M key="cna">not_authorized</M>,
            '403',
            "pause / resume was signed with a key that is not the service's on-chain owner.",
            'Sign with the owner key — mock: MOCK_SELLER_ACCOUNT, live: the SELLER_SIGNER_KEY used at registration.',
          ],
          [
            <M key="iu2">INVALID_URL</M>,
            '400',
            'A URL (upstream or gateway/dashboard base) was not a valid http(s) URL, or a base URL carried a query string / fragment.',
            'Use a clean http:// or https:// URL with no query or fragment.',
          ],
          [
            <M key="isu">INSECURE_URL</M>,
            '400',
            'In live mode a non-localhost gateway base used http:// — the wrap mapping request to that gateway (the owner-signed self-service map, or an admin Bearer token) would travel over cleartext http.',
            'Use https:// for the gateway in live mode (localhost may stay http).',
          ],
          [
            <M key="ip">INVALID_PRICE</M>,
            '400',
            'The --price resolved to ≤ 0 OG.',
            'Pass a price > 0 OG (e.g. --price 0.5).',
          ],
          [
            <M key="iad">INVALID_ADDRESS</M>,
            '400',
            '--payment-target or --attestor was not a "0x"+40-hex EVM address.',
            "Supply a valid address — or omit the flag: the payment target derives from the signer and the attestor from the gateway's /healthz.",
          ],
          [
            <M key="gnm">GATEWAY_NETWORK_MISMATCH</M>,
            '400',
            'The gateway named by --gateway (or the hosted default) reports on /healthz that it serves a different chain than the one wrap would register on — typically ZG_NETWORK_PROFILE=galileo with the default (mainnet) gateway. Refused before the on-chain write, so nothing was registered and no gas was spent.',
            'Pass --gateway for a gateway on that network (the Galileo catalog is served by https://0g-gateway.mdloglabs.org), or select the gateway\u2019s network with ZG_NETWORK_PROFILE.',
          ],
          [
            <M key="sm">SIGNER_MISSING</M>,
            '400',
            'No signer for the command. Seller commands: mock mode without MOCK_SELLER_ACCOUNT, or live mode without SELLER_SIGNER_KEY. buy: mock mode without MOCK_BUYER_ACCOUNT, or live mode without --key / BUYER_SIGNER_KEY.',
            'Mock: export the accounts printed by `agentgate demo-accounts`. Live: set SELLER_SIGNER_KEY (seller commands) or BUYER_SIGNER_KEY (buy). The message names the flag and the variable, never a key value.',
          ],
          [
            <M key="mo">MOCK_ONLY</M>,
            '400',
            '`agentgate demo-accounts` was run outside mock mode.',
            'Set AGENTGATE_MODE=mock to create demo accounts.',
          ],
          [
            <M key="gt">GATEWAY_TIMEOUT</M>,
            '504',
            'The mock devnet faucet (demo-accounts) did not respond within the timeout.',
            'Start the devnet (npm run dev), then re-run `agentgate demo-accounts`.',
          ],
          [
            <M key="fu">FAUCET_UNREACHABLE / FAUCET_FAILED</M>,
            '502',
            'The devnet faucet could not be reached, or it answered non-2xx / a malformed balance.',
            'Confirm the devnet is running and reachable at DEVNET_URL.',
          ],
        ]}
      />

      {/* ════════════════════════════ INTERNAL / MOCK ════════════════════════════ */}
      <H2 id="internal">Internal &amp; mock-devnet codes</H2>
      <P>
        Codes you should not meet in normal operation — programming errors, boot-time guards, and
        the mock-mode devnet transport. One line each for completeness:
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning']}
        rows={[
          [
            <M key="ivp">INVALID_PAYMENT</M>,
            '402',
            'The exported decodeXPayment / decodeXPaymentResponse helpers rejected a malformed header. Inside the gateway this is caught and re-surfaced as invalid_payment_header.',
          ],
          [
            <M key="sun">SIGNER_UNSUPPORTED</M>,
            '400',
            "wrap's self-service gateway mapping needs a key signer — set SELLER_SIGNER_KEY (mock mode maps via the admin-token path instead).",
          ],
          [
            <M key="bde">BAD_DEPS</M>,
            '500',
            'createApp() was called without { config, chain } — a programming error, not an env issue.',
          ],
          [
            <M key="lfa">LISTEN_FAILED</M>,
            '500',
            'The gateway/devnet port could not be bound (already in use, or no permission).',
          ],
          [
            <M key="ufi">UPSTREAMS_FILE_INVALID</M>,
            '500',
            'The persisted upstream-map JSON file (data/upstreams.json) is corrupt — fix or delete it; the gateway refuses to boot on it.',
          ],
          [
            <M key="dlr">DEVNET_LIVE_REFUSED</M>,
            '500',
            'The mock devnet was started with AGENTGATE_MODE=live — it is the mock chain and refuses to stand in for a real backend.',
          ],
          [
            <M key="mkg">invalid_public_key / invalid_devnet_url</M>,
            '400 / 500',
            'Mock chain client input guards: an empty publicKey argument, or a malformed / non-http(s) DEVNET_URL.',
          ],
          [
            <M key="mkt">devnet_timeout / devnet_unreachable / devnet_error</M>,
            '504 / 502',
            "The mock chain client's devnet request timed out (504), failed at the transport layer (502), or the devnet answered non-2xx (devnet_error re-throws the devnet's own status). Start the devnet with npm run dev.",
          ],
        ]}
      />

      <Callout tone="ok" title="Handling errors programmatically">
        At any call site, narrow with <M>isAgentGateError(err)</M> and branch on <M>err.code</M> —
        as the buyer agent does for <M>PRICE_EXCEEDED</M>. The <M>code</M> is the stable contract;
        the <M>message</M> is for humans and may change.
      </Callout>

      <NextLinks
        links={[
          { href: '/docs/api', label: 'HTTP API reference' },
          { href: '/docs/sdk', label: 'Client SDK' },
        ]}
      />
    </>
  );
}
