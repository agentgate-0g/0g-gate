import { NextRequest, NextResponse } from 'next/server';
import { getChain, parseLimit, toApiFailure } from '@/lib/server/chain';
import type { ActivityResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * Short server-side cache. The /activity page polls this route frequently and
 * each miss fans out to three `eth_getLogs` calls plus up to `limit` block
 * reads against the public 0G RPC. There is no API quota to exhaust any more,
 * but a public RPC is still a shared resource with rate limits and latency, so
 * caching per limit collapses all pollers to one upstream fetch per TTL. The
 * last good response is served through a transient RPC failure, so the feed
 * degrades to "cached" instead of blank.
 */
const CACHE_TTL_MS = 30_000;
type Entry = { at: number; body: ActivityResponse };
const cache = new Map<number, Entry>();

export async function GET(req: NextRequest): Promise<NextResponse> {
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 50, 200);
  const now = Date.now();
  const hit = cache.get(limit);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.body, { headers: { 'x-cache': 'hit' } });
  }
  try {
    const { chain } = getChain();
    const events = await chain.listRecentActivity(limit);
    const body: ActivityResponse = { network: chain.network, events };
    cache.set(limit, { at: now, body });
    return NextResponse.json(body, { headers: { 'x-cache': 'miss' } });
  } catch (err) {
    // Serve the last good data through a transient upstream failure so the feed
    // shows "cached" rather than emptying out (RPC rate limits, brief outages).
    if (hit) {
      return NextResponse.json(
        { ...hit.body, stale: true },
        { headers: { 'x-cache': 'stale' } },
      );
    }
    const { status, body } = toApiFailure(err, '/api/activity');
    return NextResponse.json(body, { status });
  }
}
