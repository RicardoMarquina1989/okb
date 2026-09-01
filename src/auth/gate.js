import { password, input, confirm } from '@inquirer/prompts';
import { config } from '../config.js';
import { log, colors } from '../util/logger.js';
import * as repo from '../db/repo.js';
import { CHANNELS } from './channels.js';
import * as totp from './totp.js';
import { intentHash, generateOtp, hashCode, safeEqual } from './crypto.js';

export class ApprovalError extends Error {
  constructor(message, { factor } = {}) {
    super(message);
    this.name = 'ApprovalError';
    this.factor = factor;
  }
}

/** Ask for a TOTP code and verify it, burning the token against replay. */
async function verifyTotp(hash) {
  if (!totp.isEnrolled()) {
    throw new ApprovalError('No authenticator enrolled. Run: kox auth setup', { factor: 'totp' });
  }
  for (let attempt = 1; attempt <= config.auth.otpMaxAttempts; attempt++) {
    const code = await password({
      message: `Authenticator code (attempt ${attempt}/${config.auth.otpMaxAttempts}):`,
      mask: '•',
    });
    const result = totp.verifyAndBurn(code, hash);
    if (result.ok) {
      log.ok('authenticator verified');
      return { name: 'totp', verifiedAt: new Date().toISOString() };
    }
    if (result.reason === 'replay') {
      log.warn('that code was already used — wait for the next one to appear');
    } else {
      log.warn('incorrect code');
    }
  }
  throw new ApprovalError('Authenticator verification failed', { factor: 'totp' });
}

/** Send a one-time code over a channel and verify what the user types back. */
async function verifyOtpChannel(channelName, hash, context) {
  const channel = CHANNELS[channelName];
  if (!channel) throw new ApprovalError(`Unknown auth factor: ${channelName}`);
  if (!channel.configured()) {
    throw new ApprovalError(
      `Factor "${channelName}" is enabled in AUTH_FACTORS but not configured.`,
      { factor: channelName },
    );
  }

  const code = generateOtp(6);
  const expiresAt = new Date(Date.now() + config.auth.otpTtlSeconds * 1000).toISOString();

  log.step(`sending ${channelName} code to ${channel.target()} ...`);
  await channel.send(code, context);

  const otpId = repo.insertOtp({
    channel: channelName,
    purpose: 'approval',
    intentHash: hash,
    codeHash: hashCode(code, hash),
    expiresAt,
  });
  log.ok(`${channelName} code sent (valid ${Math.round(config.auth.otpTtlSeconds / 60)} min)`);

  for (let attempt = 1; attempt <= config.auth.otpMaxAttempts; attempt++) {
    const entered = await password({
      message: `Code from ${channelName} (attempt ${attempt}/${config.auth.otpMaxAttempts}):`,
      mask: '•',
    });
    const live = repo.getLiveOtp(hash, channelName);
    if (!live || live.id !== otpId) {
      throw new ApprovalError(`${channelName} code expired — start over`, { factor: channelName });
    }
    repo.bumpOtpAttempts(live.id);

    if (safeEqual(live.code_hash, hashCode(String(entered).trim(), hash))) {
      repo.consumeOtp(live.id);
      log.ok(`${channelName} verified`);
      return { name: channelName, verifiedAt: new Date().toISOString() };
    }
    log.warn('incorrect code');
  }
  throw new ApprovalError(`${channelName} verification failed`, { factor: channelName });
}

/**
 * Gate a sensitive action behind every factor listed in AUTH_FACTORS.
 *
 * The codes are bound to a hash of `intent`, so a code issued for one withdrawal
 * cannot approve a different one. Returns the recorded approval on success and
 * throws ApprovalError on any failure or refusal.
 */
export async function requireApproval({ action, intent, summary, requireTypedConfirm }) {
  const hash = intentHash(intent);
  const factors = config.auth.factors.filter(Boolean);

  log.plain('');
  log.plain(`${colors.bold}${colors.yellow}┌─ CONFIRM ${action.toUpperCase()}${colors.reset}`);
  for (const line of summary) log.plain(`${colors.yellow}│${colors.reset}  ${line}`);
  log.plain(`${colors.yellow}└─${colors.reset}`);
  log.plain('');

  if (!factors.length) {
    log.warn('AUTH_FACTORS is empty — this action is running with NO second factor.');
  }

  // A literal echo-back defeats muscle-memory "yes" on a mistyped address.
  if (requireTypedConfirm) {
    const typed = await input({ message: `Type "${requireTypedConfirm}" to continue:` });
    if (typed.trim() !== requireTypedConfirm) {
      throw new ApprovalError('Confirmation text did not match — aborted');
    }
  } else if (!(await confirm({ message: 'Proceed?', default: false }))) {
    throw new ApprovalError('Declined at confirmation prompt');
  }

  const context = summary.join('\n');
  const verified = [];
  try {
    for (const factor of factors) {
      verified.push(factor === 'totp' ? await verifyTotp(hash) : await verifyOtpChannel(factor, hash, context));
    }
  } catch (err) {
    repo.audit(`approval.${action}`, false, { intent, error: err.message, verified });
    throw err;
  }

  const approvalId = repo.insertApproval({
    action,
    intentHash: hash,
    intent,
    factors: verified,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  repo.audit(`approval.${action}`, true, { intent, factors: verified.map((f) => f.name) });
  repo.purgeExpiredOtps();

  return { approvalId, intentHash: hash, factors: verified };
}
