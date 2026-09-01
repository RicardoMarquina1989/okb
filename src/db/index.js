import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../util/logger.js';

let db = null;

const MIGRATIONS = [
  {
    name: '001-initial',
    sql: `
    CREATE TABLE auth_factors (
      name        TEXT PRIMARY KEY,
      secret_enc  TEXT NOT NULL,
      label       TEXT,
      enrolled_at TEXT NOT NULL
    );

    CREATE TABLE otp_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel     TEXT NOT NULL,
      purpose     TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      code_hash   TEXT NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE INDEX idx_otp_lookup ON otp_codes(intent_hash, channel, consumed_at);

    CREATE TABLE approvals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      intent      TEXT NOT NULL,
      factors     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE INDEX idx_approval_lookup ON approvals(intent_hash, consumed_at);

    CREATE TABLE address_book (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT NOT NULL UNIQUE,
      ccy        TEXT NOT NULL,
      chain      TEXT NOT NULL,
      addr       TEXT NOT NULL,
      memo       TEXT,
      note       TEXT,
      added_at   TEXT NOT NULL,
      UNIQUE(ccy, chain, addr, memo)
    );

    CREATE TABLE withdrawals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id    TEXT NOT NULL UNIQUE,
      wd_id        TEXT,
      ccy          TEXT NOT NULL,
      chain        TEXT,
      amount       TEXT NOT NULL,
      fee          TEXT,
      to_addr      TEXT NOT NULL,
      memo         TEXT,
      dest         TEXT NOT NULL,
      label        TEXT,
      status       TEXT NOT NULL,
      okx_state    TEXT,
      tx_id        TEXT,
      approved_by  TEXT,
      error        TEXT,
      requested_at TEXT NOT NULL,
      submitted_at TEXT,
      updated_at   TEXT NOT NULL,
      raw          TEXT
    );
    CREATE INDEX idx_wd_requested ON withdrawals(requested_at DESC);
    CREATE INDEX idx_wd_status ON withdrawals(status);

    CREATE TABLE deposits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      dep_id     TEXT UNIQUE,
      ccy        TEXT NOT NULL,
      chain      TEXT,
      amount     TEXT NOT NULL,
      from_addr  TEXT,
      to_addr    TEXT,
      tx_id      TEXT,
      state      TEXT,
      okx_ts     TEXT,
      synced_at  TEXT NOT NULL,
      raw        TEXT
    );
    CREATE INDEX idx_dep_ts ON deposits(okx_ts DESC);

    CREATE TABLE deposit_addresses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ccy        TEXT NOT NULL,
      chain      TEXT NOT NULL,
      addr       TEXT NOT NULL,
      memo       TEXT,
      selected   INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL,
      UNIQUE(ccy, chain, addr, memo)
    );

    CREATE TABLE audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT NOT NULL,
      action  TEXT NOT NULL,
      ok      INTEGER NOT NULL,
      detail  TEXT
    );
    CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
  `,
  },
];

/** Open the database, applying any pending migrations. Idempotent. */
export function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.db.path), { recursive: true });
  db = new DatabaseSync(config.db.path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  )`);

  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        m.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      log.debug(`migration applied: ${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${err.message}`);
    }
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/** Run fn inside a transaction, rolling back on throw. */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}
