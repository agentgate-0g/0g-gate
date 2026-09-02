/**
 * Durable attestation queue (finding F7).
 *
 * A served-and-paid call is scored by an on-chain `record_attestation`. That
 * write is fire-and-forget with in-process retry (see app.ts `scheduleAttestation`),
 * so a call whose retries all fail — or whose process exits mid-retry (deploy,
 * crash) — would be silently *under-counted*: the buyer paid, the seller served,
 * but the trust ledger never learned about it.
 *
 * This queue closes that gap. Each pending attestation is enqueued *before* the
 * first on-chain attempt and removed only once the attempt confirms. Unconfirmed
 * entries survive a restart (file-backed variant) and are replayed on boot.
 * Replay is safe because the registry contract dedups by
 * `(service_id, payment_tx_hash)` (`seen_payments`), so re-submitting an
 * already-recorded attestation is an idempotent no-op on-chain.
 *
 * Replay alone is not enough, though: some `recordAttestation` reverts can never
 * succeed no matter how often they are replayed (see
 * {@link TERMINAL_ATTESTATION_REVERTS}). Without a bound, one such entry is
 * re-submitted on every boot forever and the queue file grows without limit. So
 * every entry carries an attempt budget and an age, and an entry that exhausts
 * either — or that fails terminally even once — is moved to the DEAD-LETTER log:
 * out of the live queue, still counted, still inspectable. A dead-lettered
 * attestation is a seller who served a call and lost the reputation for it, so it
 * must be visible to an operator, never silently swallowed.
 *
 * On-disk format: entries are keyed by `paymentTxHash`, and the live queue file
 * stays the same bare `[entry, …]` array earlier builds wrote — dead letters go
 * to a sidecar file next to it. A queue file written by an older build that used
 * a different key fails {@link FileAttestationQueue}'s shape guard and its
 * entries are silently dropped on load — the same "corrupt/unknown data starts
 * empty" behavior as a malformed file. There is no migration path; an
 * unrecognized queue file is simply not read.
 */
export interface PendingAttestation {
  /** Payment tx hash — the idempotent key (on-chain `seen_payments` dedups replays). */
  paymentTxHash: string;
  /** Service whose score this attestation feeds. */
  serviceId: number;
  /** Invoice nonce of the settlement being attested (the registry verifies it). */
  nonce: string;
  /** Address that settled it — the registry rejects a self-paying owner. */
  payer: string;
  /** Whether the served upstream response was a 2xx (success flag recorded on-chain). */
  success: boolean;
  /** ms-epoch the payment was captured (drives age-based pruning). */
  enqueuedAt: number;
  /** Failed on-chain attempts so far. Absent in files written before bounded retries (read as 0). */
  attempts?: number;
  /** Most recent failure message, for diagnostics. */
  lastError?: string;
}

/** A pending attestation that will never be retried again, kept for an operator to see. */
export interface DeadLetteredAttestation extends PendingAttestation {
  /** ms-epoch it left the live queue. */
  deadLetteredAt: number;
  /** Why it will never be retried: the terminal revert, the spent budget, or its age. */
  reason: string;
}

/** What {@link AttestationQueue.recordFailure} did with the entry. */
export type AttestationFailureOutcome = 'retrying' | 'dead-lettered' | 'unknown';

/** Monitoring surface — what an operator needs to see that attestations are flowing. */
export interface AttestationQueueStats {
  /** Live queue depth: attestations still awaiting an on-chain confirmation. */
  pending: number;
  /** Age of the oldest live entry, in ms (0 when the queue is empty). */
  oldestPendingAgeMs: number;
  /** Attestations abandoned since this process started, plus any loaded from disk. Monotonic. */
  deadLettered: number;
}

/** Tuning for {@link AttestationQueue} implementations. */
export interface AttestationQueueOptions {
  /** Failed attempts before a retryable entry is dead-lettered. Default {@link DEFAULT_MAX_ATTESTATION_ATTEMPTS}. */
  maxAttempts?: number;
  /** How long an entry may stay pending before age-pruning it. Default {@link DEFAULT_ATTESTATION_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** How many dead letters to retain for inspection. Default {@link DEFAULT_MAX_RETAINED_DEAD_LETTERS}. */
  maxDeadLetters?: number;
}

/**
 * Attempt budget spanning restarts, not just one process. app.ts already retries
 * a handful of times in-process; this is the outer bound on how many boots may
 * replay the same entry before it is declared undeliverable.
 */
export const DEFAULT_MAX_ATTESTATION_ATTEMPTS = 12;

/**
 * Backstop for failures no revert name identifies — an RPC that is wrong rather
 * than down, a service whose owner never re-activates it. A week is long enough
 * that a genuine outage plus a fix still lands the attestation, short enough that
 * the queue file cannot accumulate for a whole deployment lifetime.
 */
export const DEFAULT_ATTESTATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Dead letters are retained for inspection, but bounded — the log must not become the new unbounded file. */
export const DEFAULT_MAX_RETAINED_DEAD_LETTERS = 200;

/**
 * Registry reverts whose cause a retry cannot change, so the attestation is
 * abandoned on the first one instead of being replayed forever.
 *
 * - `SelfPayment` — the payer is the service's owner, paymentTarget OR attestor.
 *   Reachable in normal operation: the gateway's own `isSelfPayment()` check omits
 *   the attestor, so an attestor-paid call enqueues an attestation the registry
 *   will reject on every single boot.
 * - `NoSuchPayment` / `Underpaid` — the settlement the registry looked up does not
 *   exist or did not cover the price. A past payment does not grow.
 * - `NotAuthorized` — this gateway is not the service's registered attestor. Only
 *   the seller can change that, and re-registering mints a new service id anyway.
 * - `ServiceNotFound` — the registry never deletes services, so an id it does not
 *   know is one it never will.
 *
 * Deliberately NOT terminal: `ServiceInactive` (the owner can re-activate the
 * service, after which the same replay succeeds) and every transport-level
 * failure — RPC down, timeout, nonce collision. Those keep their retries and are
 * bounded by attempts and age instead.
 */
export const TERMINAL_ATTESTATION_REVERTS = [
  'SelfPayment',
  'NoSuchPayment',
  'Underpaid',
  'NotAuthorized',
  'ServiceNotFound',
] as const;

/** Flattens an error and its `cause` chain into one searchable string. */
function describeErrorChain(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  // Depth-capped and cycle-guarded: a viem error nests several levels deep and
  // a self-referencing `cause` would otherwise spin here forever.
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    const e = current as { message?: unknown; shortMessage?: unknown; details?: unknown; data?: unknown; cause?: unknown };
    for (const field of [e.message, e.shortMessage, e.details]) {
      if (typeof field === 'string') parts.push(field);
    }
    const name = (e.data as { errorName?: unknown } | undefined)?.errorName;
    if (typeof name === 'string') parts.push(name);
    current = e.cause;
  }
  return parts.join('\n');
}

/**
 * True when the failure is one of {@link TERMINAL_ATTESTATION_REVERTS}. Matches
 * both viem's structured `cause.data.errorName` and the error name as it appears
 * in a flattened message, because the middleware sees whatever its chain adapter
 * hands it. Anything unrecognized is treated as retryable — under-counting a
 * seller's reputation is the harm to avoid, so only a named, provably permanent
 * revert abandons an attestation early.
 */
export function isTerminalAttestationError(err: unknown): boolean {
  const haystack = describeErrorChain(err);
  if (haystack === '') return false;
  return TERMINAL_ATTESTATION_REVERTS.some((name) => new RegExp(`\\b${name}\\b`).test(haystack));
}

/**
 * Persistence seam for pending attestations. The default is in-memory
 * ({@link MemoryAttestationQueue}); a file-backed variant survives restarts. The
 * interface is async so a shared store (e.g. Redis) can slot in for a
 * multi-instance deployment, exactly like {@link InvoiceStore}.
 */
export interface AttestationQueue {
  /** Record a pending attestation. Keyed by `paymentTxHash` — enqueuing the same hash twice is idempotent. */
  enqueue(item: PendingAttestation): Promise<void>;
  /** Drop a confirmed attestation so it is never replayed. */
  remove(paymentTxHash: string): Promise<void>;
  /** All still-pending attestations (used to replay on boot). Over-age entries are pruned first. */
  list(): Promise<PendingAttestation[]>;
  /**
   * Report a failed on-chain attempt. Terminal failures (see
   * {@link isTerminalAttestationError}) dead-letter at once; retryable ones spend
   * one attempt and dead-letter only when the budget runs out.
   */
  recordFailure(
    paymentTxHash: string,
    failure: { terminal: boolean; error: string },
  ): Promise<AttestationFailureOutcome>;
  /** Move over-age entries to the dead-letter log. Returns how many moved. Also runs lazily on enqueue/list/stats. */
  prune(): Promise<number>;
  /** Abandoned attestations, newest last, capped at `maxDeadLetters`. */
  deadLetters(): Promise<DeadLetteredAttestation[]>;
  /** Counters for a monitoring endpoint. */
  stats(): Promise<AttestationQueueStats>;
  /** Release any resources (timers/handles). Idempotent. */
  close(): void;
}

/**
 * Queue mechanics shared by the in-memory and file-backed variants: the attempt
 * budget, terminal dead-lettering, age pruning and the counters. Subclasses add
 * durability by overriding {@link persist}.
 */
export abstract class BaseAttestationQueue implements AttestationQueue {
  protected readonly items = new Map<string, PendingAttestation>();
  protected deadLetterLog: DeadLetteredAttestation[] = [];
  protected deadLetteredTotal = 0;
  protected readonly maxAttempts: number;
  protected readonly maxAgeMs: number;
  protected readonly maxDeadLetters: number;

  constructor(opts: AttestationQueueOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTESTATION_ATTEMPTS;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_ATTESTATION_MAX_AGE_MS;
    this.maxDeadLetters = opts.maxDeadLetters ?? DEFAULT_MAX_RETAINED_DEAD_LETTERS;
    if (this.maxAttempts < 1 || this.maxAgeMs <= 0 || this.maxDeadLetters < 1) {
      throw new RangeError('attestation queue bounds must be positive');
    }
  }

  /** Number of pending attestations currently held. */
  get size(): number {
    return this.items.size;
  }

  enqueue(item: PendingAttestation): Promise<void> {
    this.pruneExpired();
    const existing = this.items.get(item.paymentTxHash);
    // Same payment hash = same attestation. Carrying the attempt count over stops
    // a re-enqueue from handing a permanently failing entry a fresh budget.
    this.items.set(item.paymentTxHash, { ...item, attempts: existing?.attempts ?? item.attempts ?? 0 });
    this.persist();
    return Promise.resolve();
  }

  remove(paymentTxHash: string): Promise<void> {
    if (this.items.delete(paymentTxHash)) this.persist();
    return Promise.resolve();
  }

  list(): Promise<PendingAttestation[]> {
    this.pruneExpired();
    return Promise.resolve([...this.items.values()].map((i) => ({ ...i })));
  }

  recordFailure(
    paymentTxHash: string,
    failure: { terminal: boolean; error: string },
  ): Promise<AttestationFailureOutcome> {
    const entry = this.items.get(paymentTxHash);
    // Already confirmed (removed) or already dead-lettered: nothing to charge.
    if (!entry) return Promise.resolve('unknown');
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.lastError = failure.error.slice(0, 500);
    if (failure.terminal) {
      this.moveToDeadLetters(entry, `terminal failure: ${entry.lastError}`);
      return Promise.resolve('dead-lettered');
    }
    if (entry.attempts >= this.maxAttempts) {
      this.moveToDeadLetters(entry, `gave up after ${entry.attempts} attempts: ${entry.lastError}`);
      return Promise.resolve('dead-lettered');
    }
    this.persist();
    return Promise.resolve('retrying');
  }

  prune(): Promise<number> {
    return Promise.resolve(this.pruneExpired());
  }

  deadLetters(): Promise<DeadLetteredAttestation[]> {
    return Promise.resolve(this.deadLetterLog.map((d) => ({ ...d })));
  }

  stats(): Promise<AttestationQueueStats> {
    this.pruneExpired();
    const now = Date.now();
    let oldest = 0;
    for (const item of this.items.values()) {
      const age = now - item.enqueuedAt;
      if (age > oldest) oldest = age;
    }
    return Promise.resolve({
      pending: this.items.size,
      oldestPendingAgeMs: this.items.size === 0 ? 0 : Math.max(0, oldest),
      deadLettered: this.deadLetteredTotal,
    });
  }

  close(): void {
    // No timers held; nothing to release.
  }

  /**
   * Age backstop for failures no revert name identifies. Pruning is lazy —
   * driven by enqueue/list/stats rather than a timer — so the queue holds no
   * handle that could keep the gateway process alive.
   */
  protected pruneExpired(): number {
    const cutoff = Date.now() - this.maxAgeMs;
    let moved = 0;
    for (const entry of [...this.items.values()]) {
      if (entry.enqueuedAt <= cutoff) {
        this.moveToDeadLetters(entry, `pruned by age after ${Date.now() - entry.enqueuedAt} ms pending`, false);
        moved += 1;
      }
    }
    if (moved > 0) this.persist();
    return moved;
  }

  /** Takes an entry out of the live queue and files it under the dead letters. */
  private moveToDeadLetters(entry: PendingAttestation, reason: string, flush = true): void {
    this.items.delete(entry.paymentTxHash);
    this.deadLetterLog.push({ ...entry, deadLetteredAt: Date.now(), reason });
    // The retained log is bounded, but the counter is not: an operator must still
    // see that N attestations were abandoned even once the oldest details age out.
    if (this.deadLetterLog.length > this.maxDeadLetters) {
      this.deadLetterLog = this.deadLetterLog.slice(-this.maxDeadLetters);
    }
    this.deadLetteredTotal += 1;
    if (flush) this.persist();
  }

  /** Write-through hook: a no-op for in-memory queues, an atomic file rewrite for the file-backed one. */
  protected persist(): void {
    // no-op
  }
}

/** In-memory {@link AttestationQueue}: retries survive within a process but not a restart. */
export class MemoryAttestationQueue extends BaseAttestationQueue {}
