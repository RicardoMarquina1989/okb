import { authenticator } from 'otplib';
import { getFactor, saveFactor, findOtpByHash, insertOtp } from '../db/repo.js';
import { encryptSecret, decryptSecret, hashCode } from './crypto.js';

// Accept the neighbouring 30s steps so a slightly-skewed clock still works.
authenticator.options = { window: 1 };

export function isEnrolled() {
  return getFactor('totp') !== null;
}

/** Create and store a new TOTP seed. Returns the seed and its otpauth:// URI. */
export function enroll({ accountLabel = 'okx', issuer = 'kox-bot' } = {}) {
  const secret = authenticator.generateSecret();
  const uri = authenticator.keyuri(accountLabel, issuer, secret);
  saveFactor('totp', encryptSecret(secret), accountLabel);
  return { secret, uri };
}

export function getSecret() {
  const row = getFactor('totp');
  if (!row) {
    throw new Error('No authenticator enrolled. Run: kox auth setup');
  }
  return decryptSecret(row.secret_enc);
}

/** Verify a 6-digit code against the enrolled seed. Does not guard replay. */
export function verifyCode(code) {
  const clean = String(code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    return authenticator.verify({ token: clean, secret: getSecret() });
  } catch {
    return false;
  }
}

/**
 * Verify a code and burn it, so the same token cannot approve a second action
 * inside its 30-second validity window.
 */
export function verifyAndBurn(code, intentHash) {
  if (!verifyCode(code)) return { ok: false, reason: 'invalid' };

  const clean = String(code).replace(/\s+/g, '');
  // Codes are recorded under a fixed key so replay detection spans all intents.
  const GUARD = 'totp-replay-guard';
  const digest = hashCode(clean, GUARD);
  if (findOtpByHash(GUARD, 'totp', digest)) {
    return { ok: false, reason: 'replay' };
  }

  // Left unconsumed on purpose: the row *is* the record that this token was spent.
  // It ages out via expires_at, which outlives the token (30s step + drift either side).
  insertOtp({
    channel: 'totp',
    purpose: 'approval',
    intentHash: GUARD,
    codeHash: digest,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
  return { ok: true, intentHash };
}
