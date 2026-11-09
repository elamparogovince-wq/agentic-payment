import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createSimulatedDevice, createDeviceRegistry } from '../src/device.js';
import { createSettlement } from '../src/settlement.js';

const DEVICE_HASH = 'a'.repeat(64);

function setup({ veloStatus = 'pending', agent } = {}) {
  const store = openStore(':memory:');
  const device = createSimulatedDevice({ deviceHash: DEVICE_HASH, seed: 'test-seed' });
  const registry = createDeviceRegistry();
  registry.register(DEVICE_HASH, device.publicKeyHex);
  const state = { veloStatus, agentCalls: 0, claimCalls: 0 };
  const settlement = createSettlement({
    store, registry,
    runAgent: agent ?? (async (input) => {
      state.agentCalls += 1;
      return { decision: 'authorized', mode: 'test', paymentSubmitted: true, amount: '2.00', merchant: 'GTEST', transactionHash: 'ab'.repeat(32), evidence: input };
    }),
    getVeloPayment: async () => ({ status: state.veloStatus }),
    claimAsMerchant: async () => { state.claimCalls += 1; return { hash: 'cd'.repeat(32) }; },
    getPendingBalance: async () => 0n,
    timeoutMs: 2000,
  });
  const send = (over = {}) => settlement.ingestReading({ ...device.signReading({ shipmentId: 'shp_1', temperatureC: 5.2, checkpointMatched: true, ...over.reading }), ...over.raw });
  const bookVelo = () => store.saveCheckout({ shipmentId: 'shp_1', paymentIntentId: 'pi_test1', checkoutUrl: 'https://example.test', amount: '10.00', asset: 'native' });
  return { store, device, settlement, state, send, bookVelo };
}

test('a forged or tampered reading is rejected and never reaches the agent', async () => {
  const { settlement, device, state } = setup();
  const good = device.signReading({ shipmentId: 'shp_1', temperatureC: 5.2, checkpointMatched: true });
  const tampered = await settlement.ingestReading({ ...good, temperatureC: 4.0 });
  assert.equal(tampered.status, 401);
  const other = createSimulatedDevice({ deviceHash: DEVICE_HASH, seed: 'someone-else' });
  const forged = await settlement.ingestReading(other.signReading({ shipmentId: 'shp_1', temperatureC: 5, checkpointMatched: true }));
  assert.equal(forged.status, 401);
  assert.equal(state.agentCalls, 0);
});

test('a replayed reading is rejected', async () => {
  const { settlement, device } = setup();
  const reading = device.signReading({ shipmentId: 'shp_1', temperatureC: 5.2, checkpointMatched: true });
  assert.equal((await settlement.ingestReading(reading)).status, 202);
  assert.equal((await settlement.ingestReading(reading)).status, 409);
});

test('a stale reading is rejected', async () => {
  const { settlement, device } = setup();
  const old = device.signReading({ shipmentId: 'shp_1', temperatureC: 5.2, checkpointMatched: true, ts: Date.now() - 10 * 60 * 1000 });
  assert.equal((await settlement.ingestReading(old)).status, 422);
});

test('the agent holds the payout until Velo confirms, then pays on its own', async () => {
  const { send, bookVelo, settlement, state, store } = setup();
  bookVelo();
  const first = await send();
  await first.settled;
  assert.equal(store.getRun('shp_1').state, 'waiting');
  assert.equal(state.agentCalls, 0);

  state.veloStatus = 'paid'; // no new reading and no button press: the poller finishes the job
  await settlement.pollWaiting();
  const run = store.getRun('shp_1');
  assert.equal(run.state, 'authorized');
  assert.equal(state.agentCalls, 1);
  const types = store.eventsAfter('shp_1').map((e) => e.type);
  assert.deepEqual(types, ['telemetry.accepted', 'agent.waiting', 'velo.confirmed', 'agent.checking', 'agent.authorized']);
});

test('a temperature breach is denied without needing Velo and never pays', async () => {
  const { send, store, state } = setup({ agent: async () => ({ decision: 'denied', paymentSubmitted: false, reason: 'breach' }) });
  const result = await send({ reading: { temperatureC: 10.4 } });
  await result.settled;
  assert.equal(store.getRun('shp_1').state, 'denied');
  assert.equal(state.agentCalls, 0);
});

test('a shipment is settled exactly once even when readings keep arriving', async () => {
  const { send, bookVelo, state } = setup({ veloStatus: 'paid' });
  bookVelo();
  const results = await Promise.all([send(), send(), send()]);
  await Promise.all(results.map((r) => r.settled));
  await (await send()).settled;
  assert.equal(state.agentCalls, 1);
});

test('a Noir failure is recorded as unknown, not retried blindly', async () => {
  const { send, bookVelo, store } = setup({ veloStatus: 'paid', agent: async () => { throw new Error('network'); } });
  bookVelo();
  await (await send()).settled;
  assert.equal(store.getRun('shp_1').state, 'unknown');
});

test('a restart mid-payment becomes unknown instead of paying twice', async () => {
  const { store, settlement } = setup();
  store.claimRun('shp_1');
  settlement.recoverStale();
  assert.equal(store.getRun('shp_1').state, 'unknown');
  assert.equal(store.claimRun('shp_1'), false);
});

test('the merchant claim works once and only after authorization', async () => {
  const { send, bookVelo, settlement, state } = setup({ veloStatus: 'paid' });
  assert.equal((await settlement.claim('shp_1')).status, 409);
  bookVelo();
  await (await send()).settled;
  const claimed = await settlement.claim('shp_1');
  assert.equal(claimed.status, 200);
  const again = await settlement.claim('shp_1');
  assert.equal(again.body.alreadyClaimed, true);
  assert.equal(state.claimCalls, 1);
});

test('state survives reopening the database file', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'aeropay-')), 'x.db');
  const a = openStore(file);
  a.saveCheckout({ shipmentId: 's1', paymentIntentId: 'pi_x1234', checkoutUrl: 'u', amount: '1', asset: 'native' });
  a.addEvent('s1', 'test', 'hello', { n: 1 });
  a.close();
  const b = openStore(file);
  assert.equal(b.checkoutByShipment('s1').paymentIntentId, 'pi_x1234');
  assert.equal(b.eventsAfter('s1')[0].data.n, 1);
  b.close();
});
