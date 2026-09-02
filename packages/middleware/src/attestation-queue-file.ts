import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BaseAttestationQueue,
  type AttestationQueueOptions,
  type DeadLetteredAttestation,
  type PendingAttestation,
} from './attestation-queue';

/** Sidecar suffix for the dead-letter log that sits next to the live queue file. */
export const DEAD_LETTER_FILE_SUFFIX = '.dead-letters.json';

/**
 * File-backed attestation queue: an in-memory Map mirrored to a JSON file with an
 * atomic (temp-write + rename) flush on every mutation. Unlike
 * {@link MemoryAttestationQueue}, a pending attestation survives a process
 * restart — so a served-and-paid call whose on-chain attestation never confirmed
 * before a deploy/crash is replayed on the next boot instead of being silently
 * dropped from the trust ledger (finding F7). Replay is idempotent: the registry
 * dedups by `(service_id, payment_tx_hash)`, so re-recording is a no-op.
 *
 * Attempt counts persist with the entries, which is the whole point of persisting
 * them: an attestation that reverts permanently must spend its budget ACROSS
 * boots, not be handed a fresh one by every restart.
 *
 * Dead letters go to a sidecar file (`<queue file>{@link DEAD_LETTER_FILE_SUFFIX}`)
 * rather than into the queue file, so an abandoned attestation is still visible
 * after the restart that abandoned it, and so the live queue file keeps the plain
 * `[entry, …]` shape every other build and operator script already reads.
 *
 * Single-instance only; for a multi-instance deployment use a shared store (the
 * async interface is designed for a Redis-backed one).
 *
 * On-disk format: entries are keyed by `paymentTxHash`. A record that fails the
 * shape guard is dropped silently on load — the same "corrupt/unknown data starts
 * empty" behavior as a malformed file. There is no migration path; an
 * unrecognized queue file is simply not read.
 */
export class FileAttestationQueue extends BaseAttestationQueue {
  private readonly deadLetterPath: string;

  constructor(
    private readonly filePath: string,
    opts: AttestationQueueOptions = {},
  ) {
    super(opts);
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new Error('FileAttestationQueue requires a non-empty file path');
    }
    this.deadLetterPath = `${filePath}${DEAD_LETTER_FILE_SUFFIX}`;
    this.load();
  }

  /** Loads pending attestations and the dead-letter log. A missing or corrupt file starts empty (never throws). */
  private load(): void {
    for (const entry of readJsonArray(this.filePath)) {
      const p = asPending(entry);
      if (p) this.items.set(p.paymentTxHash, p);
    }
    for (const entry of readJsonArray(this.deadLetterPath)) {
      const p = asPending(entry);
      const d = entry as Partial<DeadLetteredAttestation>;
      if (p && typeof d.deadLetteredAt === 'number' && typeof d.reason === 'string') {
        this.deadLetterLog.push({ ...p, deadLetteredAt: d.deadLetteredAt, reason: d.reason });
      }
    }
    // The retained log is capped, so its length is only a floor on how many were
    // abandoned — entries trimmed off the front are gone. The count is stored
    // beside the log for exactly that reason, and is what an operator's alert
    // reads.
    this.deadLetteredTotal = Math.max(readDeadLetterTotal(this.deadLetterPath), this.deadLetterLog.length);
  }

  /**
   * Atomically rewrites both files (temp + rename) so a crash mid-write never
   * corrupts either. The dead-letter sidecar is written FIRST: a crash between
   * the two writes then leaves an entry recorded as dead AND still queued, which
   * costs one duplicate (idempotent) replay — whereas the other order could drop
   * the entry from the queue with no record of it anywhere, which is exactly the
   * silently-lost attestation this queue exists to prevent.
   */
  protected override persist(): void {
    writeAtomic(this.deadLetterPath, JSON.stringify({
      deadLetteredTotal: this.deadLetteredTotal,
      entries: this.deadLetterLog,
    }));
    writeAtomic(this.filePath, JSON.stringify([...this.items.values()]));
  }
}

/** Reads the entry array out of a queue/dead-letter file; `[]` for missing, corrupt or unrecognized data. */
function readJsonArray(file: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return []; // no file yet — fresh start
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) ? entries : [];
  } catch {
    // Corrupt file — start empty rather than crash the gateway on boot.
    return [];
  }
}

/** Reads the running dead-letter count, which outlives the capped log it sits beside. */
function readDeadLetterTotal(file: string): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const total = (parsed as { deadLetteredTotal?: unknown } | null)?.deadLetteredTotal;
    return typeof total === 'number' && Number.isFinite(total) ? total : 0;
  } catch {
    return 0;
  }
}

/** Temp-write + rename, creating the directory if needed. */
function writeAtomic(file: string, contents: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, file);
}

/** Shape guard for one on-disk record; returns null for anything unrecognized. */
function asPending(entry: unknown): PendingAttestation | null {
  const p = entry as Partial<PendingAttestation> | null;
  if (
    p &&
    typeof p.paymentTxHash === 'string' &&
    typeof p.serviceId === 'number' &&
    typeof p.success === 'boolean' &&
    typeof p.enqueuedAt === 'number'
  ) {
    return { ...(p as PendingAttestation), attempts: typeof p.attempts === 'number' ? p.attempts : 0 };
  }
  return null;
}
