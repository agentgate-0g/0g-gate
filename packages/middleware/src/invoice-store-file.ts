import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { InvoiceStore, StoredInvoice } from './invoice-store';

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** True when a pid currently exists (signal 0 tests existence without signalling). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * File-backed {@link InvoiceStore}: an in-memory Map mirrored to a JSON file
 * with an atomic (temp-write + rename) flush on every mutation. Unlike
 * {@link MemoryInvoiceStore}, issued invoices survive a process restart — so a
 * buyer who already sent an irreversible on-chain payment is not lost when the
 * gateway redeploys or crashes between the 402 challenge and the proof retry
 * (finding F2). Single-instance only; for a multi-instance deployment use a
 * shared store (the async interface is designed for a Redis-backed one).
 */
export class FileInvoiceStore implements InvoiceStore {
  private readonly invoices = new Map<string, StoredInvoice>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly graceMs: number;
  private readonly lockPath: string;
  private closed = false;

  constructor(
    private readonly filePath: string,
    sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
    retentionMs?: number,
  ) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new Error('FileInvoiceStore requires a non-empty file path');
    }
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
      throw new RangeError(`sweepIntervalMs must be a positive number, got ${sweepIntervalMs}`);
    }
    if (retentionMs !== undefined && (!Number.isFinite(retentionMs) || retentionMs <= 0)) {
      throw new RangeError(`retentionMs must be a positive number, got ${retentionMs}`);
    }
    // Retention IS the redemption window — see MemoryInvoiceStore for why an
    // early drop costs a buyer their money.
    this.graceMs = retentionMs ?? sweepIntervalMs;
    this.lockPath = `${filePath}.lock`;
    this.lock();
    this.load();
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref();
  }

  /** Number of invoices currently held (including not-yet-swept expired ones). */
  get size(): number {
    return this.invoices.size;
  }

  put(invoice: StoredInvoice): Promise<void> {
    this.invoices.set(invoice.nonce, { ...invoice });
    this.persist();
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
    this.persist();
    return Promise.resolve(true);
  }

  release(nonce: string): Promise<void> {
    const found = this.invoices.get(nonce);
    if (found && found.used) {
      found.used = false;
      this.persist();
    }
    return Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweeper);
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already gone (or never taken) — close() must stay idempotent.
    }
  }

  /**
   * Loads invoices from disk. A MISSING file is a fresh start; a CORRUPT one
   * throws.
   *
   * Starting empty on corruption used to look like the safe choice. It is the
   * opposite: live mode refuses to boot without this store precisely because a
   * lost invoice is a buyer who paid on-chain and can never be served, and
   * PaymentRouter has no refund. Silently discarding the file produces exactly
   * that outcome while the gateway reports itself healthy. Refusing to boot is
   * loud, and an operator can still choose to move the bad file aside.
   */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return; // no file yet — fresh start
    }
    if (raw.trim() === '') return; // an empty file is an unwritten one
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `invoice store at ${this.filePath} is not valid JSON. Refusing to start with an empty ` +
          'store: every issued invoice it held is a payment that could already be in flight, ' +
          'and an unredeemable payment cannot be refunded. Move the file aside to start fresh.',
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `invoice store at ${this.filePath} is valid JSON but not an array of invoices — ` +
          'refusing to start with an empty store (see above).',
      );
    }
    for (const item of parsed) {
      const inv = item as Partial<StoredInvoice>;
      if (
        inv &&
        typeof inv.nonce === 'string' &&
        typeof inv.serviceId === 'number' &&
        typeof inv.priceWei === 'string' &&
        typeof inv.expiresAt === 'number' &&
        typeof inv.used === 'boolean'
      ) {
        this.invoices.set(inv.nonce, inv as StoredInvoice);
      }
    }
  }

  /**
   * Atomically rewrites the backing file: write temp -> fsync temp -> rename.
   *
   * The rename is what makes the swap atomic, but rename alone does NOT make
   * the CONTENTS durable — after a host crash the directory entry can point at
   * a file whose blocks were never flushed, which is the one failure this store
   * exists to survive. So the temp file is fsync'd before the rename and the
   * directory after it.
   *
   * The temp name carries pid + uuid rather than a fixed `.tmp`, matching
   * UpstreamStore: a shared constant name is itself a way for two writers to
   * corrupt each other.
   */
  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify([...this.invoices.values()]));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
    // Durably record the rename itself.
    try {
      const dirFd = openSync(dir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync is not portable (notably on Windows); the temp-file
      // fsync above is the load-bearing half.
    }
  }

  /**
   * Take an exclusive lock on this store, or refuse to start.
   *
   * FileInvoiceStore is single-instance by construction — two processes each
   * hold the whole invoice map in memory and rewrite the file wholesale, so the
   * second one to flush erases every invoice the first one issued. Nothing used
   * to enforce that, and "single-instance only" in a doc comment is not a
   * guarantee: a rolling deploy runs two replicas for a few seconds, which is
   * long enough to destroy in-flight paid invoices that cannot be refunded.
   */
  private lock(): void {
    const dir = path.dirname(this.lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (;;) {
      try {
        writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const holder = Number(readFileSync(this.lockPath, 'utf8').trim());
        // Deliberately NOT excluding our own pid: two stores sharing a file
        // inside one process corrupt each other exactly as two processes do,
        // and close() removes the lock, so a legitimate reopen never lands here.
        if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
          throw new Error(
            `invoice store at ${this.filePath} is already held by process ${holder}. ` +
              'Two gateways sharing one invoice file silently destroy each other\'s paid ' +
              'invoices — refusing to start. Use a shared store for multi-replica deployments.',
          );
        }
        // Stale lock from a crashed process: reclaim it and retry.
        rmSync(this.lockPath, { force: true });
      }
    }
  }

  /** Removes invoices whose expiry is more than one sweep interval in the past. */
  private sweep(): void {
    const cutoff = Date.now() - this.graceMs;
    let changed = false;
    for (const [nonce, invoice] of this.invoices) {
      if (invoice.expiresAt < cutoff) {
        this.invoices.delete(nonce);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}
