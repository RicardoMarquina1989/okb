const SECRET_KEYS = /^(okx_api_secret|okx_api_passphrase|okx_api_key|kox_encryption_key|smtp_pass|twilio_auth_token|secret|password|token|code)$/i;

/** Mask a secret, keeping a short recognizable prefix/suffix. */
export function mask(value, keep = 4) {
  if (value == null) return value;
  const s = String(value);
  if (s.length <= keep * 2) return '*'.repeat(s.length);
  return `${s.slice(0, keep)}${'*'.repeat(Math.min(12, s.length - keep * 2))}${s.slice(-keep)}`;
}

/** Deep-clone an object with any secret-looking field masked. Use before logging or persisting. */
export function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.test(k) ? mask(v) : redact(v);
  }
  return out;
}

/** Shorten a blockchain address for display: 0x1234...cdef */
export function shortAddr(addr) {
  if (!addr || addr.length <= 16) return addr ?? '';
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}
