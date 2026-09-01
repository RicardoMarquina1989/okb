import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockOkx, CREDS } from './mock-okx.js';

const { OkxClient, OkxError } = await import('../src/okx/client.js');

// Credentials must exist before requireOkxCredentials() runs.
process.env.OKX_API_KEY = CREDS.apiKey;
process.env.OKX_API_SECRET = CREDS.apiSecret;
process.env.OKX_API_PASSPHRASE = CREDS.passphrase;

const mock = await startMockOkx();
const client = () => new OkxClient({ baseUrl: mock.baseUrl, ...CREDS, maxRetries: 2 });

test.after(() => mock.close());

test('a signed GET is accepted by a server validating like OKX', async () => {
  const data = await client().get('/api/v5/account/config');
  assert.equal(data[0].uid, '123456');
});

test('query parameters are part of the signed path', async () => {
  const data = await client().get('/api/v5/asset/balances', { ccy: 'USDT' });
  assert.equal(data[0].ccy, 'USDT');
  assert.equal(mock.calls.at(-1).params.ccy, 'USDT');
});

test('empty and undefined params are dropped from the query', async () => {
  await client().get('/api/v5/asset/balances', { ccy: undefined, foo: '', bar: null });
  assert.deepEqual(mock.calls.at(-1).params, {});
});

test('a bad secret is rejected as an invalid signature', async () => {
  const bad = new OkxClient({ baseUrl: mock.baseUrl, ...CREDS, apiSecret: 'wrong', maxRetries: 0 });
  await assert.rejects(() => bad.get('/api/v5/account/config'), (err) => {
    assert.ok(err instanceof OkxError);
    assert.equal(err.code, '50113');
    return true;
  });
});

test('a bad passphrase surfaces OKX code 50114', async () => {
  const bad = new OkxClient({ baseUrl: mock.baseUrl, ...CREDS, passphrase: 'nope', maxRetries: 0 });
  await assert.rejects(() => bad.get('/api/v5/account/config'), (err) => err.code === '50114');
});

test('rate limits are retried on GET', async () => {
  mock.rateLimitNext(2);
  const data = await client().get('/api/v5/account/config');
  assert.equal(data[0].uid, '123456');
});

test('a POST is never retried automatically', async () => {
  mock.rateLimitNext(1);
  const before = mock.calls.length;
  await assert.rejects(
    () => client().post('/api/v5/asset/withdrawal', { ccy: 'USDT' }, { retryable: false }),
    (err) => err.code === '50011',
  );
  assert.equal(mock.calls.length - before, 1, 'withdrawal POST must be attempted exactly once');
});

test('the simulated flag sets the demo-trading header', async () => {
  const sim = new OkxClient({ baseUrl: mock.baseUrl, ...CREDS, simulated: true });
  await sim.get('/api/v5/account/config');
  assert.equal(mock.calls.at(-1).headers['x-simulated-trading'], '1');
});

test('per-item sCode wins over the envelope message', async () => {
  const m = await startMockOkx({
    overrides: {
      'POST /api/v5/asset/withdrawal': () => ({
        code: '1',
        msg: 'Operation failed.',
        data: [{ sCode: '58207', sMsg: 'Withdrawal address is not whitelisted' }],
      }),
    },
  });
  const c = new OkxClient({ baseUrl: m.baseUrl, ...CREDS });
  await assert.rejects(
    () => c.post('/api/v5/asset/withdrawal', { ccy: 'USDT' }, { retryable: false }),
    (err) => {
      assert.equal(err.sCode, '58207');
      assert.match(err.message, /not whitelisted/);
      return true;
    },
  );
  await m.close();
});
