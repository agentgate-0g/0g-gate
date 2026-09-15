import { describe, expect, it } from 'vitest';
import { AgentGateError } from '@agentgate/shared';
import { toApiFailure } from '../dashboard/lib/server/chain';

/**
 * Every /api/* route funnels its failures through toApiFailure, and it used to
 * answer 503 `chain_unreachable` for all of them but one. That is the code the
 * UI turns into "Waiting for the chain to come back… start the local stack with
 * npm run dev" — advice that is actively wrong when the chain is fine and the
 * deployment simply does not match the shipped ABI, which is how a registry
 * drift cost hours pointed at a healthy RPC.
 *
 * An AgentGateError already carries the code and status it wants; the mapper's
 * job is to stop overwriting them.
 */
describe('toApiFailure', () => {
  it('reports a shape mismatch under its own code, not as an unreachable chain', () => {
    const err = new AgentGateError('registry_abi_mismatch', 'registry 0x… cannot decode', 500);
    expect(toApiFailure(err, '/api/services')).toEqual({
      status: 500,
      body: { error: 'registry_abi_mismatch' },
    });
  });

  it('still reports a genuinely unreachable node as chain_unreachable', () => {
    expect(toApiFailure(new Error('fetch failed'), '/api/services')).toEqual({
      status: 503,
      body: { error: 'chain_unreachable' },
    });
  });

  it('still reports an invalid config as config_invalid', () => {
    const err = new AgentGateError('CONFIG_INVALID', 'AGENTGATE_MODE must be mock or live', 500);
    expect(toApiFailure(err, '/api/services')).toEqual({
      status: 500,
      body: { error: 'config_invalid' },
    });
  });
});
