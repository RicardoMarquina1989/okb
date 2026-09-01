import { log, table } from '../util/logger.js';
import { shortAddr } from '../util/redact.js';
import * as repo from '../db/repo.js';
import { requireApproval } from '../auth/gate.js';

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
