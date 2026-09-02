import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DEAD_LETTER_FILE_SUFFIX, FileAttestationQueue } from '../src/attestation-queue-file';
import { isTerminalAttestationError, MemoryAttestationQueue } from '../src/attestation-queue';

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentgate-att-'));
  return path.join(dir, 'attestations.json');
}

describe('MemoryAttestationQueue', () => {
  it('enqueues, lists, and removes in-memory', async () => {
    const q = new MemoryAttestationQueue();
    await q.enqueue({ paymentTxHash: 'aa', serviceId: 1, nonce: '1', payer: '0x00000000000000000000000000000001', success: true, enqueuedAt: Date.now() });
    await q.enqueue({ paymentTxHash: 'bb', serviceId: 2, nonce: '1', payer: '0x00000000000000000000000000000001', success: false, enqueuedAt: Date.now() });
    expect((await q.list()).map((i) => i.paymentTxHash).sort()).toEqual(['aa', 'bb']);
    await q.remove('aa');
    expect((await q.list()).map((i) => i.paymentTxHash)).toEqual(['bb']);
    q.close();
  });

  it('enqueue is idempotent on paymentTxHash (mirrors on-chain seen_payments dedup)', async () => {
    const q = new MemoryAttestationQueue();
    await q.enqueue({ paymentTxHash: 'aa', serviceId: 1, nonce: '1', payer: '0x00000000000000000000000000000001', success: true, enqueuedAt: Date.now() });
    await q.enqueue({ paymentTxHash: 'aa', serviceId: 1, nonce: '1', payer: '0x00000000000000000000000000000001', success: false, enqueuedAt: Date.now() });
    expect(await q.list()).toHaveLength(1);
    q.close();
  });
});

describe('FileAttestationQueue (F7 — survives restart)', () => {
  it('persists enqueued attestations and reloads them from disk on a new instance', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file);
    await q1.enqueue({ paymentTxHash: 'aa', serviceId: 1, nonce: '1', payer: '0x00000000000000000000000000000001', success: true, enqueuedAt: Date.now() });
    await q1.enqueue({ paymentTxHash: 'bb', serviceId: 2, nonce: '1', payer: '0x00000000000000000000000000000001', success: false, enqueuedAt: Date.now() });
    q1.close();

    const q2 = new FileAttestationQueue(file);
    const items = await q2.list();
    expect(items.map((i) => i.paymentTxHash).sort()).toEqual(['aa', 'bb']);
    expect(items.find((i) => i.paymentTxHash === 'bb')).toMatchObject({
      serviceId: 2,
      success: false,
    });
    q2.close();
  });

  it('remove() persists the deletion so a reloaded instance no longer sees it', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file);
    await q1.enqueue({ paymentTxHash: 'aa', serviceId: 1, nonce: '1', payer: '0x00000000000000000000000000000001', success: true, enqueuedAt: Date.now() });
    await q1.remove('aa');
    q1.close();

    const q2 = new FileAttestationQueue(file);
    expect(await q2.list()).toEqual([]);
    q2.close();
  });

  it('a missing or corrupt file starts empty rather than throwing', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file); // no file yet
    expect(await q1.list()).toEqual([]);
    await q1.enqueue({ paymentTxHash: 'aa', serviceId: 1, nonce: '1', payer: '0x00000000000000000000000000000001', success: true, enqueuedAt: Date.now() });
    q1.close();

    // Corrupt the backing file → a fresh instance must not crash.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{not json', 'utf8');
    const q2 = new FileAttestationQueue(file);
    expect(await q2.list()).toEqual([]);
    q2.close();
  });

  it('rejects an empty file path', () => {
    expect(() => new FileAttestationQueue('')).toThrow();
  });

  it('writes valid JSON to disk on enqueue', async () => {
    const file = await tmpFile();
    const q = new FileAttestationQueue(file);
    await q.enqueue({ paymentTxHash: 'aa', serviceId: 1, nonce: '1', payer: '0x00000000000000000000000000000001', success: true, enqueuedAt: Date.now() });
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown[];
    expect(parsed).toHaveLength(1);
    q.close();
  });
});

const ENTRY = {
  serviceId: 1,
  nonce: '1',
  payer: '0x00000000000000000000000000000001',
  success: true,
};

/** A viem-shaped revert: the error name lives on a nested `cause.data.errorName`. */
function revertError(errorName: string): Error {
  const inner = Object.assign(new Error(`reverted with custom error ${errorName}()`), {
    data: { errorName },
  });
  return Object.assign(new Error('execution reverted'), { cause: inner });
}

describe('isTerminalAttestationError', () => {
  it('classifies registry reverts that retrying can never fix as terminal', () => {
    for (const name of ['SelfPayment', 'NoSuchPayment', 'Underpaid', 'NotAuthorized', 'ServiceNotFound']) {
      expect(isTerminalAttestationError(revertError(name)), name).toBe(true);
    }
  });

  it('finds the error name in a flat message too (no structured revert data)', () => {
    expect(
      isTerminalAttestationError(
        new Error('ContractFunctionExecutionError: The contract function "recordAttestation" reverted.\nError: SelfPayment()'),
      ),
    ).toBe(true);
  });

  it('treats transport/nonce/timeout failures as retryable', () => {
    expect(isTerminalAttestationError(new Error('fetch failed: ECONNREFUSED 127.0.0.1:8545'))).toBe(false);
    expect(isTerminalAttestationError(new Error('nonce too low'))).toBe(false);
    expect(isTerminalAttestationError(new Error('timeout'))).toBe(false);
    expect(isTerminalAttestationError(undefined)).toBe(false);
  });

  it('treats ServiceInactive as retryable — the owner can re-activate the service', () => {
    expect(isTerminalAttestationError(revertError('ServiceInactive'))).toBe(false);
  });
});

describe('AttestationQueue bounded retries + dead letters', () => {
  it('dead-letters a terminal failure immediately: it leaves the live queue but stays inspectable', async () => {
    const q = new MemoryAttestationQueue();
    await q.enqueue({ ...ENTRY, paymentTxHash: 'aa', enqueuedAt: Date.now() });
    const outcome = await q.recordFailure('aa', { terminal: true, error: 'SelfPayment()' });

    expect(outcome).toBe('dead-lettered');
    expect(await q.list()).toEqual([]);
    const dead = await q.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.paymentTxHash).toBe('aa');
    expect(dead[0]?.reason).toContain('SelfPayment');
    expect((await q.stats()).deadLettered).toBe(1);
    q.close();
  });

  it('keeps a retryable failure queued, then dead-letters it once the attempt budget is spent', async () => {
    const q = new MemoryAttestationQueue({ maxAttempts: 3 });
    await q.enqueue({ ...ENTRY, paymentTxHash: 'aa', enqueuedAt: Date.now() });

    expect(await q.recordFailure('aa', { terminal: false, error: 'ECONNREFUSED' })).toBe('retrying');
    expect(await q.recordFailure('aa', { terminal: false, error: 'ECONNREFUSED' })).toBe('retrying');
    expect(await q.list()).toHaveLength(1);
    expect((await q.list())[0]?.attempts).toBe(2);

    expect(await q.recordFailure('aa', { terminal: false, error: 'ECONNREFUSED' })).toBe('dead-lettered');
    expect(await q.list()).toEqual([]);
    expect((await q.deadLetters())[0]?.reason).toContain('3');
    q.close();
  });

  it('re-enqueuing the same payment hash does not reset the attempt budget', async () => {
    const q = new MemoryAttestationQueue({ maxAttempts: 2 });
    await q.enqueue({ ...ENTRY, paymentTxHash: 'aa', enqueuedAt: Date.now() });
    await q.recordFailure('aa', { terminal: false, error: 'boom' });
    await q.enqueue({ ...ENTRY, paymentTxHash: 'aa', enqueuedAt: Date.now() });
    expect(await q.recordFailure('aa', { terminal: false, error: 'boom' })).toBe('dead-lettered');
    q.close();
  });

  it('reports unknown for a hash that is no longer queued', async () => {
    const q = new MemoryAttestationQueue();
    expect(await q.recordFailure('zz', { terminal: false, error: 'boom' })).toBe('unknown');
    q.close();
  });

  it('prunes entries older than maxAgeMs into the dead-letter log, including lazily on list()', async () => {
    const q = new MemoryAttestationQueue({ maxAgeMs: 1000 });
    await q.enqueue({ ...ENTRY, paymentTxHash: 'old', enqueuedAt: Date.now() - 60_000 });
    await q.enqueue({ ...ENTRY, paymentTxHash: 'new', enqueuedAt: Date.now() });

    expect((await q.list()).map((i) => i.paymentTxHash)).toEqual(['new']);
    const dead = await q.deadLetters();
    expect(dead.map((d) => d.paymentTxHash)).toEqual(['old']);
    expect(dead[0]?.reason).toContain('age');
    q.close();
  });

  it('exposes queue depth, oldest pending age and dead-letter count for monitoring', async () => {
    const q = new MemoryAttestationQueue();
    expect(await q.stats()).toMatchObject({ pending: 0, oldestPendingAgeMs: 0, deadLettered: 0 });

    await q.enqueue({ ...ENTRY, paymentTxHash: 'aa', enqueuedAt: Date.now() - 5_000 });
    await q.enqueue({ ...ENTRY, paymentTxHash: 'bb', enqueuedAt: Date.now() - 1_000 });
    const s = await q.stats();
    expect(s.pending).toBe(2);
    expect(s.oldestPendingAgeMs).toBeGreaterThanOrEqual(5_000);
    expect(s.deadLettered).toBe(0);
    q.close();
  });

  it('caps the retained dead-letter log but never loses the count', async () => {
    const q = new MemoryAttestationQueue({ maxDeadLetters: 2 });
    for (const h of ['a', 'b', 'c', 'd']) {
      await q.enqueue({ ...ENTRY, paymentTxHash: h, enqueuedAt: Date.now() });
      await q.recordFailure(h, { terminal: true, error: 'SelfPayment()' });
    }
    expect((await q.deadLetters()).map((d) => d.paymentTxHash)).toEqual(['c', 'd']);
    expect((await q.stats()).deadLettered).toBe(4);
    q.close();
  });
});

describe('FileAttestationQueue dead letters survive a restart', () => {
  it('persists the dead-letter log and its running count across instances', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file);
    await q1.enqueue({ ...ENTRY, paymentTxHash: 'aa', enqueuedAt: Date.now() });
    await q1.enqueue({ ...ENTRY, paymentTxHash: 'bb', enqueuedAt: Date.now() });
    await q1.recordFailure('aa', { terminal: true, error: 'SelfPayment()' });
    q1.close();

    const q2 = new FileAttestationQueue(file);
    expect((await q2.list()).map((i) => i.paymentTxHash)).toEqual(['bb']);
    const dead = await q2.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.paymentTxHash).toBe('aa');
    expect((await q2.stats()).deadLettered).toBe(1);
    q2.close();
  });

  it('persists attempt counts so the budget is spent across restarts, not reset by them', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file, { maxAttempts: 2 });
    await q1.enqueue({ ...ENTRY, paymentTxHash: 'aa', enqueuedAt: Date.now() });
    await q1.recordFailure('aa', { terminal: false, error: 'ECONNREFUSED' });
    q1.close();

    const q2 = new FileAttestationQueue(file, { maxAttempts: 2 });
    expect(await q2.recordFailure('aa', { terminal: false, error: 'ECONNREFUSED' })).toBe('dead-lettered');
    expect(await q2.list()).toEqual([]);
    q2.close();
  });

  it('still reads a legacy bare-array queue file written by an older build', async () => {
    const file = await tmpFile();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      file,
      JSON.stringify([{ ...ENTRY, paymentTxHash: 'aa', enqueuedAt: Date.now() }]),
      'utf8',
    );
    const q = new FileAttestationQueue(file);
    expect((await q.list()).map((i) => i.paymentTxHash)).toEqual(['aa']);
    q.close();
  });

  it('prunes over-age entries off disk so the file cannot grow without bound', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file, { maxAgeMs: 1000 });
    await q1.enqueue({ ...ENTRY, paymentTxHash: 'old', enqueuedAt: Date.now() - 60_000 });
    await q1.list(); // lazy prune
    q1.close();

    const q2 = new FileAttestationQueue(file, { maxAgeMs: 1000 });
    expect(await q2.list()).toEqual([]);
    expect((await q2.deadLetters()).map((d) => d.paymentTxHash)).toEqual(['old']);
    q2.close();
  });

  it('keeps dead letters in a sidecar so the live queue file stays a bare array', async () => {
    const file = await tmpFile();
    const q = new FileAttestationQueue(file);
    await q.enqueue({ ...ENTRY, paymentTxHash: 'aa', enqueuedAt: Date.now() });
    await q.recordFailure('aa', { terminal: true, error: 'SelfPayment()' });

    const queueFile = JSON.parse(await readFile(file, 'utf8')) as unknown[];
    expect(queueFile).toEqual([]);
    const sidecar = JSON.parse(await readFile(`${file}${DEAD_LETTER_FILE_SUFFIX}`, 'utf8')) as {
      deadLetteredTotal: number;
      entries: { paymentTxHash: string }[];
    };
    expect(sidecar.deadLetteredTotal).toBe(1);
    expect(sidecar.entries.map((e) => e.paymentTxHash)).toEqual(['aa']);
    q.close();
  });

  it('keeps counting dead letters whose details were trimmed out of the retained log', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file, { maxDeadLetters: 1 });
    for (const h of ['a', 'b', 'c']) {
      await q1.enqueue({ ...ENTRY, paymentTxHash: h, enqueuedAt: Date.now() });
      await q1.recordFailure(h, { terminal: true, error: 'SelfPayment()' });
    }
    q1.close();

    const q2 = new FileAttestationQueue(file, { maxDeadLetters: 1 });
    expect((await q2.deadLetters()).map((d) => d.paymentTxHash)).toEqual(['c']);
    expect((await q2.stats()).deadLettered).toBe(3);
    q2.close();
  });
});
