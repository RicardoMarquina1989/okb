#!/usr/bin/env node
import { Command } from 'commander';
import { log } from './util/logger.js';
import { ConfigError, config } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { OkxError } from './okx/client.js';
import { ApprovalError } from './auth/gate.js';

import { withdrawCommand, reconcileCommand, statusCommand, cancelCommand } from './commands/withdraw.js';
import { depositAddressCommand, depositHistoryCommand } from './commands/deposit.js';
import { withdrawalHistoryCommand } from './commands/history.js';
import { transferCommand } from './commands/transfer.js';
import { balanceCommand, currenciesCommand, doctorCommand } from './commands/account.js';
import { setupCommand, keygenCommand, authStatusCommand, authTestCommand, auditCommand } from './commands/auth.js';
import { addAddressCommand, listAddressCommand, removeAddressCommand, checkAddressCommand } from './commands/address.js';

const program = new Command();

program
  .name('kox')
  .description('Terminal bot for OKX funding operations — deposit addresses, guarded withdrawals, local ledger')
  .version('1.0.0')
  .option('--simulated', 'force OKX demo-trading mode for this invocation')
  .hook('preAction', (thisCommand) => {
    if (thisCommand.opts().simulated) config.okx.simulated = true;
    getDb(); // apply migrations before any command runs
    if (config.okx.simulated) log.warn('running in SIMULATED mode (x-simulated-trading: 1)');
  });

/* ------------------------------------------------------------- deposit */

const deposit = program.command('deposit').description('receive funds');

deposit
  .command('address <ccy>')
  .description('show (and cache) the deposit address for a currency')
  .option('-c, --chain <chain>', 'restrict to one network, e.g. "USDT-TRC20"')
  .option('-a, --account <code>', 'receiving account: 6 = funding, 18 = trading')
  .option('--qr', 'also render the address as a QR code')
  .action((ccy, opts) => depositAddressCommand(ccy, opts));

deposit
  .command('history')
  .description('sync and list incoming deposits')
  .option('-c, --ccy <ccy>', 'filter by currency')
  .option('-n, --limit <n>', 'number of rows', Number, 25)
  .option('--no-sync', 'read the local ledger without calling OKX')
  .action((opts) => depositHistoryCommand(opts));

/* ------------------------------------------------------------ withdraw */

const withdraw = program
  .command('withdraw')
  .description('send funds (requires multi-factor approval)');

withdraw
  .command('send', { isDefault: true })
  .description('submit a withdrawal')
  .requiredOption('-a, --amount <amount>', 'amount in the currency being withdrawn, or "max" for everything available')
  .option('-l, --label <label>', 'destination from the address book')
  .option('-t, --to <address>', 'destination address (must be in the address book)')
  .option('-C, --ccy <ccy>', 'currency, required with --to')
  .option('-c, --chain <chain>', 'network, e.g. "USDT-TRC20"')
  .option('-m, --memo <memo>', 'memo / tag / payment id, if the chain needs one')
  .option('-f, --fee <fee>', 'network fee (defaults to the chain minimum)')
  .option('-d, --dest <dest>', 'onchain | internal', 'onchain')
  .option('--no-top-up', 'do not move a shortfall from the trading account first')
  .option('--dry-run', 'validate and print, submit nothing')
  .action((opts) => withdrawCommand(opts));

withdraw
  .command('status <id>')
  .description('refresh and show one withdrawal by client id or wdId')
  .action((id) => statusCommand(id));

withdraw
  .command('reconcile')
  .description('refresh every open withdrawal against OKX')
  .action(() => reconcileCommand());

withdraw
  .command('cancel <id>')
  .description('request cancellation of a pending withdrawal')
  .action((id) => cancelCommand(id));

withdraw
  .command('history')
  .description('list the local withdrawal ledger')
  .option('-c, --ccy <ccy>', 'filter by currency')
  .option('-s, --status <status>', 'filter by local status')
  .option('-n, --limit <n>', 'number of rows', Number, 25)
  .option('--sync', 'import from OKX first (includes withdrawals made elsewhere)')
  .action((opts) => withdrawalHistoryCommand(opts));

/* ------------------------------------------------------- address book */

const address = program.command('address').description('manage the withdrawal allow-list');

address
  .command('add')
  .description('add a destination (guarded by the same factors as a withdrawal)')
  .requiredOption('-l, --label <label>', 'short name to withdraw to later')
  .requiredOption('-C, --ccy <ccy>', 'currency')
  .requiredOption('-c, --chain <chain>', 'network')
  .requiredOption('--addr <address>', 'destination address')
  .option('-m, --memo <memo>', 'memo / tag, if required')
  .option('--note <note>', 'free-text note')
  .action((opts) => addAddressCommand(opts));

address.command('list').description('list saved destinations').action(() => listAddressCommand());
address
  .command('check <address>')
  .description('check an address against the local book and past OKX withdrawals (read-only)')
  .option('-C, --ccy <ccy>', 'restrict to one currency')
  .option('-c, --chain <chain>', 'restrict to one network')
  .action((addr, opts) => checkAddressCommand(addr, opts));
address.command('remove <label>').description('remove a destination').action((l) => removeAddressCommand(l));

/* ------------------------------------------------------------- transfer */

program
  .command('transfer')
  .description('move funds between your own trading and funding accounts')
  .requiredOption('-C, --ccy <ccy>', 'currency')
  .requiredOption('-a, --amount <amount>', 'amount, or "max" for everything the source account can release')
  .option('--from <account>', 'trading | funding', 'trading')
  .option('--to <account>', 'trading | funding (defaults to the other one)')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', 'show what would move, move nothing')
  .action((opts) => transferCommand(opts));

/* -------------------------------------------------------------- account */

program
  .command('balance')
  .description('show funding (and optionally trading) balances')
  .option('-c, --ccy <ccy>', 'filter by currency')
  .option('-t, --trading', 'also show the trading account')
  .option('--all', 'include zero balances')
  .action((opts) => balanceCommand(opts));

program
  .command('currencies [ccy]')
  .description('list chains, limits and fees for a currency')
  .action((ccy) => currenciesCommand(ccy));

program
  .command('doctor')
  .description('check configuration, factors and API connectivity (read-only)')
  .action(() => doctorCommand());

/* ----------------------------------------------------------------- auth */

const auth = program.command('auth').description('manage the local approval factors');

auth
  .command('keygen')
  .description('generate a KOX_ENCRYPTION_KEY for .env')
  .action(() => keygenCommand());

auth
  .command('setup')
  .description('enroll a TOTP authenticator app')
  .option('--force', 'replace an existing enrollment')
  .option('--label <label>', 'label shown in the authenticator app')
  .action((opts) => setupCommand(opts));

auth.command('status').description('show which factors are ready').action(() => authStatusCommand());

auth
  .command('test <channel>')
  .description('send a test code through a channel (email | sms | console)')
  .action((ch) => authTestCommand(ch));

auth
  .command('audit')
  .description('show recent security-relevant events')
  .option('-n, --limit <n>', 'number of rows', Number, 30)
  .action((opts) => auditCommand(opts.limit));

/* ---------------------------------------------------------------- main */

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      process.exitCode = 78; // EX_CONFIG
    } else if (err instanceof ApprovalError) {
      log.error(`Approval failed: ${err.message}`);
      process.exitCode = 77; // EX_NOPERM
    } else if (err instanceof OkxError) {
      log.error(err.message);
      if (err.code === '58207') {
        log.plain('  → the address is not on your OKX withdrawal whitelist; add it in the OKX web UI first');
      } else if (err.code === '50113' || err.code === '50111') {
        log.plain('  → signature/key rejected: check OKX_API_KEY, OKX_API_SECRET and the machine clock');
      } else if (err.code === '50114') {
        log.plain('  → invalid passphrase: OKX_API_PASSPHRASE must be the API passphrase, not the login password');
      } else if (err.code === '50110') {
        log.plain('  → your IP is not on the API key allow-list; add it in the OKX API settings');
      }
      process.exitCode = 1;
    } else if (err?.name === 'ExitPromptError') {
      log.warn('cancelled');
      process.exitCode = 130;
    } else {
      log.error(err?.message ?? String(err));
      if (process.env.LOG_LEVEL === 'debug') log.error(err);
      process.exitCode = 1;
    }
  } finally {
    closeDb();
  }
}

main();
