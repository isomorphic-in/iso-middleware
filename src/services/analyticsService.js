const { Analytics, Bot } = require('../models');
const logger = require('../helpers/logger');

class AnalyticsService {
  /**
   * Log query telemetry asynchronously
   */
  async recordQuery({ botId, promptTokens = 0, completionTokens = 0, latencyMs = 0, query = '' }) {
    try {
      if (!botId) return;
      const resolvedBotId = botId.toString();

      let analytics = await Analytics.findOne({ botId: resolvedBotId });

      if (!analytics) {
        analytics = new Analytics({
          botId: resolvedBotId,
          summary: {
            totalConversations: 1,
            totalMessages: 0,
            avgResponseTime: 0,
            userSatisfaction: 100,
            activeUsers: 1
          },
          tokenUsage: { promptTokens: 0, completionTokens: 0 },
          dailyActivity: [],
          topQueries: []
        });
      }

      // Update message counts
      analytics.summary.totalMessages += 1;
      
      // Update average response time
      const totalMsgs = analytics.summary.totalMessages;
      analytics.summary.avgResponseTime = Math.round(
        ((analytics.summary.avgResponseTime * (totalMsgs - 1)) + latencyMs) / totalMsgs
      );

      // Update token usage
      analytics.tokenUsage.promptTokens += Math.round(promptTokens);
      analytics.tokenUsage.completionTokens += Math.round(completionTokens);

      // Update daily activity
      const todayStr = new Date().toISOString().split('T')[0];
      const todayRecord = analytics.dailyActivity.find(d => d.date === todayStr);
      if (todayRecord) {
        todayRecord.messages += 1;
      } else {
        analytics.dailyActivity.push({
          date: todayStr,
          conversations: 1,
          messages: 1
        });
      }

      // Keep only last 30 days of daily activity
      if (analytics.dailyActivity.length > 30) {
        analytics.dailyActivity = analytics.dailyActivity.slice(-30);
      }

      // Track query sentiment/frequency
      if (query && query.length > 3) {
        const cleanQ = query.trim().slice(0, 100);
        const existingQ = analytics.topQueries.find(q => q.query.toLowerCase() === cleanQ.toLowerCase());
        if (existingQ) {
          existingQ.count += 1;
        } else if (analytics.topQueries.length < 25) {
          analytics.topQueries.push({
            query: cleanQ,
            count: 1,
            sentiment: this.detectSentiment(cleanQ)
          });
        }
      }

      await analytics.save();
    } catch (err) {
      logger.error('Failed to record analytics telemetry:', err);
    }
  }

  detectSentiment(text) {
    const t = text.toLowerCase();
    if (t.includes('thank') || t.includes('great') || t.includes('awesome') || t.includes('good') || t.includes('helpful')) {
      return 'positive';
    }
    if (t.includes('bad') || t.includes('error') || t.includes('broken') || t.includes('terrible') || t.includes('worst') || t.includes('fail')) {
      return 'negative';
    }
    return 'neutral';
  }

  /**
   * Fetch analytics for a given bot
   */
  async getBotAnalytics(botId) {
    if (!botId) return null;
    const strBotId = String(botId).trim();
    let query = {};
    if (strBotId.match(/^[0-9a-fA-F]{24}$/)) {
      query = { botId: strBotId };
    } else {
      const bot = await Bot.findOne({ $or: [{ code: strBotId }, { botId: strBotId }] });
      if (bot) {
        query = { $or: [{ botId: bot._id }, { botId: strBotId }] };
      } else {
        query = { botId: strBotId };
      }
    }

    return Analytics.findOne(query).lean();
  }
}

module.exports = new AnalyticsService();
