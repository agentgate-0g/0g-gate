/**
 * Waiting for a transaction receipt on 0G.
 *
 * 0G reports a block before the receipts for its transactions are queryable,
 * and the public RPC is load-balanced, so the node answering a poll is often
 * not the one that accepted the transaction. viem raises that as
 * `TransactionReceiptNotFoundError` — which reads exactly like "this
 * transaction does not exist", and is not what it means.
 *
 * Treating it as failure abandons transactions that already succeeded. That is
 * not a cosmetic difference on the buy path: tx
 * `0xfdcdd67a2c87976466ae5c5e8f3837910f31c928bfadc678375adf6e387d39f5` paid
 * 0.001 OG into the PaymentRouter, landed in block 53367833 with status 1, and
 * the buyer still got `TX_RECEIPT_UNCONFIRMED` and no API response — the call
 * was never redeemed against a payment that had already been made. Money out,
 * nothing served, and no attestation to show for it.
 *
 * So the wait is retried against a wall-clock deadline instead of giving up on
 * the first miss, and ONLY for the errors that mean "not served yet". A revert,
 * a malformed hash, or a transport error that says something real is rethrown
 * untouched: retrying those would hide a genuine failure behind a timeout.
 *
 * This is the same rule ProofRelay applies against the same chain, arrived at
 * the same way — by watching a transfer that had already succeeded be reported
 * as a crash.
 */
import {
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';

/** Wall-clock budget for one receipt, when the config does not name one. */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Worst case for ONE JSON-RPC request through viem's default `http()`
 * transport: `timeout: 10_000` with `retryCount: 3`, so four tries plus about a
 * second of exponential backoff.
 */
export const TRANSPORT_WORST_CASE_MS = 41_000;

/**
 * Budget for ONE `waitForTransactionReceipt` call.
 *
 * Short enough that re-entering the call gets the next poll onto a different
 * peer of the load balancer — a single call stays on the peer it started with,
 * and a peer that is behind stays behind. The wall-clock deadline below is what
 * actually decides how long we wait.
 *
 * But it MUST exceed `TRANSPORT_WORST_CASE_MS`, and this was 20s before that
 * was understood. viem assigns its block-watcher handle only after the FIRST
 * `getTransactionReceipt` resolves; a timeout that fires while that probe is
 * still in flight finds nothing to unwatch, and the orphaned continuation then
 * starts a per-block poller nobody holds a handle to. Against a stalled RPC
 * that leaks one poller per abandoned attempt, for the life of the process.
 */
export const RECEIPT_ATTEMPT_TIMEOUT_MS = 60_000;

/** Pause between attempts. Roughly four 0G blocks — long enough that a lagging
 *  peer can catch up, short enough that a normal receipt is not delayed. */
export const RECEIPT_RETRY_DELAY_MS = 2_000;

/**
 * The wordings a 0G node uses for a receipt it cannot serve yet.
 *
 * Matched on text as well as on viem's error classes because the same
 * condition arrives differently depending on where it is raised: Galileo says
 * "could not be found", and mainnet answers "no matching receipts found: this
 * may indicate potential data corruption" — alarming, and still just lag.
 * Neither is reached through a viem error class when it surfaces from a raw
 * RPC call.
 */
const LAG_WORDING =
  /could not be found|no matching receipts|receipt(?:s)?\s+(?:were\s+)?not\s+found|could not be processed/i;

/**
 * True only when the node has not served the receipt yet — never for a
 * transaction that actually failed.
 *
 * `WaitForTransactionReceiptTimeoutError` counts: viem raises it when its own
 * inner budget elapses without a receipt, which is the same condition observed
 * from one level up.
 *
 * Every field is searched, not the first one that happens to be set. Every viem
 * error is a BaseError, and BaseError ALWAYS fills `shortMessage` with its own
 * canned English while the node's actual words go to `details` (and into
 * `message` as a trailing "Details:" line). A `shortMessage ?? message` chain
 * therefore never reaches the node's wording at all, which made this whole
 * regex dead code for anything arriving through a viem client — the only way it
 * ever arrives in production. Mainnet's lag is JSON-RPC -32000, which viem
 * wraps as InvalidInputRpcError with shortMessage "Missing or invalid
 * parameters."; matched against that alone the answer is false, and the retry
 * this file exists to perform never happens.
 */
export function isReceiptLag(err: unknown): boolean {
  if (err instanceof TransactionReceiptNotFoundError) return true;
  if (err instanceof WaitForTransactionReceiptTimeoutError) return true;
  const shell = err as { shortMessage?: unknown; details?: unknown; message?: unknown } | null | undefined;
  const parts = [shell?.shortMessage, shell?.details, shell?.message].filter(
    (part): part is string => typeof part === 'string',
  );
  return LAG_WORDING.test(parts.length > 0 ? parts.join('\n') : String(err));
}

export interface AwaitReceiptOptions {
  /** Total wall-clock budget across every attempt. */
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Injected so a test can drive the deadline without waiting for one. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `attempt` until it returns, the deadline passes, or it fails for a
 * reason that is not receipt lag.
 *
 * Deliberately generic over what an attempt *is*: the caller owns the viem
 * call and its own per-attempt budget, and this owns only the question of
 * whether a failure is worth trying again. That keeps the retry rule testable
 * without a node — which matters, because a node fast enough to run a test
 * against is precisely one that never reproduces the bug.
 */
export async function awaitReceipt<T>(
  attempt: () => Promise<T>,
  options: AwaitReceiptOptions = {},
): Promise<T> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryDelayMs = options.retryDelayMs ?? RECEIPT_RETRY_DELAY_MS;
  const deadline = now() + (options.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS);

  for (;;) {
    try {
      return await attempt();
    } catch (err: unknown) {
      if (!isReceiptLag(err)) throw err;
      // The last lag error is rethrown rather than replaced, so the caller can
      // still recognise it and say "unconfirmed" rather than "failed".
      if (now() >= deadline) throw err;
      await sleep(retryDelayMs);
    }
  }
}
