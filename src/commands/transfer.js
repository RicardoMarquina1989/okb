import crypto from 'node:crypto';
import { confirm } from '@inquirer/prompts';
import { log, colors } from '../util/logger.js';
import { toUnits, fromUnits, floorTo } from '../util/decimal.js';
import * as repo from '../db/repo.js';
import * as funding from '../okx/funding.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACCOUNTS = Object.keys(funding.ACCOUNT);

/** Units of `ccy` that can leave `account` right now. */
export async function transferable(account, ccy) {
  if (account === 'funding') {
    const [bal] = await funding.getFundingBalances(ccy);
    return toUnits(bal?.availBal ?? '0');
  }
  const rows = await funding.getMaxTransferable(ccy);
  return toUnits(rows.find((r) => r.ccy === ccy)?.maxWd ?? '0');
}

/**
 * Decimal places to use for a currency: the coarsest withdrawal precision across
 * its chains, so a "max" amount is accepted everywhere at the cost of dust.
 */
async function decimalsOf(ccy) {
  try {
    const ticks = (await funding.getCurrencies(ccy)).map((c) => Number(c.wdTickSz)).filter(Number.isFinite);
    return ticks.length ? Math.min(...ticks) : 8;
  } catch {
    return 8;
  }
}

/**
 * Submit a transfer and wait until OKX reports it settled. On a submit error,
 * asks OKX by clientId whether it landed anyway before giving up, so a network
 * blip cannot cause a double transfer.
 */
export async function executeTransfer({ ccy, amt, from, to }) {
  const clientId = crypto.randomBytes(16).toString('hex');
  log.step(`moving ${amt} ${ccy} from ${from} to ${to} ...`);

  let transId;
  try {
    const [res] = await funding.submitTransfer({
      ccy,
      amt,
      from: funding.ACCOUNT[from],
      to: funding.ACCOUNT[to],
      clientId,
    });
    transId = res?.transId;
  } catch (err) {
    const [found] = await funding.getTransferState({ clientId }).catch(() => []);
    if (!found) {
      repo.audit('transfer', false, { ccy, amt, from, to, error: err.message });
      throw err;
    }
    log.warn('submit errored but OKX accepted the transfer — continuing');
    transId = found.transId;
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    const [state] = await funding.getTransferState({ transId });
    if (state?.state === 'success') {
      repo.audit('transfer', true, { ccy, amt, from, to, transId });
      log.ok(`moved ${amt} ${ccy} from ${from} to ${to} (transId ${transId})`);
      return { transId, ccy, amt, from, to };
    }
    if (state?.state === 'failed') {
      repo.audit('transfer', false, { ccy, amt, from, to, transId, error: 'failed' });
      throw new Error(`OKX reports transfer ${transId} failed`);
    }
    await sleep(1000);
  }
  repo.audit('transfer', false, { ccy, amt, from, to, transId, error: 'still pending' });
  throw new Error(`Transfer ${transId} is still pending. Check it on OKX before trying again.`);
}

/** Move funds between the user's own funding and trading accounts. */
export async function transferCommand(opts) {
  const ccy = String(opts.ccy).toUpperCase();
  const from = String(opts.from ?? 'trading').toLowerCase();
  const to = String(opts.to ?? (from === 'trading' ? 'funding' : 'trading')).toLowerCase();
  for (const acct of [from, to]) {
    if (!ACCOUNTS.includes(acct)) throw new Error(`Unknown account "${acct}". Use: ${ACCOUNTS.join(', ')}`);
  }
  if (from === to) throw new Error('--from and --to must be different accounts');

  const available = await transferable(from, ccy);
  let amt;
  if (String(opts.amount).toLowerCase() === 'max') {
    amt = floorTo(available, await decimalsOf(ccy));
  } else {
    amt = toUnits(opts.amount);
  }
  if (amt <= 0n) throw new Error(`Nothing to move: ${fromUnits(available)} ${ccy} available in ${from}`);
  if (amt > available) {
    throw new Error(`Only ${fromUnits(available)} ${ccy} can be moved out of ${from} right now`);
  }
  const amount = fromUnits(amt);

  log.plain('');
  log.plain(`  ${colors.bold}Move ${amount} ${ccy}${colors.reset} from ${from} to ${to}`);
  log.plain(`  ${colors.dim}${fromUnits(available)} ${ccy} available in ${from}. The money stays in your OKX account.${colors.reset}`);
  log.plain('');
  if (opts.dryRun) {
    log.warn('DRY RUN — nothing will be moved');
    return { dryRun: true, ccy, amt: amount, from, to };
  }
  if (!opts.yes && !(await confirm({ message: 'Proceed?', default: false }))) {
    log.warn('cancelled');
    return null;
  }
  return executeTransfer({ ccy, amt: amount, from, to });
}
