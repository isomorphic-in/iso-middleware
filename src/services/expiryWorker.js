const mongoose = require('mongoose');
const logger = require('../helpers/logger');

class ExpiryWorker {
  constructor() {
    this.interval = null;
  }

  /**
   * Start periodic check for expiring knowledge URLs (every 30 minutes)
   * and inactive sessions older than 20 minutes (every 60 seconds)
   */
  start(intervalMs = 30 * 60 * 1000) {
    if (this.interval) return;
    logger.info('[Expiry Worker] Starting background link expiry & 20-min session auto-closer worker...');
    
    // Initial checks after 10s
    setTimeout(() => {
      this.checkExpiringLinks().catch(() => {});
      this.checkInactiveSessions().catch(() => {});
    }, 10000);

    // Periodic check for expiring knowledge links
    this.interval = setInterval(() => {
      this.checkExpiringLinks().catch(err => {
        logger.error(`[Expiry Worker] Error in link expiry check: ${err.message}`);
      });
    }, intervalMs);

    // Periodic check for 20-min inactive chat sessions (every 60 seconds)
    this.sessionInterval = setInterval(() => {
      this.checkInactiveSessions().catch(err => {
        logger.error(`[Expiry Worker] Error in session auto-closer: ${err.message}`);
      });
    }, 60 * 1000);
  }

  /**
   * Stop background worker
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.sessionInterval) {
      clearInterval(this.sessionInterval);
      this.sessionInterval = null;
    }
    logger.info('[Expiry Worker] Background worker stopped.');
  }

  /**
   * Automatically end chat sessions that have been idle for more than 20 minutes
   */
  async checkInactiveSessions() {
    if (mongoose.connection.readyState !== 1) return;

    try {
      const client = mongoose.connection?.client 
        || (mongoose.connection && typeof mongoose.connection.getClient === 'function' && mongoose.connection.getClient())
        || (mongoose.connections && mongoose.connections[0] && mongoose.connections[0].client);

      const masterDb = client ? client.db('master') : mongoose.connection.useDb('master').db;
      if (!masterDb || typeof masterDb.collection !== 'function') return;
      const col = masterDb.collection('conversationHistory');

      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);

      // Find distinct active sessions with last activity older than 20 minutes
      const inactiveSessions = await col.aggregate([
        { $match: { sessionStatus: 'active' } },
        {
          $group: {
            _id: '$sessionId',
            lastActivityAt: { $max: '$createdAt' }
          }
        },
        { $match: { lastActivityAt: { $lte: twentyMinutesAgo } } }
      ]).toArray();

      if (inactiveSessions.length > 0) {
        for (const s of inactiveSessions) {
          const autoEndAt = new Date(s.lastActivityAt.getTime() + 20 * 60 * 1000);
          await col.updateMany(
            { sessionId: s._id, sessionStatus: 'active' },
            { 
              $set: { 
                sessionStatus: 'ended', 
                sessionEndAt: autoEndAt,
                'metadata.endReason': 'auto_inactivity_20m',
                updatedAt: new Date()
              } 
            }
          );
          logger.info(`[Expiry Worker] Auto-closed session "${s._id}" after 20 minutes of inactivity.`);
        }
      }
    } catch (err) {
      logger.error(`[Expiry Worker] checkInactiveSessions failed: ${err.message}`);
    }
  }

  /**
   * Scan all active tenant databases for expired knowledge sources
   */
  async checkExpiringLinks() {
    if (mongoose.connection.readyState !== 1) return;

    try {
      const masterDb = mongoose.connection.useDb('master', { useCache: true });
      const tenants = await masterDb.collection('tenantInfo').find({ tenantActive: true }).toArray();

      const now = new Date();

      for (const t of tenants) {
        const dbName = t.tenantDbName || `iso_${t.tenantId}`;
        const tenantDb = mongoose.connection.useDb(dbName, { useCache: true });
        
        // Find sources where link is expired and notification is enabled but not yet sent
        const expiringSources = await tenantDb.collection('ingestion_sources').find({
          expiryNotificationEnabled: true,
          notificationSent: { $ne: true },
          linkExpiry: { $ne: null, $lte: now }
        }).toArray();

        for (const s of expiringSources) {
          logger.warn(`[Expiry Worker] 🚨 LINK EXPIRED: "${s.sourceUrl}" for Bot "${s.botName}" (${s.botId}) in Tenant "${s.tenantName}". Email Alert To: ${s.notificationEmail || 'N/A'}`);

          // Send notification email if configured
          if (s.notificationEmail && s.notificationEmail.includes('@')) {
            try {
              const emailService = require('./emailService');
              const orgTitle = t.tenantName || t.name || 'ISO Knowledge Base';
              const subject = `⚠️ Knowledge Source Link Expired - ${s.title || s.sourceUrl}`;
              const textContent = `Hello,\n\nThe following knowledge source link for Bot "${s.botName || s.botId}" has expired:\n\nURL: ${s.sourceUrl}\nExpiry Date: ${new Date(s.linkExpiry).toISOString()}\n\nPlease update or rescrape this resource in your admin portal.\n\nBest regards,\n${orgTitle} Admin Engine`;
              
              if (process.env.GMAIL_SCRIPT_URL || process.env.SMTP_USER) {
                const axios = require('axios');
                const scriptUrl = (process.env.GMAIL_SCRIPT_URL || process.env.GOOGLE_SCRIPT_URL || '').trim();
                if (scriptUrl) {
                  await axios.post(scriptUrl, {
                    to: s.notificationEmail,
                    subject,
                    html: `<p>The following knowledge source link for Bot <strong>${s.botName || s.botId}</strong> in <strong>${orgTitle}</strong> has expired:</p><p><a href="${s.sourceUrl}">${s.sourceUrl}</a></p><p>Expired on: ${new Date(s.linkExpiry).toLocaleString()}</p>`,
                    text: textContent,
                    senderName: orgTitle
                  }).catch(() => {});
                }
              }
            } catch (mailErr) {
              logger.warn(`[Expiry Worker] Failed to send link expiry notification: ${mailErr.message}`);
            }
          }

          // Mark status as expired & notificationSent as true
          await tenantDb.collection('ingestion_sources').updateOne(
            { _id: s._id },
            { 
              $set: { 
                status: 'expired',
                notificationSent: true,
                notificationSentAt: new Date()
              }
            }
          );

          // Update chunks status to expired
          await tenantDb.collection('rag_chunks').updateMany(
            { sourceId: s._id },
            { $set: { 'metadata.status': 'expired' } }
          );
        }
      }
    } catch (err) {
      logger.error(`[Expiry Worker] checkExpiringLinks failed: ${err.message}`);
    }
  }
}

module.exports = new ExpiryWorker();
