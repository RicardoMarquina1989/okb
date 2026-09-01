import crypto from 'node:crypto';
import { config } from '../config.js';
import { log, table, colors } from '../util/logger.js';
import { shortAddr } from '../util/redact.js';
import * as repo from '../db/repo.js';
import * as funding from '../okx/funding.js';
import { OkxError } from '../okx/client.js';
import { requireApproval } from '../auth/gate.js';

/** OKX accepts an alphanumeric clientId of up to 32 chars; we use it for idempotency. */
const newClientId = () => crypto.randomBytes(16).toString('hex');

function decimalsOf(value) {
  const [, frac = ''] = String(value).split('.');
  return frac.length;
}

/** Resolve where the funds are going, enforcing the local address book. */
function resolveDestination(opts) {
  if (opts.label) {
    const entry = repo.findAddressByLabel(opts.label);
    if (!entry) {
      const known = repo.listAddresses().map((a) => a.label);
      throw new Error(
        `No address book entry labelled "${opts.label}".` +
          (known.length ? ` Known labels: ${known.join(', ')}` : ' Add one with: kox address add'),
      );
    }
    return {
      ccy: entry.ccy,
      chain: opts.chain ?? entry.chain,
      toAddr: entry.addr,
      memo: opts.memo ?? entry.memo ?? undefined,
      label: entry.label,
    };
  }

  if (!opts.to) throw new Error('Specify a destination with --to <address> or --label <name>');
  if (!opts.ccy) throw new Error('Specify --ccy when using --to');

  const dest = {
    ccy: opts.ccy.toUpperCase(),
    chain: opts.chain,
    toAddr: opts.to,
    memo: opts.memo,
    label: null,
  };

  if (config.limits.requireAddressBook && opts.dest !== 'internal') {
    const known = repo.findAddress(dest.ccy, dest.chain ?? '', dest.toAddr);
    if (!known) {
      throw new Error(
        `Address ${shortAddr(dest.toAddr)} (${dest.ccy} on ${dest.chain ?? '?'}) is not in the local address book.\n` +
          `  Add it first:  kox address add --label <name> --ccy ${dest.ccy} --chain <chain> --addr ${dest.toAddr}\n` +
          `  Or set REQUIRE_ADDRESS_BOOK=false to disable this check (not recommended).`,
      );
    }
    dest.label = known.label;
  }
  return dest;
}

/** Validate the requested amount against OKX chain limits and local ceilings. */
function validateAmount({ amount, chainInfo, ccy }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error(`Invalid amount: ${amount}`);

  if (amt > config.limits.maxWithdrawalAmount) {
    throw new Error(
      `Amount ${amt} exceeds MAX_WITHDRAWAL_AMOUNT (${config.limits.maxWithdrawalAmount})`,
    );
  }

  const already = repo.withdrawnSince(ccy, 24);
  if (already + amt > config.limits.maxDaily) {
    throw new Error(
      `Amount ${amt} would exceed the 24h ceiling for ${ccy}: ` +
        `${already} already requested, limit ${config.limits.maxDaily}`,
    );
  }

  if (!chainInfo) return;

  if (chainInfo.canWd === false || chainInfo.canWd === 'false') {
    throw new Error(`Withdrawals are currently disabled for ${ccy} on ${chainInfo.chain}`);
  }
  const min = Number(chainInfo.minWd);
  const max = Number(chainInfo.maxWd);
  if (Number.isFinite(min) && min > 0 && amt < min) {
    throw new Error(`Amount ${amt} is below the ${chainInfo.chain} minimum of ${min} ${ccy}`);
  }
  if (Number.isFinite(max) && max > 0 && amt > max) {
    throw new Error(`Amount ${amt} is above the ${chainInfo.chain} maximum of ${max} ${ccy}`);
  }
  const tick = Number(chainInfo.wdTickSz);
  if (Number.isFinite(tick) && decimalsOf(amount) > tick) {
    throw new Error(
      `${ccy} on ${chainInfo.chain} allows at most ${tick} decimal place(s); got "${amount}"`,
    );
  }
}

export async function withdrawCommand(opts) {
  const destCode = opts.dest === 'internal' ? funding.DEST.internal : funding.DEST.onchain;
  const isInternal = destCode === funding.DEST.internal;
  const target = resolveDestination(opts);
  const ccy = target.ccy;

  let chainInfo = null;
  if (!isInternal) {
    if (!target.chain) {
      const chains = await funding.getChainInfo(ccy);
      throw new Error(
        `--chain is required for on-chain withdrawals. Available for ${ccy}: ` +
          chains.map((c) => c.chain).join(', '),
      );
    }
    chainInfo = await funding.getChainInfo(ccy, target.chain);
  }

  validateAmount({ amount: opts.amount, chainInfo, ccy });

  const fee = isInternal ? undefined : (opts.fee ?? chainInfo?.minFee);
  if (!isInternal && (fee === undefined || fee === '')) {
    throw new Error(`Could not determine a withdrawal fee for ${ccy}/${target.chain}; pass --fee`);
  }

  // Warn early rather than letting OKX reject after the approval ceremony.
  const [bal] = await funding.getFundingBalances(ccy);
  const available = Number(bal?.availBal ?? 0);
  const needed = Number(opts.amount) + Number(fee ?? 0);
  if (available < needed) {
    log.warn(
      `Funding balance is ${available} ${ccy} but this withdrawal needs ${needed} ` +
        `(${opts.amount} + ${fee ?? 0} fee). OKX will likely reject it.`,
    );
  }

  const intent = {
    action: 'withdraw',
    ccy,
    chain: isInternal ? 'internal' : target.chain,
    amount: String(opts.amount),
    toAddr: target.toAddr,
    memo: target.memo ?? null,
    dest: destCode,
    fee: fee ?? null,
  };

  const summary = [
    `Amount      ${colors.bold}${opts.amount} ${ccy}${colors.reset}`,
    `Network     ${isInternal ? 'OKX internal transfer' : target.chain}`,
    `Fee         ${isInternal ? '(none)' : `${fee} ${ccy}`}`,
    `Total debit ${needed} ${ccy}`,
    `To          ${target.toAddr}`,
    ...(target.memo ? [`Memo/tag    ${target.memo}`] : []),
    ...(target.label ? [`Saved as    ${target.label}`] : []),
    `Balance     ${available} ${ccy} available`,
  ];

  if (opts.dryRun) {
    log.plain('');
    log.warn('DRY RUN — nothing will be submitted');
    for (const line of summary) log.plain('  ' + line);
    return { dryRun: true, intent };
  }

  // Echoing the address tail defeats clipboard-swapping malware.
  const tail = target.toAddr.slice(-6);
  const approval = await requireApproval({
    action: 'withdraw',
    intent,
    summary,
    requireTypedConfirm: tail,
  });

  const clientId = newClientId();
  repo.insertWithdrawal({
    clientId,
    ccy,
    chain: intent.chain,
    amount: intent.amount,
    fee: fee ?? null,
    toAddr: target.toAddr,
    memo: target.memo,
    dest: destCode,
    label: target.label,
    approvedBy: approval.factors.map((f) => f.name),
  });

  log.step(`submitting withdrawal (clientId ${clientId}) ...`);
  let result;
  try {
    [result] = await funding.submitWithdrawal({
      ccy,
      amt: intent.amount,
      dest: destCode,
      toAddr: target.toAddr + (target.memo ? `:${target.memo}` : ''),
      chain: isInternal ? undefined : target.chain,
      fee,
      clientId,
    });
  } catch (err) {
    // A failed POST may still have been accepted upstream. Ask OKX before
    // recording a failure, using clientId as the idempotency key.
    log.warn(`submit errored: ${err.message}`);
    log.step('checking whether OKX accepted it anyway ...');
    const found = await findByClientId(clientId);
    if (found) {
      log.warn('the withdrawal WAS accepted despite the error — recording it');
      repo.markWithdrawalSubmitted(clientId, { wdId: found.wdId, raw: found });
      repo.audit('withdraw.submitted', true, { clientId, wdId: found.wdId, recovered: true });
      return { clientId, wdId: found.wdId, recovered: true };
    }
    repo.markWithdrawalFailed(clientId, err.message);
    repo.audit('withdraw.failed', false, {
      clientId,
      error: err.message,
      code: err instanceof OkxError ? err.code : undefined,
    });
    throw err;
  }

  repo.markWithdrawalSubmitted(clientId, { wdId: result?.wdId, raw: result });
  repo.audit('withdraw.submitted', true, {
    clientId,
    wdId: result?.wdId,
    ccy,
    amount: intent.amount,
    toAddr: target.toAddr,
  });

  log.ok(`withdrawal submitted — wdId ${result?.wdId}`);
  log.plain(`  track it with: ${colors.cyan}kox withdraw status ${clientId}${colors.reset}`);
  return { clientId, wdId: result?.wdId };
}

/** Look up a withdrawal by our clientId in OKX's history. */
async function findByClientId(clientId) {
  try {
    const rows = await funding.getWithdrawalHistory({ clientId });
    return rows.find((r) => r.clientId === clientId) ?? null;
  } catch (err) {
    log.warn(`could not query withdrawal history: ${err.message}`);
    return null;
  }
}

/**
 * Refresh every locally-open withdrawal against OKX. Also recovers rows that
 * were left "pending" because a submit crashed mid-flight.
 */
export async function reconcileCommand() {
  const open = repo.openWithdrawals();
  if (!open.length) {
    log.ok('no open withdrawals to reconcile');
    return [];
  }
  log.step(`reconciling ${open.length} open withdrawal(s) ...`);

  const updates = [];
  for (const row of open) {
    let remote = null;
    try {
      const rows = row.wd_id
        ? await funding.getWithdrawalHistory({ wdId: row.wd_id })
        : await funding.getWithdrawalHistory({ clientId: row.client_id });
      remote = rows.find((r) => r.clientId === row.client_id || r.wdId === row.wd_id) ?? null;
    } catch (err) {
      log.warn(`${row.client_id}: lookup failed — ${err.message}`);
      continue;
    }

    if (!remote) {
      // Nothing upstream: a pending row whose submit never landed is simply dead.
      if (row.status === 'pending') {
        repo.markWithdrawalFailed(row.client_id, 'not found on OKX during reconcile');
        updates.push({ clientId: row.client_id, status: 'failed', note: 'never reached OKX' });
      }
      continue;
    }

    const { label, status } = funding.describeWithdrawalState(remote.state);
    repo.updateWithdrawalState(row.client_id, {
      wdId: remote.wdId,
      state: label,
      txId: remote.txId,
      fee: remote.fee,
      status,
    });
    updates.push({ clientId: row.client_id, wdId: remote.wdId, state: label, status });
  }

  if (updates.length) table(updates);
  repo.audit('withdraw.reconcile', true, { count: updates.length });
  return updates;
}

/** Show one withdrawal, refreshed from OKX. */
export async function statusCommand(clientIdOrWdId) {
  const local =
    repo.getWithdrawal(clientIdOrWdId) ??
    repo.listWithdrawals({ limit: 500 }).find((r) => r.wd_id === clientIdOrWdId);
  if (!local) throw new Error(`No local record for "${clientIdOrWdId}"`);

  let remote = null;
  try {
    const rows = local.wd_id
      ? await funding.getWithdrawalHistory({ wdId: local.wd_id })
      : await funding.getWithdrawalHistory({ clientId: local.client_id });
    remote = rows.find((r) => r.clientId === local.client_id || r.wdId === local.wd_id) ?? null;
  } catch (err) {
    log.warn(`live lookup failed, showing local record only — ${err.message}`);
  }

  if (remote) {
    const { label, status } = funding.describeWithdrawalState(remote.state);
    repo.updateWithdrawalState(local.client_id, {
      wdId: remote.wdId,
      state: label,
      txId: remote.txId,
      fee: remote.fee,
      status,
    });
  }

  const fresh = repo.getWithdrawal(local.client_id);
  log.plain('');
  for (const [k, v] of Object.entries({
    'client id': fresh.client_id,
    'okx wdId': fresh.wd_id ?? '-',
    amount: `${fresh.amount} ${fresh.ccy}`,
    fee: fresh.fee ?? '-',
    chain: fresh.chain ?? '-',
    to: fresh.to_addr,
    memo: fresh.memo ?? '-',
    status: fresh.status,
    'okx state': fresh.okx_state ?? '-',
    'tx id': fresh.tx_id ?? '-',
    'approved by': fresh.approved_by,
    requested: fresh.requested_at,
    updated: fresh.updated_at,
    error: fresh.error ?? '-',
  })) {
    log.plain(`  ${colors.dim}${k.padEnd(12)}${colors.reset}${v}`);
  }
  return fresh;
}

export async function cancelCommand(clientIdOrWdId) {
  const local = repo.getWithdrawal(clientIdOrWdId);
  const wdId = local?.wd_id ?? clientIdOrWdId;
  if (!wdId) throw new Error(`No wdId known for "${clientIdOrWdId}"`);

  await requireApproval({
    action: 'cancel-withdrawal',
    intent: { action: 'cancel', wdId },
    summary: [`Cancel withdrawal ${wdId}`, ...(local ? [`${local.amount} ${local.ccy} to ${shortAddr(local.to_addr)}`] : [])],
  });

  const [res] = await funding.cancelWithdrawal(wdId);
  if (local) {
    repo.updateWithdrawalState(local.client_id, { state: 'canceling', status: 'processing' });
  }
  repo.audit('withdraw.cancel', true, { wdId });
  log.ok(`cancellation requested for ${res?.wdId ?? wdId}`);
  return res;
}
