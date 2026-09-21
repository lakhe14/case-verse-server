'use strict';

const env = require('../config/env');

/**
 * Stubbed transactional email. Phase 1 logs to the console; swap this module's
 * body for a real provider (Resend / SES / Postmark) without touching callers.
 */
async function sendEmail({ to, subject, text }) {
  if (env.isTest) return;
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
