const intentService = require('./intentService');
const queryRewriterService = require('./queryRewriterService');
const ragSearchService = require('./ragSearchService');
const llmService = require('./llmService');
const genAISettingsService = require('./genAISettingsService');
const conversationService = require('./conversationService');
const logger = require('../helpers/logger');

class AIService {
  /**
   * Main entrypoint to process chat queries through Intent Classification,
   * Query Rewriter, KNN Vector Search, and Groq/LLM generation, fully configured
   * via dynamic tenant genAISettings in MongoDB Atlas.
   */
  async generateResponse({ bot, query, history = [], tenantId = '', botId = '', sessionId = '' }) {
    const startTime = Date.now();
    const resolvedBotId = botId || (bot && (bot.botId || bot.code || bot._id?.toString())) || 'ISOBot';
    const resolvedTenantId = tenantId || (bot && (bot.tenantId || bot.tenantName)) || 'default';
    const resolvedSessionId = sessionId || `sess_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;

    logger.info(`[AI Service] Processing query for tenant "${resolvedTenantId}", bot "${resolvedBotId}", session "${resolvedSessionId}": "${query}"`);

    // Resolve effective conversation history if not supplied in request
    let effectiveHistory = Array.isArray(history) && history.length > 0 ? history : [];
    if (effectiveHistory.length === 0 && resolvedSessionId) {
      try {
        const prevRecords = await conversationService.getHistory(resolvedSessionId, 10);
        if (prevRecords && prevRecords.length > 0) {
          effectiveHistory = [];
          for (const r of prevRecords) {
            if (r.query) effectiveHistory.push({ role: 'user', content: r.query, text: r.query, userQuery: r.query });
            if (r.answer) effectiveHistory.push({ role: 'assistant', content: r.answer, text: r.answer, botResponse: r.answer, response: r.answer });
          }
        }
      } catch (e) {
        logger.warn(`[AI Service] Error resolving session history: ${e.message}`);
      }
    }

    // =========================================================================
    // STEP 0: FETCH GEN AI SETTINGS FROM TENANT DATABASE & CHECK TENANT CONFIG
    // =========================================================================
    const genAISettings = await genAISettingsService.getSettings({
      tenantId: resolvedTenantId,
      botId: resolvedBotId
    });

    // Check if Grievance / Ticket feature is enabled for this tenant
    let isGrievanceEnabled = true;
    try {
      if (resolvedTenantId && resolvedTenantId !== 'default') {
        const mongoose = require('mongoose');
        const masterDb = mongoose.connection.useDb('master', { useCache: true });
        const tenantDoc = await masterDb.collection('tenantInfo').findOne({
          $or: [
            { tenantId: resolvedTenantId },
            { code: resolvedTenantId },
            { tenantName: new RegExp(`^${resolvedTenantId}$`, 'i') }
          ]
        });
        if (tenantDoc && tenantDoc.tenantConfig && tenantDoc.tenantConfig.enableGrievanceSystem === false) {
          isGrievanceEnabled = false;
        }
      }
    } catch (e) {
      logger.warn(`[AI Service] Could not fetch tenantConfig for grievance check: ${e.message}`);
    }

    const botName = bot?.botName || bot?.name || 'ISO AI Assistant';
    const tenantFullName = genAISettings.tenantFullName || bot?.tenantName || resolvedTenantId;

    // Check if GenAI is disabled for this tenant/bot
    if (genAISettings.genAiEnabled === false) {
      logger.info(`[AI Service] GenAI is disabled for bot "${resolvedBotId}". Returning default fallback.`);
      return {
        text: genAISettings.defaultFallbackAnswer || 'Generative AI is currently disabled.',
        intent: 'fallback',
        retrievedChunksCount: 0,
        retrievedChunks: [],
        sources: [],
        tokens: { prompt: 0, completion: 0 },
        latencyMs: Date.now() - startTime,
        model: 'rule-based',
        provider: 'system'
      };
    }

    // =========================================================================
    // STEP 1: INTENT CLASSIFICATION (using tenant genAISettings)
    // =========================================================================
    const classification = await intentService.classifyIntent({
      query,
      history: effectiveHistory,
      bot,
      genAISettings,
      tenantId: resolvedTenantId,
      botId: resolvedBotId,
      isGrievanceEnabled
    });

    logger.info(`[AI Service] Intent detected: "${classification.intent}" (${classification.reason || 'N/A'})`);

    // 1A. End Chat Handler
    if (classification.intent === 'end_chat') {
      const endChatRes = await intentService.handleEndChat({
        query,
        bot,
        history: effectiveHistory,
        genAISettings
      });
      const latencyMs = Date.now() - startTime;
      return {
        text: endChatRes.text,
        intent: 'end_chat',
        isEndChat: true,
        form: 'survey',
        retrievedChunks: [],
        sources: [],
        tokens: endChatRes.tokens || { prompt: 20, completion: 25 },
        latencyMs,
        model: endChatRes.model || genAISettings.textGenerationModel || bot?.model || 'openai/gpt-oss-120b',
        provider: 'groq/llm'
      };
    }

    // 1B. Smalltalk Handler
    if (classification.intent === 'smalltalk') {
      const smalltalkRes = await intentService.handleSmalltalk({
        query,
        bot,
        history: effectiveHistory,
        genAISettings
      });
      const latencyMs = Date.now() - startTime;
      return {
        text: smalltalkRes.text,
        intent: 'smalltalk',
        retrievedChunks: [],
        sources: [],
        tokens: smalltalkRes.tokens || { prompt: 20, completion: 30 },
        latencyMs,
        model: smalltalkRes.model || genAISettings.textGenerationModel || bot?.model || 'openai/gpt-oss-120b',
        provider: 'groq/llm'
      };
    }

    // 1C. Ambiguous Query Handler
    if (classification.intent === 'ambiguous') {
      const ambiguousRes = await intentService.handleAmbiguousQuery({
        query,
        bot,
        history: effectiveHistory,
        genAISettings
      });
      const latencyMs = Date.now() - startTime;
      return {
        text: ambiguousRes.text,
        intent: 'ambiguous',
        retrievedChunks: [],
        sources: [],
        tokens: ambiguousRes.tokens || { prompt: 20, completion: 40 },
        latencyMs,
        model: ambiguousRes.model || genAISettings.textGenerationModel || bot?.model || 'openai/gpt-oss-120b',
        provider: 'groq/llm'
      };
    }

    // 1D. Grievance / Complaint Registration Handler
    if (classification.intent === 'grievance') {
      const grievanceRes = await intentService.handleGrievance({
        query,
        bot,
        history: effectiveHistory,
        genAISettings,
        tenantId: resolvedTenantId,
        botId: resolvedBotId,
        sessionId: resolvedSessionId
      });
      const latencyMs = Date.now() - startTime;
      return {
        text: grievanceRes.text,
        intent: 'grievance',
        ticketId: grievanceRes.ticketId,
        category: grievanceRes.category,
        department: grievanceRes.department,
        priority: grievanceRes.priority,
        retrievedChunks: [],
        sources: [],
        tokens: grievanceRes.tokens || { prompt: 25, completion: 80 },
        latencyMs,
        model: grievanceRes.model || 'system/grievance-engine',
        provider: 'system'
      };
    }

    // 1E. Check Ticket Status Handler
    if (classification.intent === 'check_ticket') {
      const ticketStatusRes = await intentService.handleCheckTicket({
        query,
        ticketId: classification.ticketId,
        bot,
        tenantId: resolvedTenantId
      });
      const latencyMs = Date.now() - startTime;
      return {
        text: ticketStatusRes.text,
        intent: 'check_ticket',
        retrievedChunks: [],
        sources: [],
        tokens: ticketStatusRes.tokens || { prompt: 20, completion: 70 },
        latencyMs,
        model: ticketStatusRes.model || 'system/grievance-engine',
        provider: 'system'
      };
    }

    // =========================================================================
    // STEP 2: QUERY REWRITER & EXPANSION (using tenant genAISettings)
    // =========================================================================
    const expandedQueries = await queryRewriterService.rewriteAndExpandQuery({
      query,
      history: effectiveHistory,
      bot,
      genAISettings,
      tenantId: resolvedTenantId,
      botId: resolvedBotId
    });
    logger.info(`[AI Service] Expanded queries for KNN: ${JSON.stringify(expandedQueries)}`);

    // =========================================================================
    // STEP 3: KNN VECTOR RAG SEARCH (using tenant genAISettings)
    // =========================================================================
    const retrievedChunks = await ragSearchService.performKnnSearch({
      queries: expandedQueries,
      tenantId: resolvedTenantId,
      botId: resolvedBotId,
      topK: parseInt(genAISettings.topK) || 4,
      scoreThreshold: parseFloat(genAISettings.scoreThreshold) || 0.05
    });

    // =========================================================================
    // STEP 4: PROMPT ASSEMBLY & LLM GENERATION (using tenant genAISettings)
    // =========================================================================
    let contextText = '';
    const uniqueSources = [];

    if (retrievedChunks.length > 0) {
      contextText = retrievedChunks.map((c, i) => {
        if (c.sourceUrl && !uniqueSources.includes(c.sourceUrl)) {
          uniqueSources.push(c.sourceUrl);
        }
        const sourceUrl = c.sourceUrl ? ` | Link: ${c.sourceUrl}` : '';
        const title = c.title || 'Knowledge Resource';
        return `[Document ${i + 1}: ${title}${sourceUrl}]\n${c.text}`;
      }).join('\n\n');
    } else {
      contextText = 'No specific knowledge base documents retrieved.';
    }

    // Format chat history according to genAISettings ("History Turns Limit")
    let historyContext = '';
    const includeHistory = genAISettings.includeConversationHistoryInAnswerGeneration !== false;
    const historyLimit = parseInt(genAISettings.conversationHistoryLimit ?? genAISettings.historyTurnsLimit ?? 5);

    const historyMessages = [];
    if (includeHistory && Array.isArray(history) && history.length > 0) {
      const maxMessages = Math.max(1, historyLimit) * 2;
      const recentHistory = history.slice(-maxMessages);
      recentHistory.forEach(h => {
        const isUser = h.role === 'user' || h.sender === 'user';
        const rawContent = h.content || h.text || h.response || h.userQuery || h.message || '';
        const cleanContent = String(rawContent).replace(/<[^>]*>?/gm, '').trim();
        if (cleanContent) {
          historyMessages.push({
            role: isUser ? 'user' : 'assistant',
            content: cleanContent
          });
        }
      });
      historyContext = historyMessages.map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n');
    }

    // 1. Interpolate System Persona Prompt
    const systemPromptTemplate = genAISettings.systemPrompt || genAISettingsService.getDefaultSettings().systemPrompt;
    const systemPersona = genAISettingsService.interpolate(systemPromptTemplate, {
      tenantFullName,
      botName,
      userQuery: query
    });

    // 2. Interpolate Answer Generation Template
    const answerGenTemplate = genAISettings.answerGenerationPrompt || genAISettingsService.getDefaultSettings().answerGenerationPrompt;
    const userPromptContent = genAISettingsService.interpolate(answerGenTemplate, {
      context: contextText,
      userQuery: query,
      chatHistory: historyContext,
      tenantFullName,
      botName
    });

    const messages = [
      { role: 'system', content: systemPersona },
      ...historyMessages,
      { role: 'user', content: userPromptContent }
    ];

    const llmResult = await llmService.chatCompletion({
      messages,
      temperature: parseFloat(genAISettings.temperature) || 0.3,
      maxTokens: parseInt(genAISettings.maxTokens) || 350,
      model: genAISettings.textGenerationModel || bot?.model
    });

    const latencyMs = Date.now() - startTime;
    let finalAnswer = llmResult.content;

    // Check fallback texts if answer appears empty or matched fallback patterns
    const fallbackTexts = Array.isArray(genAISettings.fallbackTexts) ? genAISettings.fallbackTexts : [];
    const isExplicitFallback = fallbackTexts.some(fb => fb && finalAnswer.toLowerCase().includes(fb.toLowerCase()));
    
    if (isExplicitFallback && retrievedChunks.length === 0 && genAISettings.defaultFallbackAnswer) {
      logger.info('[AI Service] LLM indicated no information and 0 chunks retrieved. Using defaultFallbackAnswer.');
      finalAnswer = genAISettings.defaultFallbackAnswer;
    } else {
      // Clean and properly format document citations into valid clickable markdown links
      finalAnswer = this.formatAndSanitizeCitations(finalAnswer, retrievedChunks);

      // If grievance system is enabled and user asked about an issue, append subtle escalation option
      const problemKeywords = ['issue', 'problem', 'delay', 'not received', 'not working', 'failed', 'deducted', 'missing', 'error', 'pending', 'stuck', "haven't", 'has not', 'complaint'];
      const isProblemQuery = problemKeywords.some(kw => query.toLowerCase().includes(kw));
      if (isGrievanceEnabled && isProblemQuery && !finalAnswer.toLowerCase().includes('raise a ticket')) {
        finalAnswer += `\n\n*(💡 If this does not resolve your issue, you can reply **"Raise a ticket"** and I will create an official student grievance for staff review.)*`;
      }
    }

    return {
      text: finalAnswer,
      intent: 'information_seeking',
      retrievedChunksCount: retrievedChunks.length,
      retrievedChunks,
      sources: uniqueSources,
      tokens: llmResult.tokens || { prompt: query.length / 4, completion: finalAnswer.length / 4 },
      latencyMs,
      model: llmResult.model,
      provider: llmResult.provider
    };
  }

  /**
   * Sanitizes ugly raw LLM citation markers (like 【Document 1】, [Document 1], 【source】)
   * and maps them to valid clickable Markdown links if a source URL exists.
   */
  formatAndSanitizeCitations(text, retrievedChunks = []) {
    if (!text || typeof text !== 'string') return text;

    let sanitized = text;

    // 1. Map 【Document N...】 or [Document N...] to markdown links if chunk has URL
    sanitized = sanitized.replace(/【(?:Document|Source|Doc)?\s*(\d+)[^】]*】|\[(?:Document|Source|Doc)\s*(\d+)[^\]]*\]/gi, (match, p1, p2) => {
      const idx = parseInt(p1 || p2, 10);
      if (idx && retrievedChunks[idx - 1]) {
        const chunk = retrievedChunks[idx - 1];
        if (chunk.sourceUrl) {
          const title = chunk.title || `Resource ${idx}`;
          return ` [${title}](${chunk.sourceUrl})`;
        }
      }
      return ''; // Strip if no valid URL to avoid ugly raw brackets
    });

    // 2. Strip leftover raw bracket tokens like 【...†source】 or 【...】 or [1†source]
    sanitized = sanitized.replace(/【[^】]+】/g, '');
    sanitized = sanitized.replace(/\s*\[\d+†source\]/gi, '');
    sanitized = sanitized.replace(/\s*\[\d+:\d+†source\]/gi, '');

    // 3. Fix double spaces and trailing punctuation artifacts
    sanitized = sanitized
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    return sanitized;
  }
}

module.exports = new AIService();
