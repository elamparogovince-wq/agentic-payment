import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Small SQLite store (node:sqlite, no extra dependency).
 * State survives server restarts as long as the database file survives.
 * On Render's free plan the disk is ephemeral; attach a persistent disk and set
 * DATA_DIR to keep it across deploys.
 */
export function openStore(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS checkouts (
      shipment_id TEXT PRIMARY KEY,
      payment_intent_id TEXT NOT NULL UNIQUE,
      checkout_url TEXT NOT NULL,
      amount TEXT NOT NULL,
      asset TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id TEXT NOT NULL,
      device_hash TEXT NOT NULL,
      nonce TEXT NOT NULL,
      ts INTEGER NOT NULL,
      temperature_c REAL NOT NULL,
      checkpoint_matched INTEGER NOT NULL,
      signature TEXT NOT NULL,
      scenario TEXT NOT NULL DEFAULT 'success',
      received_at TEXT NOT NULL,
      UNIQUE (device_hash, nonce)
    );
    CREATE TABLE IF NOT EXISTS runs (
      shipment_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      result TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS events_by_shipment ON events (shipment_id, id);
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payment_intent_id TEXT,
      received_at TEXT NOT NULL
    );
  `);

  const now = () => new Date().toISOString();
  const json = (value) => (value === undefined ? null : JSON.stringify(value));
  const parse = (text) => (text ? JSON.parse(text) : null);

  const stmt = {
    insertCheckout: db.prepare(`INSERT OR IGNORE INTO checkouts
      (shipment_id, payment_intent_id, checkout_url, amount, asset, payment_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`),
    checkoutByShipment: db.prepare('SELECT * FROM checkouts WHERE shipment_id = ?'),
    checkoutByIntent: db.prepare('SELECT * FROM checkouts WHERE payment_intent_id = ?'),
    setCheckoutStatus: db.prepare('UPDATE checkouts SET payment_status = ? WHERE payment_intent_id = ?'),
    insertReading: db.prepare(`INSERT INTO readings
      (shipment_id, device_hash, nonce, ts, temperature_c, checkpoint_matched, signature, scenario, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    latestReading: db.prepare('SELECT * FROM readings WHERE shipment_id = ? ORDER BY id DESC LIMIT 1'),
    claimRun: db.prepare("INSERT OR IGNORE INTO runs (shipment_id, state, updated_at) VALUES (?, 'processing', ?)"),
    getRun: db.prepare('SELECT * FROM runs WHERE shipment_id = ?'),
    finishRun: db.prepare('UPDATE runs SET state = ?, result = ?, updated_at = ? WHERE shipment_id = ?'),
    deleteProcessing: db.prepare("DELETE FROM runs WHERE shipment_id = ? AND state = 'processing'"),
    deleteWaiting: db.prepare("DELETE FROM runs WHERE shipment_id = ? AND state = 'waiting'"),
    setWaiting: db.prepare(`INSERT INTO runs (shipment_id, state, updated_at) VALUES (?, 'waiting', ?)
      ON CONFLICT(shipment_id) DO UPDATE SET state = 'waiting', updated_at = excluded.updated_at WHERE runs.state = 'waiting'`),
    waitingRuns: db.prepare("SELECT shipment_id FROM runs WHERE state = 'waiting'"),
    staleProcessing: db.prepare("SELECT shipment_id FROM runs WHERE state = 'processing'"),
    insertEvent: db.prepare('INSERT INTO events (shipment_id, ts, type, message, data) VALUES (?, ?, ?, ?, ?)'),
    eventsAfter: db.prepare('SELECT * FROM events WHERE shipment_id = ? AND id > ? ORDER BY id ASC LIMIT 200'),
    insertDelivery: db.prepare('INSERT OR IGNORE INTO webhook_deliveries (delivery_id, type, payment_intent_id, received_at) VALUES (?, ?, ?, ?)'),
    recentDeliveries: db.prepare('SELECT * FROM webhook_deliveries ORDER BY received_at DESC LIMIT 40'),
  };

  const rowToCheckout = (row) => row && ({
    shipmentId: row.shipment_id,
    paymentIntentId: row.payment_intent_id,
    checkoutUrl: row.checkout_url,
    amount: row.amount,
    asset: row.asset,
    paymentStatus: row.payment_status,
    createdAt: row.created_at,
  });

  return {
    file,
    close: () => db.close(),

    saveCheckout(c) {
      stmt.insertCheckout.run(c.shipmentId, c.paymentIntentId, c.checkoutUrl, c.amount, c.asset, now());
      return rowToCheckout(stmt.checkoutByShipment.get(c.shipmentId));
    },
    checkoutByShipment: (id) => rowToCheckout(stmt.checkoutByShipment.get(id)),
    checkoutByIntent: (id) => rowToCheckout(stmt.checkoutByIntent.get(id)),
    setCheckoutStatus: (intentId, status) => { stmt.setCheckoutStatus.run(status, intentId); },

    /** Returns false when this (device, nonce) pair was already used: replay protection. */
    saveReading(r) {
      try {
        stmt.insertReading.run(r.shipmentId, r.deviceHash, r.nonce, r.ts, r.temperatureC,
          r.checkpointMatched ? 1 : 0, r.signature, r.scenario || 'success', now());
        return true;
      } catch (error) {
        if (/UNIQUE/i.test(String(error?.message))) return false;
        throw error;
      }
    },
    latestReading(shipmentId) {
      const row = stmt.latestReading.get(shipmentId);
      return row && {
        shipmentId: row.shipment_id, deviceHash: row.device_hash, nonce: row.nonce, ts: row.ts,
        temperatureC: row.temperature_c, checkpointMatched: Boolean(row.checkpoint_matched),
        signature: row.signature, scenario: row.scenario,
      };
    },

    /** Atomically claims the single settlement run for a shipment. Only one caller wins. */
    claimRun(shipmentId) {
      stmt.deleteWaiting.run(shipmentId); // a 'waiting' placeholder becomes claimable; 'processing' never is
      return stmt.claimRun.run(shipmentId, now()).changes === 1;
    },
    releaseRun(shipmentId) { stmt.deleteProcessing.run(shipmentId); },
    markWaiting(shipmentId) { stmt.setWaiting.run(shipmentId, now()); },
    finishRun(shipmentId, state, result) { stmt.finishRun.run(state, json(result), now(), shipmentId); },
    getRun(shipmentId) {
      const row = stmt.getRun.get(shipmentId);
      return row && { shipmentId, state: row.state, result: parse(row.result), updatedAt: row.updated_at };
    },
    waitingShipments: () => stmt.waitingRuns.all().map((row) => row.shipment_id),
    staleProcessing: () => stmt.staleProcessing.all().map((row) => row.shipment_id),

    addEvent(shipmentId, type, message, data) {
      const info = stmt.insertEvent.run(shipmentId, now(), type, message, json(data));
      return Number(info.lastInsertRowid);
    },
    eventsAfter(shipmentId, afterId = 0) {
      return stmt.eventsAfter.all(shipmentId, afterId).map((row) => ({
        id: row.id, ts: row.ts, type: row.type, message: row.message, data: parse(row.data),
      }));
    },

    recordDelivery(deliveryId, type, intentId) {
      return stmt.insertDelivery.run(deliveryId, type, intentId, now()).changes === 1;
    },
    recentDeliveries: () => stmt.recentDeliveries.all().map((row) => ({
      deliveryId: row.delivery_id, type: row.type, paymentIntentId: row.payment_intent_id, receivedAt: row.received_at,
    })),
  };
}
