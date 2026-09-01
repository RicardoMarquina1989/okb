import { getDb } from './index.js';
import { redact } from '../util/redact.js';

const now = () => new Date().toISOString();

/* ---------------------------------------------------------------- audit */

export function audit(action, ok, detail) {
  getDb()
    .prepare('INSERT INTO audit_log (ts, action, ok, detail) VALUES (?, ?, ?, ?)')
    .run(now(), action, ok ? 1 : 0, detail ? JSON.stringify(redact(detail)) : null);
}

export function recentAudit(limit = 50) {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------------------------------------------------- auth factors */

export function saveFactor(name, secretEnc, label) {
  getDb()
    .prepare(
      `INSERT INTO auth_factors (name, secret_enc, label, enrolled_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET secret_enc = excluded.secret_enc,
                                       label = excluded.label,
                                       enrolled_at = excluded.enrolled_at`,
    )
    .run(name, secretEnc, label ?? null, now());
}

export function getFactor(name) {
  return getDb().prepare('SELECT * FROM auth_factors WHERE name = ?').get(name) ?? null;
}

export function deleteFactor(name) {
  return getDb().prepare('DELETE FROM auth_factors WHERE name = ?').run(name).changes;
}

/* ------------------------------------------------------------ otp codes */

export function insertOtp({ channel, purpose, intentHash, codeHash, expiresAt }) {
  return getDb()
    .prepare(
      `INSERT INTO otp_codes (channel, purpose, intent_hash, code_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(channel, purpose, intentHash, codeHash, now(), expiresAt).lastInsertRowid;
}

export function getLiveOtp(intentHash, channel) {
  return (
    getDb()
      .prepare(
        `SELECT * FROM otp_codes
         WHERE intent_hash = ? AND channel = ? AND consumed_at IS NULL AND expires_at > ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(intentHash, channel, now()) ?? null
  );
}

/** Look up a code by digest regardless of consumption — used for replay detection. */
export function findOtpByHash(intentHash, channel, codeHash) {
  return (
    getDb()
      .prepare(
        `SELECT * FROM otp_codes
         WHERE intent_hash = ? AND channel = ? AND code_hash = ? AND expires_at > ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(intentHash, channel, codeHash, now()) ?? null
  );
}

export function bumpOtpAttempts(id) {
  getDb().prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(id);
}

export function consumeOtp(id) {
  getDb().prepare('UPDATE otp_codes SET consumed_at = ? WHERE id = ?').run(now(), id);
}

/** Drop expired, unconsumed codes. Called opportunistically. */
export function purgeExpiredOtps() {
  return getDb()
    .prepare('DELETE FROM otp_codes WHERE consumed_at IS NULL AND expires_at <= ?')
    .run(now()).changes;
}

/* ------------------------------------------------------------ approvals */

export function insertApproval({ action, intentHash, intent, factors, expiresAt }) {
  return getDb()
    .prepare(
      `INSERT INTO approvals (action, intent_hash, intent, factors, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(action, intentHash, JSON.stringify(intent), JSON.stringify(factors), now(), expiresAt)
    .lastInsertRowid;
}

export function consumeApproval(id) {
  return getDb()
    .prepare('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
    .run(now(), id).changes;
}

/* --------------------------------------------------------- address book */

export function addAddress({ label, ccy, chain, addr, memo, note }) {
  return getDb()
    .prepare(
      `INSERT INTO address_book (label, ccy, chain, addr, memo, note, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(label, ccy.toUpperCase(), chain, addr, memo ?? null, note ?? null, now()).lastInsertRowid;
}

export function listAddresses() {
  return getDb().prepare('SELECT * FROM address_book ORDER BY label').all();
}

export function findAddressByLabel(label) {
  return getDb().prepare('SELECT * FROM address_book WHERE label = ?').get(label) ?? null;
}

export function findAddress(ccy, chain, addr) {
  return (
    getDb()
      .prepare('SELECT * FROM address_book WHERE ccy = ? AND chain = ? AND addr = ?')
      .get(ccy.toUpperCase(), chain, addr) ?? null
  );
}

export function removeAddress(label) {
  return getDb().prepare('DELETE FROM address_book WHERE label = ?').run(label).changes;
}

/* ---------------------------------------------------------- withdrawals */

export function insertWithdrawal(w) {
  return getDb()
    .prepare(
      `INSERT INTO withdrawals
        (client_id, ccy, chain, amount, fee, to_addr, memo, dest, label,
         status, approved_by, requested_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      w.clientId,
      w.ccy,
      w.chain ?? null,
      w.amount,
      w.fee ?? null,
      w.toAddr,
      w.memo ?? null,
      w.dest,
      w.label ?? null,
      'pending',
      JSON.stringify(w.approvedBy ?? []),
      now(),
      now(),
    ).lastInsertRowid;
}

export function markWithdrawalSubmitted(clientId, { wdId, raw }) {
  getDb()
    .prepare(
      `UPDATE withdrawals SET wd_id = ?, status = 'submitted', submitted_at = ?,
              updated_at = ?, raw = ? WHERE client_id = ?`,
    )
    .run(wdId ?? null, now(), now(), JSON.stringify(raw ?? null), clientId);
}

export function markWithdrawalFailed(clientId, error) {
  getDb()
    .prepare(
      `UPDATE withdrawals SET status = 'failed', error = ?, updated_at = ? WHERE client_id = ?`,
    )
    .run(String(error).slice(0, 2000), now(), clientId);
}

export function updateWithdrawalState(clientId, { wdId, state, txId, fee, status }) {
  getDb()
    .prepare(
      `UPDATE withdrawals
         SET wd_id      = COALESCE(?, wd_id),
             okx_state  = COALESCE(?, okx_state),
             tx_id      = COALESCE(?, tx_id),
             fee        = COALESCE(?, fee),
             status     = COALESCE(?, status),
             updated_at = ?
       WHERE client_id = ?`,
    )
    .run(wdId ?? null, state ?? null, txId ?? null, fee ?? null, status ?? null, now(), clientId);
}

export function getWithdrawal(clientId) {
  return getDb().prepare('SELECT * FROM withdrawals WHERE client_id = ?').get(clientId) ?? null;
}

export function listWithdrawals({ limit = 25, status } = {}) {
  const db = getDb();
  return status
    ? db
        .prepare('SELECT * FROM withdrawals WHERE status = ? ORDER BY id DESC LIMIT ?')
        .all(status, limit)
    : db.prepare('SELECT * FROM withdrawals ORDER BY id DESC LIMIT ?').all(limit);
}

/** Rows that may still change state on the exchange side. */
export function openWithdrawals() {
  return getDb()
    .prepare(`SELECT * FROM withdrawals WHERE status IN ('pending','submitted','processing')`)
    .all();
}

/** Sum of amounts requested for a currency within the trailing window. */
export function withdrawnSince(ccy, hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS total FROM withdrawals
       WHERE ccy = ? AND requested_at >= ? AND status != 'failed'`,
    )
    .get(ccy.toUpperCase(), since);
  return Number(row?.total ?? 0);
}

/* ------------------------------------------------------------- deposits */

export function upsertDeposit(d) {
  getDb()
    .prepare(
      `INSERT INTO deposits (dep_id, ccy, chain, amount, from_addr, to_addr, tx_id, state, okx_ts, synced_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dep_id) DO UPDATE SET
         state = excluded.state, tx_id = excluded.tx_id,
         synced_at = excluded.synced_at, raw = excluded.raw`,
    )
    .run(
      d.depId,
      d.ccy,
      d.chain ?? null,
      d.amount,
      d.fromAddr ?? null,
      d.toAddr ?? null,
      d.txId ?? null,
      d.state ?? null,
      d.okxTs ?? null,
      now(),
      JSON.stringify(d.raw ?? null),
    );
}

export function listDeposits({ limit = 25, ccy } = {}) {
  const db = getDb();
  return ccy
    ? db
        .prepare('SELECT * FROM deposits WHERE ccy = ? ORDER BY okx_ts DESC LIMIT ?')
        .all(ccy.toUpperCase(), limit)
    : db.prepare('SELECT * FROM deposits ORDER BY okx_ts DESC LIMIT ?').all(limit);
}

/* ---------------------------------------------------- deposit addresses */

export function saveDepositAddress({ ccy, chain, addr, memo, selected }) {
  getDb()
    .prepare(
      `INSERT INTO deposit_addresses (ccy, chain, addr, memo, selected, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ccy, chain, addr, memo) DO UPDATE SET
         selected = excluded.selected, fetched_at = excluded.fetched_at`,
    )
    .run(ccy.toUpperCase(), chain, addr, memo ?? null, selected ? 1 : 0, now());
}

export function listDepositAddresses(ccy) {
  const db = getDb();
  return ccy
    ? db
        .prepare('SELECT * FROM deposit_addresses WHERE ccy = ? ORDER BY chain')
        .all(ccy.toUpperCase())
    : db.prepare('SELECT * FROM deposit_addresses ORDER BY ccy, chain').all();
}
