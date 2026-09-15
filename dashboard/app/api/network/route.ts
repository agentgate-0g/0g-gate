import { NextResponse } from 'next/server';
import { getNetworkInfo, toApiFailure } from '@/lib/server/chain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which chain this instance reads — the same facts the layout hands to the
 * UI, exposed for tooling and for anyone checking what a given host serves
 * (`curl .../api/network`) before trusting its catalog. Pure config; no RPC.
 */
export function GET(): NextResponse {
  try {
    return NextResponse.json(getNetworkInfo());
  } catch (err) {
    const { status, body } = toApiFailure(err, '/api/network');
    return NextResponse.json(body, { status });
  }
}
