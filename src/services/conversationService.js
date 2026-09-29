const mongoose = require('mongoose');
const logger = require('../helpers/logger');

class ConversationService {
  /**
   * Helper: Get native master database connection
   */
  getMasterDb() {
    if (mongoose.connection.readyState !== 1) {
      return null;
    }

    const client = mongoose.connection?.client 
      || (mongoose.connection && typeof mongoose.connection.getClient === 'function' && mongoose.connection.getClient())
      || (mongoose.connections && mongoose.connections[0] && mongoose.connections[0].client);

    if (client && typeof client.db === 'function') {
      return client.db('master');
    }
    const conn = mongoose.connection.useDb('master', { useCache: true });
    return (conn && conn.client && typeof conn.client.db === 'function') ? conn.client.db('master') : (conn.db || conn);
  }

  /**
   * Record a single conversation turn in master > conversationHistory
   */
  async recordExchange({
    sessionId,
    botId,
    tenantId,
    userQuery,
    botResponse,
    metadata = {},
    clientInfo = {},
    queryReceivedAt = new Date(),
    responseGivenAt = new Date()
  }) {
    if (!sessionId) {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    const cleanTenantId = (tenantId || 'onestop').toLowerCase().trim();
    const cleanBotId = (botId || 'isobot').toLowerCase().trim();

    try {
      const masterDb = this.getMasterDb();
      if (!masterDb || typeof masterDb.collection !== 'function') {
        return null;
      }
      const col = masterDb.collection('conversationHistory');

      // 1. Resolve sessionStartAt from the earliest chat document with this sessionId
      let sessionStartAt = queryReceivedAt;
      const firstExchange = await col.find({ sessionId }).sort({ createdAt: 1 }).limit(1).toArray();
      if (firstExchange.length > 0 && firstExchange[0].sessionStartAt) {
        sessionStartAt = firstExchange[0].sessionStartAt;
      }

      // 2. Check if user is saying bye / ending the session
      const queryLower = (userQuery || '').toLowerCase().trim();
      const isBye = /^(bye|goodbye|bye bye|good bye|exit|end chat|end conversation|close chat)\b/i.test(queryLower) ||
                    queryLower === 'bye' ||
                    queryLower === 'goodbye';

      const sessionStatus = isBye ? 'ended' : 'active';
      const sessionEndAt = isBye ? responseGivenAt : null;

      // 3. Construct document representing this specific chat turn
      const chatDoc = {
        sessionId,
        tenantId: cleanTenantId,
        botId: cleanBotId,
        query: userQuery,
        answer: botResponse,
        intent: metadata.intent || 'information_seeking',
        sources: metadata.sources || [],
        retrievedChunksCount: metadata.retrievedChunksCount || 0,
        latencyMs: metadata.latencyMs || 0,
        queryReceivedAt,
        responseGivenAt,
        sessionStartAt,
        sessionEndAt,
        sessionStatus,
        metadata: {
          model: metadata.model || 'openai/gpt-oss-120b',
          provider: metadata.provider || 'groq',
          tokens: metadata.tokens || {}
        },
        clientInfo: {
          ip: clientInfo.ip || '',
          userAgent: clientInfo.userAgent || '',
          referer: clientInfo.referer || ''
        },
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const insertRes = await col.insertOne(chatDoc);

      // 4. If session ended, update all documents in this session with the final sessionEndAt
      if (isBye) {
        await col.updateMany(
          { sessionId },
          { 
            $set: { 
              sessionEndAt, 
              sessionStatus: 'ended', 
              updatedAt: new Date() 
            } 
          }
        );
        logger.info(`[Conversation Service] Session "${sessionId}" marked as ENDED by user exit query.`);
      }

      logger.info(`[Conversation Service] Saved chat turn doc ${insertRes.insertedId} for session "${sessionId}" in master > conversationHistory`);
      return chatDoc;
    } catch (err) {
      logger.error(`[Conversation Service] Failed to save chat to master > conversationHistory: ${err.message}`);
      return null;
    }
  }

  /**
   * Explicitly end a session when chat is closed or reset
   * and save form data in the last chat document where session ended
   */
  async endSession({ sessionId, tenantId, botId, rating, feedback, formData }) {
    if (!sessionId) return null;

    try {
      const masterDb = this.getMasterDb();
      if (!masterDb || typeof masterDb.collection !== 'function') {
        return null;
      }
      const col = masterDb.collection('conversationHistory');

      const endAt = new Date();
      const cleanTenantId = (tenantId || 'onestop').toLowerCase();
      const cleanBotId = (botId || 'isobot').toLowerCase();

      // 1. Mark all previous turns for this session as ended
      await col.updateMany(
        { sessionId },
        { 
          $set: { 
            sessionEndAt: endAt, 
            sessionStatus: 'ended', 
            updatedAt: endAt 
          } 
        }
      );

      // 2. Resolve rating, feedback, and full form payload
      const finalRating = rating ? parseInt(rating, 10) : (formData?.rating ? parseInt(formData.rating, 10) : null);
      const finalFeedback = feedback || formData?.feedback || formData?.comment || '';
      const finalFormData = {
        rating: finalRating,
        feedback: finalFeedback,
        submittedAt: endAt,
        ...(typeof formData === 'object' && formData ? formData : {})
      };

      // 3. Update the LAST chat document where user said bye or cut the chat
      const lastDoc = await col.findOne({ sessionId }, { sort: { createdAt: -1 } });
      if (lastDoc) {
        await col.updateOne(
          { _id: lastDoc._id },
          {
            $set: {
              formData: finalFormData,
              rating: finalRating,
              feedback: finalFeedback,
              sessionEndAt: endAt,
              sessionStatus: 'ended',
              updatedAt: endAt
            }
          }
        );
        logger.info(`[Conversation Service] Attached formData to last chat doc (${lastDoc._id}) for session "${sessionId}".`);
      } else {
        // If user closed before sending messages, create closure document
        await col.insertOne({
          sessionId,
          tenantId: cleanTenantId,
          botId: cleanBotId,
          query: '[Chat Session Closed / Form Submitted]',
          answer: 'Session ended by user.',
          intent: 'session_closure',
          sources: [],
          retrievedChunksCount: 0,
          latencyMs: 0,
          queryReceivedAt: endAt,
          responseGivenAt: endAt,
          sessionStartAt: endAt,
          sessionEndAt: endAt,
          sessionStatus: 'ended',
          formData: finalFormData,
          rating: finalRating,
          feedback: finalFeedback,
          createdAt: endAt,
          updatedAt: endAt
        });
      }

      // 4. Also store in master > feedback collection for aggregate analytics
      if (finalRating || finalFeedback) {
        try {
          const feedbackCol = masterDb.collection('feedback');
          await feedbackCol.insertOne({
            sessionId,
            tenantId: cleanTenantId,
            botId: cleanBotId,
            rating: finalRating,
            comment: finalFeedback,
            formData: finalFormData,
            createdAt: endAt
          });
        } catch (fErr) {
          logger.warn(`Failed to insert into feedback collection: ${fErr.message}`);
        }
      }

      return { sessionId, sessionEndAt: endAt, formData: finalFormData };
    } catch (err) {
      logger.error(`[Conversation Service] Error ending session "${sessionId}": ${err.message}`);
      return null;
    }
  }

  /**
   * Get all messages for a session from master > conversationHistory
   */
  async getHistory(sessionId, limit = 50) {
    if (!sessionId) return [];
    try {
      const masterDb = this.getMasterDb();
      if (!masterDb || typeof masterDb.collection !== 'function') {
        return [];
      }
      const col = masterDb.collection('conversationHistory');
      return await col.find({ sessionId }).sort({ createdAt: 1 }).limit(limit).toArray();
    } catch (err) {
      logger.error(`[Conversation Service] Error fetching history for session "${sessionId}": ${err.message}`);
      return [];
    }
  }

  /**
   * Generate text transcript of chat session
   */
  async generateTranscript(sessionId) {
    if (!sessionId) return null;
    const history = await this.getHistory(sessionId, 200);
    if (!history || history.length === 0) return null;

    const lines = [];
    lines.push(`=======================================================`);
    lines.push(` CHAT CONVERSATION TRANSCRIPT: ${sessionId}`);
    lines.push(` Exported At: ${new Date().toISOString()}`);
    lines.push(`=======================================================\n`);

    history.forEach((turn) => {
      const time = turn.queryReceivedAt || turn.createdAt ? new Date(turn.queryReceivedAt || turn.createdAt).toLocaleTimeString() : '';
      if (turn.query) {
        lines.push(`[${time}] User: ${turn.query}`);
      }
      if (turn.answer) {
        lines.push(`[${time}] Assistant: ${turn.answer}\n`);
      }
    });

    return lines.join('\n');
  }
}

module.exports = new ConversationService();
