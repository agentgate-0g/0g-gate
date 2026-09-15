'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { formatOg, weiToOg } from '@agentgate/shared';
import { fetcher, isChainDown, isNotFound } from '@/lib/fetcher';
import { formatDateTime, formatInt, svcLabel, timeAgo } from '@/lib/format';
import type { ServiceDetailResponse } from '@/lib/api-types';
import { TrustBadge } from '@/components/trust-badge';
import { ScoreViz } from '@/components/score-viz';
import { AddressLink, TxHash } from '@/components/tx-hash';
import { CommandBlock, CopyButton } from '@/components/copy';
import { ChainDownBanner, EmptyState, ErrorState, Skeleton } from '@/components/states';
import { LiveDot } from '@/components/live-dot';

function MetaRow({
  label,
  value,
  mono = true,
  copyValue,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyValue?: string;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/60 py-3 last:border-b-0">
      <span className="microlabel shrink-0">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          title={title ?? value}
          className={`truncate text-right text-sm ${mono ? 'font-mono text-[13px]' : ''} text-zinc-200`}
        >
          {value}
        </span>
        {copyValue ? <CopyButton text={copyValue} /> : null}
      </span>
    </div>
  );
}

/**
 * A MetaRow whose value is an on-chain address: same row chrome, but the value
 * links to the explorer in live mode (AddressLink falls back to plain text on
 * mock, where the address exists on no explorer).
 */
function AddressRow({
  label,
  address,
  network,
}: {
  label: string;
  address: string;
  network: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/60 py-3 last:border-b-0">
      <span className="microlabel shrink-0">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <AddressLink address={address} network={network} className="truncate text-[13px]" />
        <CopyButton text={address} />
      </span>
    </div>
  );
}

function buildCurlSnippet(endpointUrl: string, network: string): string {
  return [
    '# 1 — call without payment → HTTP 402 + PaymentRequiredResponse JSON',
    `curl -i ${endpointUrl}`,
    '',
    '# 2 — call PaymentRouter.pay(serviceId, nonce, payTo) at accepts[0].extra.router',
    '#     with msg.value = accepts[0].maxAmountRequired wei, receive <txHash>.',
    // The proof names the network the invoice was settled on — this instance's.
    `#     Encode proof: base64({"x402Version":1,"scheme":"exact-settled","network":"${network}",`,
    '#       "payload":{"transaction":"<txHash>","nonce":"<nonce>","from":"<address>"}})',
    `curl -s ${endpointUrl} \\`,
    '  -H "X-PAYMENT: <base64-encoded-payload>"',
  ].join('\n');
}

function DetailSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-10 w-72" />
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="panel p-6 lg:col-span-7">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="mt-3 h-4 w-2/3" />
          <div className="mt-6 space-y-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </div>
        <div className="space-y-5 lg:col-span-5">
          <div className="panel p-6">
            <Skeleton className="h-28 w-28 rounded-full" />
          </div>
          <div className="panel p-6">
            <Skeleton className="h-9 w-40" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** /services/[id] data surface — polls /api/services/:id every 5 s. */
export function ServiceDetail({ id }: { id: number }) {
  const { data, error, isLoading } = useSWR<ServiceDetailResponse>(
    `/api/services/${id}`,
    fetcher,
    { refreshInterval: 5000, keepPreviousData: true },
  );

  if (!data) {
    if (isLoading) return <DetailSkeleton />;
    if (error) {
      if (isNotFound(error)) {
        return (
          <EmptyState label="404" title={`Service #${id} is not registered on-chain.`}>
            <p className="text-center text-sm text-mut">
              Check the{' '}
              <Link href="/catalog" className="text-accent underline underline-offset-4">
                catalog
              </Link>{' '}
              for live services.
            </p>
          </EmptyState>
        );
      }
      return isChainDown(error) ? (
        <>
          <ChainDownBanner />
          <EmptyState label="standby" title="Waiting for the chain to come back…" />
        </>
      ) : (
        <ErrorState title="Could not load this service" detail="The API returned an error." />
      );
    }
    return null;
  }

  const { service, score, trustTier, attestations, revenueWei, balanceWei, network, mode } = data;

  return (
    <>
      {error ? <ChainDownBanner /> : null}

      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="microlabel">
            {svcLabel(service.id)} · network <span className="text-white">{network}</span>
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            {service.name}
          </h1>
        </div>
        <div className="flex items-center gap-3 pb-1">
          <TrustBadge tier={trustTier} />
          <span
            className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
              service.active ? 'text-ok' : 'text-mut'
            }`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${service.active ? 'bg-ok animate-pulse-dot' : 'bg-mut/60'}`}
            />
            {service.active ? 'active' : 'inactive'}
          </span>
        </div>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-12">
        {/* metadata */}
        <section className="panel p-6 lg:col-span-7">
          <p className="microlabel">service metadata</p>
          <p className="mt-3 text-sm leading-6 text-zinc-300">
            {service.description || 'No description provided.'}
          </p>
          <div className="mt-5">
            <MetaRow
              label="endpoint"
              value={service.endpointUrl}
              copyValue={service.endpointUrl}
            />
            <MetaRow label="price / call" value={formatOg(service.priceWei)} />
            <AddressRow label="payment target" address={service.paymentTarget} network={network} />
            <AddressRow label="owner" address={service.owner} network={network} />
            <AddressRow label="attestor" address={service.attestor} network={network} />
            <MetaRow label="registered" value={formatDateTime(service.createdAt)} mono={false} />
          </div>
        </section>

        <div className="space-y-5 lg:col-span-5">
          {/* score */}
          <section className="panel p-6">
            <div className="flex items-center justify-between">
              <p className="microlabel">reputation score</p>
              <TrustBadge tier={trustTier} />
            </div>
            <div className="mt-5">
              <ScoreViz score={score} />
            </div>
          </section>

          {/* revenue */}
          <section className="panel p-6">
            <p className="microlabel">revenue settled</p>
            <p className="mt-2 font-display text-4xl font-semibold tracking-tight text-white">
              {weiToOg(revenueWei)}
              <span className="ml-2 font-mono text-sm text-mut">OG</span>
            </p>
            <p className="mt-2 font-mono text-[11px] text-mut">
              {formatOg(service.priceWei)} × {formatInt(score.successCalls)} successful calls
            </p>
            {mode === 'mock' && balanceWei !== null ? (
              <p className="mt-4 border-t border-line/60 pt-3 font-mono text-[11px] text-mut">
                payment-target wallet balance{' '}
                <span className="text-white">{formatOg(balanceWei)}</span>{' '}
                <span className="text-mut/70">(mock devnet)</span>
              </p>
            ) : null}
          </section>
        </div>
      </div>

      {/* 402 flow snippet */}
      <section className="mt-5">
        <div className="mb-3 flex items-center justify-between">
          <p className="microlabel">try it — the HTTP 402 flow</p>
        </div>
        <CommandBlock text={buildCurlSnippet(service.endpointUrl, network)} prompt={null} />
      </section>

      {/* attestation feed */}
      <section className="panel mt-5">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <p className="microlabel">on-chain attestations · newest first</p>
          <LiveDot stalled={error !== undefined} />
        </div>
        {attestations.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="microlabel">no attestations yet</p>
            <p className="mx-auto mt-3 max-w-md font-display text-lg text-white">
              The first paid call will write its attestation here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {attestations.map((a) => (
              <li
                // Keyed on the PAYMENT hash, not the attestation hash: the
                // contract dedups on (serviceId, paymentTxHash) so it is unique
                // and always present, whereas recordTxHash is a log join that
                // comes back empty for anything older than the lookback window.
                key={a.paymentTxHash}
                className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4"
              >
                <span
                  className={`inline-block w-16 shrink-0 border px-1.5 py-0.5 text-center font-mono text-[9px] uppercase tracking-[0.16em] ${
                    a.success ? 'border-ok/50 text-ok' : 'border-warn/50 text-warn'
                  }`}
                >
                  {a.success ? 'ok ✓' : 'fail ✗'}
                </span>
                <span className="w-20 shrink-0 font-mono text-[11px] text-mut">
                  {timeAgo(a.timestamp)}
                </span>
                <span className="min-w-0 flex-1 font-mono text-[11px] text-mut">
                  payment <TxHash hash={a.paymentTxHash} network={network} />
                </span>
                <span className="shrink-0 font-mono text-[11px] text-mut">
                  {a.recordTxHash === '' ? (
                    <span title="Attestation tx predates the activity lookback window">
                      attest <span className="text-mut/60">—</span>
                    </span>
                  ) : (
                    <>
                      attest <TxHash hash={a.recordTxHash} network={network} />
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
