import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.KOX_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { encryptSecret, decryptSecret, intentHash, generateOtp, hashCode, safeEqual } = await import(
  '../src/auth/crypto.js'
);
const { sign } = await import('../src/okx/client.js');

test('signature matches the OKX v5 scheme', () => {
  const args = {
    timestamp: '2020-12-08T09:08:57.715Z',
    method: 'GET',
    requestPath: '/api/v5/account/balance?ccy=BTC',
    body: '',
    secret: '22582BD0CFF14C41EDBF1AB98506286D',
  };
  const expected = crypto
    .createHmac('sha256', args.secret)
    .update(args.timestamp + args.method + args.requestPath + args.body)
    .digest('base64');

  assert.equal(sign(args), expected);
});

test('signature covers the request body', () => {
  const base = { timestamp: 't', method: 'POST', requestPath: '/p', secret: 's' };
  assert.notEqual(
    sign({ ...base, body: '{"amt":"1"}' }),
    sign({ ...base, body: '{"amt":"1000"}' }),
  );
});

test('secrets round-trip through encryption', () => {
  const enc = encryptSecret('JBSWY3DPEHPK3PXP');
  assert.equal(decryptSecret(enc), 'JBSWY3DPEHPK3PXP');
});

test('each encryption uses a fresh salt and iv', () => {
  assert.notEqual(encryptSecret('same'), encryptSecret('same'));
});

test('decryption fails with the wrong key', () => {
  const enc = encryptSecret('secret-value');
  assert.throws(() => decryptSecret(enc, 'x'.repeat(44)), /does not match/);
});

test('tampered ciphertext is rejected by the auth tag', () => {
  const [v, salt, iv, tag, ct] = encryptSecret('secret-value').split('.');
  const flipped = Buffer.from(ct, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(() => decryptSecret([v, salt, iv, tag, flipped.toString('base64')].join('.')));
});

test('intent hash ignores key order but tracks values', () => {
  assert.equal(intentHash({ a: 1, b: 2 }), intentHash({ b: 2, a: 1 }));
  assert.notEqual(intentHash({ amount: '1' }), intentHash({ amount: '10' }));
});

test('otp codes are six digits and vary', () => {
  const codes = new Set(Array.from({ length: 200 }, () => generateOtp(6)));
  for (const c of codes) assert.match(c, /^\d{6}$/);
  assert.ok(codes.size > 150, 'expected high entropy across samples');
});

test('otp hashes are bound to their intent', () => {
  assert.notEqual(hashCode('123456', 'intent-a'), hashCode('123456', 'intent-b'));
  assert.ok(safeEqual(hashCode('123456', 'i'), hashCode('123456', 'i')));
});

test('safeEqual rejects differing values and lengths', () => {
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});
