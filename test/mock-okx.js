import http from 'node:http';
import crypto from 'node:crypto';

export const CREDS = {
  apiKey: 'test-key',
  apiSecret: 'test-secret-0123456789',
  passphrase: 'test-pass',
};

const ok = (data) => ({ code: '0', msg: '', data });

/**
 * Minimal stand-in for the OKX v5 REST API.
 * It verifies the request signature exactly the way OKX does, so a test that
 * passes here proves the client signs correctly.
 */
export function startMockOkx({ overrides = {} } = {}) {
  const calls = [];
  let failNext = 0; // number of upcoming requests to answer with 429

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      const ts = req.headers['ok-access-timestamp'];
      const expected = crypto
        .createHmac('sha256', CREDS.apiSecret)
        .update(ts + req.method + req.url + body)
        .digest('base64');

      if (req.headers['ok-access-key'] !== CREDS.apiKey) {
        return send(401, { code: '50111', msg: 'Invalid API key' });
      }
      if (req.headers['ok-access-passphrase'] !== CREDS.passphrase) {
        return send(401, { code: '50114', msg: 'Invalid passphrase' });
      }
      if (req.headers['ok-access-sign'] !== expected) {
        return send(401, { code: '50113', msg: 'Invalid signature' });
      }

      const [path, query] = req.url.split('?');
      const params = new URLSearchParams(query ?? '');
      calls.push({ method: req.method, path, params: Object.fromEntries(params), body: body ? JSON.parse(body) : null, headers: req.headers });

      if (failNext > 0) {
        failNext--;
        return send(429, { code: '50011', msg: 'Requests too frequent' });
      }

      const handler = overrides[`${req.method} ${path}`];
      if (handler) return send(200, handler({ params, body: body ? JSON.parse(body) : null }));

      switch (`${req.method} ${path}`) {
        case 'GET /api/v5/account/config':
          return send(200, ok([{ uid: '123456', acctLv: '2' }]));

        case 'GET /api/v5/asset/currencies':
          return send(200, ok([
            { ccy: 'USDT', chain: 'USDT-TRC20', canDep: true, canWd: true, minWd: '2', maxWd: '8000000', minFee: '0.8', maxFee: '1.6', wdTickSz: '6', mainNet: true },
            { ccy: 'USDT', chain: 'USDT-ERC20', canDep: true, canWd: true, minWd: '2', maxWd: '8000000', minFee: '3.2', maxFee: '6.4', wdTickSz: '6', mainNet: false },
            { ccy: 'USDT', chain: 'USDT-Polygon', canDep: true, canWd: false, minWd: '2', maxWd: '100000', minFee: '0.1', maxFee: '0.2', wdTickSz: '6' },
          ]));

        case 'GET /api/v5/asset/balances':
          return send(200, ok([{ ccy: 'USDT', bal: '1500.5', frozenBal: '0', availBal: '1500.5' }]));

        case 'GET /api/v5/asset/deposit-address':
          return send(200, ok([
            { chain: 'USDT-TRC20', ccy: 'USDT', to: '6', addr: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', selected: true },
            { chain: 'USDT-ERC20', ccy: 'USDT', to: '6', addr: '0x2c8fbb17e9b1e0d1e9e1b0a1f2c3d4e5f60718293', selected: false },
          ]));

        case 'GET /api/v5/asset/deposit-history':
          return send(200, ok([
            { depId: 'dep-1', ccy: 'USDT', chain: 'USDT-TRC20', amt: '250', from: '', to: 'TQn9Y2kh', txId: 'abc123', state: '2', ts: '1700000000000' },
          ]));

        case 'GET /api/v5/asset/withdrawal-history': {
          const clientId = params.get('clientId');
          const wdId = params.get('wdId');
          if (!clientId && !wdId) return send(200, ok([...MOCK_WD.values()]));
          if (clientId && !MOCK_WD.has(clientId)) return send(200, ok([]));
          const rec = clientId ? MOCK_WD.get(clientId) : [...MOCK_WD.values()].find((r) => r.wdId === wdId);
          return send(200, ok(rec ? [rec] : []));
        }

        case 'POST /api/v5/asset/withdrawal': {
          const b = JSON.parse(body);
          const wdId = String(70000 + MOCK_WD.size);
          MOCK_WD.set(b.clientId, {
            wdId, clientId: b.clientId, ccy: b.ccy, chain: b.chain,
            amt: b.amt, fee: b.fee, to: b.toAddr, state: '2', txId: `0xtx${wdId}`, ts: '1700000000000',
          });
          return send(200, ok([{ ccy: b.ccy, chain: b.chain, amt: b.amt, wdId, clientId: b.clientId }]));
        }

        default:
          return send(404, { code: '51000', msg: `unmocked route ${req.method} ${path}` });
      }
    });
  });

  const MOCK_WD = new Map();

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        calls,
        withdrawals: MOCK_WD,
        rateLimitNext: (n) => (failNext = n),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
