import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import {
  AgentGateError,
  buildSelfMapMessage,
  createLogger,
  decodeXPayment,
  encodeXPaymentResponse,
  randomNonce,
  SELF_MAP_WINDOW_MS,
  trustTier,
  X402_ASSET_OG,
  X402_SCHEME,
  X402_VERSION,
  type AgentGateConfig,
  type AnySigner,
  type ChainClient,
  type Logger,
  type PaymentRequiredResponse,
  type PaymentRequirements,
  type ServiceRecord,
} from '@agentgate/shared';
import { addressFromPrivateKey, isAddress, recoverSigner, sameAddress } from '@agentgate/chain';
import { MemoryInvoiceStore, type InvoiceStore } from './invoice-store';
import { FileInvoiceStore } from './invoice-store-file';
import { MemoryAttestationQueue, type AttestationQueue } from './attestation-queue';
import { FileAttestationQueue } from './attestation-queue-file';
import { UpstreamStore } from './upstream-store';
import { ServiceCache } from './service-cache';
import { isUpstreamSuccess, proxyToUpstream } from './proxy';
import { resolvedHostIsPublic, validateUpstreamUrl } from './ssrf';
import {
  HEADER_X_PAYMENT,
  HEADER_X_PAYMENT_RESPONSE,
} from './types';

export interface MiddlewareDeps {
  config: AgentGateConfig;
  chain: ChainClient;
  logger?: Logger;
  /**
   * Path of the upstream-map JSON file. Relative paths resolve against cwd.
   * Default: `data/upstreams.json` under the middleware package directory.
   */
  upstreamsFile?: string;
  /** Custom invoice store (default: in-memory + TTL sweep). Injected stores are not closed on dispose. */
  invoiceStore?: InvoiceStore;
  /**
   * When set (and no `invoiceStore` is injected), persist invoices to this JSON
   * file so they survive a restart (finding F2). The gateway owns and closes it.
   */
  invoiceStorePath?: string;
  /** Custom attestation queue (default: in-memory). Injected queues are not closed on dispose. */
  attestationQueue?: AttestationQueue;
  /**
   * When set (and no `attestationQueue` is injected), persist pending attestations
   * to this JSON file so a served+paid call whose on-chain attestation never
   * confirmed is replayed after a restart instead of being under-counted (F7).
   */
  attestationQueuePath?: string;
  /** Base delay before the first attestation retry (exponential backoff). Default 5000 ms. */
  attestationRetryDelayMs?: number;
  /** Total attestation attempts before giving up (1 = no retry). Default 4. */
  attestationMaxAttempts?: number;
}

/** Internal handles startServer() uses for graceful shutdown. */
export interface AppInternals {
  dispose(): Promise<void>;
}

const DEFAULT_ATTESTATION_RETRY_DELAY_MS = 5_000;
const DEFAULT_ATTESTATION_MAX_ATTEMPTS = 4;
const JSON_BODY_LIMIT = '256kb';
const SVC_RATE_LIMIT_PER_MINUTE = 60;
const ADMIN_RATE_LIMIT_PER_MINUTE = 20;
const SELF_MAP_RATE_LIMIT_PER_MINUTE = 20;
const SERVICE_ID_RE = /^\d{1,15}$/;

/**
 * True when the request carries a body the gateway cannot faithfully forward.
 * We only relay JSON bodies (express.json parsed them); a non-JSON body would be
 * silently dropped, so we reject it BEFORE charging rather than bill the buyer
 * for an upstream call that receives an empty body.
 */
function hasUnsupportedRequestBody(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  const contentLength = req.header('content-length');
  const hasBody =
    (contentLength !== undefined && contentLength !== '0') ||
    req.header('transfer-encoding') !== undefined;
  if (!hasBody) return false;
  return !req.is('application/json');
}

function defaultUpstreamsFile(): string {
  // <package>/src/app.ts → <package>/data/upstreams.json
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.join(packageDir, 'data', 'upstreams.json');
}

function parseServiceId(raw: string | undefined): number | null {
  if (raw === undefined || !SERVICE_ID_RE.test(raw)) return null;
  return Number(raw);
}

/** Constant-time string comparison (hash first so lengths never short-circuit). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * A payer that is the service owner or its payout account is wash-trading.
 *
 * `sameAddress` matches only well-formed `0x<40hex>` pairs, so this fires in
 * BOTH modes: live identities come from the contract, and mock identities are
 * `mockAccountAddress`-derived, which yields the same shape. (Before that
 * derivation existed, every mock payer failed the format check and the guard
 * was silently a no-op on the demo path.)
 */
export function isSelfPayment(payer: string, service: ServiceRecord): boolean {
  return sameAddress(payer, service.owner) || sameAddress(payer, service.paymentTarget);
}

/** Express 4 does not catch async handler rejections — wrap them. */
function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Builds the 402 paywall reverse proxy + admin API (SPEC §5).
 * Pure factory — no listen(); startServer() wires it to a port.
 */
export function createApp(deps: MiddlewareDeps): Express {
  if (!deps || !deps.config || !deps.chain) {
    throw new AgentGateError('BAD_DEPS', 'createApp requires { config, chain }', 500);
  }
  const { config, chain } = deps;
  // Fail closed: live mode must use a real attestor key, never the mock-signer
  // fallback (which would record attestations with no key material).
  if (config.mode === 'live' && config.gateSignerKey.trim() === '') {
    throw new AgentGateError(
      'CONFIG_INVALID',
      'live mode requires GATE_SIGNER_KEY (the attestor signing key) — refusing the mock-signer fallback',
      500,
    );
  }
  // Derived once: the address this gateway signs attestations as. Empty in
  // mock mode, where a mock signer stands in for a key.
  const gatewayAttestor =
    config.gateSignerKey.trim() === '' ? '' : addressFromPrivateKey(config.gateSignerKey);

  // Fail closed: an unset/malformed router means every 402 this gateway ever
  // issues carries `extra.router: ''` — the gateway boots and looks healthy,
  // but no buyer can ever pay (the client rejects a non-0x router as
  // BAD_INVOICE before calling chain.transfer). Catch that at boot, not one
  // silent-failure-per-buyer later.
  if (config.mode === 'live' && !isAddress(config.paymentRouterAddress)) {
    throw new AgentGateError(
      'CONFIG_INVALID',
      'live mode requires PAYMENT_ROUTER_ADDRESS to be a 0x-prefixed EVM address — refusing to issue unpayable invoices',
      500,
    );
  }
  // Fail closed: a live gateway must not hold invoices only in memory.
  // PaymentRouter.pay forwards msg.value to the seller inside the same
  // transaction — no escrow, and no refund function exists in any of the three
  // contracts — so an invoice lost to a restart is a buyer who paid and can
  // never be served. FileInvoiceStore exists for this, but it is opt-in, and an
  // opt-in safety default is the one that is missing when it matters. An
  // injected store is accepted: the caller has taken ownership of durability.
  if (
    config.mode === 'live' &&
    deps.invoiceStore === undefined &&
    (deps.invoiceStorePath === undefined || deps.invoiceStorePath.trim() === '')
  ) {
    throw new AgentGateError(
      'CONFIG_INVALID',
      'live mode requires INVOICE_STORE_PATH — an in-memory invoice store loses every ' +
        'in-flight payment on restart, and those payments cannot be refunded',
      500,
    );
  }
  const logger = deps.logger ?? createLogger('middleware');
  // Persistent when a path is configured (F2), else in-memory. Either way, a
  // store the gateway constructs itself is closed on dispose; an injected one is not.
  const invoices =
    deps.invoiceStore ??
    (deps.invoiceStorePath !== undefined && deps.invoiceStorePath.trim() !== ''
      ? new FileInvoiceStore(deps.invoiceStorePath)
      : new MemoryInvoiceStore());
  const ownsInvoiceStore = deps.invoiceStore === undefined;
  // Durable when a path is configured (F7), else in-memory. Owned queues (not
  // injected) are closed on dispose.
  const attestations =
    deps.attestationQueue ??
    (deps.attestationQueuePath !== undefined && deps.attestationQueuePath.trim() !== ''
      ? new FileAttestationQueue(deps.attestationQueuePath)
      : new MemoryAttestationQueue());
  const ownsAttestationQueue = deps.attestationQueue === undefined;
  const upstreams = new UpstreamStore(
    deps.upstreamsFile !== undefined
      ? path.resolve(process.cwd(), deps.upstreamsFile)
      : defaultUpstreamsFile(),
    logger,
  );
  // Boot-time load (throws on corrupt file); re-apply the SSRF guard so a
  // persisted mapping to a now-forbidden host is dropped, not trusted.
  upstreams.loadSync(
    (url) => validateUpstreamUrl(url, { rejectPrivateHosts: config.mode === 'live' }).ok,
  );
  const services = new ServiceCache(chain);
  const attestationRetryDelayMs = deps.attestationRetryDelayMs ?? DEFAULT_ATTESTATION_RETRY_DELAY_MS;
  const attestationMaxAttempts = deps.attestationMaxAttempts ?? DEFAULT_ATTESTATION_MAX_ATTEMPTS;

  const app = express();
  app.disable('x-powered-by');
  // Number of trusted reverse-proxy hops, so req.ip (and thus rate-limit keying)
  // reflects the real client behind Railway/Vercel. Default 0 (trust none); set
  // TRUST_PROXY to the real hop count in production. Never blindly trust all
  // hops, which would make X-Forwarded-For spoofable.
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  // CORS is intentionally OFF: the gateway is a server-to-server API for agents,
  // not called directly from browsers (the dashboard reads via its own server
  // routes). Add an explicit allowlist here only if a browser client is needed.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Structured request logs (no upstream URLs, no tokens — path + outcome only).
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  // ---------------------------------------------------------------- helpers

  /** Gate/attestor signer: live key in live mode, mock identity otherwise. */
  function gateSignerFor(service: ServiceRecord): AnySigner {
    if (config.mode === 'live' && config.gateSignerKey !== '') {
      return { kind: 'key', privateKey: config.gateSignerKey };
    }
    // Mock mode: the devnet authorizes by public key string; act as the
    // service's registered attestor (mock signers carry no key material).
    return { kind: 'mock', publicKey: service.attestor };
  }

  function buildRequirements(
    service: ServiceRecord, nonce: string, expiresAt: number, resource: string,
  ): PaymentRequirements {
    return {
      scheme: X402_SCHEME,
      network: chain.network,
      maxAmountRequired: service.priceWei,
      asset: X402_ASSET_OG,
      payTo: service.paymentTarget,
      resource,
      description: service.name,
      maxTimeoutSeconds: Math.floor(config.invoiceTtlMs / 1000),
      extra: {
        nonce,
        serviceId: service.id,
        expiresAtMs: expiresAt,
        settlement: '0g-payment-router',
        // The buyer MUST pay through this router — a bare transfer carries no
        // nonce and can never be matched back to this invoice.
        router: config.paymentRouterAddress,
        nonceEncoding: 'uint256-decimal',
      },
    };
  }

  function send402(
    res: Response, error: string, requirements: PaymentRequirements, retryAfterSeconds?: number,
  ): void {
    if (retryAfterSeconds !== undefined) res.set('Retry-After', String(retryAfterSeconds));
    const body: PaymentRequiredResponse = { x402Version: X402_VERSION, error, accepts: [requirements] };
    res.status(402).json(body);
  }

  /** Issues + persists a fresh invoice, then responds 402. */
  async function respond402Fresh(
    res: Response, service: ServiceRecord, resource: string, error: string,
  ): Promise<void> {
    const nonce = randomNonce();
    const expiresAt = Date.now() + config.invoiceTtlMs;
    await invoices.put({ nonce, serviceId: service.id, priceWei: service.priceWei, expiresAt, used: false });
    send402(res, error, buildRequirements(service, nonce, expiresAt, resource));
  }

  /**
   * Run the on-chain attestation attempt loop for one payment (success := upstream
   * 2xx). Never blocks the buyer; on failure retries with exponential backoff up
   * to `attestationMaxAttempts` total tries (timers unref'd so they never keep the
   * process alive). On success the payment is dropped from the durable queue; a
   * run whose attempts all fail leaves it queued for replay on the next boot (F7),
   * so a served+paid call is under-counted only until the next restart, never
   * over-counted.
   */
  function runAttestation(
    service: ServiceRecord,
    settlement: { paymentTxHash: string; nonce: string; payer: string },
    success: boolean,
  ): void {
    const { paymentTxHash, nonce, payer } = settlement;
    // nonce + payer name the PaymentRouter settlement; the registry verifies it
    // exists and refuses a self-paying owner, so a score cannot be minted.
    const input = { serviceId: service.id, nonce, payer, paymentTxHash, success };
    const signer = gateSignerFor(service);
    const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    const attempt = (n: number): void => {
      chain.recordAttestation(input, signer).then(
        (r) => {
          logger.info(n === 1 ? 'attestation_recorded' : 'attestation_recorded_on_retry', {
            ...input,
            attempt: n,
            txHash: r.txHash,
          });
          // Confirmed on-chain — drop it from the durable queue so it is not replayed.
          void attestations.remove(paymentTxHash);
        },
        (err: unknown) => {
          if (n >= attestationMaxAttempts) {
            // Leave it queued: a persistent queue replays it on the next boot; an
            // in-memory one drops it (under-count, never over-count).
            logger.error('attestation_failed_final', { ...input, attempts: n, error: msg(err) });
            return;
          }
          const retryInMs = attestationRetryDelayMs * 2 ** (n - 1);
          logger.warn('attestation_failed_retrying', {
            ...input,
            attempt: n,
            retryInMs,
            error: msg(err),
          });
          const timer = setTimeout(() => attempt(n + 1), retryInMs);
          timer.unref();
        },
      );
    };
    attempt(1);
  }

  /**
   * Enqueue a served+paid call for attestation (durably, when a queue path is
   * configured), then run the attempt loop. The enqueue happens before the first
   * on-chain attempt, so a crash mid-attest still leaves a replayable record.
   * Fire-and-forget — never blocks the buyer response (F7).
   */
  function scheduleAttestation(
    service: ServiceRecord,
    settlement: { paymentTxHash: string; nonce: string; payer: string },
    success: boolean,
  ): void {
    void attestations
      .enqueue({
        paymentTxHash: settlement.paymentTxHash,
        nonce: settlement.nonce,
        payer: settlement.payer,
        serviceId: service.id,
        success,
        enqueuedAt: Date.now(),
      })
      .then(() => runAttestation(service, settlement, success));
  }

  /**
   * Replay attestations persisted from a previous run that never confirmed (F7).
   * Idempotent on-chain (`seen_payments` dedup), so re-recording an already-scored
   * payment is a harmless no-op. Fire-and-forget on boot.
   */
  function replayPendingAttestations(): void {
    void attestations.list().then(async (pending) => {
      for (const p of pending) {
        const service = await services.get(p.serviceId).catch(() => null);
        if (service) {
          runAttestation(service, { paymentTxHash: p.paymentTxHash, nonce: p.nonce, payer: p.payer }, p.success);
        } else {
          logger.warn('attestation_replay_skipped_unknown_service', {
            serviceId: p.serviceId,
            paymentTxHash: p.paymentTxHash,
          });
        }
      }
    });
  }

  // ------------------------------------------------------------- rate limit

  app.use(
    '/svc',
    rateLimit({
      windowMs: 60_000,
      limit: SVC_RATE_LIMIT_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  );

  // Stricter limit on the admin API to blunt admin-token brute force.
  app.use(
    '/admin',
    rateLimit({
      windowMs: 60_000,
      limit: ADMIN_RATE_LIMIT_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  );

  // Self-service mapping is unauthenticated-by-token (auth is the owner
  // signature) — rate-limit it to blunt signature-spam / mapping churn.
  app.use(
    '/services',
    rateLimit({
      windowMs: 60_000,
      limit: SELF_MAP_RATE_LIMIT_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  );

  // ------------------------------------------------------- public endpoints

  // Liveness: the process is up. Cheap and dependency-free (for Docker/Railway).
  app.get('/healthz', (_req, res) => {
    // `attestor` is advertised so a seller can register with an attestor this
    // gateway is actually authorised to be. The registry reverts
    // recordAttestation for anyone who is neither the service's attestor nor
    // its owner, so a service registered against the wrong address takes
    // payments and never scores — and nothing tells the seller. Publishing the
    // address is safe: it is in every attestation this gateway writes on-chain.
    res.json({ ok: true, network: chain.network, attestor: gatewayAttestor });
  });

  // Readiness: the backing chain is reachable (bounded). Returns 503 when not,
  // so a load balancer can stop routing traffic to a gateway that can't serve.
  app.get(
    '/readyz',
    wrap(async (_req, res) => {
      try {
        if (chain.ping) await chain.ping();
        res.json({ ready: true, network: chain.network });
      } catch {
        res.status(503).json({ ready: false });
      }
    }),
  );

  // Public, unpaid metadata: service record + score + trust tier.
  app.get(
    '/svc/:id/meta',
    wrap(async (req, res) => {
      const id = parseServiceId(req.params.id);
      if (id === null) {
        res.status(404).json({ error: 'service_not_found' });
        return;
      }
      const service = await services.get(id);
      if (!service) {
        res.status(404).json({ error: 'service_not_found' });
        return;
      }
      const score = await chain.getScore(id);
      res.json({ service, score, trustTier: trustTier(score) });
    }),
  );

  // ---------------------------------------------------------------- paywall

  app.all(
    '/svc/:id',
    wrap(async (req, res) => {
      // 1. Resolve the service (60s cache).
      const id = parseServiceId(req.params.id);
      if (id === null) {
        res.status(404).json({ error: 'service_not_found' });
        return;
      }
      const service = await services.get(id);
      if (!service) {
        res.status(404).json({ error: 'service_not_found' });
        return;
      }
      if (!service.active) {
        res.status(403).json({ error: 'service_inactive' });
        return;
      }
      const upstreamUrl = upstreams.get(id);
      if (upstreamUrl === undefined) {
        // Registered on-chain but not mapped on this gateway — cannot serve,
        // and we must not charge for something we cannot deliver.
        res.status(503).json({ error: 'service_unavailable' });
        return;
      }

      // 1b. Reject a body we cannot forward BEFORE issuing/charging an invoice,
      //     so the buyer is never billed for a request the upstream can't receive.
      if (hasUnsupportedRequestBody(req)) {
        res.status(415).json({ error: 'unsupported_media_type' });
        return;
      }

      // 1c. Live-mode SSRF re-check at request time (defeats DNS rebinding of a
      //     host that was public at registration). Refuse before any payment.
      if (config.mode === 'live') {
        let host = '';
        try {
          host = new URL(upstreamUrl).hostname;
        } catch {
          host = '';
        }
        if (!(await resolvedHostIsPublic(host))) {
          logger.warn('upstream_host_forbidden', { serviceId: id });
          res.status(503).json({ error: 'service_unavailable' });
          return;
        }
      }

      const resource = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;

      // 2. No payment proof → fresh 402 challenge.
      const xPayment = req.header(HEADER_X_PAYMENT)?.trim() ?? '';
      if (xPayment === '') {
        await respond402Fresh(res, service, resource, 'X-PAYMENT header is required');
        return;
      }

      // 2b. Decode the proof (malformed → re-challenge, never 5xx).
      let payment;
      try {
        payment = decodeXPayment(xPayment);
      } catch {
        await respond402Fresh(res, service, resource, 'invalid_payment_header');
        return;
      }
      if (payment.network !== chain.network) {
        await respond402Fresh(res, service, resource, 'invalid_payment_header');
        return;
      }
      const txHashHeader = payment.payload.transaction;
      const nonceHeader = payment.payload.nonce;

      // 3. Validate the invoice behind the presented nonce.
      const invoice = await invoices.get(nonceHeader);
      if (!invoice || invoice.serviceId !== id) { await respond402Fresh(res, service, resource, 'unknown_nonce'); return; }
      if (invoice.used) { await respond402Fresh(res, service, resource, 'invoice_used'); return; }
      if (Date.now() > invoice.expiresAt) { await respond402Fresh(res, service, resource, 'invoice_expired'); return; }

      // 3b. Verify the on-chain transfer. serviceId binds this proof to THIS
      // service — PaymentRouter.seenNonce is keyed (serviceId, nonce), and
      // payment targets are shared across services, so nonce+payTo alone
      // cannot make that binding on their own.
      const verdict = await chain.verifyTransfer({
        txHash: txHashHeader,
        serviceId: service.id,
        expectedTarget: service.paymentTarget,
        minAmountWei: service.priceWei,
        expectedNonce: nonceHeader,
        maxAgeMs: config.invoiceTtlMs,
      });
      if (!verdict.ok) {
        if (verdict.reason === 'pending') {
          // Still settling: keep the SAME invoice alive so the buyer can
          // retry the identical proof after Retry-After seconds.
          send402(res, 'settlement_pending', buildRequirements(service, nonceHeader, invoice.expiresAt, resource), 2);
          return;
        }
        await respond402Fresh(res, service, resource, verdict.reason);
        return;
      }

      // 3c. Burn the nonce BEFORE proxying — single-use even if the upstream
      // fails, and exactly one concurrent request can win the race.
      const consumed = await invoices.markUsed(nonceHeader);
      if (!consumed) {
        await respond402Fresh(res, service, resource, 'invoice_used');
        return;
      }

      // 4. Proxy to the upstream (status/content-type passthrough; the
      //    upstream URL never appears in any response).
      const outcome = await proxyToUpstream({
        upstreamUrl,
        req,
        timeoutMs: config.upstreamTimeoutMs,
        followRedirects: config.mode !== 'live',
        pinToPublicIp: config.mode === 'live',
      });
      const success = isUpstreamSuccess(outcome);

      // 5. Respond to the buyer first, then attest asynchronously.
      // Always set the settlement confirmation header (payment was processed).
      res.set(
        HEADER_X_PAYMENT_RESPONSE,
        encodeXPaymentResponse({
          success: true,
          transaction: txHashHeader,
          network: chain.network,
          payer: verdict.from,
        }),
      );
      if (outcome.kind === 'response') {
        res.status(outcome.status);
        if (outcome.contentType) res.set('Content-Type', outcome.contentType);
        res.send(outcome.body);
      } else {
        logger.warn('proxy_failed', { serviceId: id, error: outcome.error });
        res.status(outcome.status).json({ error: outcome.error });
      }

      // Attest only when the upstream actually returned a response (F4): a
      // gateway-level failure (upstream_unreachable/upstream_timeout/too_large)
      // is the seller's backend being unreachable, not a service outcome, so it
      // is not scored either way. And never let a self-paid call earn trust
      // (F1): a payer that is the owner or the payout account is wash-trading.
      const selfPaid = isSelfPayment(verdict.from, service);
      if (outcome.kind === 'response' && !selfPaid) {
        scheduleAttestation(
          service,
          { paymentTxHash: txHashHeader, nonce: nonceHeader, payer: verdict.from },
          success,
        );
      } else {
        logger.info('attestation_skipped', {
          serviceId: id,
          reason: selfPaid ? 'self_payment' : outcome.kind === 'failure' ? outcome.error : 'skipped',
        });
      }
    }),
  );

  // -------------------------------------------------------------- admin API

  const adminAuth: RequestHandler = (req, res, next) => {
    const header = req.header('authorization') ?? '';
    if (!safeEqual(header, `Bearer ${config.adminToken}`)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  app.post(
    '/admin/services',
    adminAuth,
    wrap(async (req, res) => {
      const body: unknown = req.body;
      if (body === null || typeof body !== 'object') {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      const { serviceId, upstreamUrl } = body as { serviceId?: unknown; upstreamUrl?: unknown };
      if (typeof serviceId !== 'number' || !Number.isSafeInteger(serviceId) || serviceId < 0) {
        res.status(400).json({ error: 'invalid_service_id' });
        return;
      }
      const verdict = validateUpstreamUrl(upstreamUrl, {
        rejectPrivateHosts: config.mode === 'live', // SSRF guard (live only; mock allows localhost demos)
      });
      if (!verdict.ok) {
        res.status(400).json({ error: verdict.error });
        return;
      }
      await upstreams.set(serviceId, verdict.url.toString());
      logger.info('upstream_mapped', { serviceId });
      res.status(204).end();
    }),
  );

  app.get('/admin/services', adminAuth, (_req, res) => {
    res.json(upstreams.list());
  });

  app.delete(
    '/admin/services/:id',
    adminAuth,
    wrap(async (req, res) => {
      const id = parseServiceId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'invalid_service_id' });
        return;
      }
      await upstreams.delete(id);
      logger.info('upstream_unmapped', { serviceId: id });
      res.status(204).end();
    }),
  );

  // -------------------------------------------- self-service mapping (no token)
  //
  // A service OWNER maps their upstream by signing a canonical challenge with
  // the key whose address equals the on-chain `owner` — no shared admin
  // token needed. This is what lets a one-line `agentgate wrap` run against a
  // hosted gateway in one line. Ordering is DoS-conscious: cheap rejects first,
  // the signature/owner check only after the service is known to exist, and the
  // SSRF check only for a verified owner.
  const lastSelfMapTs = new Map<number, number>();

  app.post(
    '/services/:id/map',
    wrap(async (req, res) => {
      const id = parseServiceId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'invalid_service_id' });
        return;
      }
      const body: unknown = req.body;
      if (body === null || typeof body !== 'object') {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      const { upstreamUrl, timestamp, signatureHex } = body as {
        upstreamUrl?: unknown;
        timestamp?: unknown;
        signatureHex?: unknown;
      };
      if (
        typeof upstreamUrl !== 'string' ||
        typeof signatureHex !== 'string' ||
        typeof timestamp !== 'number' ||
        !Number.isSafeInteger(timestamp)
      ) {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }

      // Freshness — bounds replay independently of the per-service guard below.
      if (Math.abs(Date.now() - timestamp) > SELF_MAP_WINDOW_MS) {
        res.status(401).json({ error: 'stale_request' });
        return;
      }

      const service = await services.get(id);
      if (!service) {
        res.status(404).json({ error: 'service_not_found' });
        return;
      }

      // Recover the signer from the EIP-191 signature over the RAW transmitted
      // upstreamUrl (byte-identical to what the owner signed), then bind it to
      // the on-chain owner. Recovery succeeding proves NOTHING by itself — every
      // well-formed signature recovers to *some* address — so the address
      // comparison is the actual authorization check. Both failure modes (bad
      // signature vs. valid signature from a non-owner) collapse to the same
      // response so neither leaks which case occurred.
      const message = buildSelfMapMessage({
        network: chain.network,
        serviceId: id,
        upstreamUrl,
        timestamp,
      });
      const { address, valid } = await recoverSigner(message, signatureHex);
      if (!valid || !sameAddress(address, service.owner)) {
        res.status(401).json({ error: 'not_service_owner' });
        return;
      }

      // Per-service monotonic timestamp — reject stale/replayed authorized requests.
      const last = lastSelfMapTs.get(id);
      if (last !== undefined && timestamp <= last) {
        res.status(409).json({ error: 'replayed' });
        return;
      }

      // SSRF guard — same as the admin path; only reached for a verified owner.
      const verdict = validateUpstreamUrl(upstreamUrl, {
        rejectPrivateHosts: config.mode === 'live',
      });
      if (!verdict.ok) {
        res.status(400).json({ error: verdict.error });
        return;
      }

      lastSelfMapTs.set(id, timestamp);
      await upstreams.set(id, verdict.url.toString());
      logger.info('self_mapped', { serviceId: id });
      res.status(204).end();
    }),
  );

  // ------------------------------------------------------ fallbacks & errors

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Final error handler: structured, generic, never leaks internals/upstreams.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const httpError = err as { type?: string; status?: number };
    if (httpError.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (httpError.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    if (err instanceof AgentGateError) {
      logger.error('request_failed', { code: err.code, message: err.message });
      res.status(err.httpStatus).json({ error: err.code.toLowerCase() });
      return;
    }
    logger.error('request_failed', {
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    res.status(500).json({ error: 'internal_error' });
  });

  // Handles for startServer()'s graceful shutdown.
  const internals: AppInternals = {
    async dispose(): Promise<void> {
      if (ownsInvoiceStore) invoices.close();
      if (ownsAttestationQueue) attestations.close();
      await upstreams.flush();
    },
  };
  app.locals['agentgate'] = internals;

  // Replay any attestations left pending by a previous run (F7). Fire-and-forget;
  // idempotent on-chain, so it is safe even if the previous run partially recorded.
  replayPendingAttestations();

  return app;
}
