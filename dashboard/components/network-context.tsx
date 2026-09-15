'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { NetworkInfo } from '@/lib/api-types';

/**
 * The network this instance reads, handed down from the root layout (which
 * resolves it on the server at request time) to every client component that
 * names a chain or links to an explorer. A context rather than a fetch so the
 * first paint already carries the right label — a badge that says "galileo"
 * for a moment on the mainnet instance is the kind of thing a screenshot
 * preserves forever.
 */
const NetworkContext = createContext<NetworkInfo | null>(null);

export function NetworkProvider({ value, children }: { value: NetworkInfo; children: ReactNode }) {
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

/**
 * Throws rather than defaulting: a component rendered outside the provider
 * would otherwise silently show SOME network, and the only candidate for a
 * default is the testnet — exactly the wrong answer on the mainnet instance.
 */
export function useNetwork(): NetworkInfo {
  const info = useContext(NetworkContext);
  if (!info) throw new Error('useNetwork() called outside <NetworkProvider> — the root layout must wrap the app');
  return info;
}
