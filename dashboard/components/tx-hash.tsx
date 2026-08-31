import { truncateHash, truncateMiddle } from '@/lib/format';

const EXPLORER = 'https://chainscan-galileo.0g.ai';

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const LINK_CLASS =
  'text-zinc-300 underline decoration-line underline-offset-4 transition-colors hover:text-accent hover:decoration-accent';

/**
 * Tx hash rendering:
 * - mock network → plain mono text (nothing to link to)
 * - live network → link to https://chainscan-galileo.0g.ai/tx/<hash>
 */
export function TxHash({
  hash,
  network,
  className = '',
}: {
  hash: string;
  network: string;
  className?: string;
}) {
  const label = truncateHash(hash);
  const base = `font-mono text-xs ${className}`;
  // Only build an explorer link for a well-formed 0x + 64-hex tx hash; anything
  // else (mock network, or a malformed on-chain value) renders as plain text.
  if (network === 'mock' || !TX_HASH_RE.test(hash)) {
    return (
      <code title={hash} className={`${base} text-mut`}>
        {label}
      </code>
    );
  }
  return (
    <a
      href={`${EXPLORER}/tx/${encodeURIComponent(hash)}`}
      target="_blank"
      rel="noopener noreferrer"
      title={hash}
      className={`${base} ${LINK_CLASS}`}
    >
      {label}
      <span aria-hidden className="ml-1 text-[10px]">
        ↗
      </span>
    </a>
  );
}

/**
 * Address rendering, the sibling of TxHash:
 * - mock network → plain mono text (mock addresses exist on no explorer)
 * - live network → link to https://chainscan-galileo.0g.ai/address/<addr>
 */
export function AddressLink({
  address,
  network,
  lead = 14,
  tail = 8,
  className = '',
}: {
  address: string;
  network: string;
  lead?: number;
  tail?: number;
  className?: string;
}) {
  const label = truncateMiddle(address, lead, tail);
  const base = `font-mono text-xs ${className}`;
  if (network === 'mock' || !ADDRESS_RE.test(address)) {
    return (
      <code title={address} className={`${base} text-mut`}>
        {label}
      </code>
    );
  }
  return (
    <a
      href={`${EXPLORER}/address/${encodeURIComponent(address)}`}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className={`${base} ${LINK_CLASS}`}
    >
      {label}
      <span aria-hidden className="ml-1 text-[10px]">
        ↗
      </span>
    </a>
  );
}
