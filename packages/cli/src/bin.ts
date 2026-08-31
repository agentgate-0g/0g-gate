#!/usr/bin/env node
import { Command } from 'commander';
// Read from the manifest rather than a second constant: a hand-maintained
// version silently drifts from the one that was actually published, and the
// whole point of --version is telling the user which build they are running.
// resolveJsonModule is on and tsup inlines this, so it costs nothing at runtime.
import { version as CLI_VERSION } from '../package.json';
import { createChainClient } from '@agentgate/chain';
import {
  AgentGateError,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_GATEWAY_URL,
  formatOg,
  isAgentGateError,
  loadConfig,
  type AgentGateConfig,
} from '@agentgate/shared';
import { buyService } from './buy';
import { createDemoAccounts } from './demo-accounts';
import { listServices } from './list';
import { mapService } from './map';
import { setServiceActive } from './pause';
import { buyerSigner, sellerSigner } from './signers';
import { serviceStatus, STATUS_ATTESTATION_LIMIT } from './status';
import { wrapService } from './wrap';
import { startAgentGateMcpServer } from './mcp';
import { resolveCliEnv, type CliConfigFlags } from './cli-env';

interface WrapCmdOpts extends CliConfigFlags {
  price: string;
  name: string;
  description?: string;
  gateway?: string;
  paymentTarget?: string;
  attestor?: string;
}

/** Plain monospace table: pads every column to its widest cell. */
function renderTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all
    .map((r) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

/** Attach the shared chain-config flags (mode/rpc/registry) to a command. */
function withConfigFlags(cmd: Command): Command {
  return cmd
    .option('--mode <mode>', 'chain mode: mock | live (published CLI defaults to live)')
    .option('--rpc-url <url>', '0G Galileo RPC URL (default: https://evmrpc-testnet.0g.ai)')
    .option('--registry <address>', 'AgentGateRegistry contract address (default: the deployed one)');
}

/**
 * Build runtime config from flags + env. The CLI needs neither an indexer key
 * nor a strong admin token just to load — reads go straight to a public RPC, and
 * wrap surfaces a token/gateway problem at the admin POST, not at config load.
 */
function cliConfig(opts: CliConfigFlags): AgentGateConfig {
  return loadConfig(
    resolveCliEnv({
      mode: opts.mode,
      rpcUrl: opts.rpcUrl,
      registry: opts.registry,
      key: opts.key,
      adminToken: opts.adminToken,
    }),
    { requireStrongAdminToken: false },
  );
}

/** Explorer link for a tx, or undefined in mock mode (nothing to link to). */
function explorerTxUrl(config: AgentGateConfig, txHash: string): string | undefined {
  if (config.mode !== 'live' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return undefined;
  return `${config.zgExplorerUrl}/tx/${txHash}`;
}

const program = new Command();

program
  .name('agentgate')
  .version(CLI_VERSION, '-v, --version', 'print the installed version')
  .description('AgentGate — wrap any API into a 402-paywalled, on-chain-registered service');

withConfigFlags(
  program
    .command('wrap')
    .description('Wrap an upstream API behind the AgentGate 402 paywall and register it on-chain')
    .argument('<upstreamUrl>', 'upstream API URL to wrap (kept private, only sent to the gateway)')
    .requiredOption('--price <og>', 'price per call in OG (e.g. 0.5)')
    .requiredOption('--name <name>', 'service name')
    .option('--description <d>', 'service description', '')
    .option('--gateway <url>', 'gateway base URL (default: the hosted gateway in live mode)')
    .option(
      '--payment-target <address>',
      'payment target address (default: derived from the seller signer)',
    )
    .option(
      '--attestor <address>',
      'address allowed to record attestations (default: the seller signer address)',
    )
    .option('--key <0xhex>', 'seller signer private key — prefer SELLER_SIGNER_KEY (a --key argument is visible in shell history and `ps`)')
    .option('--admin-token <token>', 'gateway admin bearer token (leaks into shell history/ps)'),
).action(async (upstreamUrl: string, opts: WrapCmdOpts) => {
    const config = cliConfig(opts);
    const chain = createChainClient(config);
    const signer = sellerSigner(config);
    const gateway =
      opts.gateway ??
      (config.mode === 'live' ? DEFAULT_GATEWAY_URL : `http://localhost:${config.middlewarePort}`);
    const result = await wrapService({
      upstreamUrl,
      priceOg: opts.price,
      name: opts.name,
      description: opts.description,
      gateway,
      paymentTarget: opts.paymentTarget,
      attestor: opts.attestor,
      dashboardBaseUrl:
        config.mode === 'live'
          ? DEFAULT_DASHBOARD_URL
          : `http://localhost:${config.dashboardPort}`,
      chain,
      signer,
      adminToken: config.adminToken,
      mode: config.mode,
      network: config.zgNetwork,
      timeoutMs: config.upstreamTimeoutMs,
    });
    console.log(`service id:      ${result.serviceId}`);
    console.log(`public endpoint: ${result.publicUrl}`);
    console.log(`dashboard:       ${result.dashboardUrl}`);
    console.log(`register tx:     ${result.txHash}`);
    const explorer = explorerTxUrl(config, result.txHash);
    if (explorer !== undefined) console.log(`explorer:        ${explorer}`);
    if (!result.adminOk) {
      // wrapService already printed the detailed warning + retry curl to stderr.
      console.log('note: gateway upstream mapping FAILED — see the warning above for the retry curl.');
    }
  });

interface MapCmdOpts extends CliConfigFlags {
  gateway?: string;
}

withConfigFlags(
  program
    .command('map')
    .description(
      "Point the gateway at a service's upstream WITHOUT registering it again — the recovery path when wrap's on-chain registration succeeded but its gateway mapping did not",
    )
    .argument('<id>', 'service id that is already registered on-chain')
    .argument('<upstreamUrl>', 'upstream API URL to map (kept private, only sent to the gateway)')
    .option('--gateway <url>', 'gateway base URL (default: the hosted gateway in live mode)')
    .option('--key <0xhex>', 'seller signer private key — prefer SELLER_SIGNER_KEY (a --key argument is visible in shell history and `ps`)')
    .option('--admin-token <token>', 'gateway admin bearer token (mock mode only; leaks into shell history/ps)'),
).action(async (idRaw: string, upstreamUrl: string, opts: MapCmdOpts) => {
  if (!/^\d+$/.test(idRaw.trim()) || Number(idRaw.trim()) < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${JSON.stringify(idRaw)}`,
      400,
    );
  }
  const config = cliConfig(opts);
  const signer = sellerSigner(config);
  const gateway =
    opts.gateway ??
    (config.mode === 'live' ? DEFAULT_GATEWAY_URL : `http://localhost:${config.middlewarePort}`);
  const result = await mapService({
    serviceId: Number(idRaw.trim()),
    upstreamUrl,
    gateway,
    signer,
    adminToken: config.adminToken,
    mode: config.mode,
    network: config.zgNetwork,
    timeoutMs: config.upstreamTimeoutMs,
  });
  console.log(`service id:      ${result.serviceId}`);
  console.log(`public endpoint: ${result.publicUrl}`);
  console.log(`authorized via:  ${result.via}`);
});

withConfigFlags(
  program
    .command('list')
    .description('List the on-chain service catalog with scores and trust tiers'),
).action(async (opts: CliConfigFlags) => {
    const config = cliConfig(opts);
    const chain = createChainClient(config);
    const listings = await listServices({ chain });
    if (listings.length === 0) {
      console.log(
        'no services registered yet — wrap one with `agentgate wrap <upstreamUrl> --price 0.5 --name "My API"`',
      );
      return;
    }
    const rows = listings.map(({ service, score, tier }) => [
      String(service.id),
      service.name,
      formatOg(service.priceWei),
      tier,
      `${score.successCalls}/${score.totalCalls}`,
      service.active ? 'yes' : 'no',
      service.endpointUrl,
    ]);
    console.log(renderTable(['ID', 'NAME', 'PRICE', 'TIER', 'SCORE', 'ACTIVE', 'ENDPOINT'], rows));
  });

interface BuyCmdOpts extends CliConfigFlags {
  max?: string;
  method: string;
  body?: string;
  gateway?: string;
}

withConfigFlags(
  program
    .command('buy')
    .description(
      'Buy one call to a service: pay its 402 invoice through the PaymentRouter contract and print the response (body → stdout, payment details → stderr)',
    )
    .argument('<id>', 'service id (see `agentgate list`)')
    .option('--max <og>', 'refuse invoices priced above this many OG')
    .option('--method <method>', 'HTTP method for the paid request', 'GET')
    .option('--body <json>', 'JSON request body to send with the paid request')
    .option('--gateway <url>', "gateway base URL (default: the service's on-chain endpoint)")
    .option('--key <0xhex>', 'buyer signer private key — prefer BUYER_SIGNER_KEY (a --key argument is visible in shell history and `ps`)'),
).action(async (idRaw: string, opts: BuyCmdOpts) => {
  // Service ids are 1-based, matching status/pause/resume.
  if (!/^\d+$/.test(idRaw.trim()) || Number(idRaw.trim()) < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${JSON.stringify(idRaw)}`,
      400,
    );
  }
  // The shared --key flag means the SELLER key in cliConfig; for buy it is the
  // buyer key, so keep it out of the config env and hand it to buyerSigner.
  const config = cliConfig({ ...opts, key: undefined });
  const chain = createChainClient(config);
  const signer = buyerSigner(config, opts.key);
  const { service, url, result } = await buyService({
    chain,
    signer,
    id: Number(idRaw.trim()),
    method: opts.method,
    ...(opts.max !== undefined ? { maxOg: opts.max } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.gateway !== undefined ? { gateway: opts.gateway } : {}),
  });

  // Payment metadata → stderr so the response body on stdout stays pipeable.
  console.error(`service:  #${service.id} ${service.name}`);
  console.error(`url:      ${url}`);
  if (result.paid) {
    console.error(`paid:     ${formatOg(result.priceWei ?? service.priceWei)}`);
    console.error(`payment:  ${result.txHash}`);
    const explorer = result.txHash !== undefined ? explorerTxUrl(config, result.txHash) : undefined;
    if (explorer !== undefined) console.error(`explorer: ${explorer}`);
    if (result.settlement !== undefined) {
      const payer = result.settlement.payer !== undefined ? `  (payer ${result.settlement.payer})` : '';
      console.error(`settled:  ${result.settlement.success ? 'ok' : 'FAILED'}${payer}`);
    }
    if (result.status === 402) {
      console.error(
        'warning:  payment sent but the gateway still answered 402 — see the body for the error code',
      );
    }
  } else {
    console.error('paid:     no — the endpoint answered without requiring payment');
  }
  console.error(`status:   ${result.status}`);
  const body = result.body;
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
});

withConfigFlags(
  program
    .command('status')
    .description('Show one service: record, score, trust tier and recent attestations')
    .argument('<id>', 'service id'),
).action(async (idRaw: string, opts: CliConfigFlags) => {
    // Service ids are 1-based (matches pause/resume); serviceStatus also enforces id >= 1.
    if (!/^\d+$/.test(idRaw.trim()) || Number(idRaw.trim()) < 1) {
      throw new AgentGateError(
        'INVALID_SERVICE_ID',
        `service id must be a positive integer, got ${JSON.stringify(idRaw)}`,
        400,
      );
    }
    const config = cliConfig(opts);
    const chain = createChainClient(config);
    // Attestation history is an on-chain view call on 0G — no indexer, no API key.
    const { service, score, tier, attestations } = await serviceStatus({
      chain,
      id: Number(idRaw.trim()),
    });
    console.log(
      `service:        #${service.id} ${service.name}${service.active ? '' : '  [INACTIVE]'}`,
    );
    if (service.description !== '') console.log(`description:    ${service.description}`);
    console.log(`endpoint:       ${service.endpointUrl}`);
    console.log(`price:          ${formatOg(service.priceWei)}`);
    console.log(`payment target: ${service.paymentTarget}`);
    console.log(`owner:          ${service.owner}`);
    console.log(`attestor:       ${service.attestor}`);
    console.log(`trust:          ${tier} (${score.successCalls}/${score.totalCalls} calls ok)`);
    if (attestations.length === 0) {
      console.log('attestations:   none yet');
      return;
    }
    console.log(`attestations (latest ${STATUS_ATTESTATION_LIMIT}):`);
    for (const a of attestations) {
      const when = new Date(a.timestamp).toISOString();
      // recordTxHash is a log join and can be empty for an attestation older
      // than the lookback window — print nothing rather than a dangling "tx ".
      const attestTx = a.recordTxHash === '' ? '' : `  tx ${a.recordTxHash}`;
      console.log(
        `  [${a.success ? 'ok  ' : 'FAIL'}] ${when}  payment ${a.paymentTxHash}${attestTx}`,
      );
    }
  });

/** Shared action for `pause` / `resume`: toggle the on-chain active flag and report. */
async function toggleActive(idRaw: string, active: boolean, opts: CliConfigFlags): Promise<void> {
  if (!/^\d+$/.test(idRaw.trim())) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${JSON.stringify(idRaw)}`,
      400,
    );
  }
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const signer = sellerSigner(config);
  const { txHash, service } = await setServiceActive({
    chain,
    signer,
    id: Number(idRaw.trim()),
    active,
  });
  console.log(`service:       #${service.id} ${service.name}`);
  console.log(`active:        ${service.active ? 'yes' : 'no (paused)'}`);
  console.log(`setActive tx:  ${txHash}`);
  const explorer = explorerTxUrl(config, txHash);
  if (explorer !== undefined) console.log(`explorer:      ${explorer}`);
}

withConfigFlags(
  program
    .command('pause')
    .description('Pause a service you own: setActive(false) on-chain, the paywall answers 403')
    .argument('<id>', 'service id')
    .option('--key <0xhex>', 'seller signer private key — prefer SELLER_SIGNER_KEY (a --key argument is visible in shell history and `ps`)'),
).action(async (idRaw: string, opts: CliConfigFlags) => toggleActive(idRaw, false, opts));

withConfigFlags(
  program
    .command('resume')
    .description('Resume a paused service you own: setActive(true) on-chain, calls flow again')
    .argument('<id>', 'service id')
    .option('--key <0xhex>', 'seller signer private key — prefer SELLER_SIGNER_KEY (a --key argument is visible in shell history and `ps`)'),
).action(async (idRaw: string, opts: CliConfigFlags) => toggleActive(idRaw, true, opts));

withConfigFlags(
  program
    .command('demo-accounts')
    .description('Create faucet-funded buyer/seller demo accounts on the mock devnet (mock mode only)'),
).action(async (opts: CliConfigFlags) => {
    const config = cliConfig(opts);
    if (config.mode !== 'mock') {
      throw new AgentGateError(
        'MOCK_ONLY',
        'demo-accounts only works in mock mode (set AGENTGATE_MODE=mock)',
        400,
      );
    }
    const result = await createDemoAccounts({
      devnetUrl: config.devnetUrl,
      timeoutMs: config.upstreamTimeoutMs,
    });
    console.log(`buyer:  ${result.buyer.publicKey}  (${formatOg(result.buyer.balanceWei)})`);
    console.log(`seller: ${result.seller.publicKey}  (${formatOg(result.seller.balanceWei)})`);
    console.log('');
    console.log('# paste into your shell (used by the buyer agent and `agentgate wrap`):');
    for (const line of result.exportLines) {
      console.log(line);
    }
  });

withConfigFlags(
  program
    .command('mcp')
    .description(
      'Serve AgentGate as an MCP (Model Context Protocol) stdio server — any MCP-capable agent gets AgentGate discover/inspect/buy tools (run via `npx agentgate-0g mcp`)',
    )
    .option(
      '--key <0xhex>',
      'buyer signer private key for the agentgate_buy tool — prefer BUYER_SIGNER_KEY (a --key argument is visible in shell history and `ps`)',
    ),
).action(async (opts: CliConfigFlags) => {
  // stdio is the MCP JSON-RPC channel — never write to stdout here. The server
  // stays alive until the client closes stdin.
  const config = cliConfig({ ...opts, key: undefined });
  const chain = createChainClient(config);
  await startAgentGateMcpServer({
    chain,
    signerProvider: () => buyerSigner(config, opts.key),
  });
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = isAgentGateError(err)
    ? `${err.code}: ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
});
