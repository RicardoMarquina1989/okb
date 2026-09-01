import { log, table } from '../util/logger.js';
import { shortAddr } from '../util/redact.js';
import * as repo from '../db/repo.js';
import * as funding from '../okx/funding.js';

/**
 * Local withdrawal ledger, optionally refreshed from OKX first.
 * Rows OKX knows about but we do not (e.g. withdrawals made in the web UI)
 * are imported so the ledger is complete.
 */
export async function withdrawalHistoryCommand(opts = {}) {
  if (opts.sync) {
    log.step('syncing withdrawal history from OKX ...');
    const rows = await funding.getWithdrawalHistory({
      ccy: opts.ccy ? String(opts.ccy).toUpperCase() : undefined,
      limit: opts.limit ?? 100,
    });

    let imported = 0;
    for (const r of rows) {
      const { label, status } = funding.describeWithdrawalState(r.state);
      const clientId = r.clientId || `okx-${r.wdId}`;

      if (repo.getWithdrawal(clientId)) {
        repo.updateWithdrawalState(clientId, {
          wdId: r.wdId,
          state: label,
          txId: r.txId,
          fee: r.fee,
          status,
        });
        continue;
      }

      // Not ours — most likely made outside this bot. Record it as external.
      repo.insertWithdrawal({
        clientId,
        ccy: r.ccy,
        chain: r.chain,
        amount: r.amt,
        fee: r.fee,
        toAddr: r.to,
        memo: null,
        dest: '4',
        label: 'external',
        approvedBy: ['external'],
      });
      repo.updateWithdrawalState(clientId, {
        wdId: r.wdId,
        state: label,
        txId: r.txId,
        fee: r.fee,
        status,
      });
      imported++;
    }
    log.ok(`synced ${rows.length} record(s), ${imported} newly imported`);
    repo.audit('withdraw.sync', true, { count: rows.length, imported });
  }

  const local = repo.listWithdrawals({ limit: opts.limit ?? 25, status: opts.status });
  log.plain('');
  table(
    local.map((w) => ({
      when: w.requested_at.slice(0, 19).replace('T', ' '),
      ccy: w.ccy,
      amount: w.amount,
      fee: w.fee ?? '-',
      chain: w.chain ?? '-',
      to: w.label ?? shortAddr(w.to_addr),
      status: w.status,
      state: w.okx_state ?? '-',
      id: w.client_id.slice(0, 8),
    })),
  );
  return local;
}
