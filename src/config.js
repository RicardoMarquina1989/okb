import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(v, dflt = false) {
  if (v == null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function num(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function list(v, dflt = []) {
  if (!v) return dflt;
  return String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const config = {
  root: ROOT,

  okx: {
    apiKey: process.env.OKX_API_KEY ?? '',
    apiSecret: process.env.OKX_API_SECRET ?? '',
    passphrase: process.env.OKX_API_PASSPHRASE ?? '',
    baseUrl: (process.env.OKX_BASE_URL ?? 'https://www.okx.com').replace(/\/+$/, ''),
    simulated: bool(process.env.OKX_SIMULATED, false),
    timeoutMs: num(process.env.OKX_TIMEOUT_MS, 20000),
    maxRetries: num(process.env.OKX_MAX_RETRIES, 3),
  },

  db: {
    path: path.resolve(ROOT, process.env.DB_PATH ?? 'data/kox.db'),
  },

  auth: {
    /** Factors that must all pass before a guarded action runs. */
    factors: list(process.env.AUTH_FACTORS, ['totp']),
    otpTtlSeconds: num(process.env.OTP_TTL_SECONDS, 300),
    otpMaxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 3),
    /** Key used to encrypt the TOTP seed at rest. */
    encryptionKey: process.env.KOX_ENCRYPTION_KEY ?? '',
  },

  email: {
    host: process.env.SMTP_HOST ?? '',
    port: num(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
    to: process.env.OTP_EMAIL_TO ?? '',
  },

  sms: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    from: process.env.TWILIO_FROM ?? '',
    to: process.env.OTP_SMS_TO ?? '',
  },

  limits: {
    /** Hard ceiling per single withdrawal, in the withdrawn currency's units. */
    maxWithdrawalAmount: num(process.env.MAX_WITHDRAWAL_AMOUNT, Infinity),
    /** Rolling 24h ceiling, summed per currency. */
    maxDaily: num(process.env.MAX_DAILY_WITHDRAWAL_AMOUNT, Infinity),
    /** Refuse to send to an address that is not in the local address book. */
    requireAddressBook: bool(process.env.REQUIRE_ADDRESS_BOOK, true),
  },
};

export class ConfigError extends Error {}

/** Throw unless the OKX credential triple is present. */
export function requireOkxCredentials() {
  const missing = ['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE'].filter(
    (k) => !process.env[k],
  );
  if (missing.length) {
    throw new ConfigError(
      `Missing OKX credentials: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`,
    );
  }
}

/** Throw unless an at-rest encryption key is configured. */
export function requireEncryptionKey() {
  if (!config.auth.encryptionKey || config.auth.encryptionKey.length < 32) {
    throw new ConfigError(
      'KOX_ENCRYPTION_KEY is missing or too short (need >=32 chars). Generate one with: kox auth keygen',
    );
  }
  return config.auth.encryptionKey;
}
