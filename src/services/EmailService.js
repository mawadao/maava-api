/**
 * Email Service
 *
 * Sends transactional emails via Gmail.
 * Required environment variables:
 *
 *   GMAIL_USER          — your Gmail address (e.g. yourapp@gmail.com)
 *   GMAIL_APP_PASSWORD  — 16-char Gmail App Password (not your login password)
 *                         Generate at: https://myaccount.google.com/apppasswords
 *
 * In development (NODE_ENV !== 'production'), emails are printed to the
 * console instead of being sent, so no setup is required locally.
 */

const nodemailer = require('nodemailer');

const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Barrsa';
const GMAIL_USER   = process.env.GMAIL_USER;
const EMAIL_FROM   = GMAIL_USER ? `${PRODUCT_NAME} <${GMAIL_USER}>` : `${PRODUCT_NAME} <no-reply@barrsa.com>`;
const IS_PROD      = process.env.NODE_ENV === 'production';

/** Lazily-created transporter (avoids startup errors if Gmail is unconfigured). */
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!IS_PROD || !GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    // Development stub — logs to console instead of sending
    _transporter = nodemailer.createTransport({ jsonTransport: true });
    return _transporter;
  }

  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  return _transporter;
}

/**
 * Internal: send an email. In dev mode, log instead of deliver.
 */
async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();

  const info = await transporter.sendMail({
    from: EMAIL_FROM,
    to,
    subject,
    html,
    text,
  });

  if (!IS_PROD || !process.env.SMTP_HOST) {
    // jsonTransport: info.message is the serialized mail object
    console.log(`[EmailService DEV] Would send email to <${to}>: "${subject}"`);
    if (process.env.DEBUG_EMAIL === 'true') {
      console.log(info.message);
    }
  }

  return info;
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

function waitlistConfirmationHtml(displayName) {
  const name = displayName || 'there';
  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1a1a1a">
  <h2 style="color:#4f46e5">🎉 You're on the waitlist!</h2>
  <p>Hi ${name},</p>
  <p>Thanks for signing up for <strong>${PRODUCT_NAME}</strong>! We're currently in alpha
  testing with limited seats available.</p>
  <p>Your request has been received and you've been added to our waitlist.
  We'll review your application and send you an email within 24–48 hours if a spot opens up.</p>
  <p style="margin-top:32px">— The ${PRODUCT_NAME} Team</p>
</body>
</html>`;
}

function waitlistApprovedHtml(displayName) {
  const name = displayName || 'there';
  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1a1a1a">
  <h2 style="color:#16a34a">✅ You're in!</h2>
  <p>Hi ${name},</p>
  <p>Great news — your ${PRODUCT_NAME} account has been approved.
  You can now sign in with the username and password you registered with.</p>
  <p><a href="${process.env.FRONTEND_URL || 'https://barrsa.com'}/auth/login"
     style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
    Sign In to ${PRODUCT_NAME}
  </a></p>
  <p style="margin-top:32px">— The ${PRODUCT_NAME} Team</p>
</body>
</html>`;
}

function waitlistRejectedHtml(displayName) {
  const name = displayName || 'there';
  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1a1a1a">
  <h2>Thanks for your interest in ${PRODUCT_NAME}</h2>
  <p>Hi ${name},</p>
  <p>We appreciate you signing up. Unfortunately, we're not able to offer you
  a spot in our current alpha at this time.</p>
  <p>We may open more seats in the future — keep an eye on our announcements.</p>
  <p style="margin-top:32px">— The ${PRODUCT_NAME} Team</p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send confirmation to a newly waitlisted user.
 */
async function sendWaitlistConfirmation(email, displayName) {
  await sendMail({
    to: email,
    subject: `You're on the ${PRODUCT_NAME} waitlist!`,
    html: waitlistConfirmationHtml(displayName),
    text: `Hi ${displayName || 'there'},\n\nThanks for signing up! You've been added to the ${PRODUCT_NAME} waitlist. We'll be in touch within 24-48 hours.\n\n— The ${PRODUCT_NAME} Team`,
  });
}

/**
 * Send approval email after admin approves a waitlist entry.
 */
async function sendWaitlistApproved(email, displayName) {
  await sendMail({
    to: email,
    subject: `You're in! Your ${PRODUCT_NAME} account is ready`,
    html: waitlistApprovedHtml(displayName),
    text: `Hi ${displayName || 'there'},\n\nYour ${PRODUCT_NAME} account has been approved. Sign in at ${process.env.FRONTEND_URL || 'https://barrsa.com'}/auth/login\n\n— The ${PRODUCT_NAME} Team`,
  });
}

/**
 * Send rejection/decline email.
 */
async function sendWaitlistRejected(email, displayName) {
  await sendMail({
    to: email,
    subject: `An update on your ${PRODUCT_NAME} application`,
    html: waitlistRejectedHtml(displayName),
    text: `Hi ${displayName || 'there'},\n\nThank you for signing up. Unfortunately, we're unable to offer you a spot at this time.\n\n— The ${PRODUCT_NAME} Team`,
  });
}

module.exports = { sendWaitlistConfirmation, sendWaitlistApproved, sendWaitlistRejected };
