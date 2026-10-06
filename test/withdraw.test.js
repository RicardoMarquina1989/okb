import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startMockOkx, CREDS } from './mock-okx.js';

const mock = await startMockOkx();

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kox-test-')), 'test.db');
Object.assign(process.env, {
  OKX_BASE_URL: mock.baseUrl,
  OKX_API_KEY: CREDS.apiKey,
  OKX_API_SECRET: CREDS.apiSecret,
  OKX_API_PASSPHRASE: CREDS.passphrase,
  DB_PATH: tmpDb,
  KOX_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  LOG_LEVEL: 'error',
});

const { config } = await import('../src/config.js');
const repo = await import('../src/db/repo.js');
const { closeDb } = await import('../src/db/index.js');
const { withdrawCommand, reconcileCommand } = await import('../src/commands/withdraw.js');
const { depositAddressCommand } = await import('../src/commands/deposit.js');
const { checkAddressCommand } = await import('../src/commands/address.js');
const { transferCommand } = await import('../src/commands/transfer.js');
const { toUnits, fromUnits } = await import('../src/util/decimal.js');

repo.addAddress({
  label: 'cold',
  ccy: 'USDT',
  chain: 'USDT-TRC20',
  addr: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
  memo: null,
});

test.after(async () => {
  closeDb();
  await mock.close();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

const dry = (opts) => withdrawCommand({ dest: 'onchain', dryRun: true, ...opts });

test('a dry run resolves an address-book label without submitting', async () => {
  const before = mock.withdrawals.size;
  const res = await dry({ label: 'cold', amount: '100' });

  assert.equal(res.dryRun, true);
  assert.equal(res.intent.toAddr, 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE');
  assert.equal(res.intent.chain, 'USDT-TRC20');
  assert.equal(res.intent.fee, '0.8', 'fee should default to the chain minimum');
  assert.equal(mock.withdrawals.size, before, 'nothing may be submitted on a dry run');
});

test('an explicit --fee overrides the chain default', async () => {
  const res = await dry({ label: 'cold', amount: '100', fee: '1.2' });
  assert.equal(res.intent.fee, '1.2');
});

test('an address outside the book is refused', async () => {
  await assert.rejects(
    () => dry({ to: 'TStrangeAddressNotSaved', ccy: 'USDT', chain: 'USDT-TRC20', amount: '10' }),
    /not in the local address book/,
  );
});

test('a raw address that is in the book is accepted', async () => {
  const res = await dry({
    to: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
    ccy: 'USDT',
    chain: 'USDT-TRC20',
    amount: '10',
  });
  assert.equal(res.intent.toAddr, 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE');
});

test('an unknown label lists the known ones', async () => {
  await assert.rejects(() => dry({ label: 'nope', amount: '10' }), /Known labels: cold/);
});

test('an unknown chain lists the available chains', async () => {
  await assert.rejects(
    () => dry({ label: 'cold', chain: 'USDT-Fantasy', amount: '10' }),
    /Available: USDT-TRC20, USDT-ERC20, USDT-Polygon/,
  );
});

test('amounts below the chain minimum are refused', async () => {
  await assert.rejects(() => dry({ label: 'cold', amount: '1' }), /below the USDT-TRC20 minimum of 2/);
});

test('amounts above the chain maximum are refused', async () => {
  await assert.rejects(() => dry({ label: 'cold', amount: '9000000' }), /above the .* maximum/);
});

test('excess decimal places are refused', async () => {
  await assert.rejects(() => dry({ label: 'cold', amount: '10.1234567' }), /at most 6 decimal place/);
});

test('a chain with withdrawals disabled is refused', async () => {
  repo.addAddress({ label: 'poly', ccy: 'USDT', chain: 'USDT-Polygon', addr: '0xpoly', memo: null });
  await assert.rejects(() => dry({ label: 'poly', amount: '10' }), /disabled for USDT on USDT-Polygon/);
});

test('non-numeric and negative amounts are refused', async () => {
  await assert.rejects(() => dry({ label: 'cold', amount: 'abc' }), /Invalid amount/);
  await assert.rejects(() => dry({ label: 'cold', amount: '-5' }), /Invalid amount/);
});

test('the per-transaction ceiling is enforced', async () => {
  const original = config.limits.maxWithdrawalAmount;
  config.limits.maxWithdrawalAmount = 50;
  try {
    await assert.rejects(() => dry({ label: 'cold', amount: '100' }), /exceeds MAX_WITHDRAWAL_AMOUNT/);
    await dry({ label: 'cold', amount: '25' }); // under the ceiling: fine
  } finally {
    config.limits.maxWithdrawalAmount = original;
  }
});

test('the rolling 24h ceiling counts prior requests', async () => {
  const original = config.limits.maxDaily;
  config.limits.maxDaily = 500;
  repo.insertWithdrawal({
    clientId: 'seed-daily',
    ccy: 'USDT',
    chain: 'USDT-TRC20',
    amount: '450',
    toAddr: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
    dest: '4',
  });
  try {
    await assert.rejects(() => dry({ label: 'cold', amount: '100' }), /would exceed the 24h ceiling/);
  } finally {
    config.limits.maxDaily = original;
  }
});

test('failed withdrawals do not consume the daily ceiling', () => {
  repo.insertWithdrawal({
    clientId: 'seed-failed',
    ccy: 'BTC',
    chain: 'BTC-Bitcoin',
    amount: '1',
    toAddr: 'bc1qxyz',
    dest: '4',
  });
  assert.equal(repo.withdrawnSince('BTC'), 1);
  repo.markWithdrawalFailed('seed-failed', 'test');
  assert.equal(repo.withdrawnSince('BTC'), 0);
});

test('reconcile pulls the live state into the ledger', async () => {
  const clientId = 'recon-1';
  repo.insertWithdrawal({
    clientId,
    ccy: 'USDT',
    chain: 'USDT-TRC20',
    amount: '10',
    toAddr: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
    dest: '4',
  });
  repo.markWithdrawalSubmitted(clientId, { wdId: '99001' });
  mock.withdrawals.set(clientId, {
    wdId: '99001', clientId, ccy: 'USDT', chain: 'USDT-TRC20',
    amt: '10', fee: '0.8', to: 'TQn9', state: '2', txId: '0xdeadbeef',
  });

  await reconcileCommand();

  const row = repo.getWithdrawal(clientId);
  assert.equal(row.status, 'success');
  assert.equal(row.okx_state, 'success');
  assert.equal(row.tx_id, '0xdeadbeef');
});

test('a pending row that never reached OKX is marked failed', async () => {
  repo.insertWithdrawal({
    clientId: 'ghost-1',
    ccy: 'USDT',
    chain: 'USDT-TRC20',
    amount: '10',
    toAddr: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
    dest: '4',
  });
  await reconcileCommand();
  assert.equal(repo.getWithdrawal('ghost-1').status, 'failed');
});

test('deposit addresses are fetched and cached locally', async () => {
  const rows = await depositAddressCommand('usdt', { chain: 'USDT-TRC20' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].addr, 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE');
  const cached = repo.listDepositAddresses('USDT');
  assert.ok(cached.some((c) => c.chain === 'USDT-TRC20' && c.selected === 1));
});

test('a deposit address request for an unavailable chain explains what exists', async () => {
  await assert.rejects(() => depositAddressCommand('USDT', { chain: 'USDT-Solana' }), /Available: USDT-TRC20, USDT-ERC20/);
});

test('every guarded action left an audit trail', () => {
  const actions = repo.recentAudit(100).map((r) => r.action);
  assert.ok(actions.includes('deposit.address'));
  assert.ok(actions.includes('withdraw.reconcile'));
});

test('address check finds a saved address and past OKX payouts to it', async () => {
  mock.withdrawals.set('paid-1', {
    wdId: '88001', clientId: 'paid-1', ccy: 'USDT', chain: 'USDT-TRC20',
    amt: '40', fee: '0.8', to: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', state: '2', txId: '0xpaid', ts: '1700000000000',
  });
  const res = await checkAddressCommand('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', { ccy: 'usdt' });
  assert.deepEqual(res.local.map((a) => a.label), ['cold']);
  assert.ok(res.okxHistory.some((r) => r.wdId === '88001'));
});

test('address check reports an unknown address as absent everywhere', async () => {
  const res = await checkAddressCommand('TUnknownAddressNeverUsed');
  assert.equal(res.local.length, 0);
  assert.equal(res.okxHistory.length, 0);
});

test('address check ignores case for EVM addresses and respects --chain', async () => {
  assert.equal((await checkAddressCommand('0XPOLY')).local.length, 1);
  assert.equal((await checkAddressCommand('0xpoly', { chain: 'USDT-TRC20' })).local.length, 0);
});

/* Mock balances: funding 1500.5 USDT, trading can release 800.1234567 USDT, TRC20 fee 0.8, 6 decimals. */

test('decimal helpers are exact and drop digits past 8 places', () => {
  assert.equal(fromUnits(toUnits('0.1') + toUnits('0.2')), '0.3');
  assert.equal(fromUnits(toUnits('825.3051766211363')), '825.30517662');
  assert.throws(() => toUnits('-5'), /Invalid amount/);
});

test('a withdrawal within the funding balance needs no top-up', async () => {
  const res = await dry({ label: 'cold', amount: '100' });
  assert.equal(res.intent.topUp, null);
});

test('a withdrawal larger than funding tops up the shortfall from trading', async () => {
  const res = await dry({ label: 'cold', amount: '2000' });
  assert.equal(res.intent.topUp, '500.3'); // 2000 + 0.8 fee - 1500.5 funding
});

test('--amount max sends everything both accounts hold, minus the fee', async () => {
  const res = await dry({ label: 'cold', amount: 'max' });
  assert.equal(res.intent.amount, '2299.823456'); // 1500.5 + 800.123456 - 0.8
  assert.equal(res.intent.topUp, '800.123456');
});

test('a withdrawal larger than both accounts together is refused', async () => {
  await assert.rejects(() => dry({ label: 'cold', amount: '2400' }), /Not enough USDT.*--amount max/s);
});

test('--no-top-up leaves the trading account alone', async () => {
  const res = await dry({ label: 'cold', amount: '2000', topUp: false });
  assert.equal(res.intent.topUp, null);
});

test('transfer max moves everything trading can release, on the currency grid', async () => {
  const before = mock.transfers.size;
  const res = await transferCommand({ ccy: 'usdt', amount: 'max', yes: true });
  assert.equal(res.amt, '800.123456');
  assert.equal(mock.transfers.size, before + 1);
  const sent = [...mock.transfers.values()].at(-1);
  assert.deepEqual([sent.from, sent.to, sent.type, sent.amt], ['18', '6', '0', '800.123456']);
});

test('transfer refuses more than the source account can release', async () => {
  await assert.rejects(() => transferCommand({ ccy: 'USDT', amount: '900', yes: true }), /Only 800.1234567 USDT/);
});

test('transfer dry run moves nothing', async () => {
  const before = mock.transfers.size;
  const res = await transferCommand({ ccy: 'USDT', amount: '10', from: 'funding', dryRun: true });
  assert.equal(res.to, 'trading');
  assert.equal(mock.transfers.size, before);
});
