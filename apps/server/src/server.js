import dotenv from 'dotenv';
import express from 'express';
import { Velo } from '@carts1024/velo-sdk';
import { runDeliveryAgent, noirReadiness } from '../../../packages/agent/src/index.js';
import { DELIVERY_POLICY, evaluateDeliveryEvidence } from '../../../packages/shared/src/index.js';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: resolve(projectRoot, '.env') });

const app = express();
const port = Number(process.env.PORT || 4173);
const webDist = resolve(projectRoot, 'apps/web/dist');
const recentWebhooks = [];
const seenDeliveries = new Set();
const checkouts = new Map();
const checkoutByShipment = new Map();
const settlementRuns = new Map();
const RECENT_LIMIT = 40;

function getVelo() {
  const apiKey = process.env.VELO_API_KEY?.trim();
  if (!apiKey) throw new Error('VELO_NOT_CONFIGURED');
  return new Velo({ apiKey, environment: 'testnet', timeoutMs: 10_000 });
}

function addWebhookRecord(record) {
  recentWebhooks.unshift(record);
  if (recentWebhooks.length > RECENT_LIMIT) recentWebhooks.length = RECENT_LIMIT;
}

function isVeloPaymentConfirmed(status) {
  return ['paid', 'succeeded'].includes(String(status || '').toLowerCase());
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
  const existingCheckout = checkoutByShipment.get(shipmentId);
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
    const checkout = {
      shipmentId,
      paymentIntentId: session.paymentIntentId,
      checkoutUrl: session.checkoutUrl,
      amount,
      asset,
      paymentStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    checkouts.set(session.paymentIntentId, checkout);
    checkoutByShipment.set(shipmentId, checkout);
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
  const checkout = checkouts.get(paymentIntentId);
  if (!checkout) return response.status(404).json({ error: 'This server has not created that AeroPay checkout.' });
  try {
    const payment = await getVelo().paymentIntents.retrieve(paymentIntentId);
    checkout.paymentStatus = payment.status;
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
  const checkout = checkoutByShipment.get(request.params.shipmentId);
  if (!checkout) return response.status(404).json({ status: 'not_started', shipmentId: request.params.shipmentId });
  try {
    const payment = await getVelo().paymentIntents.retrieve(checkout.paymentIntentId);
    checkout.paymentStatus = payment.status;
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
    if (!seenDeliveries.has(deliveryId)) {
      seenDeliveries.add(deliveryId);
      const intentId = event.paymentIntent?.id || null;
      const checkout = intentId ? checkouts.get(intentId) : null;
      addWebhookRecord({
        deliveryId,
        type: event.type,
        paymentIntentId: intentId,
        shipmentId: checkout?.shipmentId || null,
        receivedAt: new Date().toISOString(),
      });
      if (intentId && checkouts.has(intentId)) {
        const checkout = checkouts.get(intentId);
        checkout.paymentStatus = event.type === 'payment.succeeded'
          ? 'succeeded'
          : event.type === 'payment.failed'
            ? 'failed'
            : checkout.paymentStatus;
      }
    }
    return response.status(200).send('OK');
  } catch {
    return response.status(400).send('Velo webhook signature verification failed.');
  }
});

app.get('/api/velo/events', (_request, response) => {
  response.json({ events: recentWebhooks });
});

app.post('/api/agent/deliver', express.json({ limit: '12kb' }), async (request, response) => {
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
  const runKey = `${shipmentId}:${scenario}`;
  if (settlementRuns.has(runKey)) {
    return response.status(409).json({ error: 'The agent already processed this shipment ID. Use a new shipment ID for a new attempt.' });
  }

  settlementRuns.set(runKey, { state: 'processing', shipmentId, scenario, startedAt: new Date().toISOString() });
  try {
    const evidence = evaluateDeliveryEvidence({ temperatureC, checkpointMatched });
    if (scenario === 'success' && evidence.allowed) {
      const checkout = checkoutByShipment.get(shipmentId);
      if (!checkout) {
        settlementRuns.delete(runKey);
        return response.status(409).json({
          shipmentId,
          decision: 'waiting_for_velo',
          paymentSubmitted: false,
          reason: 'Create and pay the Velo Testnet booking checkout before releasing the Noir carrier payout.',
        });
      }
      const payment = await getVelo().paymentIntents.retrieve(checkout.paymentIntentId);
      checkout.paymentStatus = payment.status;
      if (!isVeloPaymentConfirmed(payment.status)) {
        settlementRuns.delete(runKey);
        return response.status(409).json({
          shipmentId,
          decision: 'waiting_for_velo',
          paymentSubmitted: false,
          veloStatus: payment.status,
          reason: `Velo has not confirmed the booking yet (status: ${payment.status}). No Noir payout was sent.`,
        });
      }
    }
    const result = await runDeliveryAgent({ temperatureC, checkpointMatched, scenario }, { authorize: true });
    if (result.decision === 'needs_setup') settlementRuns.delete(runKey);
    else settlementRuns.set(runKey, { ...result, shipmentId, scenario, finishedAt: new Date().toISOString() });
    return response.status(result.decision === 'needs_setup' ? 503 : 200).json({ shipmentId, ...result });
  } catch (error) {
    settlementRuns.set(runKey, {
      decision: 'unknown',
      shipmentId,
      scenario,
      paymentSubmitted: 'unknown',
      reason: 'The agent call did not return a confirmed result. Check the Testnet ledger before retrying.',
      finishedAt: new Date().toISOString(),
    });
    console.error('Noir agent operation returned an error:', error?.name || 'Error');
    return response.status(502).json({
      shipmentId,
      decision: 'unknown',
      paymentSubmitted: 'unknown',
      reason: 'No confirmed result was returned. Check the Testnet ledger before retrying this shipment.',
    });
  }
});

app.get('/api/agent/shipments/:shipmentId', (request, response) => {
  const result = [...settlementRuns.values()].find((entry) => entry.shipmentId === request.params.shipmentId);
  if (!result) return response.status(404).json({ error: 'No agent decision is recorded for that shipment.' });
  return response.json({ shipmentId: request.params.shipmentId, ...result });
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
