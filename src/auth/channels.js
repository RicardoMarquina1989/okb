import { config } from '../config.js';
import { log } from '../util/logger.js';
import { mask } from '../util/redact.js';

/**
 * Delivery channels for one-time codes. Each exposes:
 *   configured() -> boolean
 *   target()     -> masked destination for display
 *   send(code, context) -> Promise<void>
 */

let mailer = null;

export const emailChannel = {
  name: 'email',

  configured() {
    return Boolean(config.email.host && config.email.to);
  },

  target() {
    const [user, domain] = String(config.email.to).split('@');
    return domain ? `${mask(user, 1)}@${domain}` : mask(config.email.to);
  },

  async send(code, context) {
    if (!this.configured()) {
      throw new Error('Email OTP requested but SMTP_HOST / OTP_EMAIL_TO are not configured.');
    }
    const nodemailer = (await import('nodemailer')).default;
    mailer ??= nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: config.email.user ? { user: config.email.user, pass: config.email.pass } : undefined,
    });

    const ttlMin = Math.round(config.auth.otpTtlSeconds / 60);
    await mailer.sendMail({
      from: config.email.from,
      to: config.email.to,
      subject: `[kox-bot] Confirmation code ${code}`,
      text: [
        `Your kox-bot confirmation code is: ${code}`,
        ``,
        `It expires in ${ttlMin} minute(s) and authorises exactly this action:`,
        ``,
        context,
        ``,
        `If you did not start this, someone has access to your machine or API keys.`,
        `Revoke the OKX API key immediately.`,
      ].join('\n'),
    });
  },
};

let twilioClient = null;

export const smsChannel = {
  name: 'sms',

  configured() {
    return Boolean(config.sms.accountSid && config.sms.authToken && config.sms.from && config.sms.to);
  },

  target() {
    return mask(config.sms.to, 3);
  },

  async send(code, context) {
    if (!this.configured()) {
      throw new Error(
        'SMS OTP requested but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM / OTP_SMS_TO are not configured.',
      );
    }
    let twilio;
    try {
      twilio = (await import('twilio')).default;
    } catch {
      throw new Error('SMS OTP requires the optional "twilio" package: npm install twilio');
    }
    twilioClient ??= twilio(config.sms.accountSid, config.sms.authToken);

    const firstLine = String(context).split('\n')[0];
    await twilioClient.messages.create({
      from: config.sms.from,
      to: config.sms.to,
      body: `kox-bot code ${code} — ${firstLine}. Expires in ${Math.round(
        config.auth.otpTtlSeconds / 60,
      )}m. Never share this code.`,
    });
  },
};

/**
 * Prints the code to the terminal instead of delivering it. Only for local
 * testing — it provides no second factor, so it refuses to run against live keys.
 */
export const consoleChannel = {
  name: 'console',
  configured: () => true,
  target: () => 'stdout (INSECURE - testing only)',
  async send(code) {
    log.warn(`console channel: code is ${code} — this provides no real second factor`);
  },
};

export const CHANNELS = {
  email: emailChannel,
  sms: smsChannel,
  console: consoleChannel,
};
