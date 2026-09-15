// PM2 process definitions for the AgentGate public deploy (matches this box's
// existing PM2 setup). Usage:
//
//   pm2 start deploy/agentgate.ecosystem.config.cjs        # all four apps
//   pm2 start deploy/agentgate.ecosystem.config.cjs --only agentgate-0g-gateway
//   pm2 save                                               # persist across reboot
//   pm2 logs agentgate-0g-gateway
//
// The names carry the 0g- prefix on purpose. A pm2 app named `agentgate-gateway`
// already exists on this box, pointing at an unrelated older checkout, and
// `pm2 start` matches on NAME, not on path: starting this file under the bare
// name restarted that other app instead and took this gateway offline.
//
// Two networks, one box, one build. Since 2026-09-15 the PUBLIC hosts serve
// 0G MAINNET, and Galileo runs beside it, selected by ZG_NETWORK_PROFILE=galileo.
// The ports are whatever the Cloudflare tunnel (managed remotely, not in this
// repo) points each hostname at — change them here only together with it:
//
//   gateway            → mainnet 402 middleware on :16021  (0g-gateway.equiflow.xyz)
//   gateway-galileo    → the same code on :16022, Galileo   (0g-gateway.mdloglabs.org)
//   dashboard          → mainnet `next start` on :13000     (agentgate.equiflow.xyz)
//   dashboard-galileo  → the same build on :13001, Galileo  (no hostname)
//
// A gateway serves ONE chain (it verifies payments against its router and
// attests on its chain) and keeps three files — invoices, pending attestations,
// and the service-id → upstream map. Service ids start at 1 on every chain, so
// the two gateways must never share a file: each names its own set below. The
// dashboard resolves its network per request (dashboard/lib/server/chain.ts),
// so the two dashboard apps differ by the profile variable alone.
//
// Derived, never hardcoded. These pointed at a different checkout (the Casper-era
// tree, which still exists on this box) and at a node version that had moved on —
// so `pm2 start` would happily boot the wrong application. __dirname is this file's
// own home, and process.execPath is the node actually running pm2.
const path = require('node:path');
const REPO = path.resolve(__dirname, '..');
const NODE_BIN = path.dirname(process.execPath);

// Shared env fragments; each app below spells out its own name, profile,
// port and files so the four definitions read as the table above.
const BASE_ENV = {
  NODE_ENV: 'production',
  PATH: `${NODE_BIN}:${process.env.PATH || ''}`,
};

module.exports = {
  apps: [
    {
      name: 'agentgate-0g-gateway',
      cwd: REPO,
      script: 'npm',
      args: 'run dev:live',
      interpreter: 'none',
      autorestart: true,
      env: {
        ...BASE_ENV,
        ZG_NETWORK_PROFILE: 'mainnet',
        MIDDLEWARE_PORT: process.env.MIDDLEWARE_PORT || '16021',
        // Persist issued invoices across restarts (FileInvoiceStore, F2) —
        // a buyer who paid on-chain is not lost if the gateway bounces.
        INVOICE_STORE_PATH: `${REPO}/data/gateway-mainnet-invoices.json`,
        // Persist pending attestations across restarts (FileAttestationQueue, F7)
        // — a served+paid call whose attestation didn't confirm before a bounce
        // is replayed on boot, so the trust ledger is never under-counted.
        ATTESTATION_QUEUE_PATH: `${REPO}/data/gateway-mainnet-attestations.json`,
        UPSTREAMS_PATH: `${REPO}/data/gateway-mainnet-upstreams.json`,
      },
    },
    {
      name: 'agentgate-0g-gateway-galileo',
      cwd: REPO,
      script: 'npm',
      args: 'run dev:live',
      interpreter: 'none',
      autorestart: true,
      env: {
        ...BASE_ENV,
        ZG_NETWORK_PROFILE: 'galileo',
        MIDDLEWARE_PORT: process.env.MIDDLEWARE_GALILEO_PORT || '16022',
        // The Galileo files keep their pre-cutover names and locations: they
        // hold that network's history, and its upstream map lived at the
        // middleware package's default path.
        INVOICE_STORE_PATH: `${REPO}/data/gateway-invoices.json`,
        ATTESTATION_QUEUE_PATH: `${REPO}/data/gateway-attestations.json`,
        UPSTREAMS_PATH: `${REPO}/packages/middleware/data/upstreams.json`,
      },
    },
    {
      name: 'agentgate-0g-dashboard',
      cwd: `${REPO}/dashboard`,
      script: 'npm',
      args: 'run start',
      interpreter: 'none',
      autorestart: true,
      env: {
        ...BASE_ENV,
        ZG_NETWORK_PROFILE: 'mainnet',
        // Explicit: `next start` defaults to 3000, which is already taken on
        // this box by an unrelated app. A dashboard that silently fails to bind
        // looks identical to one that is merely slow to boot.
        PORT: process.env.DASHBOARD_PORT || '13000',
      },
    },
    {
      name: 'agentgate-0g-dashboard-galileo',
      cwd: `${REPO}/dashboard`,
      script: 'npm',
      args: 'run start',
      interpreter: 'none',
      autorestart: true,
      env: {
        ...BASE_ENV,
        ZG_NETWORK_PROFILE: 'galileo',
        PORT: process.env.DASHBOARD_GALILEO_PORT || '13001',
      },
    },
  ],
};
