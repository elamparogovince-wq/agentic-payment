import { evaluateDeliveryEvidence } from '../../../packages/shared/src/index.js';

const NOIR_TIMEOUT_MS = 90_000;

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const isConfirmed = (status) => ['paid', 'succeeded'].includes(String(status || '').toLowerCase());

/**
 * The autonomous agent loop.
 * Nothing here is triggered by a "pay" button: a verified device reading (and a
 * confirmed Velo booking) is what makes the agent act. Every step is written to the
 * event log, and a shipment can only ever be settled once.
 */
export function createSettlement({ store, registry, runAgent, getVeloPayment, claimAsMerchant, getPendingBalance, timeoutMs = NOIR_TIMEOUT_MS }) {
  const inFlight = new Set();
  const log = (shipmentId, type, message, data) => store.addEvent(shipmentId, type, message, data);

  async function ingestReading(raw) {
    const checked = registry.verifyReading(raw);
    if (!checked.ok) return { status: checked.status, body: { accepted: false, error: checked.error } };
    const { reading } = checked;
    const run = store.getRun(reading.shipmentId);
    if (run && run.state !== 'waiting') {
      return { status: 409, body: { accepted: false, settled: true, error: 'This shipment is already settled. Start a new shipment to try again.' } };
    }
    const scenario = ['success', 'breach', 'overcap'].includes(raw.scenario) ? raw.scenario : 'success';
    const saved = store.saveReading({ ...reading, scenario });
    if (!saved) return { status: 409, body: { accepted: false, error: 'This reading was already received (replay rejected).' } };
    log(reading.shipmentId, 'telemetry.accepted',
      `Signed reading verified: ${reading.temperatureC.toFixed(1)}°C, checkpoint ${reading.checkpointMatched ? 'reached' : 'not reached'}.`,
      { temperatureC: reading.temperatureC, checkpointMatched: reading.checkpointMatched, deviceHash: reading.deviceHash, signature: reading.signature, scenario });
    const settled = settle(reading.shipmentId);
    return { status: 202, body: { accepted: true, shipmentId: reading.shipmentId }, settled };
  }

  async function settle(shipmentId) {
    if (inFlight.has(shipmentId)) return;
    inFlight.add(shipmentId);
    try {
      const reading = store.latestReading(shipmentId);
      if (!reading) return;
      const existing = store.getRun(shipmentId);
      if (existing && existing.state !== 'waiting') return; // already settled or being settled

      const evidence = evaluateDeliveryEvidence(reading);
      const needsBooking = reading.scenario === 'success' && evidence.allowed;
      if (needsBooking) {
        const checkout = store.checkoutByShipment(shipmentId);
        let status = checkout?.paymentStatus;
        if (checkout && !isConfirmed(status)) {
          try { status = (await getVeloPayment(checkout.paymentIntentId)).status; } catch { status = 'unreachable'; }
          store.setCheckoutStatus(checkout.paymentIntentId, status);
        }
        if (!checkout || !isConfirmed(status)) {
          if (!existing) {
            log(shipmentId, 'agent.waiting',
              checkout ? `Velo has not confirmed the booking yet (${status}). The agent will pay as soon as it does.` : 'No Velo booking yet. The agent is holding the payout until the booking is paid.',
              { decision: 'waiting_for_velo', paymentSubmitted: false, veloStatus: status || 'not_started', reason: 'Waiting for the Velo booking to be confirmed. No Noir payout was sent.' });
          }
          store.markWaiting(shipmentId);
          return;
        }
        log(shipmentId, 'velo.confirmed', 'Velo confirmed the booking payment on the Stellar ledger.', { status });
      }

      if (!store.claimRun(shipmentId)) return;
      log(shipmentId, 'agent.checking', 'Agent is checking the evidence and the Noir policy.', null);
      try {
        const result = await withTimeout(
          runAgent({ temperatureC: reading.temperatureC, checkpointMatched: reading.checkpointMatched, scenario: reading.scenario }, { authorize: true }),
          timeoutMs, 'Noir call');
        const payload = { shipmentId, ...result };
        if (result.decision === 'needs_setup') {
          store.releaseRun(shipmentId);
          log(shipmentId, 'agent.needs_setup', 'The Noir agent is not configured on this server.', payload);
          return;
        }
        store.finishRun(shipmentId, result.decision, payload);
        if (result.decision === 'authorized') log(shipmentId, 'agent.authorized', `Agent authorized ${result.amount} on Stellar Testnet.`, payload);
        else log(shipmentId, 'agent.denied', result.reason || 'The agent refused the payment.', payload);
      } catch (error) {
        const payload = {
          shipmentId, decision: 'unknown', paymentSubmitted: 'unknown',
          reason: 'No confirmed result was returned. Check the Testnet ledger before retrying this shipment.',
        };
        console.error('Noir agent operation returned an error:', error?.message || error?.name || 'Error');
        store.finishRun(shipmentId, 'unknown', payload);
        log(shipmentId, 'agent.unknown', payload.reason, payload);
      }
    } finally {
      inFlight.delete(shipmentId);
    }
  }

  /** Called on a timer: retries shipments the agent is holding because Velo was not confirmed yet. */
  async function pollWaiting() {
    for (const shipmentId of store.waitingShipments()) await settle(shipmentId);
  }

  /** A process that died mid-payment cannot know whether the transaction landed. */
  function recoverStale() {
    for (const shipmentId of store.staleProcessing()) {
      const payload = { shipmentId, decision: 'unknown', paymentSubmitted: 'unknown', reason: 'The server restarted while this payment was in progress. Check the Testnet ledger before retrying.' };
      store.finishRun(shipmentId, 'unknown', payload);
      log(shipmentId, 'agent.unknown', payload.reason, payload);
    }
  }

  async function claim(shipmentId) {
    const run = store.getRun(shipmentId);
    if (run?.state !== 'authorized') return { status: 409, body: { error: 'There is no authorized payout to claim for this shipment.' } };
    if (run.result.claimTransactionHash) return { status: 200, body: { alreadyClaimed: true, transactionHash: run.result.claimTransactionHash } };
    if (!claimAsMerchant) return { status: 503, body: { error: 'The merchant key is not configured on this server. Claim with the merchant wallet or run: npm run merchant:claim', needsMerchantKey: true } };
    try {
      const { hash } = await withTimeout(claimAsMerchant(), timeoutMs, 'Noir claim');
      store.finishRun(shipmentId, 'authorized', { ...run.result, claimTransactionHash: hash });
      log(shipmentId, 'merchant.claimed', 'The merchant claimed the pending balance on Stellar Testnet.', { transactionHash: hash });
      return { status: 200, body: { transactionHash: hash } };
    } catch (error) {
      console.error('Merchant claim failed:', error?.message || error?.name || 'Error');
      const nothing = /NothingToClaim/i.test(String(error?.message));
      return { status: nothing ? 409 : 502, body: { error: nothing ? 'Nothing is pending to claim.' : 'The claim did not complete. Check the Testnet ledger before retrying.' } };
    }
  }

  return { ingestReading, settle, pollWaiting, recoverStale, claim, getPendingBalance };
}
