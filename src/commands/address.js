import { log, table, colors } from '../util/logger.js';
import { shortAddr } from '../util/redact.js';
import { config } from '../config.js';
import * as repo from '../db/repo.js';
import * as funding from '../okx/funding.js';
import { requireApproval } from '../auth/gate.js';

/** Compare addresses, ignoring a ":memo" suffix and the case of EVM (0x) addresses. */
function sameAddr(a, b) {
  const norm = (s) => {
    const base = String(s ?? '').split(':')[0].trim();
    return /^0x/i.test(base) ? base.toLowerCase() : base;
  };
  return Boolean(a && b) && norm(a) === norm(b);
}

/**
 * Add a withdrawal destination to the local allow-list.
 *
 * This is itself a guarded action: if it were not, an attacker with shell access
 * could simply add their own address and withdraw to it.
 */
export async function addAddressCommand(opts) {
  for (const required of ['label', 'ccy', 'chain', 'addr']) {
    if (!opts[required]) throw new Error(`--${required} is required`);
  }
  if (repo.findAddressByLabel(opts.label)) {
    throw new Error(`Label "${opts.label}" is already used. Pick another or remove it first.`);
  }

  const ccy = opts.ccy.toUpperCase();
  await requireApproval({
    action: 'add-address',
    intent: { action: 'add-address', label: opts.label, ccy, chain: opts.chain, addr: opts.addr, memo: opts.memo ?? null },
    summary: [
      `Label    ${opts.label}`,
      `Currency ${ccy}`,
      `Network  ${opts.chain}`,
      `Address  ${opts.addr}`,
      ...(opts.memo ? [`Memo     ${opts.memo}`] : []),
      '',
      'Once saved, withdrawals to this address need only the usual approval.',
    ],
    requireTypedConfirm: opts.addr.slice(-6),
  });

  repo.addAddress({
    label: opts.label,
    ccy,
    chain: opts.chain,
    addr: opts.addr,
    memo: opts.memo,
    note: opts.note,
  });
  repo.audit('address.add', true, { label: opts.label, ccy, chain: opts.chain, addr: opts.addr });
  log.ok(`saved "${opts.label}" → ${shortAddr(opts.addr)}`);
}

export function listAddressCommand() {
  const rows = repo.listAddresses();
  log.plain('');
  table(
    rows.map((a) => ({
      label: a.label,
      ccy: a.ccy,
      chain: a.chain,
      address: a.addr,
      memo: a.memo ?? '-',
      added: a.added_at.slice(0, 10),
      note: a.note ?? '',
    })),
  );
  return rows;
}

/**
 * Report whether an address is usable as a withdrawal destination.
 *
 * OKX's API cannot read the exchange-side withdrawal whitelist, so the OKX half
 * of this check uses withdrawal history: an address OKX already paid out to was
 * on the whitelist at that time. Read-only; needs no approval.
 */
export async function checkAddressCommand(addrRaw, opts = {}) {
  const addr = String(addrRaw).trim();
  const ccy = opts.ccy ? String(opts.ccy).toUpperCase() : undefined;
  const chainMatches = (c) => !opts.chain || String(c ?? '').toLowerCase() === opts.chain.toLowerCase();

  const local = repo
    .listAddresses()
    .filter((a) => sameAddr(a.addr, addr) && (!ccy || a.ccy === ccy) && chainMatches(a.chain));

  log.plain('');
  log.plain(`${colors.bold}Local address book${colors.reset}`);
  if (local.length) {
    table(local.map((a) => ({ label: a.label, ccy: a.ccy, chain: a.chain, memo: a.memo ?? '-', added: a.added_at.slice(0, 10) })));
  } else {
    log.warn('not saved — kox will refuse to withdraw here until it is added with: kox address add');
  }

  log.plain('');
  log.plain(`${colors.bold}OKX withdrawal history${colors.reset} ${colors.dim}(last 100 withdrawals)${colors.reset}`);
  let history = null;
  if (!config.okx.apiKey || !config.okx.apiSecret || !config.okx.passphrase) {
    log.warn('skipped — OKX credentials are not set');
  } else {
    try {
      const rows = await funding.getWithdrawalHistory({ ccy, limit: 100 });
      history = rows.filter((r) => sameAddr(r.to, addr) && chainMatches(r.chain));
    } catch (err) {
      log.warn(`could not read OKX withdrawal history: ${err.message}`);
    }
  }
  if (history?.length) {
    table(
      history.map((r) => ({
        when: r.ts ? new Date(Number(r.ts)).toISOString().slice(0, 16).replace('T', ' ') : '-',
        ccy: r.ccy,
        chain: r.chain ?? '-',
        amount: r.amt,
        state: funding.describeWithdrawalState(r.state).label,
      })),
    );
    if (history.some((r) => funding.describeWithdrawalState(r.state).status === 'success')) {
      log.ok('OKX has paid out to this address before, so it was on your OKX whitelist at that time');
    }
  } else if (history) {
    log.plain('  no withdrawals to this address found');
  }

  log.plain('');
  log.plain(
    `${colors.dim}OKX's API cannot read your OKX withdrawal whitelist itself. To be certain, check it in OKX: ` +
      `Assets → Withdraw → Address book.${colors.reset}`,
  );

  repo.audit('address.check', true, { ccy, chain: opts.chain, local: local.length, okxHistory: history?.length ?? null });
  return { local, okxHistory: history };
}

export async function removeAddressCommand(label) {
  const entry = repo.findAddressByLabel(label);
  if (!entry) throw new Error(`No address book entry labelled "${label}"`);

  // Removal is not dangerous (it only narrows what is permitted), so a plain
  // confirmation is enough here.
  const { confirm } = await import('@inquirer/prompts');
  const sure = await confirm({
    message: `Remove "${label}" (${entry.ccy} ${shortAddr(entry.addr)})?`,
    default: false,
  });
  if (!sure) return log.warn('cancelled');

  repo.removeAddress(label);
  repo.audit('address.remove', true, { label });
  log.ok(`removed "${label}"`);
}
