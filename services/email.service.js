'use strict';

const env = require('../config/env');

/**
 * Stubbed transactional email: no provider is configured yet. In development
 * it prints the message so flows can be tested locally. Anywhere else it
 * prints nothing identifying: email bodies carry live password-reset links
 * (account takeover for anyone who can read the logs), and addresses are PII.
 * Swap this module's body for a real provider (Resend / SES / Postmark)
 * without touching callers.
 */
async function sendEmail({ to, subject, text }) {
  if (env.isTest) return;
  if (env.nodeEnv !== 'development') {
    console.warn(JSON.stringify({ level: 'warn', time: new Date().toISOString(), event: 'email_not_sent', reason: 'no_email_provider_configured' }));
    return;
  }
  console.info('\n--- EMAIL (stub) ---');
  console.info(`To:      ${to}`);
  console.info(`Subject: ${subject}`);
  console.info(text);
  console.info('--- END EMAIL ---\n');
}

async function sendPasswordResetEmail(user, rawToken) {
  const link = `${env.clientOrigin}/reset-password?token=${rawToken}`;
  await sendEmail({
    to: user.email,
    subject: 'Reset your CaseVerse password',
    text: `Hi ${user.name},\n\nReset your password with this link (valid 1 hour):\n${link}\n\nIf you didn't request this, ignore this email.`,
  });
}

module.exports = { sendEmail, sendPasswordResetEmail };
