// A stand-in for a real cold-chain tag. It signs one reading with the device key and sends it to the
// AeroPay server exactly like hardware would: POST /api/telemetry. The server verifies the signature.
//
// Usage:  npm run device:send -- <shipmentId> [temperatureC] [true|false]
//   The shipmentId is shown in the browser (sessionStorage "aeropay.shipmentId") or in the activity feed.
//   Needs DEVICE_HASH and DEVICE_SIM_SEED in .env, and the same two values on the server.
import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSimulatedDevice } from '../apps/server/src/device.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

const [shipmentId, temperature = '5.2', checkpoint = 'true'] = process.argv.slice(2);
const deviceHash = (process.env.DEVICE_HASH || '').trim().toLowerCase();
const seed = process.env.DEVICE_SIM_SEED?.trim();
const base = (process.env.APP_BASE_URL || 'http://localhost:4173').replace(/\/$/, '');

if (!shipmentId || !/^[a-f\d]{64}$/.test(deviceHash) || !seed) {
  console.error('Usage: npm run device:send -- <shipmentId> [temperatureC] [true|false]\nRequires DEVICE_HASH and DEVICE_SIM_SEED in .env (same values as the server).');
  process.exit(2);
}

const device = createSimulatedDevice({ deviceHash, seed });
const reading = device.signReading({ shipmentId, temperatureC: Number(temperature), checkpointMatched: checkpoint === 'true' });
const response = await fetch(`${base}/api/telemetry`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(reading),
});
console.log(response.status, await response.text());
