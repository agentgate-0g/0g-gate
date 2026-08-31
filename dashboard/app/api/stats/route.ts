import { NextResponse } from 'next/server';
import { parseWei } from '@agentgate/shared';
import { getChain, toApiFailure } from '@/lib/server/chain';
import type { StatsResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(): Promise<NextResponse> {
  try {
    const { chain } = getChain();
    const services = await chain.listServices();
    const scores = await Promise.all(services.map((s) => chain.getScore(s.id)));

    let totalCalls = 0;
    let successCalls = 0;
    let revenue = 0n; // wei, bigint — never float math on money
    services.forEach((service, i) => {
      const score = scores[i];
      if (!score) return;
      totalCalls += score.totalCalls;
      successCalls += score.successCalls;
      revenue += parseWei(service.priceWei) * BigInt(score.successCalls);
    });

    const body: StatsResponse = {
      network: chain.network,
      services: services.length,
      activeServices: services.filter((s) => s.active).length,
      totalCalls,
      successCalls,
      revenueWei: revenue.toString(),
    };
    return NextResponse.json(body);
  } catch (err) {
    const { status, body } = toApiFailure(err, '/api/stats');
    return NextResponse.json(body, { status });
  }
}
