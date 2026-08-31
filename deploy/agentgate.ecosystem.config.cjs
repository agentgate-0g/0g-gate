// PM2 process definitions for the AgentGate public deploy (matches this box's
// existing PM2 setup). Usage:
//
//   pm2 start deploy/agentgate.ecosystem.config.cjs        # both apps
//   pm2 start deploy/agentgate.ecosystem.config.cjs --only agentgate-gateway
//   pm2 save                                               # persist across reboot
//   pm2 logs agentgate-gateway
//
// gateway  → live 402 middleware on :4021 (reads root .env via scripts/live.ts)
// dashboard → next start on :3000 (reads dashboard/.env.local)
// Derived, never hardcoded. These pointed at a different checkout (the Casper-era
// tree, which still exists on this box) and at a node version that had moved on —
// so `pm2 start` would happily boot the wrong application. __dirname is this file's
// own home, and process.execPath is the node actually running pm2.
const path = require('node:path');
const REPO = path.resolve(__dirname, '..');
const NODE_BIN = path.dirname(process.execPath);

module.exports = {
  apps: [
    {
      name: 'agentgate-gateway',
      cwd: REPO,
      script: 'npm',
      args: 'run dev:live',
      interpreter: 'none',
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        PATH: `${NODE_BIN}:${process.env.PATH || ''}`,
        // Persist issued invoices across restarts (FileInvoiceStore, F2) —
        // a buyer who paid on-chain is not lost if the gateway bounces.
        INVOICE_STORE_PATH: `${REPO}/data/gateway-invoices.json`,
        // Persist pending attestations across restarts (FileAttestationQueue, F7)
        // — a served+paid call whose attestation didn't confirm before a bounce
        // is replayed on boot, so the trust ledger is never under-counted.
        ATTESTATION_QUEUE_PATH: `${REPO}/data/gateway-attestations.json`,
      },
    },
    {
      name: 'agentgate-dashboard',
      cwd: `${REPO}/dashboard`,
      script: 'npm',
      args: 'run start',
      interpreter: 'none',
      autorestart: true,
      env: { NODE_ENV: 'production', PATH: `${NODE_BIN}:${process.env.PATH || ''}` },
    },
  ],
};
