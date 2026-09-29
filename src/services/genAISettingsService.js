const mongoose = require('mongoose');
const cacheService = require('./cacheService');
const logger = require('../helpers/logger');

const DEFAULT_SYSTEM_PROMPT = `You are $$tenantFullName virtual assistant ($$botName), a friendly, intelligent, and concise enterprise AI assistant. Answer user inquiries accurately and helpfully using the provided knowledge base context.`;

const DEFAULT_ANSWER_GENERATION_PROMPT = `<context>
$$context
</context>

User Question: $$userQuery

CHATBOT FORMATTING & CITATION RULES:
1. **Short, Crisp & Professional**: Answer in 2 to 4 concise bullet points or 1-2 short, readable paragraphs. Avoid long unformatted blocks of text.
2. **Formatting**:
   - Use **bold** for important terms, key requirements, and deadlines.
   - Use clean bullet points (• or -) for steps, lists, and features.
3. **Valid Clickable Links (NO Raw Document Tags)**:
   - DO NOT output raw citations like 【Document 1】, [Document 1], 【source】, or [1].
   - When referring to pages, portals, or guidelines from the context, always include valid clickable markdown links: e.g. [Admissions Application Portal](https://...), [Financial Aid Details](https://...).
   - Use meaningful link titles instead of raw URLs or bracket numbers.
4. **Accuracy**: Ground your response in the provided context documents. If the context does not contain sufficient information, state what you know concisely and suggest contacting support.
5. **Tone**: Warm, helpful, professional, and conversational.

Answer:`;

const DEFAULT_QUERY_REWRITE_PROMPT = `You are an expert search query reformulation and contextual query expansion system for a RAG knowledge retrieval system.

Analyze the conversation history and the latest user query. Pay special attention to follow-up questions (e.g. queries using pronouns like "it", "they", "that", "this", or phrases like "how much does it cost?", "what are the requirements?", "how do I apply?", "where is that located?").

Instructions:
1. **Resolve Follow-ups & Ambiguities**:
   - If the latest query is a follow-up or depends on previous chat context, resolve all pronouns and implied topics using the conversation history to formulate a complete, standalone query.
   - Example: If the previous discussion was about "Financial Aid Application" and the user asks "what is the deadline?", Query 1 MUST be "What is the deadline for Financial Aid Application?".
2. **Generate 2-3 High-Recall Search Queries**:
   - Query 1: Fully self-contained, standalone question with all subjects/entities resolved.
   - Query 2: Keyword-rich semantic query focusing on the core domain topics and actions.
   - Query 3: Synonyms or alternative phrasing to maximize vector search retrieval.
3. If the user query is already standalone, provide the query and 1-2 relevant semantic expansions.

Respond ONLY with a valid JSON array of 2 to 3 strings. Do not add markdown or extra commentary.

Conversation History (Recent Context):
<conversation>
$$chatHistory
</conversation>

Latest User Query: "$$userQuery"

Output JSON:`;

const DEFAULT_INTENT_PROMPT = `You are an intent classification engine for an enterprise customer assistant.
Classify the user's query into EXACTLY ONE of these categories:
1. SMALLTALK: Greetings, pleasantries, casual chit-chat, asking how the bot is doing, compliments, gratitude, or asking who the bot is / what it can do.
2. END_CHAT: The user wants to end, close, finish, exit the chat, or says goodbye (e.g. "bye", "goodbye", "end chat", "close chat", "exit", "I'm done", "see you", "talk to you later", "terminate conversation", "have a good day bye").
3. AMBIGUOUS: The query is too vague, underspecified, or unclear to look up specific documents (e.g. "tell me more", "how much is it?", "can I do that?").
4. INFORMATION_SEEKING: Specific questions about products, services, documentation, FAQs, procedures, or domain knowledge.

Output ONLY valid JSON with keys "intent" ("smalltalk" | "end_chat" | "ambiguous" | "information_seeking") and "reason".

User Query: "$$userQuery"`;

const DEFAULT_SMALLTALK_PROMPT = `You are $$tenantFullName virtual assistant ($$botName), a friendly, helpful, intelligent, and engaging AI assistant.
Respond naturally, contextually, and conversationally to the user's greeting, smalltalk, question, comment, or pleasantry.
Keep your response concise (1-3 sentences), warm, and interactive.
If they ask about you, your capabilities, how you are doing, or say hello/thanks, reply with a relevant, pleasant, and varied response, and invite them to ask any questions they have.`;

const DEFAULT_END_CHAT_PROMPT = `You are $$tenantFullName virtual assistant ($$botName), a polite and helpful assistant.
The user wants to end or exit the chat session. Give a warm, polite, and brief goodbye message (1-2 sentences) thanking them for chatting and wishing them a wonderful day.`;

const DEFAULT_AMBIGUOUS_PROMPT = `You are $$tenantFullName virtual assistant ($$botName), a helpful AI assistant.
The user's query "$$userQuery" is ambiguous or needs more details. Politely ask for clarification or offer 2-3 specific topics they might be asking about.`;

const DEFAULT_FALLBACK_ANSWER = `<p class="msgcontent">I'm sorry; I do not have enough information in my knowledge base to answer that question accurately. Can you please rephrase or provide additional details? Alternatively, you may contact our support team for assistance.</p>`;

const DEFAULT_FALLBACK_TEXTS = [
  "I don't understand",
  "I cannot answer",
  "try rephrasing",
  "no information available",
  "I don't have information",
  "not enough information"
];

class GenAISettingsService {
  /**
   * Helper: Resolve tenant database name
   */
  resolveDbName(tenantId, tenantDbName) {
    if (tenantDbName) return tenantDbName;
    const raw = (tenantId || 'default').toString().trim().toLowerCase();
    return raw.startsWith('iso_') ? raw : `iso_${raw}`;
  }

  /**
   * Helper: Get tenant database connection
   */
  getTenantDb(tenantId, tenantDbName) {
    const dbName = this.resolveDbName(tenantId, tenantDbName);
    return mongoose.connection.useDb(dbName, { useCache: true });
  }

  /**
   * Get default settings object
   */
  getDefaultSettings(botId = 'ISOBot', tenantName = 'Default Organization') {
    return {
      botId,
      tenantFullName: tenantName,
      genAiEnabled: true,
      chatBotFlag: true,
      intentEnabled: [
        'smalltalk',
        'end_chat',
        'ambiguous',
        'information_seeking',
        'transfer_call',
        'billing',
        'troubleshooting'
      ],
      conversationHistoryLimit: 5,
      includeConversationHistoryInAnswerGeneration: true,
      includeConversationHistoryInQueryRewriter: true,
      textGenerationModel: 'openai/gpt-oss-120b',
      embeddingsGenerationModel: 'amazon.titan-embed-text-v2:0',
      embeddingsModelDimentions: 1024,
      chunkSize: 600,
      chunkOverlapSize: 100,
      maxTokens: 350,
      temperature: 0.3,
      topK: 4,
      scoreThreshold: 0.05,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      answerGenerationPrompt: DEFAULT_ANSWER_GENERATION_PROMPT,
      queryRewritePrompt: DEFAULT_QUERY_REWRITE_PROMPT,
      improvedQueryRewriter: true,
      improvedQueryRewriterPrompt: 'You are a query planning assistant for a Retrieval Augmented Generation system.',
      intentClassificationPrompt: DEFAULT_INTENT_PROMPT,
      smalltalkPrompt: DEFAULT_SMALLTALK_PROMPT,
      endChatPrompt: DEFAULT_END_CHAT_PROMPT,
      ambiguousPrompt: DEFAULT_AMBIGUOUS_PROMPT,
      fallbackTexts: DEFAULT_FALLBACK_TEXTS,
      defaultFallbackAnswer: DEFAULT_FALLBACK_ANSWER,
      searchConfig: {
        type: 'knn_vector',
        weights: { knn: 0.8, text: 0.2 }
      },
      firecrawlConfigs: { proxy: 'basic' }
    };
  }

  /**
   * Retrieve Gen AI settings directly from Redis Cloud / tenant database > genAISettings collection
   * Cached in Redis for 10 minutes (Cache-Aside pattern).
   */
  async getSettings({ tenantId, botId, tenantDbName }) {
    const cleanTenant = this.resolveDbName(tenantId, tenantDbName);
    const cleanBot = (botId || 'isobot').toString().trim().toLowerCase();
    const cacheKey = `genai:settings:${cleanTenant}:${cleanBot}`;

    return cacheService.wrap(cacheKey, async () => {
      if (mongoose.connection.readyState !== 1) {
        return this.getDefaultSettings(botId, tenantId);
      }

      try {
        const tenantDb = this.getTenantDb(tenantId, tenantDbName);
        const col = tenantDb.collection('genAISettings');

        logger.info(`[Mongo Query] Fetching genAISettings from "${cleanTenant}.genAISettings" for bot "${botId}"`);

        let query = {};
        if (botId) {
          query = {
            $or: [
              { botId },
              { botId: new RegExp(`^${botId}$`, 'i') },
              { code: botId },
              { chatBotFlag: botId }
            ]
          };
        }

        let doc = await col.findOne(query);

        if (!doc && botId) {
          doc = await col.findOne({});
        }

        const defaults = this.getDefaultSettings(botId, tenantId);

        if (!doc) {
          return defaults;
        }

        return {
          ...defaults,
          ...doc,
          _id: doc._id?.toString()
        };
      } catch (err) {
        logger.error(`[GenAI Settings] Error fetching settings for tenant "${tenantId}", bot "${botId}": ${err.message}`);
        return this.getDefaultSettings(botId, tenantId);
      }
    });
  }

  /**
   * Invalidate settings cache in Redis on update
   */
  async invalidateSettings(tenantId, botId) {
    const cleanTenant = this.resolveDbName(tenantId);
    await cacheService.delPattern(`genai:settings:${cleanTenant}:*`);
  }

  /**
   * Interpolate template placeholders ($$tenantFullName, $$botName, $$context, $$userQuery, $$chatHistory)
   */
  interpolate(template, variables = {}) {
    if (!template || typeof template !== 'string') return '';
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\$\\$${key}`, 'g');
      result = result.replace(regex, value !== undefined && value !== null ? String(value) : '');
    }
    return result;
  }
}

module.exports = new GenAISettingsService();
