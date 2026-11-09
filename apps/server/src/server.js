import dns from 'node:dns';
import net from 'node:net';
// Some hosts (WSL, containers, Render) resolve IPv6 first and then hang on the Stellar RPC.
// Prefer IPv4 here so the server does not depend on a NODE_OPTIONS setting.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily?.(false);

import dotenv from 'dotenv';
import express from 'express';
import { Velo } from '@carts1024/velo-sdk';
import { runDeliveryAgent, noirReadiness } from '../../../packages/agent/src/index.js';
import { DELIVERY_POLICY } from '../../../packages/shared/src/index.js';
import { openStore } from './store.js';
import { createDeviceRegistry, createSimulatedDevice } from './device.js';
import { createSettlement } from './settlement.js';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: resolve(projectRoot, '.env') });

const app = express();
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 4173);
const webDist = resolve(projectRoot, 'apps/web/dist');

// ---- Storage (SQLite). Falls back to memory if the disk is not writable.
const dataDir = process.env.DATA_DIR?.trim() || resolve(projectRoot, 'data');
let store;
let storageMode = 'file';
try {
  store = openStore(resolve(dataDir, 'aeropay.db'));
} catch (error) {
  console.error('Could not open the SQLite file, using memory only:', error?.message);
  store = openStore(':memory:');
  storageMode = 'memory';
}

// ---- Device registry + simulated tag
const configuredDeviceHash = (process.env.DEVICE_HASH?.trim().replace(/^0x/i, '') || '').toLowerCase();
const registry = createDeviceRegistry();
let simulatedDevice = null;
if (/^[a-f\d]{64}$/.test(configuredDeviceHash)) {
  simulatedDevice = createSimulatedDevice({ deviceHash: configuredDeviceHash, seed: process.env.DEVICE_SIM_SEED?.trim() || '' });
  registry.register(configuredDeviceHash, simulatedDevice.publicKeyHex);
}

// ---- Noir helpers
async function noirClient() {
  const sdk = await import('@noirx402/agent-sdk');
  return { sdk, noir: new sdk.NoirAgentClient() };
}
const merchantSecretOk = /^S[A-Z2-7]{55}$/.test(process.env.MERCHANT_SECRET?.trim() || '');
async function claimAsMerchant() {
  const { sdk, noir } = await noirClient();
  return noir.claim({ merchant: sdk.keypairSigner(process.env.MERCHANT_SECRET.trim()), token: process.env.ASSET_CONTRACT_ID.trim() });
}
async function getPendingBalance() {
  const merchant = process.env.MERCHANT_ADDRESS?.trim();
  if (!/^G[A-Z2-7]{55}$/.test(merchant || '')) return null;
  const { sdk, noir } = await noirClient();
  return sdk.fromStroops(await noir.getPendingBalance(merchant));
}

function getVelo() {
  const apiKey = process.env.VELO_API_KEY?.trim();
  if (!apiKey) throw new Error('VELO_NOT_CONFIGURED');
  return new Velo({ apiKey, environment: 'testnet', timeoutMs: 10_000 });
}

function isVeloPaymentConfirmed(status) {
  return ['paid', 'succeeded'].includes(String(status || '').toLowerCase());
}

const settlement = createSettlement({
  store,
  registry,
  runAgent: runDeliveryAgent,
  getVeloPayment: (paymentIntentId) => getVelo().paymentIntents.retrieve(paymentIntentId),
  claimAsMerchant: merchantSecretOk && process.env.MERCHANT_ADDRESS ? claimAsMerchant : null,
  getPendingBalance,
});
settlement.recoverStale();
setInterval(() => { settlement.pollWaiting().catch((error) => console.error('Agent poll failed:', error?.message)); }, 5000).unref();

// ---- Tiny per-IP rate limit for the device endpoints
const hits = new Map();
function rateLimit(limit, windowMs = 60_000) {
  return (request, response, next) => {
    const key = `${request.path}:${request.ip}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) { hits.set(key, { start: now, count: 1 }); return next(); }
    entry.count += 1;
    if (entry.count > limit) return response.status(429).json({ error: 'Too many requests. Slow down.' });
    return next();
  };
}

app.get('/api/health', (_request, response) => {
  const noir = noirReadiness();
  response.json({
    app: 'AeroPay',
    network: 'Stellar Testnet',
    deliveryPolicy: DELIVERY_POLICY,
    velo: {
      configured: Boolean(process.env.VELO_API_KEY?.trim()),
      webhookConfigured: Boolean(process.env.VELO_WEBHOOK_SECRET?.trim()),
      checkoutAsset: process.env.VELO_CHECKOUT_ASSET || 'USDC',
      checkoutAmount: process.env.VELO_CHECKOUT_AMOUNT || '1.00',
    },
    noir: {
      configured: noir.ready,
      missing: noir.missing,
      payoutAmount: process.env.PAYMENT_AMOUNT || null,
      payoutAssetLabel: process.env.PAYMENT_ASSET_LABEL || 'configured Testnet asset',
    },
    device: {
      registered: Boolean(simulatedDevice),
      publicKey: simulatedDevice?.publicKeyHex || null,
      signing: 'Ed25519 (simulated tag)',
    },
    merchantClaim: { configured: merchantSecretOk, address: process.env.MERCHANT_ADDRESS || null },
    storage: { mode: storageMode, engine: 'sqlite' },
    autonomy: 'The agent acts on verified device readings; there is no manual pay button.',
  });
});

app.post('/api/velo/checkout', express.json({ limit: '12kb' }), async (request, response) => {
  const { shipmentId, idempotencyKey } = request.body ?? {};
  if (typeof shipmentId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(shipmentId)) {
    return response.status(400).json({ error: 'A valid shipmentId is required.' });
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{12,120}$/.test(idempotencyKey)) {
    return response.status(400).json({ error: 'A stable idempotencyKey is required.' });
  }
  if (!process.env.VELO_API_KEY?.trim()) {
    return response.status(503).json({ error: 'Add a Testnet VELO_API_KEY to the server .env file.' });
  }
  const existingCheckout = store.checkoutByShipment(shipmentId);
  if (existingCheckout) {
    return response.status(200).json({
      checkoutUrl: existingCheckout.checkoutUrl,
      paymentIntentId: existingCheckout.paymentIntentId,
      shipmentId,
      amount: existingCheckout.amount,
      asset: existingCheckout.asset,
      network: 'Stellar Testnet',
    });
  }

  const amount = process.env.VELO_CHECKOUT_AMOUNT?.trim() || '1.00';
  const asset = process.env.VELO_CHECKOUT_ASSET?.trim() || 'USDC';
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
    return response.status(500).json({ error: 'VELO_CHECKOUT_AMOUNT must be a positive decimal amount.' });
  }
  if (!/^[A-Za-z0-9_-]{2,16}$/.test(asset)) {
    return response.status(500).json({ error: 'VELO_CHECKOUT_ASSET is invalid.' });
  }

  const appBase = process.env.APP_BASE_URL?.trim()
    || process.env.RENDER_EXTERNAL_URL?.trim()
    || 'http://localhost:5173';
  let successUrl;
  let cancelUrl;
  try {
    const base = new URL(appBase);
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid protocol');
    successUrl = new URL('/', base);
    successUrl.searchParams.set('velo', 'return');
    successUrl.searchParams.set('shipmentId', shipmentId);
    cancelUrl = new URL('/', base);
    cancelUrl.searchParams.set('velo', 'cancel');
    cancelUrl.searchParams.set('shipmentId', shipmentId);
  } catch {
    return response.status(500).json({ error: 'APP_BASE_URL must be a valid public HTTP(S) app URL.' });
  }

  try {
    const session = await getVelo().checkout.sessions.create({
      amount,
      asset,
      description: `AeroPay delivery booking ${shipmentId}`,
      successUrl: successUrl.toString(),
      cancelUrl: cancelUrl.toString(),
    }, { idempotencyKey });
    store.saveCheckout({
      shipmentId,
      paymentIntentId: session.paymentIntentId,
      checkoutUrl: session.checkoutUrl,
      amount,
      asset,
    });
    store.addEvent(shipmentId, 'velo.checkout', `Velo booking checkout created: ${amount} ${asset} on Testnet.`, { paymentIntentId: session.paymentIntentId });
    return response.status(201).json({
      checkoutUrl: session.checkoutUrl,
      paymentIntentId: session.paymentIntentId,
      shipmentId,
      amount,
      asset,
      network: 'Stellar Testnet',
    });
  } catch (error) {
    if (error?.message === 'VELO_NOT_CONFIGURED') {
      return response.status(503).json({ error: 'Add a Testnet VELO_API_KEY to the server .env file.' });
    }
    console.error('Velo checkout creation failed:', error?.name || 'Error');
    return response.status(502).json({ error: 'Velo could not create the checkout session. Check the server logs and Velo Testnet project.' });
  }
});

app.get('/api/velo/payments/:paymentIntentId', async (request, response) => {
  const { paymentIntentId } = request.params;
  if (!/^pi_[A-Za-z0-9_-]{4,120}$/.test(paymentIntentId)) {
    return response.status(400).json({ error: 'Invalid Velo payment intent ID.' });
  }
  const checkout = store.checkoutByIntent(paymentIntentId);
  if (!checkout) return response.status(404).json({ error: 'This server has not created that AeroPay checkout.' });
  try {
    const payment = await getVelo().paymentIntents.retrieve(paymentIntentId);
    store.setCheckoutStatus(paymentIntentId, payment.status);
    return response.json({
      paymentIntentId: payment.id,
      shipmentId: checkout.shipmentId,
      status: payment.status,
      amount: payment.amount,
      asset: payment.asset,
      payerAddress: payment.payerAddress || null,
      checkedAgainstLedger: true,
    });
  } catch (error) {
    console.error('Velo payment retrieval failed:', error?.name || 'Error');
    return response.status(502).json({ error: 'Velo could not retrieve the payment status.' });
  }
});

app.get('/api/velo/shipments/:shipmentId', async (request, response) => {
  const checkout = store.checkoutByShipment(request.params.shipmentId);
  if (!checkout) return response.status(404).json({ status: 'not_started', shipmentId: request.params.shipmentId });
  try {
    const payment = await getVelo().paymentIntents.retrieve(checkout.paymentIntentId);
    store.setCheckoutStatus(checkout.paymentIntentId, payment.status);
    if (isVeloPaymentConfirmed(payment.status)) settlement.settle(checkout.shipmentId).catch(() => {});
    return response.json({
      shipmentId: checkout.shipmentId,
      paymentIntentId: payment.id,
      status: payment.status,
      amount: payment.amount,
      asset: payment.asset,
      confirmed: isVeloPaymentConfirmed(payment.status),
      checkedAgainstLedger: true,
    });
  } catch (error) {
    console.error('Velo shipment status retrieval failed:', error?.name || 'Error');
    return response.status(502).json({ error: 'Velo could not retrieve the booking status.' });
  }
});

// Keep this route before express.json: Velo verification needs the exact raw body.
app.post('/api/webhooks/velo', express.raw({ type: 'application/json', limit: '64kb' }), async (request, response) => {
  const secret = process.env.VELO_WEBHOOK_SECRET?.trim();
  if (!secret) return response.status(503).send('Webhook signing secret is not configured.');
  const deliveryId = request.get('x-velo-delivery');
  if (!deliveryId || deliveryId.length > 180) return response.status(400).send('Missing Velo delivery ID.');
  if (!Buffer.isBuffer(request.body)) return response.status(400).send('Expected a raw JSON request body.');

  try {
    const event = await Velo.webhooks.verify({
      payload: request.body.toString('utf8'),
      signature: request.get('x-velo-signature') || null,
      secret,
    });
    const intentId = event.paymentIntent?.id || null;
    if (store.recordDelivery(deliveryId, event.type, intentId) && intentId) {
      const checkout = store.checkoutByIntent(intentId);
      if (checkout) {
        const status = event.type === 'payment.succeeded' ? 'succeeded' : event.type === 'payment.failed' ? 'failed' : checkout.paymentStatus;
        store.setCheckoutStatus(intentId, status);
        store.addEvent(checkout.shipmentId, 'velo.webhook', `Velo webhook received: ${event.type}.`, { type: event.type });
        if (status === 'succeeded') settlement.settle(checkout.shipmentId).catch(() => {});
      }
    }
    return response.status(200).send('OK');
  } catch {
    return response.status(400).send('Velo webhook signature verification failed.');
  }
});

app.get('/api/velo/events', (_request, response) => {
  response.json({ events: store.recentDeliveries() });
});

// A verified device reading is what wakes the agent. Anyone can POST here, but only readings
// signed by a registered device are accepted (see device.js).
app.post('/api/telemetry', rateLimit(60), express.json({ limit: '4kb' }), async (request, response) => {
  const result = await settlement.ingestReading(request.body);
  return response.status(result.status).json(result.body);
});

// Demo helper: the simulated tag signs a reading and sends it through the same verified path.
app.post('/api/demo/device-reading', rateLimit(30), express.json({ limit: '4kb' }), async (request, response) => {
  if (!simulatedDevice) {
    return response.status(503).json({ error: 'The simulated device needs a valid DEVICE_HASH on the server.', missing: ['DEVICE_HASH'] });
  }
  const { shipmentId, temperatureC, checkpointMatched, scenario = 'success' } = request.body ?? {};
  if (typeof shipmentId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(shipmentId)) {
    return response.status(400).json({ error: 'A valid shipmentId is required.' });
  }
  if (!Number.isFinite(Number(temperatureC)) || typeof checkpointMatched !== 'boolean') {
    return response.status(400).json({ error: 'A numeric temperatureC and boolean checkpointMatched are required.' });
  }
  if (!['success', 'breach', 'overcap'].includes(scenario)) {
    return response.status(400).json({ error: 'scenario must be success, breach, or overcap.' });
  }
  const signed = simulatedDevice.signReading({ shipmentId, temperatureC: Number(temperatureC), checkpointMatched });
  const result = await settlement.ingestReading({ ...signed, scenario });
  return response.status(result.status).json({ ...result.body, signedBy: simulatedDevice.publicKeyHex });
});

// Live activity feed for one shipment. The page polls this; it also restores state after a reload.
app.get('/api/shipments/:shipmentId/events', (request, response) => {
  const { shipmentId } = request.params;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(shipmentId)) return response.status(400).json({ error: 'Invalid shipment ID.' });
  const after = Math.max(0, Number.parseInt(String(request.query.after ?? '0'), 10) || 0);
  const run = store.getRun(shipmentId);
  const checkout = store.checkoutByShipment(shipmentId);
  response.json({
    shipmentId,
    events: store.eventsAfter(shipmentId, after),
    run: run ? { state: run.state, result: run.result } : null,
    booking: checkout ? { paymentStatus: checkout.paymentStatus, amount: checkout.amount, asset: checkout.asset } : null,
  });
});

app.get('/api/noir/pending', async (_request, response) => {
  try {
    const pending = await getPendingBalance();
    return response.json({ pending, label: process.env.PAYMENT_ASSET_LABEL || 'XLM', merchant: process.env.MERCHANT_ADDRESS || null, claimConfigured: merchantSecretOk });
  } catch (error) {
    console.error('Pending balance read failed:', error?.message);
    return response.status(502).json({ error: 'Could not read the pending balance from Noir.' });
  }
});

app.post('/api/shipments/:shipmentId/claim', rateLimit(10), async (request, response) => {
  const { shipmentId } = request.params;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(shipmentId)) return response.status(400).json({ error: 'Invalid shipment ID.' });
  const result = await settlement.claim(shipmentId);
  return response.status(result.status).json(result.body);
});

app.get('/api/agent/shipments/:shipmentId', (request, response) => {
  const run = store.getRun(request.params.shipmentId);
  if (!run) return response.status(404).json({ error: 'No agent decision is recorded for that shipment.' });
  return response.json({ shipmentId: request.params.shipmentId, state: run.state, ...run.result });
});

app.use(express.json({ limit: '20kb' }));
if (existsSync(webDist)) {
  app.use(express.static(webDist, { index: 'index.html', maxAge: '1h' }));
  app.get(/.*/, (request, response, next) => {
    if (request.path.startsWith('/api/')) return next();
    return response.sendFile(resolve(webDist, 'index.html'));
  });
}

app.use((error, _request, response, _next) => {
  if (error?.type === 'entity.too.large') return response.status(413).json({ error: 'Request body is too large.' });
  console.error('Unhandled request error:', error?.name || 'Error');
  return response.status(500).json({ error: 'Unexpected server error.' });
});

const server = createServer(app);
server.listen(port, '0.0.0.0', () => {
  console.log(`AeroPay server listening on port ${port} · Stellar Testnet`);
});
