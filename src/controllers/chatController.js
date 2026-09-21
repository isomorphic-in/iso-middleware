const botService = require('../services/botService');
const aiService = require('../services/aiService');
const conversationService = require('../services/conversationService');
const analyticsService = require('../services/analyticsService');
const ApiResponse = require('../helpers/apiResponse');
const logger = require('../helpers/logger');

class ChatController {
  /**
   * POST /api/chat
   * Primary chat query endpoint for chatbot.js widget & portal playground
   */
  async handleChat(req, res, next) {
    const queryReceivedAt = new Date();

    try {
      const {
        query,
        message,
        botId = 'isobot',
        tenantId = '',
        history = [],
        sessionId
      } = req.body;

      const userText = query || message;
      if (!userText || typeof userText !== 'string' || !userText.trim()) {
        return ApiResponse.badRequest(res, 'Message text is required in query or message field');
      }

      // 1. Resolve Bot from dynamic tenant DB
      const bot = await botService.findBotDocument(botId, tenantId);

      // Check if bot is disabled
      if (bot && bot.status === 'inactive') {
        const botName = bot.name || bot.botName || 'ISO AI';
        return res.json({
          response: `The bot "${botName}" is currently offline or inactive. Please contact support.`,
          reply: `The bot "${botName}" is currently offline or inactive. Please contact support.`,
          message: `The bot "${botName}" is currently offline or inactive. Please contact support.`,
          botName,
          timestamp: new Date().toISOString()
        });
      }

      const resolvedSessionId = sessionId || `sess_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
      const resolvedBotId = (bot && (bot.botId || bot.code || bot._id?.toString())) || botId || 'isobot';
      const resolvedTenantId = tenantId || (bot && (bot.tenantId || bot.tenantName)) || 'onestop';

      // 2. Generate Response with Intent Classification & RAG KNN Vector Search
      const result = await aiService.generateResponse({
        bot,
        query: userText.trim(),
        history,
        tenantId: resolvedTenantId,
        botId: resolvedBotId,
        sessionId: resolvedSessionId
      });

      const responseGivenAt = new Date();
      const botName = bot?.botName || bot?.name || 'ISO Bot';

      // 3. Persist Exchange to master > conversationHistory

      conversationService.recordExchange({
        sessionId: resolvedSessionId,
        botId: resolvedBotId,
        tenantId: resolvedTenantId,
        userQuery: userText.trim(),
        botResponse: result.text,
        metadata: {
          model: result.model,
          provider: result.provider,
          tokens: result.tokens,
          latencyMs: result.latencyMs,
          intent: result.intent,
          sources: result.sources,
          retrievedChunksCount: result.retrievedChunksCount
        },
        clientInfo: {
          ip: req.ip,
          userAgent: req.get('user-agent') || '',
          referer: req.get('referer') || ''
        },
        queryReceivedAt,
        responseGivenAt
      }).catch(e => logger.error('Async conversation log error:', e));

      // 4. Record Analytics in Background
      analyticsService.recordQuery({
        botId: resolvedBotId,
        promptTokens: result.tokens?.prompt || 0,
        completionTokens: result.tokens?.completion || 0,
        latencyMs: result.latencyMs,
        query: userText.trim()
      }).catch(e => logger.error('Async analytics log error:', e));

      // 5. Return chatbot.js compatible response payload
      return res.json({
        response: result.text,
        reply: result.text,
        message: result.text,
        botName,
        form: result.form || null,
        isEndChat: Boolean(result.isEndChat || result.intent === 'end_chat'),
        quickReplies: result.quickReplies || bot?.quickReplies || [],
        intent: result.intent || 'information_seeking',
        sources: result.sources || [],
        retrievedChunksCount: result.retrievedChunksCount || 0,
        sessionId: resolvedSessionId,
        latencyMs: result.latencyMs,
        timestamp: responseGivenAt.toISOString()
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/chat/session-end
   * Ends a conversation session and stamps sessionEndAt
   */
  async handleEndSession(req, res, next) {
    try {
      const { sessionId, tenantId, botId, rating, feedback, formData } = req.body;
      if (!sessionId) {
        return ApiResponse.badRequest(res, 'sessionId is required to end session');
      }

      const result = await conversationService.endSession({
        sessionId,
        tenantId,
        botId,
        rating,
        feedback,
        formData: formData || req.body
      });

      return ApiResponse.success(res, {
        message: 'Chat session successfully ended and archived.',
        ...result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/chat/stream
   * Server-Sent Events (SSE) streaming chat endpoint
   */
  async streamChat(req, res, next) {
    try {
      const { query, message, botId = 'isobot', tenantId = '', history = [] } = req.body;
      const userText = query || message;
      if (!userText) {
        return ApiResponse.badRequest(res, 'Message text is required');
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const bot = await botService.findBotDocument(botId, tenantId);
      const result = await aiService.generateResponse({
        bot,
        query: userText.trim(),
        history,
        tenantId
      });

      const words = result.text.split(' ');
      for (let i = 0; i < words.length; i++) {
        const chunk = (i === 0 ? '' : ' ') + words[i];
        res.write(`data: ${JSON.stringify({ chunk, done: false })}\n\n`);
        await new Promise(r => setTimeout(r, 25));
      }

      res.write(`data: ${JSON.stringify({ done: true, fullText: result.text, form: result.form })}\n\n`);
      res.end();
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ChatController();
