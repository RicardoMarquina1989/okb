import qrcode from 'qrcode-terminal';
import { confirm, password, input } from '@inquirer/prompts';
import { log, table, colors } from '../util/logger.js';
import { config } from '../config.js';
import * as repo from '../db/repo.js';
import * as totp from '../auth/totp.js';
import { generateEncryptionKey } from '../auth/crypto.js';
import { CHANNELS } from '../auth/channels.js';

/** Print a fresh at-rest encryption key for the user to paste into .env. */
export function keygenCommand() {
  log.plain('');
  log.plain('Add this to your .env, then keep a copy somewhere safe:');
  log.plain('');
  log.plain(`  ${colors.bold}KOX_ENCRYPTION_KEY=${generateEncryptionKey()}${colors.reset}`);
  log.plain('');
  log.warn('Changing this key later makes the stored authenticator seed unreadable (re-enroll to fix).');
}

/** Enroll a TOTP authenticator (Google Authenticator, Aegis, 1Password, ...). */
export async function setupCommand(opts = {}) {
  if (totp.isEnrolled() && !opts.force) {
    log.warn('An authenticator is already enrolled. Re-run with --force to replace it.');
    return null;
  }
  if (totp.isEnrolled()) {
    const sure = await confirm({
      message: 'Replacing the enrolled authenticator will invalidate the old one. Continue?',
      default: false,
    });
    if (!sure) return null;
  }

  const label = opts.label ?? (await input({ message: 'Label for this account:', default: 'okx' }));
  const { secret, uri } = totp.enroll({ accountLabel: label });

  log.plain('');
  log.plain('Scan this with your authenticator app:');
  log.plain('');
  qrcode.generate(uri, { small: true });
  log.plain('');
  log.plain(`  Manual entry key: ${colors.bold}${secret}${colors.reset}`);
  log.plain('');
  log.warn('Store that key offline. Losing it locks you out of withdrawals from this bot.');
  log.plain('');

  // Confirm the app is actually in sync before trusting this factor.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await password({ message: 'Enter a code from the app to confirm:', mask: '•' });
    if (totp.verifyCode(code)) {
      repo.audit('auth.setup', true, { label });
      log.ok('authenticator enrolled and verified');
      return { label };
    }
    log.warn('that code did not match — check the device clock and try again');
  }

  repo.deleteFactor('totp');
  repo.audit('auth.setup', false, { label, reason: 'verification failed' });
  throw new Error('Enrollment rolled back — no code verified.');
}

/** Show which factors are enabled and whether each one can actually run. */
export function authStatusCommand() {
  const rows = config.auth.factors.map((f) => {
    if (f === 'totp') {
      return {
        factor: 'totp',
        ready: totp.isEnrolled() ? 'yes' : 'NO',
        target: totp.isEnrolled() ? (repo.getFactor('totp')?.label ?? 'enrolled') : 'run: kox auth setup',
      };
    }
    const ch = CHANNELS[f];
    return {
      factor: f,
      ready: ch?.configured() ? 'yes' : 'NO',
      target: ch ? ch.target() : 'unknown channel',
    };
  });

  log.plain('');
  log.plain(`${colors.bold}Required factors for a withdrawal${colors.reset}`);
  table(rows.length ? rows : [{ factor: '(none)', ready: '-', target: 'AUTH_FACTORS is empty' }]);
  if (!rows.length) log.warn('No second factor is configured — withdrawals are unguarded.');
  return rows;
}

/** Send a test code through a channel so delivery problems surface before a real withdrawal. */
export async function authTestCommand(channelName) {
  const ch = CHANNELS[channelName];
  if (!ch) throw new Error(`Unknown channel "${channelName}". Known: ${Object.keys(CHANNELS).join(', ')}`);
  if (!ch.configured()) throw new Error(`Channel "${channelName}" is not configured.`);

  const { generateOtp } = await import('../auth/crypto.js');
  const code = generateOtp(6);
  log.step(`sending test code to ${ch.target()} ...`);
  await ch.send(code, 'Test message from kox-bot — no funds are moving.');
  log.ok('sent');

  const entered = await input({ message: 'Enter the code you received:' });
  const ok = entered.trim() === code;
  repo.audit('auth.test', ok, { channel: channelName });
  if (ok) log.ok(`${channelName} delivery works`);
  else log.error('codes did not match — check the channel configuration');
  return ok;
}

/** Recent security-relevant events. */
export function auditCommand(limit = 30) {
  const rows = repo.recentAudit(limit);
  log.plain('');
  table(
    rows.map((r) => ({
      when: r.ts.slice(0, 19).replace('T', ' '),
      action: r.action,
      ok: r.ok ? 'yes' : 'NO',
      detail: (r.detail ?? '').slice(0, 80),
    })),
  );
  return rows;
}
