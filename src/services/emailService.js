const axios = require('axios');
const nodemailer = require('nodemailer');
const logger = require('../helpers/logger');
const path = require('path');

// Ensure environment variables are loaded
try {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
} catch (e) {}

class EmailService {
  constructor() {
    this.transporter = null;
  }

  /**
   * Send Password Reset Email
   * @param {Object} options
   * @param {string} options.to - Recipient email address
   * @param {string} options.username - Target username
   * @param {string} options.resetLink - Full URL to reset password screen
   * @param {string} options.tenantName - Name of the organization / tenant
   * @param {Object} options.tenantConfig - Optional tenant theme colors & logo
   */
  async sendPasswordResetEmail({ to, username, resetLink, tenantName = 'isomorphic', tenantConfig = {} }) {
    const brandColor = tenantConfig.ButtonandLeftBarColor || '#0A2240';
    const buttonFontColor = tenantConfig.buttonFontColor || '#ffffff';
    const logoUrl = tenantConfig.logoBigUrl || tenantConfig.logoSmallUrl || '';
    const orgTitle = tenantConfig.instituteName || tenantName || 'isomorphic AI';
    const supportTitle = 'Isomorphic Support';

    const subject = `Password Reset Request - ${orgTitle}`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${subject}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 24px; color: #334155; }
          .container { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
          .header { background-color: ${brandColor}; padding: 28px 24px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
          .content { padding: 32px 28px; }
          .greeting { font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #0f172a; }
          .text { font-size: 14px; line-height: 1.6; color: #475569; margin-bottom: 24px; }
          .btn-container { text-align: center; margin: 28px 0; }
          .btn { display: inline-block; background-color: ${brandColor}; color: ${buttonFontColor} !important; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-size: 14px; font-weight: 600; letter-spacing: 0.2px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .link-fallback { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 11px; word-break: break-all; color: #64748b; margin-top: 20px; }
          .footer { padding: 20px 28px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            ${logoUrl ? `<img src="${logoUrl}" alt="${orgTitle}" style="max-height: 48px; max-width: 220px; object-fit: contain; margin-bottom: 8px;" />` : ''}
            <h1>${orgTitle}</h1>
          </div>
          <div class="content">
            <div class="greeting">Hello ${username},</div>
            <p class="text">
              We received a request to reset your password for your <strong>${orgTitle}</strong> organization account.
              Click the button below to set a new password.
            </p>
            <div class="btn-container">
              <a href="${resetLink}" target="_blank" class="btn" style="color: ${buttonFontColor};">Reset My Password</a>
            </div>
            <p class="text" style="font-size: 12px; color: #64748b; margin-bottom: 8px;">
              ⏱️ This link is valid for <strong>1 hour</strong>. If you did not request a password reset, you can safely ignore this email; your account remains secure.
            </p>
            <div class="link-fallback">
              Or copy and paste this link in your browser:<br/>
              <a href="${resetLink}" style="color: ${brandColor};">${resetLink}</a>
            </div>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} ${supportTitle} • Contact: <a href="mailto:help@isomorphic.in" style="color: #64748b; text-decoration: underline;">help@isomorphic.in</a> • Organization: ${orgTitle}
          </div>
        </div>
      </body>
      </html>
    `;

    const textContent = `Hello ${username},\n\nWe received a request to reset your password for your ${orgTitle} organization account.\n\nPlease reset your password using the following link:\n${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you did not request this, please ignore this email.\n\nNeed assistance? Contact us at help@isomorphic.in\n\nBest regards,\n${supportTitle}`;

    const defaultFromEmail = 'help@isomorphic.in';
    const rawFrom = process.env.SMTP_FROM || `"${supportTitle}" <${defaultFromEmail}>`;
    const fromAddress = rawFrom.replace(/^["']|["']$/g, '').trim();

    logger.info(`[EmailService] Sending password reset email from "${fromAddress}" to "${to}" for user "${username}"...`);

    // =========================================================================
    // PRIMARY METHOD: Google Apps Script Webhook (Instant HTTPS directly from Gmail)
    // =========================================================================
    const scriptUrl = (process.env.GMAIL_SCRIPT_URL || process.env.GOOGLE_SCRIPT_URL || '').trim();
    if (scriptUrl) {
      try {
        const res = await axios.post(scriptUrl, {
          to,
          subject,
          html,
          text: textContent,
          senderName: supportTitle,
          senderEmail: defaultFromEmail,
          replyTo: defaultFromEmail
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
          maxRedirects: 5
        });

        if (res.status >= 200 && res.status < 400) {
          logger.info(`[EmailService] ⚡ Email sent instantly via Google Apps Script (help@isomorphic.in)! Recipient: ${to}`);
          return { success: true, messageId: 'gmail-script-' + Date.now() };
        }
      } catch (scriptErr) {
        logger.warn(`[EmailService] Google Script Webhook failed: ${scriptErr.message}`);
      }
    }

    // =========================================================================
    // FALLBACK: Direct SMTP (Only if GMAIL_SCRIPT_URL is not configured or failed)
    // =========================================================================
    const user = (process.env.SMTP_USER || '').trim();
    if (user && process.env.SMTP_PASS) {
      try {
        const rawPass = (process.env.SMTP_PASS || '').trim();
        const pass = user.endsWith('@gmail.com') ? rawPass.replace(/\s+/g, '') : rawPass;
        const port = parseInt(process.env.SMTP_PORT || '465', 10);
        const secure = process.env.SMTP_SECURE === 'true' || port === 465;

        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port,
          secure,
          auth: { user, pass },
          tls: { rejectUnauthorized: false },
          connectionTimeout: 5000,
          greetingTimeout: 5000,
          socketTimeout: 5000
        });

        const info = await transporter.sendMail({
          from: fromAddress,
          replyTo: defaultFromEmail,
          to,
          subject,
          html,
          text: textContent
        });

        logger.info(`[EmailService] Email sent via direct SMTP from "${fromAddress}"! MessageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
      } catch (smtpErr) {
        logger.warn(`[EmailService] Direct SMTP failed: ${smtpErr.message}`);
      }
    }

    logger.error(`[EmailService] All email delivery attempts failed.`);
    return {
      success: false,
      error: 'Email delivery failed. Please ensure GMAIL_SCRIPT_URL is configured in environment.',
      resetLink
    };
  }
}

module.exports = new EmailService();
