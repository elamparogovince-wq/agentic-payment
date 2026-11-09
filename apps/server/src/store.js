import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Async store with two interchangeable backends:
 *  - Postgres when a connection string is given (survives Render deploys and spin-downs)
 *  - SQLite (node:sqlite) otherwise (local development, or a Render persistent disk)
 * All SQL below is portable between both; only the schema and the driver glue differ.
 */

const SCHEMA_COMMON = (kind) => {
  const id = kind === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const real = kind === 'pg' ? 'DOUBLE PRECISION' : 'REAL';
  const big = kind === 'pg' ? 'BIGINT' : 'INTEGER';
  return [
    `CREATE TABLE IF NOT EXISTS checkouts (
      shipment_id TEXT PRIMARY KEY,
      payment_intent_id TEXT NOT NULL UNIQUE,
      checkout_url TEXT NOT NULL,
      amount TEXT NOT NULL,
      asset TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS readings (
      id ${id},
      shipment_id TEXT NOT NULL,
      device_hash TEXT NOT NULL,
      nonce TEXT NOT NULL,
      ts ${big} NOT NULL,
      temperature_c ${real} NOT NULL,
      checkpoint_matched INTEGER NOT NULL,
      signature TEXT NOT NULL,
      scenario TEXT NOT NULL DEFAULT 'success',
      received_at TEXT NOT NULL,
      UNIQUE (device_hash, nonce)
    )`,
    `CREATE INDEX IF NOT EXISTS readings_by_shipment ON readings (shipment_id, id)`,
    `CREATE TABLE IF NOT EXISTS runs (
      shipment_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      result TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id ${id},
      shipment_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS events_by_shipment ON events (shipment_id, id)`,
    `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payment_intent_id TEXT,
      received_at TEXT NOT NULL
    )`,
  ];
};

async function sqliteDriver(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const statement of SCHEMA_COMMON('sqlite')) db.exec(statement);
  const cache = new Map();
  const prepare = (sql) => { if (!cache.has(sql)) cache.set(sql, db.prepare(sql)); return cache.get(sql); };
  return {
    kind: 'sqlite',
    label: file === ':memory:' ? 'sqlite (memory)' : 'sqlite',
    async run(sql, params = []) { const info = prepare(sql).run(...params); return { changes: Number(info.changes) }; },
    async get(sql, params = []) { return prepare(sql).get(...params) ?? null; },
    async all(sql, params = []) { return prepare(sql).all(...params); },
    async insertReturningId(sql, params = []) { return Number(prepare(sql).run(...params).lastInsertRowid); },
    isUniqueViolation: (error) => /UNIQUE/i.test(String(error?.message)),
    async close() { db.close(); },
  };
}

async function postgresDriver(connectionString) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
  const toPg = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };
  await pool.query('SELECT 1'); // fail fast so the server can fall back
  for (const statement of SCHEMA_COMMON('pg')) await pool.query(statement);
  return {
    kind: 'pg',
    label: 'postgres',
    async run(sql, params = []) { const r = await pool.query(toPg(sql), params); return { changes: r.rowCount ?? 0 }; },
    async get(sql, params = []) { const r = await pool.query(toPg(sql), params); return r.rows[0] ?? null; },
    async all(sql, params = []) { const r = await pool.query(toPg(sql), params); return r.rows; },
    async insertReturningId(sql, params = []) { const r = await pool.query(`${toPg(sql)} RETURNING id`, params); return Number(r.rows[0].id); },
    isUniqueViolation: (error) => error?.code === '23505',
    async close() { await pool.end(); },
  };
}

/** openStore(':memory:' | '/path/file.db') for SQLite, openStore({ databaseUrl }) for Postgres. */
export async function openStore(target = ':memory:') {
  const driver = typeof target === 'object' && target?.databaseUrl
    ? await postgresDriver(target.databaseUrl)
    : await sqliteDriver(typeof target === 'string' ? target : target?.file ?? ':memory:');

  const now = () => new Date().toISOString();
  const json = (value) => (value === undefined ? null : JSON.stringify(value));
  const parse = (text) => (text ? JSON.parse(text) : null);
  const toCheckout = (row) => row && ({
    shipmentId: row.shipment_id,
    paymentIntentId: row.payment_intent_id,
    checkoutUrl: row.checkout_url,
    amount: row.amount,
    asset: row.asset,
    paymentStatus: row.payment_status,
    createdAt: row.created_at,
  });

  return {
    engine: driver.label,
    persistent: driver.kind === 'pg',
    close: () => driver.close(),

    async saveCheckout(c) {
      await driver.run(
        `INSERT INTO checkouts (shipment_id, payment_intent_id, checkout_url, amount, asset, payment_status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`,
        [c.shipmentId, c.paymentIntentId, c.checkoutUrl, c.amount, c.asset, now()]);
      return toCheckout(await driver.get('SELECT * FROM checkouts WHERE shipment_id = ?', [c.shipmentId]));
    },
    async checkoutByShipment(id) { return toCheckout(await driver.get('SELECT * FROM checkouts WHERE shipment_id = ?', [id])); },
    async checkoutByIntent(id) { return toCheckout(await driver.get('SELECT * FROM checkouts WHERE payment_intent_id = ?', [id])); },
    async setCheckoutStatus(intentId, status) { await driver.run('UPDATE checkouts SET payment_status = ? WHERE payment_intent_id = ?', [status, intentId]); },

    /** Returns false when this (device, nonce) pair was already used: replay protection. */
    async saveReading(r) {
      try {
        await driver.run(
          `INSERT INTO readings (shipment_id, device_hash, nonce, ts, temperature_c, checkpoint_matched, signature, scenario, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.shipmentId, r.deviceHash, r.nonce, r.ts, r.temperatureC, r.checkpointMatched ? 1 : 0, r.signature, r.scenario || 'success', now()]);
        return true;
      } catch (error) {
        if (driver.isUniqueViolation(error)) return false;
        throw error;
      }
    },
    async latestReading(shipmentId) {
      const row = await driver.get('SELECT * FROM readings WHERE shipment_id = ? ORDER BY id DESC LIMIT 1', [shipmentId]);
      return row && {
        shipmentId: row.shipment_id, deviceHash: row.device_hash, nonce: row.nonce, ts: Number(row.ts),
        temperatureC: Number(row.temperature_c), checkpointMatched: Boolean(row.checkpoint_matched),
        signature: row.signature, scenario: row.scenario,
      };
    },

    /** Atomically claims the single settlement run for a shipment. Only one caller wins. */
    async claimRun(shipmentId) {
      await driver.run("DELETE FROM runs WHERE shipment_id = ? AND state = 'waiting'", [shipmentId]); // a waiting placeholder becomes claimable; processing never is
      const { changes } = await driver.run("INSERT INTO runs (shipment_id, state, updated_at) VALUES (?, 'processing', ?) ON CONFLICT DO NOTHING", [shipmentId, now()]);
      return changes === 1;
    },
    async releaseRun(shipmentId) { await driver.run("DELETE FROM runs WHERE shipment_id = ? AND state = 'processing'", [shipmentId]); },
    async markWaiting(shipmentId) {
      await driver.run(
        `INSERT INTO runs (shipment_id, state, updated_at) VALUES (?, 'waiting', ?)
         ON CONFLICT (shipment_id) DO UPDATE SET state = 'waiting', updated_at = excluded.updated_at WHERE runs.state = 'waiting'`,
        [shipmentId, now()]);
    },
    async finishRun(shipmentId, state, result) { await driver.run('UPDATE runs SET state = ?, result = ?, updated_at = ? WHERE shipment_id = ?', [state, json(result), now(), shipmentId]); },
    async getRun(shipmentId) {
      const row = await driver.get('SELECT * FROM runs WHERE shipment_id = ?', [shipmentId]);
      return row && { shipmentId, state: row.state, result: parse(row.result), updatedAt: row.updated_at };
    },
    async waitingShipments() { return (await driver.all("SELECT shipment_id FROM runs WHERE state = 'waiting'")).map((row) => row.shipment_id); },
    async staleProcessing() { return (await driver.all("SELECT shipment_id FROM runs WHERE state = 'processing'")).map((row) => row.shipment_id); },

    async addEvent(shipmentId, type, message, data) {
      return driver.insertReturningId('INSERT INTO events (shipment_id, ts, type, message, data) VALUES (?, ?, ?, ?, ?)', [shipmentId, now(), type, message, json(data)]);
    },
    async eventsAfter(shipmentId, afterId = 0) {
      const rows = await driver.all('SELECT * FROM events WHERE shipment_id = ? AND id > ? ORDER BY id ASC LIMIT 200', [shipmentId, afterId]);
      return rows.map((row) => ({ id: Number(row.id), ts: row.ts, type: row.type, message: row.message, data: parse(row.data) }));
    },

    async recordDelivery(deliveryId, type, intentId) {
      return (await driver.run('INSERT INTO webhook_deliveries (delivery_id, type, payment_intent_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [deliveryId, type, intentId, now()])).changes === 1;
    },
    async recentDeliveries() {
      return (await driver.all('SELECT * FROM webhook_deliveries ORDER BY received_at DESC LIMIT 40')).map((row) => ({
        deliveryId: row.delivery_id, type: row.type, paymentIntentId: row.payment_intent_id, receivedAt: row.received_at,
      }));
    },
  };
}
