import crypto from 'node:crypto';
import { requireEncryptionKey } from '../config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
}

/**
 * Encrypt a secret for storage. Output is self-describing:
 * v1.<salt>.<iv>.<authTag>.<ciphertext>, all base64.
 */
export function encryptSecret(plaintext, password = requireEncryptionKey()) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', salt, iv, tag, ct].map((p) => (typeof p === 'string' ? p : p.toString('base64'))).join('.');
}

export function decryptSecret(payload, password = requireEncryptionKey()) {
  const [version, saltB64, ivB64, tagB64, ctB64] = String(payload).split('.');
  if (version !== 'v1') throw new Error(`Unsupported secret format: ${version}`);
  const key = deriveKey(password, Buffer.from(saltB64, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      'Could not decrypt stored secret — KOX_ENCRYPTION_KEY does not match the one used at enrollment.',
    );
  }
}

/** Hash an OTP for storage, peppered with the encryption key so DB theft alone is not enough. */
export function hashCode(code, intentHash, pepper = requireEncryptionKey()) {
  return crypto.createHmac('sha256', pepper).update(`${intentHash}:${code}`).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Stable hash of a withdrawal/action intent, so an OTP cannot approve a different action. */
export function intentHash(intent) {
  const canonical = JSON.stringify(intent, Object.keys(intent).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Cryptographically uniform numeric OTP. */
export function generateOtp(digits = 6) {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}

export function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('base64');
}
