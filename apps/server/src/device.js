import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

/**
 * Signed delivery telemetry.
 * A registered device signs every reading with Ed25519. The server verifies the
 * signature against the device registry, rejects stale timestamps and replayed
 * nonces, and only then lets the agent act on the reading.
 *
 * The demo device is simulated in software (see createSimulatedDevice). A real
 * tag would hold its private key in secure hardware and POST /api/telemetry itself.
 */

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function canonicalMessage({ deviceHash, shipmentId, ts, nonce, temperatureC, checkpointMatched }) {
  return `aeropay.v1|${deviceHash}|${shipmentId}|${ts}|${nonce}|${Number(temperatureC).toFixed(2)}|${checkpointMatched ? 1 : 0}`;
}

function privateKeyFromSeed(seed32) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32]), format: 'der', type: 'pkcs8' });
}

export function publicKeyHex(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

function publicKeyFromHex(hex) {
  if (!/^[a-f\d]{64}$/i.test(hex)) throw new Error('Device public key must be 32 bytes of hex.');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}

export function createSimulatedDevice({ deviceHash, seed }) {
  const seed32 = seed ? createHash('sha256').update(`aeropay-device:${seed}`).digest() : randomBytes(32);
  const privateKey = privateKeyFromSeed(seed32);
  return {
    deviceHash,
    publicKeyHex: publicKeyHex(createPublicKey(privateKey)),
    /** Produces a signed reading exactly as a real tag would send it. */
    signReading({ shipmentId, temperatureC, checkpointMatched, ts = Date.now(), nonce = randomBytes(12).toString('hex') }) {
      const body = { deviceHash, shipmentId, ts, nonce, temperatureC: Number(Number(temperatureC).toFixed(2)), checkpointMatched: Boolean(checkpointMatched) };
      const signature = sign(null, Buffer.from(canonicalMessage(body)), privateKey).toString('hex');
      return { ...body, signature };
    },
  };
}

export function createDeviceRegistry() {
  const devices = new Map(); // deviceHash -> public KeyObject
  return {
    register(deviceHash, publicKeyHexValue) { devices.set(deviceHash, publicKeyFromHex(publicKeyHexValue)); },
    has: (deviceHash) => devices.has(deviceHash),
    size: () => devices.size,
    /**
     * Validates one signed reading. Returns { ok: true, reading } or { ok: false, status, error }.
     * Replay protection is completed by the store's UNIQUE(device_hash, nonce).
     */
    verifyReading(input, { now = Date.now() } = {}) {
      const reading = input ?? {};
      const fail = (status, error) => ({ ok: false, status, error });
      if (typeof reading.deviceHash !== 'string' || !/^[a-f\d]{64}$/i.test(reading.deviceHash)) return fail(400, 'deviceHash must be a 64-character hex SHA-256.');
      if (typeof reading.shipmentId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(reading.shipmentId)) return fail(400, 'A valid shipmentId is required.');
      if (typeof reading.nonce !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(reading.nonce)) return fail(400, 'A nonce of 8 to 64 URL-safe characters is required.');
      if (!Number.isInteger(reading.ts)) return fail(400, 'ts must be a Unix timestamp in milliseconds.');
      if (!Number.isFinite(reading.temperatureC) || reading.temperatureC < -80 || reading.temperatureC > 120) return fail(400, 'temperatureC must be a realistic number.');
      if (typeof reading.checkpointMatched !== 'boolean') return fail(400, 'checkpointMatched must be true or false.');
      if (typeof reading.signature !== 'string' || !/^[a-f\d]{128}$/i.test(reading.signature)) return fail(400, 'signature must be 64 bytes of hex.');
      const publicKey = devices.get(reading.deviceHash.toLowerCase());
      if (!publicKey) return fail(403, 'This device is not in the registry.');
      if (Math.abs(now - reading.ts) > MAX_CLOCK_SKEW_MS) return fail(422, 'The reading timestamp is outside the allowed 5 minute window.');
      const valid = verify(null, Buffer.from(canonicalMessage({ ...reading, deviceHash: reading.deviceHash.toLowerCase() })), publicKey, Buffer.from(reading.signature, 'hex'));
      if (!valid) return fail(401, 'The signature does not match this device.');
      return { ok: true, reading: { ...reading, deviceHash: reading.deviceHash.toLowerCase() } };
    },
  };
}
