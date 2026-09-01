import crypto from 'node:crypto';
import { config, requireOkxCredentials } from '../config.js';
import { log } from '../util/logger.js';

/** An error carrying OKX's own response codes so callers can branch on them. */
export class OkxError extends Error {
  constructor(message, { code, sCode, httpStatus, path, data } = {}) {
    super(message);
    this.name = 'OkxError';
    this.code = code;
    this.sCode = sCode;
    this.httpStatus = httpStatus;
    this.path = path;
    this.data = data;
  }
}

/**
 * OKX v5 signature: base64(HMAC-SHA256(timestamp + method + requestPath + body, secret)).
 * `requestPath` must include the query string exactly as sent.
 */
export function sign({ timestamp, method, requestPath, body = '', secret }) {
  return crypto
    .createHmac('sha256', secret)
    .update(timestamp + method.toUpperCase() + requestPath + body)
    .digest('base64');
}

function buildQuery(params) {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HTTP statuses and OKX codes worth retrying: transient network/ratelimit conditions. */
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_OKX = new Set(['50011', '50013', '50026']); // rate limit, busy, system error

export class OkxClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? config.okx.baseUrl;
    this.apiKey = opts.apiKey ?? config.okx.apiKey;
    this.apiSecret = opts.apiSecret ?? config.okx.apiSecret;
    this.passphrase = opts.passphrase ?? config.okx.passphrase;
    this.simulated = opts.simulated ?? config.okx.simulated;
    this.timeoutMs = opts.timeoutMs ?? config.okx.timeoutMs;
    this.maxRetries = opts.maxRetries ?? config.okx.maxRetries;
  }

  /**
   * Perform a signed request. Returns the `data` array from OKX's envelope.
   * Throws OkxError when the envelope reports a non-zero code.
   */
  async request(method, path, { params, body, retryable } = {}) {
    requireOkxCredentials();

    const requestPath = path + buildQuery(params);
    const bodyStr = body ? JSON.stringify(body) : '';
    // Only idempotent verbs retry by default — never silently re-send a withdrawal.
    const canRetry = retryable ?? method.toUpperCase() === 'GET';

    let lastErr;
    for (let attempt = 0; attempt <= (canRetry ? this.maxRetries : 0); attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(4000, 300 * 2 ** (attempt - 1));
        log.debug(`retry ${attempt}/${this.maxRetries} after ${backoff}ms: ${requestPath}`);
        await sleep(backoff);
      }
      try {
        return await this.#send(method, requestPath, bodyStr);
      } catch (err) {
        lastErr = err;
        const retryWorthy =
          err.name === 'AbortError' ||
          err.code === 'ECONNRESET' ||
          err.cause?.code === 'ECONNRESET' ||
          RETRYABLE_HTTP.has(err.httpStatus) ||
          RETRYABLE_OKX.has(err.code);
        if (!canRetry || !retryWorthy) throw err;
      }
    }
    throw lastErr;
  }

  async #send(method, requestPath, bodyStr) {
    const timestamp = new Date().toISOString();
    const headers = {
      'OK-ACCESS-KEY': this.apiKey,
      'OK-ACCESS-SIGN': sign({
        timestamp,
        method,
        requestPath,
        body: bodyStr,
        secret: this.apiSecret,
      }),
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.simulated) headers['x-simulated-trading'] = '1';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.baseUrl + requestPath, {
        method: method.toUpperCase(),
        headers,
        body: bodyStr || undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new OkxError(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`, {
        httpStatus: res.status,
        path: requestPath,
      });
    }

    if (!res.ok && payload.code === undefined) {
      throw new OkxError(`HTTP ${res.status} ${res.statusText} for ${requestPath}`, {
        httpStatus: res.status,
        path: requestPath,
        data: payload,
      });
    }

    if (payload.code !== '0') {
      // Per-item failures live in data[0].sCode/sMsg and are more specific than the envelope.
      const item = Array.isArray(payload.data) ? payload.data[0] : undefined;
      const sCode = item?.sCode;
      const msg = item?.sMsg || payload.msg || 'unknown error';
      throw new OkxError(`OKX ${payload.code}${sCode ? `/${sCode}` : ''}: ${msg}`, {
        code: payload.code,
        sCode,
        httpStatus: res.status,
        path: requestPath,
        data: payload.data,
      });
    }

    return payload.data ?? [];
  }

  get(path, params) {
    return this.request('GET', path, { params });
  }

  post(path, body, opts) {
    return this.request('POST', path, { body, ...opts });
  }
}

/** Lazily-created shared client. */
let shared;
export function okx() {
  shared ??= new OkxClient();
  return shared;
}
