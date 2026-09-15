/**
 * The receipt-lag retry.
 *
 * Driven with a fake clock and a fake attempt, because the bug only appears on
 * a node that is BEHIND — and a node fast enough to run a test against never
 * reproduces it. What is under test is the rule, not viem: which failures are
 * worth trying again, which must be rethrown untouched, and that the wait is
 * bounded by a deadline rather than by one call's internal backoff.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InvalidInputRpcError,
  InternalRpcError,
  RpcRequestError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import {
  awaitReceipt,
  isReceiptLag,
  DEFAULT_RECEIPT_TIMEOUT_MS,
  RECEIPT_ATTEMPT_TIMEOUT_MS,
  TRANSPORT_WORST_CASE_MS,
} from '../src/receipt';

/**
 * A node-level JSON-RPC error as viem ACTUALLY delivers it.
 *
 * This shape is the whole point. A bare `new Error(nodeText)` puts the wording
 * in `message` with no `shortMessage`, which is a shape the http transport
 * never produces — and testing only that shape is how a predicate that reads
 * `shortMessage ?? message` passed its tests while returning false for every
 * real mainnet lag error. viem always wraps: its own canned English goes to
 * `shortMessage`, the node's words to `details`.
 */
function rpcError(code: number, nodeText: string): Error {
  const inner = new RpcRequestError({
    body: { method: 'eth_getTransactionReceipt' },
    error: { code, message: nodeText },
    url: 'https://evmrpc.0g.ai',
  });
  return code === -32000 ? new InvalidInputRpcError(inner) : new InternalRpcError(inner);
}

/** A clock the test moves by hand, so a 180s deadline costs no wall time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    /** Every sleep advances the clock by exactly what was asked for. */
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const notFound = () =>
  new TransactionReceiptNotFoundError({ hash: `0x${'ab'.repeat(32)}` });

describe('isReceiptLag', () => {
  it('recognises viem not-found and timeout as lag', () => {
    expect(isReceiptLag(notFound())).toBe(true);
    expect(
      isReceiptLag(
        new WaitForTransactionReceiptTimeoutError({ hash: `0x${'cd'.repeat(32)}` }),
      ),
    ).toBe(true);
  });

  /**
   * Galileo and mainnet describe the same lag differently, and mainnet's
   * wording accuses the chain of data corruption. Neither arrives as a viem
   * error class when it surfaces from a raw RPC call, so the text matters.
   */
  it('recognises the wordings a 0G node uses for a receipt it cannot serve yet', () => {
    expect(isReceiptLag(new Error('Transaction receipt with hash "0xabc" could not be found.'))).toBe(true);
    expect(
      isReceiptLag(
        new Error('no matching receipts found: this may indicate potential data corruption'),
      ),
    ).toBe(true);
  });

  /**
   * The load-bearing negative. A revert is a real answer about a real
   * transaction; retrying it would turn a clear failure into a slow timeout
   * and hide the reason.
   */
  it('does not treat a revert or an ordinary error as lag', () => {
    expect(isReceiptLag(new Error('execution reverted: DuplicateAttestation'))).toBe(false);
    expect(isReceiptLag(new Error('nonce too low'))).toBe(false);
    expect(isReceiptLag(new Error('fetch failed'))).toBe(false);
    expect(isReceiptLag(undefined)).toBe(false);
    expect(isReceiptLag(null)).toBe(false);
  });

  it('reads viem shortMessage as well as message', () => {
    expect(isReceiptLag({ shortMessage: 'The receipt could not be found.' })).toBe(true);
  });

  /**
   * The case the first version of this file got wrong. 0G mainnet answers a
   * lagging receipt with JSON-RPC -32000 and the text below; viem wraps that as
   * InvalidInputRpcError whose shortMessage is "Missing or invalid parameters."
   * Reading shortMessage alone, the answer was false — so the retry never ran
   * and a paid call failed on a transaction that had already landed.
   */
  it('recognises the mainnet wording through the wrapper viem actually applies', () => {
    const wrapped = rpcError(-32000, 'no matching receipts found: this may indicate potential data corruption');
    expect(wrapped.constructor.name).toBe('InvalidInputRpcError');
    expect((wrapped as { shortMessage?: string }).shortMessage).not.toMatch(/receipt/i);
    expect(isReceiptLag(wrapped)).toBe(true);
  });

  it('recognises the Galileo wording through the same wrapper', () => {
    expect(isReceiptLag(rpcError(-32603, 'transaction receipt could not be found'))).toBe(true);
  });

  /**
   * The other half: wrapping must not turn real failures into lag. Every one of
   * these arrives through the same viem classes as the two above.
   */
  it('does not classify a real RPC failure as lag once wrapped', () => {
    for (const text of [
      'execution reverted: DuplicateAttestation',
      'nonce too low',
      'insufficient funds for gas * price + value',
      'replacement transaction underpriced',
      'method eth_getTransactionReceipt does not exist',
      'already known',
    ]) {
      expect(isReceiptLag(rpcError(-32000, text)), text).toBe(false);
      expect(isReceiptLag(rpcError(-32603, text)), text).toBe(false);
    }
  });
});

describe('awaitReceipt', () => {
  it('returns the first answer without sleeping', async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async () => 'receipt');
    const sleep = vi.fn(clock.sleep);

    await expect(awaitReceipt(attempt, { now: clock.now, sleep })).resolves.toBe('receipt');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  /**
   * The whole point. Before this, one not-found ended the wait and the caller
   * reported a transaction that had already succeeded as unconfirmed.
   */
  it('keeps asking while the node has not served the receipt yet', async () => {
    const clock = fakeClock();
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls < 4) throw notFound();
      return 'receipt';
    });

    await expect(
      awaitReceipt(attempt, { now: clock.now, sleep: clock.sleep, retryDelayMs: 2_000 }),
    ).resolves.toBe('receipt');
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it('rethrows anything that is not lag, on the first attempt', async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async () => {
      throw new Error('execution reverted: DuplicateAttestation');
    });

    await expect(awaitReceipt(attempt, { now: clock.now, sleep: clock.sleep })).rejects.toThrow(
      /DuplicateAttestation/,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up at the deadline and rethrows the last lag error', async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async () => {
      throw notFound();
    });

    await expect(
      awaitReceipt(attempt, {
        timeoutMs: 10_000,
        retryDelayMs: 2_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toBeInstanceOf(TransactionReceiptNotFoundError);

    // The error stays recognisable, which is what lets settled() report
    // "unconfirmed" rather than "failed" after the budget runs out.
    await expect(
      awaitReceipt(attempt, { timeoutMs: 1_000, now: clock.now, sleep: clock.sleep }).catch(
        (err) => isReceiptLag(err),
      ),
    ).resolves.toBe(true);
  });

  it('bounds the wait by the deadline rather than by an attempt count', async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async () => {
      throw notFound();
    });

    await expect(
      awaitReceipt(attempt, {
        timeoutMs: 10_000,
        retryDelayMs: 2_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toBeTruthy();

    // 10s of budget at 2s a retry: attempts at 0,2,4,6,8s, and the one at 10s
    // is refused because the deadline has arrived.
    expect(attempt).toHaveBeenCalledTimes(6);
  });

  it('always tries once, even with no budget left', async () => {
    const clock = fakeClock();
    const attempt = vi.fn(async () => 'receipt');
    await expect(
      awaitReceipt(attempt, { timeoutMs: 0, now: clock.now, sleep: clock.sleep }),
    ).resolves.toBe('receipt');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('budgets', () => {
  /**
   * An attempt budget at or above the total would make the outer loop
   * decorative — the first call would consume the whole deadline and never be
   * re-entered against another peer.
   */
  it('leaves room for more than one attempt inside the default deadline', () => {
    expect(RECEIPT_ATTEMPT_TIMEOUT_MS).toBeLessThan(DEFAULT_RECEIPT_TIMEOUT_MS);
  });

  /**
   * Pinned, because getting this backwards leaks pollers rather than failing.
   * viem assigns its block-watcher handle only after the first probe resolves,
   * so an attempt timeout shorter than one worst-case request can fire while
   * that probe is still in flight — leaving a per-block poller with no owner.
   */
  it('outlives the transport, so a timeout cannot fire mid-probe', () => {
    expect(RECEIPT_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(TRANSPORT_WORST_CASE_MS);
  });
});
