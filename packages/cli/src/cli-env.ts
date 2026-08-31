import { DEFAULT_REGISTRY_ADDRESS } from '@agentgate/shared';

/** Config-bearing CLI flags shared across commands (all optional). */
export interface CliConfigFlags {
  mode?: string;
  rpcUrl?: string;
  registry?: string;
  /**
   * Seller signer private key (`0x` + 64 hex). A secret: it lands in
   * `SELLER_SIGNER_KEY` for `loadConfig` and is never logged or echoed back.
   */
  key?: string;
  adminToken?: string;
}

type Env = Record<string, string | undefined>;

/** First non-empty (trimmed) of flag, then env; else the fallback (may be undefined). */
function pick(
  flag: string | undefined,
  envVal: string | undefined,
  fallback?: string,
): string | undefined {
  if (flag !== undefined && flag.trim() !== '') return flag;
  if (envVal !== undefined && envVal.trim() !== '') return envVal;
  return fallback;
}

/**
 * Builds the env overlay the CLI hands to `loadConfig`. Precedence per key:
 * explicit flag > process.env (non-empty) > CLI built-in default. The published
 * CLI targets 0G Galileo + the deployed registry by default; keys with no CLI
 * default are left to `loadConfig`'s own defaults (RPC URL, chain id, …).
 */
export function resolveCliEnv(flags: CliConfigFlags, env: Env = process.env): Env {
  const overlay: Env = { ...env };
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined) overlay[key] = value;
  };
  set('AGENTGATE_MODE', pick(flags.mode, env.AGENTGATE_MODE, 'live'));
  set(
    'REGISTRY_CONTRACT_ADDRESS',
    pick(flags.registry, env.REGISTRY_CONTRACT_ADDRESS, DEFAULT_REGISTRY_ADDRESS),
  );
  set('ZG_RPC_URL', pick(flags.rpcUrl, env.ZG_RPC_URL));
  set('SELLER_SIGNER_KEY', pick(flags.key, env.SELLER_SIGNER_KEY));
  set('AGENTGATE_ADMIN_TOKEN', pick(flags.adminToken, env.AGENTGATE_ADMIN_TOKEN));
  return overlay;
}
