import type { Wei } from '@agentgate/shared';

/** One issued 402 invoice, keyed by its nonce (the PaymentRouter.pay() nonce). */
export interface StoredInvoice {
  nonce: string;
  serviceId: number;
  priceWei: Wei;
  expiresAt: number; // unix ms
  used: boolean;
}

/**
 * Nonce/invoice persistence seam. The default is in-memory (MemoryInvoiceStore);
 * the async surface lets a Redis-backed store swap in without touching the app.
 */
export interface InvoiceStore {
  put(invoice: StoredInvoice): Promise<void>;
  /** Returns a copy of the invoice, or null when unknown (or already swept). */
  get(nonce: string): Promise<StoredInvoice | null>;
  /**
   * Atomically transitions an invoice from unused → used.
   * Returns false when the nonce is unknown OR already used — exactly one
   * concurrent caller wins, which is what makes invoices single-use.
   */
  markUsed(nonce: string): Promise<boolean>;
  /**
   * Puts a burned invoice back — the compensating action for markUsed when the
   * GATEWAY, not the buyer, is why the paid call was not delivered.
   *
   * The nonce is burned before proxying so a payment is single-use even if the
   * upstream fails. But an upstream that is unreachable, times out, or answers
   * too large is the SELLER's backend failing, not a call the buyer consumed:
   * the code already refuses to attest those (it can tell the difference). It
   * kept the money anyway. Releasing lets the payer retry with the same proof.
   *
   * Safe against theft because the proof is now bound to the payer's signature:
   * only the address that actually paid can present it again.
   */
  release(nonce: string): Promise<void>;
  /** Stops background sweeps. Safe to call multiple times. */
  close(): void;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * In-memory InvoiceStore with a periodic TTL sweep (interval is unref'd so it
 * never keeps the process alive).
 *
 * Expired invoices are retained for `retentionMs` past their expiry, not merely
 * one sweep interval. That retention IS the redemption window: a payment that
 * settled on-chain while the invoice was valid can still be collected
 * afterwards, and dropping the row early turned a recoverable late presentation
 * into `unknown_nonce` with the buyer's OG already spent and no refund path.
 */
export class MemoryInvoiceStore implements InvoiceStore {
  private readonly invoices = new Map<string, StoredInvoice>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly graceMs: number;
  private closed = false;

  constructor(sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS, retentionMs?: number) {
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
      throw new RangeError(`sweepIntervalMs must be a positive number, got ${sweepIntervalMs}`);
    }
    if (retentionMs !== undefined && (!Number.isFinite(retentionMs) || retentionMs <= 0)) {
      throw new RangeError(`retentionMs must be a positive number, got ${retentionMs}`);
    }
    this.graceMs = retentionMs ?? sweepIntervalMs;
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref();
  }

  /** Number of invoices currently held (including not-yet-swept expired ones). */
  get size(): number {
    return this.invoices.size;
  }

  put(invoice: StoredInvoice): Promise<void> {
    this.invoices.set(invoice.nonce, { ...invoice });
    return Promise.resolve();
  }

  get(nonce: string): Promise<StoredInvoice | null> {
    const found = this.invoices.get(nonce);
    return Promise.resolve(found ? { ...found } : null);
  }

  markUsed(nonce: string): Promise<boolean> {
    const found = this.invoices.get(nonce);
    if (!found || found.used) return Promise.resolve(false);
    found.used = true;
    return Promise.resolve(true);
  }

  release(nonce: string): Promise<void> {
    const found = this.invoices.get(nonce);
    if (found) found.used = false;
    return Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweeper);
  }

  /** Removes invoices whose expiry is more than the retention window in the past. */
  private sweep(): void {
    const cutoff = Date.now() - this.graceMs;
    for (const [nonce, invoice] of this.invoices) {
      if (invoice.expiresAt < cutoff) this.invoices.delete(nonce);
    }
  }
}
