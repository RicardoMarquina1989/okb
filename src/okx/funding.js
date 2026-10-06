import { okx } from './client.js';

/** Account type codes used by POST /api/v5/asset/transfer. */
export const ACCOUNT = {
  funding: '6',
  trading: '18',
};

/** Withdrawal destination codes used by POST /api/v5/asset/withdrawal. */
export const DEST = {
  internal: '3', // OKX-to-OKX transfer (email / phone / account id)
  onchain: '4',
};

/** OKX withdrawal `state` values, mapped to a local status. */
export const WITHDRAWAL_STATE = {
  '-3': { label: 'canceling', status: 'processing' },
  '-2': { label: 'canceled', status: 'canceled' },
  '-1': { label: 'failed', status: 'failed' },
  0: { label: 'waiting-withdrawal', status: 'processing' },
  1: { label: 'withdrawing', status: 'processing' },
  2: { label: 'success', status: 'success' },
  7: { label: 'approved', status: 'processing' },
  10: { label: 'waiting-transfer', status: 'processing' },
  4: { label: 'waiting-manual-review', status: 'processing' },
  5: { label: 'waiting-manual-review', status: 'processing' },
  6: { label: 'waiting-manual-review', status: 'processing' },
  8: { label: 'waiting-manual-review', status: 'processing' },
  9: { label: 'waiting-manual-review', status: 'processing' },
  12: { label: 'waiting-manual-review', status: 'processing' },
};

/** OKX deposit `state` values. */
export const DEPOSIT_STATE = {
  0: 'waiting-confirmation',
  1: 'credited-cannot-withdraw',
  2: 'completed',
  8: 'pending-suspended',
  11: 'address-blacklisted',
  12: 'account-frozen',
  13: 'subaccount-intercepted',
  14: 'kyc-limit',
};

export function describeWithdrawalState(state) {
  return WITHDRAWAL_STATE[String(state)] ?? { label: `state-${state}`, status: 'processing' };
}

export function describeDepositState(state) {
  return DEPOSIT_STATE[String(state)] ?? `state-${state}`;
}

/* --------------------------------------------------------------- reads */

/** Per-chain currency metadata: withdrawal limits, fees, and enablement flags. */
export function getCurrencies(ccy) {
  return okx().get('/api/v5/asset/currencies', { ccy });
}

/** Find the chain entry for a currency, e.g. ("USDT", "USDT-TRC20"). */
export async function getChainInfo(ccy, chain) {
  const all = await getCurrencies(ccy);
  const forCcy = all.filter((c) => c.ccy.toUpperCase() === ccy.toUpperCase());
  if (!forCcy.length) throw new Error(`Currency ${ccy} is not available on this account`);
  if (!chain) return forCcy;
  const found = forCcy.find((c) => c.chain.toLowerCase() === chain.toLowerCase());
  if (!found) {
    throw new Error(
      `Chain "${chain}" not found for ${ccy}. Available: ${forCcy.map((c) => c.chain).join(', ')}`,
    );
  }
  return found;
}

/** Funding-account balances. */
export function getFundingBalances(ccy) {
  return okx().get('/api/v5/asset/balances', { ccy });
}

/** Trading-account balances. */
export function getTradingBalances(ccy) {
  return okx().get('/api/v5/account/balance', { ccy });
}

/** All deposit addresses OKX has issued for a currency. */
export function getDepositAddresses(ccy) {
  return okx().get('/api/v5/asset/deposit-address', { ccy });
}

export function getDepositHistory({ ccy, depId, txId, state, after, before, limit = 100 } = {}) {
  return okx().get('/api/v5/asset/deposit-history', {
    ccy,
    depId,
    txId,
    state,
    after,
    before,
    limit,
  });
}

export function getWithdrawalHistory({ ccy, wdId, clientId, txId, state, limit = 100 } = {}) {
  return okx().get('/api/v5/asset/withdrawal-history', {
    ccy,
    wdId,
    clientId,
    txId,
    state,
    limit,
  });
}

/** How much of a currency can leave the trading account right now (excludes margin in use). */
export function getMaxTransferable(ccy) {
  return okx().get('/api/v5/account/max-withdrawal', { ccy });
}

/** State of an internal transfer, looked up by OKX transId or our clientId. */
export function getTransferState({ transId, clientId }) {
  return okx().get('/api/v5/asset/transfer-state', { transId, clientId });
}

/** Account metadata — used as a cheap credential/connectivity probe. */
export function getAccountConfig() {
  return okx().get('/api/v5/account/config');
}

/* -------------------------------------------------------------- writes */

/**
 * Submit a withdrawal. Never retried automatically: a timed-out POST may still
 * have been accepted, so recovery goes through reconcile() using clientId.
 */
export function submitWithdrawal({ ccy, amt, dest, toAddr, chain, fee, clientId, areaCode }) {
  const body = { ccy, amt: String(amt), dest, toAddr };
  if (chain) body.chain = chain;
  if (fee !== undefined && fee !== null && fee !== '') body.fee = String(fee);
  if (clientId) body.clientId = clientId;
  if (areaCode) body.areaCode = areaCode;
  return okx().post('/api/v5/asset/withdrawal', body, { retryable: false });
}

/**
 * Move funds between the user's own funding and trading accounts. Never retried
 * automatically, for the same reason as submitWithdrawal.
 */
export function submitTransfer({ ccy, amt, from, to, clientId }) {
  return okx().post(
    '/api/v5/asset/transfer',
    { ccy, amt: String(amt), from, to, type: '0', clientId },
    { retryable: false },
  );
}

export function cancelWithdrawal(wdId) {
  return okx().post('/api/v5/asset/cancel-withdrawal', { wdId }, { retryable: false });
}
