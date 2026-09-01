import qrcode from 'qrcode-terminal';
import { log, table, colors } from '../util/logger.js';
import * as repo from '../db/repo.js';
import * as funding from '../okx/funding.js';

/**
 * Fetch (and cache) deposit addresses for a currency.
 * OKX issues one address per chain; `selected` marks the account default.
 */
export async function depositAddressCommand(ccyRaw, opts = {}) {
  const ccy = String(ccyRaw).toUpperCase();
  const rows = await funding.getDepositAddresses(ccy);

  if (!rows.length) {
    throw new Error(`OKX returned no deposit address for ${ccy}. Is the currency supported on this account?`);
  }

  // `to` is the receiving account type; 6 = funding, 18 = trading.
  const filtered = rows.filter((r) => {
    if (opts.chain && r.chain?.toLowerCase() !== opts.chain.toLowerCase()) return false;
    if (opts.account && String(r.to) !== String(opts.account)) return false;
    return true;
  });

  if (!filtered.length) {
    throw new Error(
      `No ${ccy} deposit address matched chain "${opts.chain}". ` +
        `Available: ${[...new Set(rows.map((r) => r.chain))].join(', ')}`,
    );
  }

  for (const r of filtered) {
    repo.saveDepositAddress({
      ccy,
      chain: r.chain,
      addr: r.addr,
      memo: r.memo ?? r.tag ?? r.pmtId ?? null,
      selected: r.selected,
    });
  }
  repo.audit('deposit.address', true, { ccy, chain: opts.chain, count: filtered.length });

  const display = filtered.map((r) => ({
    chain: r.chain,
    address: r.addr,
    'memo/tag': r.memo ?? r.tag ?? r.pmtId ?? '-',
    account: String(r.to) === '6' ? 'funding' : String(r.to) === '18' ? 'trading' : r.to,
    default: r.selected ? 'yes' : '',
  }));

  log.plain('');
  table(display);
  log.plain('');
  log.warn(`Send ONLY ${ccy} on the exact network shown. Wrong-network deposits are usually unrecoverable.`);

  const withMemo = filtered.filter((r) => r.memo || r.tag || r.pmtId);
  if (withMemo.length) {
    log.warn('This currency uses a memo/tag — a deposit without it may be lost.');
  }

  if (opts.qr) {
    for (const r of filtered) {
      log.plain('');
      log.plain(`${colors.bold}${ccy} · ${r.chain}${colors.reset}`);
      qrcode.generate(r.addr, { small: true });
      log.plain(`  ${r.addr}`);
    }
  }

  return filtered;
}

/** Pull deposit history from OKX into SQLite and print it. */
export async function depositHistoryCommand(opts = {}) {
  if (opts.sync !== false) {
    log.step('syncing deposit history from OKX ...');
    const rows = await funding.getDepositHistory({
      ccy: opts.ccy ? String(opts.ccy).toUpperCase() : undefined,
      limit: opts.limit ?? 100,
    });
    for (const r of rows) {
      repo.upsertDeposit({
        depId: r.depId,
        ccy: r.ccy,
        chain: r.chain,
        amount: r.amt,
        fromAddr: Array.isArray(r.from) ? r.from.join(',') : r.from,
        toAddr: r.to,
        txId: r.txId,
        state: funding.describeDepositState(r.state),
        okxTs: r.ts ? new Date(Number(r.ts)).toISOString() : null,
        raw: r,
      });
    }
    log.ok(`synced ${rows.length} deposit record(s)`);
    repo.audit('deposit.sync', true, { count: rows.length, ccy: opts.ccy });
  }

  const local = repo.listDeposits({ limit: opts.limit ?? 25, ccy: opts.ccy });
  log.plain('');
  table(
    local.map((d) => ({
      when: (d.okx_ts ?? '').slice(0, 19).replace('T', ' '),
      ccy: d.ccy,
      amount: d.amount,
      chain: d.chain ?? '-',
      state: d.state ?? '-',
      txid: d.tx_id ? `${d.tx_id.slice(0, 12)}…` : '-',
    })),
  );
  return local;
}
