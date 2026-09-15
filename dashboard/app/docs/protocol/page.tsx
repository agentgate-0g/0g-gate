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
  PropList,
  StepFlow,
} from '@/components/docs';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/protocol' },
  title: 'How it works',
  description:
    'A concepts walkthrough of the x402 V1 payment protocol: discovery, the 402 PaymentRequiredResponse challenge (accepts[] / PaymentRequirements), a native OG payment through the PaymentRouter contract that binds the invoice nonce on-chain, the X-PAYMENT proof header, verification from the transaction receipt, single-use nonce burning, the upstream proxy, and the attestation that feeds a trust score.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="CONCEPTS"
        title="How it works"
        lede="AgentGate is an HTTP-402 payment gateway for AI agents following the x402 V1 wire format. A buyer agent discovers a service, receives a machine-readable 402 PaymentRequiredResponse (accepts[] with PaymentRequirements), pays by calling PaymentRouter.pay(serviceId, nonce, payTo) — which binds the invoice nonce to the payment on-chain — then retries with the X-PAYMENT proof header. The gateway verifies the payment from that transaction's receipt, burns the nonce, proxies to the upstream API, and records an attestation that updates the service's trust score."
      />

      <H2 id="flow">The flow at a glance</H2>
      <P>
        Every paid request follows the same three-leg exchange: an unpaid <M>402</M> challenge,
        an on-chain payment, and a retry that carries proof of that payment. The gateway is a
        reverse proxy in front of the seller&apos;s real API; buyers never need an API key, and
        the upstream URL — which may embed the seller&apos;s own key — is stored only in the
        gateway&apos;s private map and never appears in any response. The steps below are the
        exact sequence the gateway
        (<M>packages/middleware/src/app.ts</M>) and the buyer client
        (<M>packages/client/src/index.ts</M>) implement.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Discover',
            body: (
              <>
                The buyer client (the agent-side SDK, <M>packages/client</M>) reads the on-chain
                registry to find services and their{' '}
                <DocLink href="/docs/protocol#attestation">trust scores</DocLink>, choosing one to call. Each
                service record carries a public gateway URL (<M>/svc/:id</M>) — never the upstream.
              </>
            ),
          },
          {
            title: 'Request the service',
            body: (
              <>
                The buyer client issues the request to <M>GET /svc/:id</M> (any method is accepted via{' '}
                <M>app.all</M>) with no payment headers. The gateway resolves the service from a
                60-second cache, rejects it if inactive (<M>403 service_inactive</M>) or unmapped
                (<M>503 service_unavailable</M>), and rejects non-JSON request bodies before
                charging (<M>415</M>).
              </>
            ),
          },
          {
            title: 'Receive the 402 challenge (PaymentRequiredResponse)',
            body: (
              <>
                With no <M>X-PAYMENT</M> header, the gateway mints a fresh invoice — a random nonce
                plus an <M>expiresAtMs</M> deadline — persists it, and replies <M>402</M> with a{' '}
                <M>PaymentRequiredResponse</M> JSON body: <M>x402Version:1</M>,{' '}
                <M>error:"X-PAYMENT header is required"</M>, and an <M>accepts[]</M> array containing
                one <M>PaymentRequirements</M> entry.
              </>
            ),
            code: 'HTTP/1.1 402 Payment Required\nContent-Type: application/json\n\n{"x402Version":1,"error":"X-PAYMENT header is required","accepts":[{"scheme":"exact-settled","network":"0g-mainnet",...}]}',
          },
          {
            title: 'Pay through the PaymentRouter contract',
            body: (
              <>
                The buyer client validates the response (<M>parsePaymentRequired</M> — selects
                the <M>accepts[]</M> entry matching the chain network and <M>scheme:"exact-settled"</M>),
                refuses prices above its cap (<M>PRICE_EXCEEDED</M>), then calls{' '}
                <M>PaymentRouter.pay(serviceId, nonce, payTo)</M> at <M>extra.router</M> with{' '}
                <M>msg.value = maxAmountRequired</M> wei. The router forwards the whole value to{' '}
                <M>payTo</M> and emits <M>Paid</M> with <M>serviceId</M> and <M>nonce</M> indexed.
                The transaction hash becomes the payment proof.
              </>
            ),
          },
          {
            title: 'Retry with proof',
            body: (
              <>
                After a settle delay the buyer client retries the same request with the{' '}
                <M>X-PAYMENT</M> header — a base64-encoded{' '}
                <M>PaymentPayload</M>: <M>x402Version:1</M>, <M>scheme:"exact-settled"</M>,{' '}
                <M>network:"0g-mainnet"</M> (or <M>"0g-galileo"</M>), and <M>payload.transaction</M> (the tx hash),{' '}
                <M>payload.nonce</M> (the nonce), <M>payload.from</M> (optional — ignored by
                the gateway; payer identity is read from the on-chain <M>Paid</M> log).
              </>
            ),
          },
          {
            title: 'Verify on-chain',
            body: (
              <>
                The gateway decodes the <M>X-PAYMENT</M> header, validates invoice state (nonce
                must exist, be unused, and be within <M>expiresAtMs</M>), then calls{' '}
                <M>chain.verifyTransfer</M> to check the transfer&apos;s target, amount, transfer
                id, and age (see <DocLink href="/docs/protocol#verification">Verification rules</DocLink>). A
                still-settling transfer returns <M>402</M> with <M>error:"settlement_pending"</M>{' '}
                and a <M>Retry-After: 2</M> response header.
              </>
            ),
          },
          {
            title: 'Burn the nonce (single-use)',
            body: (
              <>
                Before any upstream call, the nonce is marked used atomically. Exactly one
                concurrent request wins the compare-and-set; every other holder of the same proof
                gets a fresh <M>402 invoice_used</M>.
              </>
            ),
          },
          {
            title: 'Proxy to the upstream',
            body: (
              <>
                The gateway forwards the request to the mapped upstream URL (a strict header
                whitelist; the <M>X-PAYMENT</M> proof header is stripped), passing the upstream
                status and content-type back to the agent. Every paid response — whatever status
                the upstream returned, and even a proxy failure — carries{' '}
                <M>X-PAYMENT-RESPONSE</M> (base64 <M>SettlementResponse</M> with{' '}
                <M>success:true</M> meaning the payment settled, plus <M>transaction</M>,{' '}
                <M>network</M>, <M>payer</M>). The upstream URL never appears in any response.
              </>
            ),
          },
          {
            title: 'Record an attestation',
            body: (
              <>
                After responding, the gateway fires a non-blocking on-chain attestation —{' '}
                <M>{'{ serviceId, paymentTxHash, success }'}</M> where{' '}
                <M>success</M> is true iff the upstream returned a 2xx — unless the payer is the
                service&apos;s own owner/payout account, or the upstream never returned a
                response. On failure it retries with exponential backoff (default 4 total
                attempts: 5 s, 10 s, 20 s).
              </>
            ),
          },
          {
            title: 'Update the trust score',
            body: (
              <>
                Each attestation increments the service&apos;s on-chain counters
                (<M>totalCalls</M>, and <M>successCalls</M> on success). Those counters map to a
                trust tier the next discovering agent reads (see{' '}
                <DocLink href="/docs/protocol#attestation">Attestation and trust score</DocLink>).
              </>
            ),
          },
        ]}
      />

      <H2 id="invoice">The 402 challenge body (PaymentRequiredResponse)</H2>
      <P>
        The body of every <M>402</M> response is a <M>PaymentRequiredResponse</M> — the x402 V1
        envelope that tells the agent exactly how to pay. It is defined in{' '}
        <M>packages/shared/src/x402.ts</M> and built by the gateway in{' '}
        <M>buildRequirements()</M>/<M>respond402Fresh()</M>. The protocol version number is fixed:{' '}
        <M>x402Version: 1</M>.
      </P>
      <CodeBlock
        label="402 response body (PaymentRequiredResponse)"
        code={[
          '{',
          '  "x402Version": 1,',
          '  "error": "X-PAYMENT header is required",',
          '  "accepts": [',
          '    {',
          '      "scheme": "exact-settled",',
          '      "network": "0g-mainnet",',
          '      "maxAmountRequired": "1000000000000000",',
          '      "asset": "OG",',
          '      "payTo": "0xb678...4eb9",',
          '      "resource": "https://0g-gateway.equiflow.xyz/svc/1",',
          '      "description": "USD FX Feed",',
          '      "maxTimeoutSeconds": 300,',
          '      "extra": {',
          '        "nonce": "4521903117755646",',
          '        "serviceId": 1,',
          '        "expiresAtMs": 1782966672306,',
          '        "settlement": "0g-payment-router",',
          '        "router": "0x5102...45eF",',
          '        "nonceEncoding": "uint256-decimal"',
          '      }',
          '    }',
          '  ]',
          '}',
        ].join('\n')}
      />
      <P>
        <strong className="text-white">Settlement model:</strong>{' '}
        <M>scheme:"exact-settled"</M> with <M>extra.settlement:"0g-payment-router"</M> is a
        settled-payment-proof variant: the buyer broadcasts the payment themselves and the gateway
        verifies it, so no third party ever sits in the money path.
      </P>

      <H2 id="x402-relationship">How this relates to x402</H2>
      <P>
        AgentGate uses the <strong className="text-white">x402 V1 envelope</strong> and{' '}
        <strong className="text-white">not</strong> its <M>exact</M> settlement scheme. Both halves
        of that sentence matter, so here they are side by side rather than buried in a footnote.
      </P>
      <DocTable
        head={['', 'x402 “exact”', 'AgentGate “exact-settled”']}
        rows={[
          [
            'What the payer sends',
            'A signed authorization (an EIP-3009 transferWithAuthorization on EVM) — a promise to pay that has not moved yet.',
            <span key="a">
              A <strong className="text-white">tx hash of a payment that already settled</strong>{' '}
              through <M>PaymentRouter.pay(serviceId, nonce, payTo)</M>.
            </span>,
          ],
          [
            'Who settles',
            'The resource server, or a facilitator acting for it, submits the authorization on-chain.',
            'The buyer, before it ever presents proof. The gateway only reads.',
          ],
          [
            'Facilitator',
            'A /verify + /settle service the resource server trusts.',
            <span key="c">
              <strong className="text-white">None.</strong> 0G has no x402 facilitator, and the
              gateway custodies nothing — value goes buyer → seller in one call.
            </span>,
          ],
          [
            'Trust shape',
            'The server can be paid without the buyer paying gas; the facilitator is in the money path.',
            'The buyer pays its own gas and keeps custody until it pays. Nobody can settle on the buyer’s behalf.',
          ],
        ]}
      />
      <Callout tone="info" title="Why the scheme is named differently">
        Advertising <M>scheme:"exact"</M> would be a promise of interoperability this gateway
        cannot keep: a generic x402 client would sign an authorization, and get a{' '}
        <M>402</M> back forever, because what is wanted is a settled tx hash. Naming the scheme{' '}
        <M>exact-settled</M> makes that client fail fast and legibly — &ldquo;no{' '}
        <M>accepts[]</M> entry for the scheme I support&rdquo; — instead of failing mysteriously
        after signing. The envelope stays x402 V1, so anything that parses a 402 body,{' '}
        <M>accepts[]</M>, <M>X-PAYMENT</M> and <M>X-PAYMENT-RESPONSE</M> still works unchanged.
      </Callout>
      <P>
        <strong className="text-white">What this buys on 0G.</strong> Settled-proof needs no
        facilitator to exist, run, or be trusted — which is the difference between shipping on 0G
        today and waiting for one. The cost is that the buyer pays its own gas and cannot delegate
        settlement. On a chain with sub-cent fees that is a reasonable trade; on an expensive chain
        it would not be, and the <M>accepts[]</M> price list already stored on-chain is the seam
        where an authorization-based rail would slot in later without a contract change.
      </P>
      <Callout tone="warn" title="extra.router is not optional — a plain transfer settles nothing">
        A bare EVM value transfer to <M>payTo</M> carries no invoice reference, so the gateway has
        no way to bind it to your 402: the money leaves and no data comes back. The payment{' '}
        <strong>must</strong> go through <M>pay()</M> on the <M>extra.router</M> contract, which is
        what emits the <M>Paid(serviceId, nonce, …)</M> log verification looks for.
      </Callout>
      <PropList
        items={[
          {
            name: 'x402Version',
            type: 'number (1)',
            required: true,
            desc: <>Fixed x402 protocol version. The client requires an exact match.</>,
          },
          {
            name: 'error',
            type: 'string',
            required: true,
            desc: (
              <>
                Human-readable reason. Fresh challenge: <M>"X-PAYMENT header is required"</M>.
                Rejected proof: one of the <M>PaywallErrorCode</M> strings (e.g.{' '}
                <M>"amount_too_low"</M>). Pending: <M>"settlement_pending"</M>.
              </>
            ),
          },
          {
            name: 'accepts',
            type: 'PaymentRequirements[]',
            required: true,
            desc: (
              <>
                One or more acceptable payment methods. Clients select the entry whose{' '}
                <M>network</M> matches the chain they are on and <M>scheme === "exact-settled"</M>.
              </>
            ),
          },
          {
            name: 'accepts[].scheme',
            type: '"exact-settled"',
            required: true,
            desc: (
              <>
                Always <M>"exact-settled"</M>. Deliberately <em>not</em> x402&apos;s{' '}
                <M>"exact"</M>: that scheme expects a signed authorization the server settles,
                while this one expects the buyer to have settled already and to present the tx
                hash. A distinct name makes a generic x402 client fail fast rather than sign
                something this gateway will never accept.
              </>
            ),
          },
          {
            name: 'accepts[].network',
            type: 'string',
            required: true,
            desc: (
              <>
                Chain name — <M>mock</M>, <M>0g-mainnet</M> or <M>0g-galileo</M>. The client throws{' '}
                <M>NETWORK_MISMATCH</M> if no entry matches its own network.
              </>
            ),
          },
          {
            name: 'accepts[].maxAmountRequired',
            type: 'string (wei)',
            required: true,
            desc: (
              <>
                Price in wei of native OG as a decimal string. 1 OG = 1e18 wei.
                uint256-safe via bigint — never parse it as a JS number.
              </>
            ),
          },
          {
            name: 'accepts[].payTo',
            type: 'string',
            required: true,
            desc: (
              <>
                Recipient in <M>0x&lt;40 hex&gt;</M> format. The router forwards the payment
                here — you pass it as <M>pay()</M>&apos;s third argument, you do not transfer to it
                directly.
              </>
            ),
          },
          {
            name: 'accepts[].resource',
            type: 'string (URL)',
            required: true,
            desc: <>Absolute URL of the protected resource (<M>/svc/:id</M>).</>,
          },
          {
            name: 'accepts[].description',
            type: 'string',
            required: true,
            desc: <>The service name from on-chain registration (non-empty).</>,
          },
          {
            name: 'accepts[].maxTimeoutSeconds',
            type: 'number',
            required: true,
            desc: (
              <>
                <M>INVOICE_TTL_MS / 1000</M> — deadline in seconds from issuance. The default{' '}
                <M>INVOICE_TTL_MS</M> is 300000 ms, which the hosted gateway keeps, so live
                responses show <M>300</M>. The cap is <M>MAX_INVOICE_TTL_MS</M> (13 minutes), so a
                quote can never outlive the registry&apos;s 15-minute terms-change delay.
              </>
            ),
          },
          {
            name: 'accepts[].extra.nonce',
            type: 'string (decimal ≤ 2^53−2)',
            required: true,
            desc: (
              <>
                Per-invoice decimal string — a positive integer ≤ 2^53−2
                (9,007,199,254,740,990; at most 16 digits), capped below{' '}
                <M>Number.MAX_SAFE_INTEGER</M> so it survives any JSON hop that materializes it as
                a float64. Passed verbatim as <M>pay()</M>&apos;s <M>nonce</M> argument and echoed
                back in <M>payload.nonce</M> of the <M>X-PAYMENT</M> header.
              </>
            ),
          },
          {
            name: 'accepts[].extra.expiresAtMs',
            type: 'number',
            required: true,
            desc: (
              <>
                Unix-ms deadline, strictly greater than &quot;now&quot; when issued. Replaces the
                old <M>expiresAt</M>.
              </>
            ),
          },
          {
            name: 'accepts[].extra.settlement',
            type: '"0g-payment-router"',
            required: true,
            desc: (
              <>
                Identifies the settled-payment-proof variant: the buyer broadcasts the payment; the
                gateway verifies the resulting <M>Paid</M> log.
              </>
            ),
          },
          {
            name: 'accepts[].extra.router',
            type: 'string (0x address)',
            required: true,
            desc: (
              <>
                The <M>PaymentRouter</M> contract the buyer must call. Validated by the reference
                client — an invoice without a well-formed router is rejected as <M>BAD_INVOICE</M>,
                because paying without it would spend money that can never be redeemed.
              </>
            ),
          },
          {
            name: 'accepts[].asset',
            type: '"OG"',
            required: true,
            desc: <>Native OG (no token contract). Always present; the reference client does not validate it.</>,
          },
          {
            name: 'accepts[].extra.nonceEncoding',
            type: '"uint256-decimal"',
            required: true,
            desc: <>How the nonce is encoded for the router call. Always present; the reference client does not validate it.</>,
          },
        ]}
      />
      <H3 id="invoice-rejection-fields">Rejection fields in the 402 body</H3>
      <P>
        Every <M>402</M> response is a full <M>PaymentRequiredResponse</M>. The <M>error</M> field
        always carries the reason. For a still-settling transfer the error is{' '}
        <M>"settlement_pending"</M> and the response also carries a standard{' '}
        <M>Retry-After: 2</M> response header (seconds) — the same invoice is kept alive. Every
        other rejection re-issues a fresh <M>accepts[]</M> with a new nonce.
      </P>

      <H2 id="payment">Payment and proof headers</H2>
      <P>
        Payment is a <strong className="text-white">native OG payment through a contract</strong>,
        not a bare transfer. The buyer client calls <M>chain.transfer</M>, which calls{' '}
        <M>PaymentRouter.pay(serviceId, nonce, payTo)</M> at <M>accepts[].extra.router</M> with{' '}
        <M>msg.value = accepts[].maxAmountRequired</M>. The router forwards the whole value to{' '}
        <M>payTo</M> and emits <M>Paid</M> with <M>serviceId</M> and <M>nonce</M> indexed — that
        log is what binds the on-chain payment to this specific invoice. The call returns a
        transaction hash. After a settle delay the client base64-encodes a <M>PaymentPayload</M>{' '}
        and sends it as the <M>X-PAYMENT</M> request header.
      </P>
      <Callout tone="ok" title="No network minimum — real micropayments">
        The only floor is the registry&apos;s own <M>MIN_PRICE_WEI</M> (1e12 wei = 0.000001 OG), so
        per-call pricing can go genuinely small. Verification requires{' '}
        <M>amount ≥ maxAmountRequired</M> — overpayment is accepted — and the bundled buyers
        (<M>agentgate buy</M>, the SDK&apos;s <M>fetchPaid</M>, the LLM agent) pay exactly the
        invoiced amount. The practical floor is your own gas: price above what a buyer spends to
        pay you, or paying is irrational for them.
      </Callout>
      <DocTable
        head={['Header', 'Direction', 'Carries']}
        rows={[
          [
            <M key="h1">X-PAYMENT</M>,
            'request (retry)',
            <>
              base64(JSON): <M>x402Version:1</M>, <M>scheme:"exact-settled"</M>,{' '}
              <M>network:"0g-mainnet"</M> (or <M>"0g-galileo"</M>), <M>payload.transaction</M> (tx hash),{' '}
              <M>payload.nonce</M> (nonce), <M>payload.from</M> (optional, ignored — the
              gateway derives the payer from the transfer itself; the reference client omits it).
            </>,
          ],
          [
            <M key="h2">X-PAYMENT-RESPONSE</M>,
            'response (any paid reply)',
            <>
              base64(JSON): <M>success:true</M>, <M>transaction</M> (tx hash),{' '}
              <M>network</M>, <M>payer</M> (address). New in x402 V1.
            </>,
          ],
        ]}
      />
      <P>
        Header names are case-insensitive on the wire. The <M>X-PAYMENT</M> proof header is
        consumed by the gateway and is never forwarded to the upstream API.
      </P>

      <H2 id="verification">Verification rules</H2>
      <P>
        When a retry arrives with proof headers, the gateway first checks the invoice behind the
        presented nonce (it must exist, match the requested <M>serviceId</M>, be unused, and be
        within <M>expiresAtMs</M>). It then verifies the payment on-chain via{' '}
        <M>
          chain.verifyTransfer({'{'} txHash, serviceId, expectedTarget, minAmountWei, expectedNonce,
          maxAgeMs {'}'})
        </M> — one <M>eth_getTransactionReceipt</M> on the hash the buyer presented, then an
        exact match against the <M>Paid</M> logs in that receipt. Because the hash is
        buyer-supplied, only logs emitted by the <strong>configured router</strong> are considered:
        otherwise any contract could mint a look-alike <M>Paid</M> event and pass verification.
        Then four checks — evaluated in the order target → nonce/service → amount → age — must all
        pass:
      </P>
      <DocTable
        head={['#', 'Check', 'Rule', 'On failure']}
        rows={[
          [
            '0',
            'Exists',
            <span key="r0">
              The tx hash resolves to a receipt carrying a <M>Paid</M> log for this exact{' '}
              <M>(serviceId, nonce)</M>, emitted by the configured router. A log from any other
              contract is ignored — a look-alike event cannot forge a payment.
            </span>,
            <M key="e0">not_found</M>,
          ],
          [
            '1',
            'Target',
            <span key="r1">
              The log&apos;s <M>payTo</M> equals the service&apos;s <M>paymentTarget</M>
              (compared as lowercased addresses).
            </span>,
            <M key="e1">wrong_target</M>,
          ],
          [
            '2',
            'Nonce + service',
            <span key="r2">
              A <M>Paid</M> log whose <M>nonce</M> AND <M>serviceId</M> both match the invoice.
              Both are required: a nonce is unique only per service (<M>seenNonce</M> is keyed on
              the pair) and payment targets are shared across services, so neither field
              disambiguates on its own.
            </span>,
            <M key="e2">wrong_nonce</M>,
          ],
          [
            '3',
            'Amount',
            <span key="r3">
              <M>log.amount ≥ priceWei</M> (bigint comparison — overpayment is accepted).
            </span>,
            <M key="e3">amount_too_low</M>,
          ],
          [
            '4',
            'Age',
            <span key="r4">
              Deploy age is within <M>maxAgeMs</M> (the invoice TTL).
            </span>,
            <M key="e4">expired</M>,
          ],
        ]}
      />
      <P>
        A transfer that exists but has not finalized yet returns <M>settlement_pending</M> rather than a
        failure: the gateway keeps the same <M>accepts[]</M> alive (same nonce) and answers{' '}
        <M>402</M> with <M>error:"settlement_pending"</M> and a standard{' '}
        <M>Retry-After: 2</M> response header (seconds) so the buyer can re-present the identical
        proof shortly. Every other verification failure re-sends a fresh{' '}
        <M>PaymentRequiredResponse</M> (new nonce) so a client can re-pay.
      </P>

      <H2 id="single-use">Single-use nonce and idempotency</H2>
      <P>
        Once all four checks pass, the gateway burns the nonce{' '}
        <strong className="text-white">before</strong> it proxies to the upstream. The invoice
        store&apos;s <M>markUsed()</M> is a compare-and-set: exactly one concurrent request can
        consume a given nonce. Any other request presenting the same proof loses the race and
        receives a fresh <M>402 invoice_used</M>. A burned nonce stays burned even if the
        upstream call then fails — proof is consumed at most once, so a buyer is charged for at
        most one delivered call per invoice.
      </P>
      <DocTable
        head={['Situation', 'Outcome']}
        rows={[
          [
            'Proof replayed after a successful call',
            <span key="o1">
              <M>402 invoice_used</M> — the nonce is dead; re-pay against a new invoice.
            </span>,
          ],
          [
            'Two concurrent retries, same proof',
            'One wins and is proxied; the other gets invoice_used.',
          ],
          [
            'Transfer still settling',
            <span key="o3">
              <M>402</M> + <M>error:"settlement_pending"</M> + <M>Retry-After: 2</M> (header,
              seconds) — same nonce stays alive; retry the same <M>X-PAYMENT</M> proof.
            </span>,
          ],
          [
            'Upstream fails after the burn',
            'Nonce remains used; the buyer is not silently re-charged.',
          ],
        ]}
      />
      <Callout tone="info" title="Client-side pending retries">
        The buyer client (<M>fetchPaid</M>) retries a <M>settlement_pending</M> response up to five
        times, sleeping the <M>Retry-After</M> value in seconds (capped at 30,000 ms per wait), then
        returns whatever the gateway last sent.
      </Callout>

      <H2 id="attestation">Attestation and trust score</H2>
      <P>
        After the buyer&apos;s response is sent, the gateway records an on-chain attestation
        without blocking the request. The attestation input is{' '}
        <M>{'{ serviceId, paymentTxHash, success }'}</M>, where{' '}
        <M>success</M> is true exactly when the upstream returned a 2xx (<M>isUpstreamSuccess</M>).
        If the attestation transaction fails, the gateway retries with exponential backoff — base
        delay 5,000 ms doubling per attempt (5 s, 10 s, 20 s), up to 4 total attempts. A final
        failure is only logged and never affects the buyer; a call whose attempts all fail is
        under-counted, never over-counted.
      </P>
      <P>
        Two situations record <strong className="text-white">no attestation at all</strong>: a
        gateway-level proxy failure (<M>upstream_unreachable</M>, <M>upstream_timeout</M>,{' '}
        <M>upstream_response_too_large</M>, <M>upstream_request_too_large</M> — the upstream never
        returned a usable response, so the call is not scored either way), and a self-payment — a
        payer whose account is the service&apos;s own <M>owner</M> or <M>paymentTarget</M> never
        earns trust (wash-trade guard).
      </P>
      <P>
        Attestations accumulate into a per-service <M>ServiceScore</M> of two counters:{' '}
        <M>totalCalls</M> and <M>successCalls</M>. <M>trustTier()</M> maps those integer counters
        to a badge using exact integer math (no float boundaries):
      </P>
      <DocTable
        head={['Tier', 'Condition']}
        rows={[
          [
            <M key="t1">new</M>,
            <span key="c1">
              <M>totalCalls &lt; 5</M>, or any score that does not meet a higher tier.
            </span>,
          ],
          [
            <M key="t2">reliable</M>,
            <span key="c2">
              <M>totalCalls ≥ 5</M> and success ratio ≥ 0.9 (<M>successCalls × 10 ≥ totalCalls × 9</M>).
            </span>,
          ],
          [
            <M key="t3">trusted</M>,
            <span key="c3">
              <M>totalCalls ≥ 25</M> and success ratio ≥ 0.95 (<M>successCalls × 100 ≥ totalCalls × 95</M>).
            </span>,
          ],
        ]}
      />
      <P>
        Malformed scores (negative counters, or <M>successCalls &gt; totalCalls</M>) never earn a
        badge and fall back to <M>new</M>. A discovering agent reads this tier alongside the
        service record, closing the loop: usage produces attestations, attestations produce a
        score, and the score guides the next agent&apos;s choice.
      </P>

      <NextLinks
        links={[
          { href: '/docs/architecture', label: 'Architecture' },
          { href: '/docs/api', label: 'HTTP API reference' },
        ]}
      />
    </>
  );
}
