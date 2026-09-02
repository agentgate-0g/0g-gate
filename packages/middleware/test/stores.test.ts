import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FileInvoiceStore, MemoryInvoiceStore, UpstreamStore } from '../src/index';
import { sleep, until } from './helpers';

describe('MemoryInvoiceStore', () => {
  it('stores and retrieves invoices by nonce (copies, not references)', async () => {
    const store = new MemoryInvoiceStore();
    try {
      await store.put({ nonce: '42', serviceId: 1, priceWei: '100', expiresAt: Date.now() + 1000, used: false });
      const got = await store.get('42');
      expect(got).toMatchObject({ nonce: '42', serviceId: 1, used: false });
      if (got) got.used = true; // mutating the copy must not affect the store
      expect((await store.get('42'))?.used).toBe(false);
      expect(await store.get('nope')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('markUsed is single-winner: exactly one of two competing calls succeeds', async () => {
    const store = new MemoryInvoiceStore();
    try {
      await store.put({ nonce: '7', serviceId: 1, priceWei: '100', expiresAt: Date.now() + 1000, used: false });
      const [a, b] = await Promise.all([store.markUsed('7'), store.markUsed('7')]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await store.markUsed('missing')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('TTL sweep evicts long-expired invoices', async () => {
    const store = new MemoryInvoiceStore(25);
    try {
      await store.put({ nonce: '1', serviceId: 1, priceWei: '100', expiresAt: Date.now() - 100, used: false });
      await store.put({ nonce: '2', serviceId: 1, priceWei: '100', expiresAt: Date.now() + 60_000, used: false });
      await until(() => store.size === 1, 2_000);
      expect(await store.get('1')).toBeNull();
      expect(await store.get('2')).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('rejects a non-positive sweep interval', () => {
    expect(() => new MemoryInvoiceStore(0)).toThrow(RangeError);
  });
});

describe('FileInvoiceStore', () => {
  async function tmpFile(): Promise<string> {
    return path.join(await mkdtemp(path.join(os.tmpdir(), 'agentgate-inv-')), 'invoices.json');
  }

  it('survives a restart: invoices persist to disk and reload (F2)', async () => {
    const file = await tmpFile();
    const a = new FileInvoiceStore(file);
    try {
      await a.put({ nonce: '42', serviceId: 1, priceWei: '100', expiresAt: Date.now() + 60_000, used: false });
    } finally {
      a.close();
    }
    const b = new FileInvoiceStore(file); // simulate a restart
    try {
      expect(await b.get('42')).toMatchObject({ nonce: '42', serviceId: 1, used: false });
    } finally {
      b.close();
    }
  });

  it('persists markUsed across a restart (nonce stays single-use)', async () => {
    const file = await tmpFile();
    const a = new FileInvoiceStore(file);
    try {
      await a.put({ nonce: '7', serviceId: 1, priceWei: '100', expiresAt: Date.now() + 60_000, used: false });
      expect(await a.markUsed('7')).toBe(true);
    } finally {
      a.close();
    }
    const b = new FileInvoiceStore(file);
    try {
      expect((await b.get('7'))?.used).toBe(true);
      expect(await b.markUsed('7')).toBe(false); // already used, even after restart
    } finally {
      b.close();
    }
  });

  it('starts empty on a missing file — that is a fresh gateway, not a fault', async () => {
    const s1 = new FileInvoiceStore(await tmpFile());
    try {
      expect(await s1.get('x')).toBeNull();
    } finally {
      s1.close();
    }
  });

  // Starting empty on corruption looked like the safe choice and is the
  // opposite: live mode refuses to boot without this store precisely because a
  // lost invoice is a buyer who paid on-chain and can never be served or
  // refunded. Discarding the file produces that outcome while reporting health.
  it('REFUSES to boot on a corrupt file rather than silently discarding invoices', async () => {
    const file = await tmpFile();
    await writeFile(file, '{not json', 'utf8');
    expect(() => new FileInvoiceStore(file)).toThrow(/not valid JSON/);

    const notArray = await tmpFile();
    await writeFile(notArray, '{"nonce":"1"}', 'utf8');
    expect(() => new FileInvoiceStore(notArray)).toThrow(/not an array/);
  });

  // "Single-instance only" in a doc comment is not a guarantee. Two processes
  // each hold the whole map and rewrite the file wholesale, so the second to
  // flush erases every invoice the first issued — and a rolling deploy runs two
  // replicas for long enough to do it to in-flight paid invoices.
  it('refuses to open a store another live process already holds', async () => {
    const file = await tmpFile();
    const first = new FileInvoiceStore(file);
    try {
      expect(() => new FileInvoiceStore(file)).toThrow(/already held by process/);
    } finally {
      first.close();
    }
    // Once released, the next instance opens cleanly.
    const second = new FileInvoiceStore(file);
    second.close();
  });

  it('rejects an empty path and a non-positive sweep interval', async () => {
    expect(() => new FileInvoiceStore('')).toThrow();
    const file = await tmpFile();
    expect(() => new FileInvoiceStore(file, 0)).toThrow(RangeError);
  });
});

describe('UpstreamStore', () => {
  async function tmpFile(): Promise<string> {
    return path.join(await mkdtemp(path.join(os.tmpdir(), 'agentgate-us-')), 'upstreams.json');
  }

  it('starts empty when the file does not exist', async () => {
    const store = new UpstreamStore(await tmpFile());
    store.loadSync();
    expect(store.list()).toEqual([]);
  });

  it('persists atomically and reloads: set/delete round-trip with no stray tmp files', async () => {
    const file = await tmpFile();
    const store = new UpstreamStore(file);
    store.loadSync();
    await Promise.all([
      store.set(3, 'http://example.com/c'),
      store.set(1, 'http://example.com/a'),
      store.set(2, 'http://example.com/b'),
    ]);
    await store.delete(2);
    await store.flush();

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    expect(onDisk).toEqual({ '1': 'http://example.com/a', '3': 'http://example.com/c' });
    expect((await readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const reloaded = new UpstreamStore(file);
    reloaded.loadSync();
    expect(reloaded.list()).toEqual([
      { serviceId: 1, upstreamUrl: 'http://example.com/a' },
      { serviceId: 3, upstreamUrl: 'http://example.com/c' },
    ]);
    expect(reloaded.get(3)).toBe('http://example.com/c');
    expect(reloaded.get(2)).toBeUndefined();
  });

  it('throws a clear error on a corrupt mapping file', async () => {
    const file = await tmpFile();
    await writeFile(file, '{not json', 'utf8');
    const store = new UpstreamStore(file);
    expect(() => store.loadSync()).toThrow(/not valid JSON/);

    await writeFile(file, '["array"]', 'utf8');
    const arrayStore = new UpstreamStore(file);
    expect(() => arrayStore.loadSync()).toThrow(/JSON object/);

    await writeFile(file, '{"abc": "http://x"}', 'utf8');
    const badKeyStore = new UpstreamStore(file);
    expect(() => badKeyStore.loadSync()).toThrow(/invalid entry/);
  });

  it('delete is idempotent and skips disk writes when nothing changed', async () => {
    const file = await tmpFile();
    const store = new UpstreamStore(file);
    store.loadSync();
    await store.delete(99); // never existed — must not create the file
    await store.flush();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await sleep(1); // settle queue
  });
});
