import { describe, it, expect } from 'vitest';
import { mockAccountAddress } from '@agentgate/chain';
import type { PaymentRequiredResponse, ServiceRecord } from '@agentgate/shared';
import { isSelfPayment } from '../src/app';
import { bootGateway, startUpstream, adminMap, proofHeaders, sleep } from './helpers';

const OWNER = `0x${'aa'.repeat(20)}`;
const PAYOUT = `0x${'cd'.repeat(20)}`;
const ATTESTOR = `0x${'bb'.repeat(20)}`;

const svc = (over: Partial<ServiceRecord> = {}): ServiceRecord => ({
  id: 1,
  name: 'x',
  description: '',
  endpointUrl: '',
  priceWei: '1',
  paymentTarget: PAYOUT,
  owner: OWNER,
  attestor: ATTESTOR,
  active: true,
  createdAt: 0,
  ...over,
});

describe('isSelfPayment — F1 wash-trade guard', () => {
  it('true when the payer is the payout account (case-insensitive)', () => {
    // Only the hex digits vary case (EIP-55 checksum) — the "0x" prefix itself
    // is always lowercase, per sameAddress's ADDRESS_RE.
    expect(isSelfPayment(`0x${PAYOUT.slice(2).toUpperCase()}`, svc())).toBe(true);
  });
  it('true when the payer is the service owner', () => {
    expect(isSelfPayment(OWNER, svc())).toBe(true);
  });
  // The contract rejects payer == attestor too: the witness is as interested a
  // party as the owner. A guard narrower than the contract does not create a
  // hole — it creates a served call whose attestation reverts forever, so the
  // seller silently loses reputation for work they really did.
  it('true when the payer is the ATTESTOR — matching the registry revert', () => {
    expect(isSelfPayment(ATTESTOR, svc())).toBe(true);
  });

  it('false for a distinct third-party payer', () => {
    expect(isSelfPayment(`0x${'ee'.repeat(20)}`, svc())).toBe(false);
  });
  it('false for an empty/unknown payer', () => {
    expect(isSelfPayment('', svc())).toBe(false);
  });
  // The guard has to fire on REAL mock identities, not just on hand-written 0x
  // literals. sameAddress needs a well-formed 0x<40hex> on BOTH sides, so if mock
  // mode ever hands out a different identity shape, the format check fails before
  // any value comparison and the whole guard silently becomes a no-op on the demo
  // path — the exact path a wash trade would take. These two cases pin the mock's
  // identity shape to the one the guard can actually compare.
  describe('with identities the mock chain actually produces', () => {
    const SELLER_KEY = '01aa'.padEnd(66, '0');
    const SELLER = mockAccountAddress(SELLER_KEY);
    const mockSvc = svc({ owner: SELLER, paymentTarget: SELLER });

    it('fires when a mock payer IS the service owner', () => {
      expect(isSelfPayment(mockAccountAddress(SELLER_KEY), svc({ owner: SELLER }))).toBe(true);
    });

    it('fires when a mock payer IS the payout account', () => {
      expect(mockAccountAddress(SELLER_KEY)).toBe(SELLER); // the derivation is deterministic
      expect(isSelfPayment(SELLER, mockSvc)).toBe(true);
    });

    it('does not fire for a different mock buyer', () => {
      expect(isSelfPayment(mockAccountAddress('01bb'.padEnd(66, '0')), mockSvc)).toBe(false);
    });
  });
});

describe('self-paid call is served but not scored — F1', () => {
  it('payer == payment target → 200 to the buyer but no attestation recorded', async () => {
    const gw = await bootGateway();
    const upstream = await startUpstream();
    try {
      const target = `0x${'cd'.repeat(20)}`;
      gw.fake.addService({ id: 7, paymentTarget: target });
      await adminMap(gw, 7, `${upstream.url}/data`);

      const challenge = await fetch(`${gw.baseUrl}/svc/7`);
      const body = (await challenge.json()) as PaymentRequiredResponse;
      const req = body.accepts[0]!;
      // Pay from the payout account itself — a wash-trade attempt.
      const { txHash } = await gw.fake.transfer(
        { to: req.payTo, amountWei: req.maxAmountRequired, nonce: req.extra.nonce, serviceId: req.extra.serviceId },
        { kind: 'mock', publicKey: target },
      );
      const res = await fetch(`${gw.baseUrl}/svc/7`, {
        headers: proofHeaders({ txHash, nonce: req.extra.nonce, network: req.network }),
      });
      expect(res.status).toBe(200); // the buyer paid, so they are still served
      await sleep(100);
      expect(gw.fake.attestations.filter((a) => a.serviceId === 7).length).toBe(0); // never scored
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});
