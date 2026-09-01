import type { Metadata } from 'next';
import { DEFAULT_REGISTRY_ADDRESS } from '@agentgate/shared';
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
} from '@/components/docs';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/contract' },
  title: 'Smart contracts',
  description:
    'Reference for the AgentGate Solidity contracts on 0G Galileo: AgentGateRegistry (service registry + attestation reputation), PaymentRouter (invoice-bound payments) and SpendGuard (x402 spend-firewall escrow) — storage, entrypoints, events, custom errors, and build/deploy.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="REFERENCE"
        title="Smart contracts"
        lede="The on-chain layer of AgentGate on 0G Galileo Testnet: three Solidity contracts — AgentGateRegistry and PaymentRouter (both wired into the product) and SpendGuard (implemented and tested, not yet wired in)."
      />

      <H2 id="overview">Overview</H2>
      <P>
        AgentGate ships three contracts under <M>contracts-evm/src/</M>, built and tested with{' '}
        <a href="https://getfoundry.sh" target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4">Foundry</a>.
        All three: <M>pragma solidity 0.8.28</M> (pinned, not <M>^</M>), SPDX <M>MIT</M>, optimizer
        on at 200 runs, <M>evm_version = &quot;cancun&quot;</M>, <strong>no constructor
        arguments</strong> and <strong>no proxy</strong> — a new version means a new address.
      </P>
      <Callout tone="warn" title="Every contract timestamp is MILLISECONDS">
        EVM <M>block.timestamp</M> is in seconds. Every contract here stores and emits{' '}
        <M>uint64(block.timestamp) * 1000</M>, because every off-chain reader (
        <M>ServiceRecord.createdAt</M>, <M>AttestationRecord.timestamp</M>,{' '}
        <M>ActivityEvent.timestamp</M>, <M>SpendGuard.windowMs</M>) is contracted on ms. If you fork
        one of these, keep the multiplication — a 10-digit value where a 13-digit one belongs is the
        single easiest detail to get wrong.
      </Callout>
      <DocTable
        head={['Contract', 'Role', 'Status']}
        rows={[
          [
            <M key="c">AgentGateRegistry</M>,
            'Service discovery catalog + per-service payment-attestation reputation ledger.',
            <span key="st">
              Wired into the off-chain product (the live registry client). 21 Foundry tests.
            </span>,
          ],
          [
            <M key="c">PaymentRouter</M>,
            'Binds an x402 invoice nonce to an on-chain payment, and rejects a replay of it.',
            <span key="st">
              Wired in: the gateway advertises it as <M>extra.router</M> and verifies against its{' '}
              <M>Paid</M> logs. 9 Foundry tests.
            </span>,
          ],
          [
            <M key="c">SpendGuard</M>,
            'x402 spend-firewall: per-policy OG escrow with on-chain budget, per-call cap, rate-window and trust-tier enforcement.',
            'Implemented and tested only (12 Foundry tests) — NOT integrated into the running product (no off-chain client, middleware never calls debit).',
          ],
        ]}
      />
      <P>
        The registry and SpendGuard share the same idioms: 1-based sequential ids (the counter is
        bumped first, then assigned, so it always equals the latest id and id <M>0</M> means
        &ldquo;absent&rdquo; to every off-chain reader), a <M>seen*</M> dedup mapping, saturating
        counter math, a private <M>_load*</M> helper that reverts with a custom error when an id is
        unknown, and checks-effects-interactions ordering around every outbound transfer. Money on
        the shipped rail is always native OG wei; the registry records only an opaque{' '}
        <M>bytes32</M> payment hash, so it never needs to know which rail settled.
      </P>

      <H2 id="registry">AgentGateRegistry</H2>
      <P>
        The registry is the catalog and the reputation source of truth. A seller calls{' '}
        <M>register_service</M> to list a wrapped HTTP API; the caller becomes the service{' '}
        <M>owner</M> and the service starts <M>active</M>. After each paid call the AgentGate
        gateway (the service&rsquo;s <M>attestor</M>) calls <M>record_attestation</M>, which
        bumps a <M>(total_calls, success_calls)</M> score and prepends to a capped, newest-first
        attestation history. The contract has no constructor args and no privileged admin — there is no global
        owner, only per-service owners.
      </P>
      <P>
        The full public endpoint is never stored on-chain: the contract keeps only{' '}
        <M>gateway_base_url</M>, and every reader (devnet, chain client, dashboard) computes the
        endpoint as <M>{'{gateway_base_url}/svc/{id}'}</M>.
      </P>

      <H3 id="registry-storage">Storage</H3>
      <DocTable
        head={['Field', 'Type', 'Holds']}
        rows={[
          [
            <M key="s">servicesCount</M>,
            <M key="t">uint64 public</M>,
            'Number of services registered (0 initially); equals the id of the most recently registered service. Ids run 1..=servicesCount.',
          ],
          [
            <M key="s">_services</M>,
            <M key="t">mapping(uint64 =&gt; Service)</M>,
            'serviceId → the stored Service record.',
          ],
          [
            <M key="s">totalCalls / successCalls</M>,
            <M key="t">mapping(uint64 =&gt; uint64) public</M>,
            'serviceId → the score counters. Keep the FULL history even after the attestation ring buffer wraps.',
          ],
          [
            <M key="s">seenPayments</M>,
            <M key="t">mapping(bytes32 =&gt; bool)</M>,
            'keccak(serviceId, paymentTxHash) → attested? The per-service duplicate guard — one attestation per payment, per service.',
          ],
          [
            <M key="s">attestations</M>,
            <M key="t">ring buffer, 100 per service</M>,
            'serviceId → the last MAX_ATTESTATIONS (100) attestations. Stored as a fixed ring and reversed on read, so getAttestations returns newest-first at constant write cost.',
          ],
        ]}
      />
      <P>
        Two public constants govern the policy: <M>MIN_PRICE_WEI = 1e12</M> (the floor for every{' '}
        <M>accepts[]</M> option amount, 1e-6 OG, keeps dust out of the catalog) and{' '}
        <M>MAX_ATTESTATIONS = 100</M> (the per-service ring-buffer size; the score counters are
        unbounded and keep full history).
      </P>
      <H3 id="registry-service-struct">Service record</H3>
      <PropList
        items={[
          { name: 'name', type: 'string', desc: <>Human-readable service name; non-empty (enforced at registration).</> },
          { name: 'description', type: 'string', desc: <>Short description shown in catalog listings.</> },
          {
            name: 'gatewayBaseUrl',
            type: 'string',
            desc: (
              <>
                Base URL of the AgentGate gateway fronting this service, stored verbatim. Readers
                compute the public endpoint as <M>{'{gatewayBaseUrl}/svc/{id}'}</M>.
              </>
            ),
          },
          {
            name: 'accepts',
            type: 'PaymentOption[]',
            desc: (
              <>
                The authoritative per-asset price list (non-empty). Readers derive the x402 402{' '}
                <M>accepts[]</M> directly from this. The shipped rail is native OG only; the
                multi-asset shape is already on-chain, so an ERC-20 rail is a client change rather
                than a contract change.
              </>
            ),
          },
          { name: 'paymentTarget', type: 'address', desc: <>Address that receives the 402 payments (the x402 payTo).</> },
          {
            name: 'owner',
            type: 'address',
            desc: <>The registration caller. May toggle <M>active</M>, rotate the attestor, and record attestations.</>,
          },
          { name: 'attestor', type: 'address', desc: <>Address allowed to record attestations (the AgentGate gateway signer).</> },
          {
            name: 'active',
            type: 'bool',
            desc: <>Discovery flag; <M>true</M> at registration. Inactive services reject attestations and are filtered out by buyers.</>,
          },
          { name: 'createdAt', type: 'uint64', desc: <>Block time in <strong>milliseconds</strong> at registration (<M>block.timestamp * 1000</M>).</> },
        ]}
      />
      <H3 id="registry-paymentoption-struct">PaymentOption record</H3>
      <P>
        One accepted payment rail — an ABI struct of six fields:
      </P>
      <PropList
        items={[
          {
            name: 'asset',
            type: 'address',
            desc: <><M>address(0)</M> means native OG; any other value is an ERC-20 token address.</>,
          },
          { name: 'amount', type: 'uint256', desc: <>Price per call in the asset&apos;s atomic units (&ge; <M>MIN_PRICE_WEI</M>).</> },
          { name: 'decimals', type: 'uint8', desc: <>Display decimals (18 for native OG).</> },
          { name: 'symbol', type: 'string', desc: <>Token symbol, e.g. <M>OG</M>.</> },
          { name: 'name', type: 'string', desc: <>Reserved EIP-712 domain name for a future ERC-20 rail (empty for native).</> },
          { name: 'version', type: 'string', desc: <>Reserved EIP-712 domain version (empty for native).</> },
        ]}
      />
      <H3 id="registry-attestation-struct">Attestation record</H3>
      <PropList
        items={[
          { name: 'paymentTxHash', type: 'bytes32', desc: <>Transaction hash of the <M>PaymentRouter.pay</M> call this attestation settles.</> },
          { name: 'success', type: 'bool', desc: <>Whether the upstream call was served successfully.</> },
          { name: 'timestamp', type: 'uint64', desc: <>Block time in <strong>milliseconds</strong> when the attestation was recorded.</> },
        ]}
      />

      <H3 id="registry-entrypoints">Entrypoints</H3>
      <DocTable
        head={['Signature', 'Auth', 'Behavior & reverts']}
        rows={[
          [
            <M key="s">registerService(name, description, gatewayBaseUrl, accepts[], paymentTarget, attestor) → uint64</M>,
            'anyone (caller becomes owner)',
            <span key="b">
              Bumps <M>servicesCount</M>, assigns it as the 1-based id, stores the record with{' '}
              <M>active=true</M>, emits <M>ServiceRegistered</M>, returns the id. Reverts{' '}
              <M>EmptyName()</M> if the name is empty/whitespace-only, <M>InvalidPrice()</M> if{' '}
              <M>accepts</M> is empty or any option&apos;s <M>amount &lt; MIN_PRICE_WEI</M>.
            </span>,
          ],
          [
            <M key="s">recordAttestation(serviceId, paymentTxHash: bytes32, success)</M>,
            'attestor OR owner',
            <span key="b">
              Marks <M>seenPayments</M>, saturating-bumps the <M>(total, success)</M> counters,
              writes into the 100-entry ring buffer, emits <M>AttestationRecorded</M> (carrying the
              post-update counters). Reverts <M>ServiceNotFound()</M>, then{' '}
              <M>NotAuthorized()</M> for strangers, <M>ServiceInactive()</M> if the service is
              inactive (<M>active=false</M> via <M>setActive</M>), <M>DuplicateAttestation()</M> if
              this hash was already attested for this service.
            </span>,
          ],
          [
            <M key="s">setActive(serviceId, active)</M>,
            'owner only',
            <span key="b">
              Toggles the <M>active</M> flag, emits <M>ServiceStatusChanged</M>. The attestor
              explicitly may NOT toggle. Reverts <M>ServiceNotFound()</M> for unknown ids,{' '}
              <M>NotAuthorized()</M> for non-owners.
            </span>,
          ],
          [
            <M key="s">setAttestor(serviceId, attestor)</M>,
            'owner only',
            <span key="b">
              Rotates the authorised attestor key, emits{' '}
              <M>ServiceAttestorChanged</M>. Lets an owner replace a compromised/rotated gateway
              signer without re-registering (which would mint a new id and reset the score) and
              without disabling the service. Reverts <M>ServiceNotFound()</M>,{' '}
              <M>NotAuthorized()</M> for non-owners.
            </span>,
          ],
          [
            <M key="s">getService(serviceId) → Service</M>,
            'read',
            'Reverts ServiceNotFound() for unknown ids — the client maps that revert to null rather than treating an RPC outage as absence.',
          ],
          [
            <M key="s">getScore(serviceId) → (uint64 total, uint64 success)</M>,
            'read',
            'Never reverts — (0, 0) for unknown or never-attested ids; counters keep full history beyond the 100-entry ring buffer.',
          ],
          [
            <M key="s">getAttestations(serviceId) → Attestation[]</M>,
            'read',
            'Never reverts — the last (up to) 100 attestations, newest first; empty for unknown ids.',
          ],
          [
            <M key="s">servicesCount() → uint64</M>,
            'read',
            'Never reverts — equals the id of the most recently registered service (0 if none).',
          ],
        ]}
      />
      <Callout tone="info" title="ATTESTATION CAP">
        <M>recordAttestation</M> writes into a fixed 100-slot ring buffer and{' '}
        <M>getAttestations</M> reverses it on read, so the returned list is newest-first and bounded
        at <strong>constant</strong> write cost — no O(n) storage shifting. The counters use
        saturating adds and keep the full count. After 105 calls, <M>getAttestations</M> returns
        the most recent 100 while <M>getScore</M> reports all 105.
      </Callout>
      <P>
        The contract stores raw counters only — the trust tier shown in the dashboard and read by
        buyer agents is computed off-chain as the <M>success_calls / total_calls</M> ratio bucketed
        by <M>trustTier()</M> in <M>packages/shared/src/trust.ts</M> (<M>new</M> / <M>reliable</M> /{' '}
        <M>trusted</M>); see{' '}
        <DocLink href="/docs/protocol#attestation">Attestation and trust score</DocLink>.
      </P>

      <H3 id="registry-events">Events</H3>
      <P>
        Standard EVM logs. The registry declares four events; <M>serviceId</M> is indexed on all
        of them, so a reader can filter by service without scanning:
      </P>
      <DocTable
        head={['Event', 'Fields', 'Emitted on']}
        rows={[
          [
            <M key="e">ServiceRegistered</M>,
            'serviceId (indexed), owner (indexed), name, accepts[], paymentTarget, attestor',
            <M key="o">registerService</M>,
          ],
          [
            <M key="e">AttestationRecorded</M>,
            'serviceId (indexed), paymentTxHash (indexed), success, totalCalls (after), successCalls (after)',
            <M key="o">recordAttestation</M>,
          ],
          [
            <M key="e">ServiceStatusChanged</M>,
            'serviceId (indexed), active (new value)',
            <M key="o">setActive</M>,
          ],
          [
            <M key="e">ServiceAttestorChanged</M>,
            'serviceId (indexed), attestor (the new authorised address)',
            <M key="o">setAttestor</M>,
          ],
        ]}
      />

      <H3 id="registry-errors">Errors</H3>
      <P>
        Solidity <strong>custom errors</strong> (4-byte selectors), not revert strings — cheaper,
        and typed on the client so <M>Live0gClient</M> can tell &ldquo;this service does not
        exist&rdquo; from &ldquo;the RPC is unreachable&rdquo;.
      </P>
      <DocTable
        head={['Error', 'Trigger']}
        rows={[
          [<M key="e">NotAuthorized()</M>, 'Caller is neither attestor nor owner (recordAttestation), or not the owner (setActive / setAttestor).'],
          [<M key="e">ServiceNotFound()</M>, 'Unknown serviceId.'],
          [<M key="e">ServiceInactive()</M>, 'Attestation against a service with active=false.'],
          [<M key="e">DuplicateAttestation()</M>, 'paymentTxHash already attested for this service (seenPayments guard; the guard is per-service, so the same hash may be attested on a different service).'],
          [<M key="e">InvalidPrice()</M>, 'Empty accepts[], or an option amount below MIN_PRICE_WEI (1e12), at registration.'],
          [<M key="e">EmptyName()</M>, 'name empty or whitespace-only at registration.'],
        ]}
      />

      <H2 id="router">PaymentRouter</H2>
      <P>
        A plain EVM value transfer carries no invoice reference, so nothing binds a payment to the
        402 that asked for it. <M>PaymentRouter</M> is that binding, and it is the whole reason the
        gateway&rsquo;s verification is a single exact-match log lookup rather than a heuristic
        search through transfers.
      </P>
      <DocTable
        head={['Signature', 'Auth', 'Behavior &amp; reverts']}
        rows={[
          [
            <M key="s">pay(uint64 serviceId, uint256 nonce, address payTo) payable</M>,
            'anyone',
            <span key="b">
              Forwards the <strong>entire</strong> <M>msg.value</M> to <M>payTo</M> and emits{' '}
              <M>Paid</M>. The router never custodies funds: value in, value straight out. Reverts{' '}
              <M>ZeroAmount()</M> on a zero-value call, <M>ZeroPayTo()</M> on the zero address,{' '}
              <M>DuplicateNonce()</M> if this <M>(serviceId, nonce)</M> was already paid, and{' '}
              <M>TransferFailed()</M> if the outbound call fails.
            </span>,
          ],
          [
            <M key="s">seenNonce(bytes32) → bool</M>,
            'read',
            'The on-chain replay guard: keccak(serviceId, nonce) → already paid?',
          ],
          [
            <M key="s">nonceKey(uint64 serviceId, uint256 nonce) → bytes32</M>,
            'pure',
            'The seenNonce key for a pair — keccak256(abi.encode(serviceId, nonce)).',
          ],
        ]}
      />
      <P>
        The <M>Paid</M> event indexes <M>serviceId</M>, <M>nonce</M> and <M>payer</M>, and carries{' '}
        <M>payTo</M>, <M>amount</M> and a millisecond <M>timestamp</M>. The gateway verifies a
        payment by reading the presented transaction&apos;s receipt and matching a <M>Paid</M> log
        from this exact contract on both indexed fields — one lookup, no scanning.
      </P>
      <Callout tone="ok" title="Two independent replay guards, and why the ordering matters">
        <M>pay</M> burns the nonce <strong>before</strong> the outbound transfer
        (checks-effects-interactions). A failed transfer reverts the whole transaction, which rolls
        the burn back too — so a failed payment leaves the invoice still payable rather than
        stranding the buyer with a dead nonce. On top of that, the gateway burns the same nonce in
        its own invoice store before proxying. Either guard alone stops a replay; together they
        close the window between them.
      </Callout>
      <Callout tone="warn" title="Never pay a service with a plain transfer">
        Sending OG directly to <M>payTo</M> settles nothing: there is no <M>Paid</M> log, so the
        gateway has no way to bind the payment to your invoice, and the money is gone without the
        data. Always call <M>pay()</M> at the <M>extra.router</M> address the invoice names.
      </Callout>

      <H2 id="spendguard">SpendGuard</H2>
      <Callout tone="warn" title="NOT YET WIRED INTO THE PRODUCT">
        SpendGuard is implemented and fully unit-tested, but it is <strong>not</strong> integrated
        into the running AgentGate product. There is no off-chain <M>SpendGuardClient</M> (
        <M>packages/chain/</M> ships only the registry client), the middleware{' '}
        <strong>does not call <M>debit</M></strong> before proxying (<M>/svc/:id</M> in{' '}
        <M>packages/middleware/src/app.ts</M> has no policy hook), and{' '}
        <M>SPEND_GUARD_ADDRESS</M> is read by <M>loadConfig()</M> but nothing consumes it yet.
        Until that wiring exists, SpendGuard must not be presented as an active spend-firewall — the
        contract is real and tested, but the live spend-control path it would enable is not yet
        built.
      </Callout>
      <P>
        Conceptually: an agent calls <M>open_policy</M> to mint a budget + rate + trust mandate,
        pre-funds the per-policy escrow with <M>deposit</M>, and (in the intended design) before
        serving a paid call the policy&rsquo;s <M>gate</M> calls <M>debit</M>. Every rule is
        enforced on-chain; a violation <M>revert</M>s atomically so the escrow is untouched and the
        payment never settles. On success the escrowed wei move to <M>payTo</M> in the same
        transaction. The owner can reclaim unspent escrow with <M>withdraw</M> and flip a
        kill-switch with <M>pause</M>.
      </P>

      <H3 id="spendguard-storage">Storage</H3>
      <DocTable
        head={['Field', 'Type', 'Holds']}
        rows={[
          [
            <M key="s">policiesCount</M>,
            <M key="t">uint64 public</M>,
            'Number of policies opened (0 initially); equals the id of the most recent one. Ids run 1..=policiesCount.',
          ],
          [<M key="s">policies</M>, <M key="t">mapping(uint64 =&gt; Policy)</M>, 'policyId → the Policy record.'],
          [
            <M key="s">seenRefs</M>,
            <M key="t">mapping(bytes32 =&gt; bool)</M>,
            'keccak(policyId, paymentRef) → debited? The per-policy replay guard.',
          ],
          [
            <M key="s">callTimes</M>,
            <M key="t">mapping(uint64 =&gt; uint64[])</M>,
            'policyId → approved-debit timestamps (ms) inside the live rate window (pruned on each debit).',
          ],
        ]}
      />
      <P>
        The <M>Policy</M> record carries: <M>owner</M> and <M>gate</M> (only the gate may{' '}
        <M>debit</M>; only the owner may <M>pause</M> / <M>withdraw</M>), <M>budget</M> (cumulative
        spend ceiling), <M>spent</M>, <M>balance</M> (escrowed wei available), <M>perCallCap</M>
        , <M>windowMs</M> + <M>maxCallsInWindow</M> (the sliding rate limit),{' '}
        <M>minTrustTier</M> (a <M>uint8</M> 0..=255 mandate — the tier value is supplied off-chain
        by the gate on each <M>debit</M>, e.g. the registry success ratio bucketed into tiers),{' '}
        <M>paused</M>, and <M>createdAt</M> (ms).
      </P>

      <H3 id="spendguard-entrypoints">Entrypoints</H3>
      <DocTable
        head={['Signature', 'Auth', 'Behavior & reverts']}
        rows={[
          [
            <M key="s">openPolicy(gate, budget, perCallCap, windowMs, maxCallsInWindow, minTrustTier) → uint64</M>,
            'anyone (caller becomes owner)',
            <span key="b">
              Mints a 1-based policy with <M>spent=0</M>, <M>balance=0</M>, <M>paused=false</M>;
              emits <M>PolicyOpened</M>. Reverts <M>InvalidConfig()</M> if{' '}
              <M>perCallCap == 0</M>, <M>maxCallsInWindow == 0</M>, <M>budget == 0</M>, or{' '}
              <M>perCallCap &gt; budget</M>.
            </span>,
          ],
          [
            <M key="s">deposit(policyId) payable</M>,
            'anyone (payable)',
            <span key="b">
              Adds <M>msg.value</M> to the escrow <M>balance</M>; emits{' '}
              <M>Deposited</M>. Reverts <M>PolicyNotFound()</M>, <M>ZeroAmount()</M>.
            </span>,
          ],
          [
            <M key="s">debit(policyId, serviceId, amount, payTo, paymentRef: bytes32, trustTier)</M>,
            'gate only',
            <span key="b">
              The firewall. Enforces every rule, writes all state, then transfers atomically and
              emits <M>DebitApproved</M>. The revert order is <strong>normative</strong> and asserted by the
              suite: <M>PolicyNotFound()</M> → <M>NotAuthorized()</M> (caller ≠ gate) →{' '}
              <M>Paused()</M> → <M>ZeroAmount()</M> → <M>PerCallExceeded()</M> →{' '}
              <M>UntrustedService()</M> → <M>DuplicateRef()</M> → <M>OverBudget()</M> (exceeds
              balance or pushes spent past budget) → <M>RateExceeded()</M>. A blocked debit reverts
              and emits nothing.
            </span>,
          ],
          [
            <M key="s">withdraw(policyId, amount)</M>,
            'owner only',
            <span key="b">
              Reclaims unspent escrow to the owner (works even while paused, so
              funds are never locked); emits <M>Withdrawn</M>. Reverts <M>PolicyNotFound()</M>,{' '}
              <M>NotAuthorized()</M>, <M>ZeroAmount()</M>, <M>OverBudget()</M> if{' '}
              <M>amount &gt; balance</M>.
            </span>,
          ],
          [
            <M key="s">pause(policyId, paused)</M>,
            'owner only',
            <span key="b">
              Flips the kill-switch; emits <M>PolicyPaused</M>. Reverts <M>PolicyNotFound()</M>,{' '}
              <M>NotAuthorized()</M>.
            </span>,
          ],
          [
            <M key="s">getPolicy(policyId) → Policy</M>,
            'read',
            'Reverts PolicyNotFound() if never opened.',
          ],
          [
            <M key="s">getRemaining(policyId) → uint256</M>,
            'read',
            'Never reverts — the escrow balance available; 0 for unknown ids.',
          ],
          [
            <M key="s">policiesCount() → uint64</M>,
            'read',
            'Never reverts — equals the id of the most recent policy (0 if none).',
          ],
        ]}
      />

      <H3 id="spendguard-events-errors">Events &amp; errors</H3>
      <P>
        Events: <M>PolicyOpened</M>, <M>Deposited</M>, <M>DebitApproved</M> (only on an approved
        debit — a blocked one reverts and emits nothing, so the failed deploy is itself the
        on-chain &ldquo;blocked&rdquo; signal), <M>PolicyPaused</M>, <M>Withdrawn</M>.
      </P>
      <DocTable
        head={['Error', 'Trigger']}
        rows={[
          [<M key="e">PolicyNotFound()</M>, 'Unknown policyId.'],
          [<M key="e">NotAuthorized()</M>, 'debit by a non-gate, or pause/withdraw by a non-owner.'],
          [<M key="e">Paused()</M>, 'debit while the policy is paused.'],
          [<M key="e">ZeroAmount()</M>, 'deposit/debit/withdraw amount was zero.'],
          [<M key="e">PerCallExceeded()</M>, 'Single-call amount exceeds perCallCap.'],
          [<M key="e">UntrustedService()</M>, 'Counterparty trustTier below the policy minTrustTier.'],
          [<M key="e">DuplicateRef()</M>, 'paymentRef already debited for this policy (replay guard).'],
          [<M key="e">OverBudget()</M>, 'Amount exceeds escrow balance, or would push spent past budget (also: withdraw amount > balance).'],
          [<M key="e">RateExceeded()</M>, 'Too many approved debits inside the current rate window.'],
          [<M key="e">InvalidConfig()</M>, 'openPolicy with zero perCallCap / maxCallsInWindow / budget, or perCallCap > budget.'],
          [<M key="e">TransferFailed()</M>, 'The outbound value transfer (debit payout or withdraw) failed.'],
        ]}
      />

      <H2 id="build-deploy">Build and deploy</H2>
      <P>
        <M>contracts-evm/</M> is a Foundry workspace, not an npm one. <M>contracts-evm/lib/</M> is
        gitignored, so vendor forge-std once on a fresh clone:
      </P>
      <CommandBlock text="cd contracts-evm && forge install foundry-rs/forge-std@v1.16.2 --no-git --shallow" />
      <CommandBlock text="cd contracts-evm && forge test" />
      <P>
        Runs all 42 tests, in-process, with no node and no network. They cover: registration
        validation (empty/whitespace name, sub-floor price, empty <M>accepts</M>), 1-based id
        assignment and <M>servicesCount</M>, default reads for unknown ids, attestor-or-owner auth
        (strangers revert), the per-service duplicate guard (and that it really is per-service), the
        inactive-flag freeze and reactivation, score math, the 100-entry ring buffer wrapping while
        counters keep full history, owner-only <M>setActive</M> / <M>setAttestor</M> (attestor
        rejected), <M>PaymentRouter</M>&rsquo;s checks-effects-interactions ordering — a failed
        transfer leaves the nonce unburned, so the invoice stays payable — and every one of{' '}
        <M>SpendGuard.debit</M>&rsquo;s ordered revert checks plus its rate-window pruning
        (all-kept, all-pruned, and partial-prune branches).
      </P>
      <CommandBlock text="cd contracts-evm && forge build" />
      <P>
        solc <M>0.8.28</M> (fetched automatically on first use), optimizer 200 runs,{' '}
        <M>evm_version = &quot;cancun&quot;</M>. Runtime bytecode is well inside EIP-170&rsquo;s
        24,576-byte limit for all three — the largest is <M>AgentGateRegistry</M> at 6,850 bytes —
        so there is no size-related deploy risk.
      </P>
      <Callout tone="ok" title="ALREADY DEPLOYED — THIS IS THE RECIPE">
        The contracts are already live on 0G Galileo — <M>AgentGateRegistry</M> at{' '}
        <M>{DEFAULT_REGISTRY_ADDRESS}</M> — and what follows is the runbook that
        produced them, kept so the deploy is reproducible on a key of your own. Deploying all three
        costs roughly{' '}
        <strong>0.014 OG</strong> at 0G&rsquo;s ~4 gwei — comfortably inside a single day&rsquo;s
        faucet grant from{' '}
        <a href="https://faucet.0g.ai" target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4 hover:text-white">faucet.0g.ai</a>{' '}
        (0.1 OG per wallet per day), so there is no need to split it across two days. The full
        runbook — including the free Anvil-fork rehearsal and the post-deploy verification
        checklist — is in <M>contracts-evm/README.md</M> and <M>docs/DEPLOY.md</M>.
      </Callout>
      <CommandBlock
        wrap
        text={'cd contracts-evm && forge script script/Deploy.s.sol:Deploy --rpc-url https://evmrpc-testnet.0g.ai --private-key "$DEPLOYER_KEY" --broadcast'}
      />
      <P>
        The script prints three lines to paste into the root <M>.env</M>. None of the contracts are
        upgradable — there is no proxy, so a &ldquo;redeploy&rdquo; is a fresh address starting from
        empty state (<M>servicesCount == 0</M>, no attestation history).
      </P>
      <CodeBlock
        label="root .env"
        code={
          'REGISTRY_CONTRACT_ADDRESS=0x…\n' +
          'PAYMENT_ROUTER_ADDRESS=0x…\n' +
          'SPEND_GUARD_ADDRESS=0x…'
        }
      />

      <NextLinks
        links={[
          { href: '/docs/architecture', label: 'Architecture' },
          { href: '/docs/errors', label: 'Error codes' },
        ]}
      />
    </>
  );
}
