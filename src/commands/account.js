import { log, table, colors } from '../util/logger.js';
import { config } from '../config.js';
import * as repo from '../db/repo.js';
import * as funding from '../okx/funding.js';
import * as totp from '../auth/totp.js';
import { CHANNELS } from '../auth/channels.js';

/** Funding and (optionally) trading balances. */
export async function balanceCommand(opts = {}) {
  const ccy = opts.ccy ? String(opts.ccy).toUpperCase() : undefined;

  const fundingRows = await funding.getFundingBalances(ccy);
  log.plain('');
  log.plain(`${colors.bold}Funding account${colors.reset}`);
  table(
    fundingRows
      .filter((b) => opts.all || Number(b.bal) > 0)
      .map((b) => ({ ccy: b.ccy, balance: b.bal, available: b.availBal, frozen: b.frozenBal })),
  );

  if (opts.trading) {
    const [acct] = await funding.getTradingBalances(ccy);
    log.plain('');
    log.plain(`${colors.bold}Trading account${colors.reset}`);
    table(
      (acct?.details ?? [])
        .filter((d) => opts.all || Number(d.eq) > 0)
        .map((d) => ({ ccy: d.ccy, equity: d.eq, available: d.availBal, frozen: d.frozenBal })),
    );
  }

  repo.audit('account.balance', true, { ccy });
  return fundingRows;
}

/** List the chains available for a currency, with limits and fees. */
export async function currenciesCommand(ccyRaw) {
  const ccy = ccyRaw ? String(ccyRaw).toUpperCase() : undefined;
  const rows = await funding.getCurrencies(ccy);
  log.plain('');
  table(
    rows.map((c) => ({
      ccy: c.ccy,
      chain: c.chain,
      deposit: c.canDep ? 'yes' : 'no',
      withdraw: c.canWd ? 'yes' : 'no',
      'min wd': c.minWd,
      'max wd': c.maxWd,
      'min fee': c.minFee,
      decimals: c.wdTickSz,
    })),
  );
  return rows;
}

/**
 * Check configuration and connectivity without moving anything.
 * Safe to run at any time; makes only read-only API calls.
 */
export async function doctorCommand() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ check: name, result: ok ? 'PASS' : 'FAIL', detail });

  const creds = ['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE'].filter((k) => process.env[k]);
  add('OKX credentials present', creds.length === 3, `${creds.length}/3 set`);

  add(
    'encryption key set',
    Boolean(config.auth.encryptionKey && config.auth.encryptionKey.length >= 32),
    config.auth.encryptionKey ? `${config.auth.encryptionKey.length} chars` : 'missing — run: kox auth keygen',
  );

  add('authenticator enrolled', totp.isEnrolled(), totp.isEnrolled() ? 'ok' : 'run: kox auth setup');

  const factors = config.auth.factors;
  add('auth factors configured', factors.length > 0, factors.join(', ') || 'NONE — withdrawals unguarded');
  for (const f of factors) {
    if (f === 'totp') continue;
    const ch = CHANNELS[f];
    add(`channel "${f}" ready`, Boolean(ch?.configured()), ch ? ch.target() : 'unknown channel');
  }

  add(
    'address book enforced',
    config.limits.requireAddressBook,
    config.limits.requireAddressBook ? 'on' : 'OFF — any address accepted',
  );
  add('address book entries', true, String(repo.listAddresses().length));
  add(
    'withdrawal ceilings',
    true,
    `per-tx ${config.limits.maxWithdrawalAmount}, 24h ${config.limits.maxDaily}`,
  );
  add('mode', true, config.okx.simulated ? 'SIMULATED (demo trading)' : 'LIVE');

  if (creds.length === 3) {
    try {
      const [cfg] = await funding.getAccountConfig();
      add('OKX API reachable', true, `uid ${cfg?.uid ?? '?'}, level ${cfg?.acctLv ?? '?'}`);
    } catch (err) {
      add('OKX API reachable', false, err.message);
    }
    try {
      await funding.getFundingBalances();
      add('read funding balances', true, 'permission ok');
    } catch (err) {
      add('read funding balances', false, err.message);
    }
  }

  log.plain('');
  table(checks);
  const failed = checks.filter((c) => c.result === 'FAIL');
  log.plain('');
  if (failed.length) {
    log.error(`${failed.length} check(s) failed`);
    process.exitCode = 1; // so scripts and CI can gate on a healthy setup
  } else {
    log.ok('all checks passed');
  }
  return checks;
}
