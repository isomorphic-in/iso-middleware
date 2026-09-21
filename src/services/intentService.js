const llmService = require('./llmService');
const genAISettingsService = require('./genAISettingsService');
const grievanceService = require('./grievanceService');
const logger = require('../helpers/logger');

class IntentService {
  /**
   * Classify user query into: 'smalltalk' | 'end_chat' | 'ambiguous' | 'information_seeking'
   */
  async classifyIntent({ query, history = [], bot = {}, genAISettings = null, tenantId = '', botId = '', isGrievanceEnabled = true }) {
    if (!query || typeof query !== 'string') {
      return { intent: 'ambiguous', reason: 'Empty query' };
    }

    const cleanQuery = query.trim().toLowerCase();
    const wordCount = cleanQuery.split(/\s+/).length;

    // Resolve genAISettings
    let settings = genAISettings;
    if (!settings) {
      settings = await genAISettingsService.getSettings({
        tenantId: tenantId || bot?.tenantId,
        botId: botId || bot?.botId || bot?.code
      });
    }

    const enabledIntents = Array.isArray(settings?.intentEnabled) 
      ? settings.intentEnabled 
      : ['smalltalk', 'end_chat', 'ambiguous', 'information_seeking'];
    
    const isSmalltalkEnabled = enabledIntents.some(i => i.toLowerCase().includes('smalltalk') || i.toLowerCase().includes('greetings'));
    const isEndChatEnabled = enabledIntents.some(i => i.toLowerCase().includes('end_chat') || i.toLowerCase().includes('endchat') || i.toLowerCase().includes('bye') || i.toLowerCase().includes('exit'));
    const isAmbiguousEnabled = enabledIntents.some(i => i.toLowerCase().includes('ambiguous'));

    // 0A. Fast Rule-Based Match for Ticket Tracking / Status Inquiries (Only if Grievance System enabled)
    if (isGrievanceEnabled) {
      // Check if the previous assistant message prompted for student details for a grievance
      const isAwaitingGrievanceInfo = history.length > 0 && Array.isArray(history) && history.slice(-6).some(h => {
        const content = (h.content || h.text || h.botResponse || h.response || '').toLowerCase();
        return (
          content.includes('may i have your full name') ||
          content.includes('may i know your full name') ||
          content.includes('share your full name') ||
          content.includes('your full name') ||
          content.includes('what is your full name') ||
          content.includes('what is your name') ||
          content.includes('registration / roll number') ||
          content.includes('roll / registration number') ||
          content.includes('registration number') ||
          content.includes('roll number') ||
          content.includes('to help our staff locate your academic records') ||
          content.includes('to help the department look up your records') ||
          content.includes('official student grievance ticket') ||
          (content.includes('please share') && (content.includes('roll') || content.includes('name')))
        );
      });

      // Check if user is replying with student contact/identity markers or skip
      const hasStudentDetailsInQuery = /(?:roll\s*(?:no|number)|reg\s*(?:no|number)|dept\s*[:=\-]|department\s*[:=\-]|phone\s*[:=\-]|email\s*[:=\-]|name\s*[:=\-]|^(skip|proceed|create\s+ticket|just\s+create)$)/i.test(cleanQuery);

      if (isAwaitingGrievanceInfo || (hasStudentDetailsInQuery && history.length > 0)) {
        return {
          intent: 'grievance',
          confidence: 0.99,
          reason: 'Follow-up turn to grievance details prompt or student identity details provided'
        };
      }

      const ticketMatch = cleanQuery.match(/\b(grv-\d{4}-\w+)\b/i);
      if (ticketMatch || /(status\s+of\s+(my\s+)?ticket|track\s+(my\s+)?(ticket|grievance)|check\s+(my\s+)?(ticket|grievance)|ticket\s+status)/i.test(cleanQuery)) {
        return {
          intent: 'check_ticket',
          confidence: 0.98,
          ticketId: ticketMatch ? ticketMatch[1].toUpperCase() : null,
          reason: 'Matched ticket status tracking pattern'
        };
      }

      // 0B. Fast Rule-Based Match for EXPLICIT Ticket Creation / Grievance Requests
      const explicitGrievancePatterns = [
        /\b(raise|create|generate|file|lodge|register|open|submit)\s+(a\s+)?(support\s+)?(ticket|grievance|complaint)\b/i,
        /\b(i\s+(want|need|would\s+like)\s+to\s+(file\s+a\s+grievance|raise\s+a\s+ticket|create\s+a\s+ticket|lodge\s+a\s+complaint|register\s+a\s+complaint))\b/i,
        /\b(yes\s*(,|please)?\s*(raise|create|file|generate)\s*(a\s+)?(ticket|grievance)?)\b/i,
        /\b(escalate\s+(this\s+)?(to\s+)?(staff|admin|department|officer|human))\b/i,
        /^(raise\s+ticket|create\s+ticket|file\s+complaint|lodge\s+grievance|open\s+ticket)$/i
      ];

      for (const pattern of explicitGrievancePatterns) {
        if (pattern.test(cleanQuery)) {
          return { intent: 'grievance', confidence: 0.98, reason: 'Matched explicit ticket creation request' };
        }
      }
    }

    // 1. Fast Rule-Based Match for End Chat / Farewells
    if (isEndChatEnabled) {
      const endChatPatterns = [
        /^(bye|goodbye|bye\s+bye|good\s+bye|cya|see\s+you(\s+later)?|take\s+care|talk\s+to\s+you\s+later)\b/i,
        /^(end|close|exit|quit|stop|terminate|leave)\s*(chat|conversation|session)?$/i,
        /^(i('m| am)?\s*(done|leaving|good|finished|heading out))\b/i,
        /^(that('s| is)?\s*(all|everything)(\s+for\s+now)?|nothing\s+else(\s+thanks)?)\b/i,
        /^(have\s+a\s+(good|great|nice|wonderful)\s+(day|night|evening|weekend))\b/i,
        /^(no\s+(more\s+)?questions?|i\s+got\s+what\s+i\s+needed)\b/i
      ];

      for (const pattern of endChatPatterns) {
        if (pattern.test(cleanQuery)) {
          return { intent: 'end_chat', confidence: 0.95, reason: 'Matched end chat / farewell pattern' };
        }
      }
    }

    // 2. Fast Rule-Based Match for Common Smalltalk & Conversational Chit-chat
    if (isSmalltalkEnabled) {
      const smalltalkPatterns = [
        /^(hi|hello|hey|heya|howdy|hola|greetings|yo|morning|afternoon|evening)(\s+there|\s+bot)?\b/i,
        /^(good\s+(morning|afternoon|evening|day|night))\b/i,
        /^(how\s+are\s+you|how's\s+it\s+going|how\s+r\s+u|what's\s+up|sup|how\s+do\s+you\s+do)\b/i,
        /^(thank\s+you|thanks|thx|thank\s+u|appreciate\s+it|many\s+thanks|much\s+appreciated)\b/i,
        /^(who\s+are\s+you|what\s+is\s+your\s+name|what\s+can\s+you\s+do|what\s+are\s+you|tell\s+me\s+about\s+yourself)\b/i,
        /^(ok|okay|cool|nice|great|awesome|got\s+it|alright|fine|perfect|understood|sure)$/i,
        /^(nice\s+to\s+meet\s+you|pleased\s+to\s+meet\s+you|glad\s+to\s+meet\s+you)\b/i,
        /^(you('re| are)?\s*(awesome|great|helpful|smart|the best|cool|good|amazing))\b/i
      ];

      for (const pattern of smalltalkPatterns) {
        if (pattern.test(cleanQuery)) {
          return { intent: 'smalltalk', confidence: 0.95, reason: 'Matched smalltalk conversational pattern' };
        }
      }
    }

    // 3. Fast Rule-Based Match for Ambiguous / Vague Queries
    if (isAmbiguousEnabled && wordCount <= 2) {
      const ambiguousPatterns = [
        /^(help|info|tell\s+me|details|more|what|why|how|where|when|can\s+i|is\s+it)$/i,
        /^(what\s+about\s+that|tell\s+me\s+more|explain\s+that|and\s+then|what\s+else)$/i,
        /^(price|cost|fees|features|plans|support|contact)$/i
      ];

      for (const pattern of ambiguousPatterns) {
        if (pattern.test(cleanQuery)) {
          return { 
            intent: 'ambiguous', 
            confidence: 0.90, 
            reason: 'Query is underspecified or lacking domain context' 
          };
        }
      }
    }

    // 4. LLM Intent Classifier for nuanced queries using tenant's genAISettings
    try {
      const rawPrompt = settings?.intentClassificationPrompt || genAISettingsService.getDefaultSettings().intentClassificationPrompt;
      const classificationPrompt = genAISettingsService.interpolate(rawPrompt, {
        userQuery: query,
        tenantFullName: settings?.tenantFullName || 'Enterprise',
        botName: bot?.botName || bot?.name || 'Bot'
      });

      const response = await llmService.chatCompletion({
        messages: [{ role: 'system', content: classificationPrompt }],
        temperature: 0.1,
        maxTokens: 100,
        model: settings?.textGenerationModel || bot?.model
      });

      const parsed = this.safeParseJSON(response.content);
      if (parsed?.intent) {
        const detected = parsed.intent.toLowerCase().trim();
        // Check if detected intent is enabled in settings
        if (detected === 'end_chat' && !isEndChatEnabled) {
          return { intent: 'information_seeking', reason: 'End chat disabled by genAISettings' };
        }
        if (detected === 'smalltalk' && !isSmalltalkEnabled) {
          return { intent: 'information_seeking', reason: 'Smalltalk disabled by genAISettings' };
        }
        if (detected === 'ambiguous' && !isAmbiguousEnabled) {
          return { intent: 'information_seeking', reason: 'Ambiguous handler disabled by genAISettings' };
        }

        if (['smalltalk', 'end_chat', 'ambiguous', 'information_seeking'].includes(detected)) {
          return {
            intent: detected,
            reason: parsed.reason || 'LLM classified',
            confidence: 0.85
          };
        }
      }
    } catch (err) {
      logger.warn(`[Intent Service] LLM intent classification skipped: ${err.message}`);
    }

    // Default fallback
    return { intent: 'information_seeking', confidence: 0.75, reason: 'Default information seeking' };
  }

  /**
   * Formats chat history into standardized array of { role, content } objects
   */
  formatHistoryForLLM(history = []) {
    if (!Array.isArray(history)) return [];
    return history.slice(-4).map(item => {
      if (item.role && (item.content || item.text)) {
        return { role: item.role === 'bot' || item.role === 'assistant' ? 'assistant' : 'user', content: item.content || item.text };
      }
      if (item.userQuery) {
        return { role: 'user', content: item.userQuery };
      }
      if (item.botResponse) {
        return { role: 'assistant', content: item.botResponse };
      }
      return null;
    }).filter(Boolean);
  }

  /**
   * Generates a conversational, interactive smalltalk answer using LLM & tenant genAISettings
   */
  async handleSmalltalk({ query, bot = {}, history = [], genAISettings = null }) {
    const botName = bot?.botName || bot?.name || 'Assistant';
    const tenantName = genAISettings?.tenantFullName || bot?.tenantName || 'Enterprise';

    const rawPrompt = genAISettings?.smalltalkPrompt || genAISettingsService.getDefaultSettings().smalltalkPrompt;
    const prompt = genAISettingsService.interpolate(rawPrompt, {
      userQuery: query,
      tenantFullName: tenantName,
      botName
    });

    const formattedHistory = this.formatHistoryForLLM(history);
    const messages = [
      { role: 'system', content: prompt },
      ...formattedHistory,
      { role: 'user', content: query }
    ];

    try {
      const response = await llmService.chatCompletion({
        messages,
        temperature: 0.7,
        maxTokens: 180,
        model: genAISettings?.textGenerationModel || bot?.model
      });

      if (response && response.content && response.content.trim()) {
        return {
          text: response.content.trim(),
          intent: 'smalltalk',
          tokens: response.tokens,
          model: response.model
        };
      }
    } catch (err) {
      logger.warn(`[Intent Service] LLM smalltalk call failed: ${err.message}`);
    }

    // Interactive fallback generation based on specific smalltalk category
    const interactiveReply = this.generateInteractiveSmalltalkFallback({ query, botName, tenantName });
    return {
      text: interactiveReply,
      intent: 'smalltalk',
      tokens: { prompt: 20, completion: 25 },
      model: 'interactive-fallback'
    };
  }

  /**
   * Generates interactive, contextual fallback replies for smalltalk
   */
  generateInteractiveSmalltalkFallback({ query, botName, tenantName }) {
    const clean = (query || '').toLowerCase().trim();

    if (/^(how\s+are\s+you|how's\s+it\s+going|how\s+r\s+u|what's\s+up|sup)\b/i.test(clean)) {
      const options = [
        `I'm doing great, thank you for asking! How can I assist you with ${tenantName} today?`,
        `All systems running smoothly! What can I help you explore or find today?`,
        `Doing wonderful and ready to help! What questions do you have for me today?`
      ];
      return options[Math.floor(Math.random() * options.length)];
    }

    if (/^(who\s+are\s+you|what\s+is\s+your\s+name|what\s+can\s+you\s+do|tell\s+me\s+about\s+yourself)\b/i.test(clean)) {
      return `I am ${botName}, your virtual AI assistant for ${tenantName}! I can answer questions, look up knowledge base information, guide you through services, and help resolve common issues. What would you like to know?`;
    }

    if (/^(thank\s+you|thanks|thx|appreciate\s+it|many\s+thanks)\b/i.test(clean)) {
      const options = [
        `You're very welcome! Let me know if there is anything else I can help you with.`,
        `Happy to help! Feel free to ask if you have any other questions.`,
        `Glad I could assist! Is there anything else you'd like to know?`
      ];
      return options[Math.floor(Math.random() * options.length)];
    }

    if (/^(you('re| are)?\s*(awesome|great|helpful|smart|the best|cool|good|amazing))\b/i.test(clean)) {
      return `Thank you so much for the kind words! 😊 I'm always here to help you with any questions.`;
    }

    if (/^(ok|okay|cool|nice|great|awesome|got\s+it|alright|fine|perfect|understood)$/i.test(clean)) {
      const options = [
        `Sounds good! What would you like to check out next?`,
        `Great! Let me know if you need any further information.`,
        `Awesome! Feel free to ask whenever you have another question.`
      ];
      return options[Math.floor(Math.random() * options.length)];
    }

    if (/^(good\s+morning)\b/i.test(clean)) {
      return `Good morning! ☀️ How can I assist you with ${tenantName} today?`;
    }

    if (/^(good\s+afternoon)\b/i.test(clean)) {
      return `Good afternoon! How can I help you today?`;
    }

    if (/^(good\s+evening)\b/i.test(clean)) {
      return `Good evening! How can I assist you tonight?`;
    }

    // Default friendly interactive greeting
    const greetings = [
      `Hello! I'm ${botName}, your assistant for ${tenantName}. How can I help you today?`,
      `Hi there! What questions can I answer for you today?`,
      `Hey! Welcome to ${tenantName}. How can I assist you?`
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  /**
   * Handles user wanting to end the chat session, outputs goodbye and triggers end chat form
   */
  async handleEndChat({ query, bot = {}, history = [], genAISettings = null }) {
    const botName = bot?.botName || bot?.name || 'Assistant';
    const tenantName = genAISettings?.tenantFullName || bot?.tenantName || 'Enterprise';

    const rawPrompt = genAISettings?.endChatPrompt || genAISettingsService.getDefaultSettings().endChatPrompt;
    const prompt = genAISettingsService.interpolate(rawPrompt, {
      userQuery: query,
      tenantFullName: tenantName,
      botName
    });

    const formattedHistory = this.formatHistoryForLLM(history);
    const messages = [
      { role: 'system', content: prompt },
      ...formattedHistory,
      { role: 'user', content: query }
    ];

    try {
      const response = await llmService.chatCompletion({
        messages,
        temperature: 0.6,
        maxTokens: 120,
        model: genAISettings?.textGenerationModel || bot?.model
      });

      if (response && response.content && response.content.trim()) {
        return {
          text: response.content.trim(),
          intent: 'end_chat',
          isEndChat: true,
          form: 'survey',
          tokens: response.tokens,
          model: response.model
        };
      }
    } catch (err) {
      logger.warn(`[Intent Service] LLM end_chat call failed: ${err.message}`);
    }

    // Fallback warm goodbye messages
    const goodbyes = [
      `Thank you for chatting with ${botName} today! Have a wonderful day ahead. Goodbye! 👋`,
      `It was a pleasure assisting you! Have a great day and feel free to reach out anytime. Goodbye! 👋`,
      `Thank you for reaching out to ${tenantName}. Take care and have a wonderful day! 👋`
    ];
    const goodbyeText = goodbyes[Math.floor(Math.random() * goodbyes.length)];

    return {
      text: goodbyeText,
      intent: 'end_chat',
      isEndChat: true,
      form: 'survey',
      tokens: { prompt: 15, completion: 20 },
      model: 'farewell-fallback'
    };
  }

  /**
   * Generates a clarification question when the query is ambiguous using tenant genAISettings
   */
  async handleAmbiguousQuery({ query, bot = {}, history = [], genAISettings = null }) {
    const botName = bot?.botName || bot?.name || 'Assistant';
    const tenantName = genAISettings?.tenantFullName || bot?.tenantName || 'Enterprise';

    const rawPrompt = genAISettings?.ambiguousPrompt || genAISettingsService.getDefaultSettings().ambiguousPrompt;
    const prompt = genAISettingsService.interpolate(rawPrompt, {
      userQuery: query,
      tenantFullName: tenantName,
      botName
    });

    const formattedHistory = this.formatHistoryForLLM(history);
    const messages = [
      { role: 'system', content: prompt },
      ...formattedHistory,
      { role: 'user', content: query }
    ];

    const response = await llmService.chatCompletion({
      messages,
      temperature: 0.5,
      maxTokens: 200,
      model: genAISettings?.textGenerationModel || bot?.model
    });

    return {
      text: response.content,
      intent: 'ambiguous',
      tokens: response.tokens,
      model: response.model
    };
  }

  /**
   * Helper to extract student identity details from conversation text
   */
  extractStudentInfo(text, lastBotPromptType = '') {
    if (!text || typeof text !== 'string') return {};
    const info = {};

    // 1. Email
    const emailMatch = text.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
    if (emailMatch) info.email = emailMatch[1];

    // 2. Phone (10-15 digits, optionally with + or dashes)
    const phoneMatch = text.match(/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/) ||
                       text.match(/\b\d{10}\b/);
    if (phoneMatch) info.phone = phoneMatch[0].trim();

    // 3. Roll Number / Reg Number (Explicit marker or standard pattern)
    const rollMatch = text.match(/\b(?:roll(?:\s*no|\s*number)?|reg(?:\s*no|\s*number)?|id(?:\s*no)?)\s*[:=\-]?\s*([A-Za-z0-9\-_/]+)\b/i) ||
                      text.match(/\b(20\d{2}[A-Za-z0-9\-_/]+|\d{2,4}[A-Za-z]{2,5}\d{2,5})\b/i);
    if (rollMatch) {
      info.rollNumber = (rollMatch[1] || rollMatch[0]).trim();
    }

    // 4. Name with prefix
    const nameMatch = text.match(/\b(?:my\s+name\s+is|name\s*[:=\-]|i\s+am)\s+([A-Za-z\s]{2,30}?)(?:,|\.|\n|roll|email|phone|department|dept|branch|$)/i);
    if (nameMatch) {
      const rawName = nameMatch[1].trim();
      if (!/^(student|user|admin|anonymous|none|skip|no|yes|ok|okay|please|ticket|grievance)$/i.test(rawName)) {
        info.name = rawName;
      }
    }

    // 5. If answering the "name" question directly and input is a 1-3 word name
    if (!info.name && lastBotPromptType === 'name') {
      const trimmed = text.trim();
      if (
        /^[A-Za-z\.\'\-]+(?:\s+[A-Za-z\.\'\-]+){0,2}$/i.test(trimmed) &&
        !/^(skip|no|yes|ok|okay|proceed|continue|create|ticket|grievance|none|nah|nope|cancel)$/i.test(trimmed) &&
        trimmed.length >= 2 && trimmed.length <= 40
      ) {
        info.name = trimmed;
      }
    }

    // 6. If answering the "roll" question directly and input is an alphanumeric code
    if (!info.rollNumber && lastBotPromptType === 'roll') {
      const trimmed = text.trim();
      if (
        /^[A-Za-z0-9\-_/]{3,25}$/i.test(trimmed) &&
        !/^(skip|no|yes|ok|okay|proceed|continue|create|ticket|grievance|none|nah|nope|cancel)$/i.test(trimmed)
      ) {
        info.rollNumber = trimmed;
      }
    }

    // 7. Department / Branch
    const deptMatch = text.match(/\b(?:dept|department|branch)\s*[:=\-]?\s*([A-Za-z\s&]{2,30}?)(?:,|\.|\n|roll|email|phone|$)/i) ||
                      text.match(/\b(CSE|ECE|EEE|MECH|CIVIL|IT|B\.?Tech|MCA|MBA|BCA|B\.?Sc|M\.?Sc)\b/i);
    if (deptMatch) info.department = deptMatch[1].trim();

    return info;
  }

  /**
   * Helper to scan entire multi-turn history turn by turn to correlate prompts and answers
   */
  extractStudentInfoFromConversation(history = [], currentQuery = '', lastBotPromptType = '') {
    const info = {};

    // 1. Check current query
    Object.assign(info, this.extractStudentInfo(currentQuery, lastBotPromptType));

    // 2. Scan all historical user queries
    for (let i = 0; i < (history || []).length; i++) {
      const h = history[i];
      const botText = (h.content || h.text || h.botResponse || h.response || h.message || '').toLowerCase();
      const isBot = h.role === 'assistant' || h.role === 'system' || h.botResponse || h.response || h.sender === 'bot';

      if (isBot) {
        const thanksMatch = (h.content || h.text || h.botResponse || h.response || '').match(/Thanks\s+\*\*([^*]+)\*\*/i);
        if (thanksMatch && !info.name) {
          info.name = thanksMatch[1].trim();
        }

        let nextUserMsg = '';
        for (let j = i + 1; j < history.length; j++) {
          const nextH = history[j];
          const isNextUser = nextH.role === 'user' || nextH.userQuery || nextH.sender === 'user';
          if (isNextUser) {
            nextUserMsg = nextH.userQuery || nextH.query || nextH.content || nextH.message || '';
            break;
          }
        }

        if (nextUserMsg && typeof nextUserMsg === 'string') {
          const cleanUser = nextUserMsg.trim();
          if (botText.includes('full name') || botText.includes('your name') || botText.includes('share your name') || botText.includes('may i have your full name') || botText.includes('may i know your full name')) {
            if (!info.name && /^[A-Za-z\.\'\-]+(?:\s+[A-Za-z\.\'\-]+){0,2}$/i.test(cleanUser) && !/^(skip|no|yes|ok|okay|create|ticket|none)$/i.test(cleanUser)) {
              info.name = cleanUser;
            }
          }
          if (botText.includes('roll / registration number') || botText.includes('registration / roll number') || botText.includes('registration number') || botText.includes('roll number') || botText.includes('student id')) {
            if (!info.rollNumber && /^[A-Za-z0-9\-_/]{3,25}$/i.test(cleanUser) && !/^(skip|no|yes|ok|okay|create|ticket|none)$/i.test(cleanUser)) {
              info.rollNumber = cleanUser;
            }
          }
        }
      }
    }

    return info;
  }

  /**
   * Handles student grievance / complaint registration conversationally:
   * Asks minimum questions (Name, then Roll/Registration Number) one by one before creating ticket.
   */
  async handleGrievance({ query, bot = {}, history = [], genAISettings = null, tenantId = 'default', botId = 'isobot', sessionId = '' }) {
    const cleanQuery = query.toLowerCase();

    // 1. Filter ONLY user messages from conversation history (ignoring bot welcome greetings / RAG answers)
    const userMessages = (history || [])
      .filter(h => h.role === 'user' || h.userQuery || h.sender === 'user' || (h.query && !h.answer))
      .map(h => (h.userQuery || h.query || (h.role === 'user' ? h.content : '') || (h.sender === 'user' ? h.message : '') || '').trim())
      .filter(t => t.length > 0);

    const isMetaCommand = (t) => {
      if (!t || typeof t !== 'string') return true;
      const clean = t.trim().toLowerCase().replace(/[?!.,;:_]+/g, '').trim();
      return (
        /^(create|raise|file|lodge|open|register|submit)\s*(a\s+)?(support\s+)?(ticket|grievance|complaint)?$/i.test(clean) ||
        /^(can\s+(you\s+)?(please\s+)?(create|raise|file|lodge|open|register)\s*(a\s+)?(ticket|grievance|complaint)?)$/i.test(clean) ||
        /^(please\s+(create|raise|file|lodge|open|register)\s*(a\s+)?(ticket|grievance|complaint)?)$/i.test(clean) ||
        /^(i\s+(want|need|would\s+like)\s+to\s+(file\s+a\s+grievance|raise\s+a\s+ticket|create\s+a\s+ticket|lodge\s+a\s+complaint|register\s+a\s+complaint))$/i.test(clean) ||
        /^(yes|skip|proceed|continue|create\s+ticket|create|done|ok|okay|no|none|nah|nope)$/i.test(clean) ||
        /^(my\s+name\s+is|name\s*[:=\-]|roll\s*[:=\-]|roll\s*no|phone\s*[:=\-]|email\s*[:=\-])/i.test(clean) ||
        /^[A-Za-z0-9\-_/]{3,20}$/i.test(clean) ||
        /^[A-Za-z]+(?:\s+[A-Za-z]+){0,2}$/i.test(clean)
      );
    };

    // Find the real student problem question: search backwards from history
    let triggeringProblemQuery = '';
    for (let i = userMessages.length - 1; i >= 0; i--) {
      const msg = userMessages[i];
      if (!isMetaCommand(msg) && msg.length >= 3) {
        triggeringProblemQuery = msg;
        break;
      }
    }

    if (!triggeringProblemQuery) {
      if (!isMetaCommand(query) && !/^(skip|proceed|create)$/i.test(query.trim())) {
        triggeringProblemQuery = query;
      } else if (userMessages.length > 0) {
        triggeringProblemQuery = userMessages[0];
      } else {
        triggeringProblemQuery = query;
      }
    }

    // 2. Categorize based ONLY on student queries
    const combinedContext = `${triggeringProblemQuery} ${userMessages.join(' ')} ${query}`.toLowerCase();

    let category = 'Other';
    let department = 'Student Welfare & Grievance Cell';
    let priority = 'medium';

    if (
      combinedContext.includes('hostel') || combinedContext.includes('room') || combinedContext.includes('mess') ||
      combinedContext.includes('warden') || combinedContext.includes('water') || combinedContext.includes('leak') ||
      combinedContext.includes('tap') || combinedContext.includes('plumb') || combinedContext.includes('electricity') ||
      combinedContext.includes('power') || combinedContext.includes('light') || combinedContext.includes('fan') ||
      combinedContext.includes('bed') || combinedContext.includes('washroom') || combinedContext.includes('geyser') ||
      combinedContext.includes('cleaning') || combinedContext.includes('mess food')
    ) {
      category = 'Hostel & Housing';
      department = 'Hostel Administration';
      priority = 'high';
    } else if (
      combinedContext.includes('scholarship') || combinedContext.includes('financial aid') || combinedContext.includes('stipend') ||
      combinedContext.includes('fellowship') || combinedContext.includes('nsp') || combinedContext.includes('grant')
    ) {
      category = 'Scholarship';
      department = 'Scholarship & Financial Aid Office';
      priority = 'high';
    } else if (
      combinedContext.includes('fee') || combinedContext.includes('payment') || combinedContext.includes('receipt') ||
      combinedContext.includes('dues') || combinedContext.includes('refund') || combinedContext.includes('challan') ||
      combinedContext.includes('fine') || combinedContext.includes('installment')
    ) {
      category = 'Fees & Finance';
      department = 'Accounts & Finance Department';
      priority = 'high';
    } else if (
      combinedContext.includes('exam') || combinedContext.includes('hall ticket') || combinedContext.includes('admit card') ||
      combinedContext.includes('marksheet') || combinedContext.includes('revaluation') || combinedContext.includes('reval') ||
      combinedContext.includes('grade') || combinedContext.includes('result') || combinedContext.includes('backlog')
    ) {
      category = 'Examination';
      department = 'Examination Cell';
      priority = 'urgent';
    } else if (
      combinedContext.includes('attendance') || combinedContext.includes('absent') || combinedContext.includes('medical leave') ||
      combinedContext.includes('condonation') || combinedContext.includes('od leave') || combinedContext.includes('shortage')
    ) {
      category = 'Attendance';
      department = 'Academic Affairs';
      priority = 'medium';
    } else if (
      combinedContext.includes('certificate') || combinedContext.includes('bonafide') || combinedContext.includes('transcript') ||
      combinedContext.includes('noc') || combinedContext.includes('id card') || combinedContext.includes('transfer certificate') ||
      combinedContext.includes('migration')
    ) {
      category = 'Certificates & Documents';
      department = 'Student Records & Registrar Office';
      priority = 'medium';
    } else if (
      combinedContext.includes('wifi') || combinedContext.includes('internet') || combinedContext.includes('login') ||
      combinedContext.includes('password') || combinedContext.includes('portal') || combinedContext.includes('erp') ||
      combinedContext.includes('lms') || combinedContext.includes('email account') || combinedContext.includes('credentials')
    ) {
      category = 'Technical & Portal';
      department = 'IT & Portal Support';
      priority = 'medium';
    } else if (
      combinedContext.includes('faculty') || combinedContext.includes('teacher') || combinedContext.includes('professor') ||
      combinedContext.includes('class') || combinedContext.includes('lecture') || combinedContext.includes('syllabus') ||
      combinedContext.includes('assignment') || combinedContext.includes('timetable')
    ) {
      category = 'Academics & Faculty';
      department = 'Academic Affairs';
      priority = 'medium';
    }

    if (combinedContext.includes('urgent') || combinedContext.includes('emergency') || combinedContext.includes('immediate') || combinedContext.includes('blocked')) {
      priority = 'urgent';
    }

    // Analyze what the bot has already asked in history
    let askedName = false;
    let askedRoll = false;
    let lastBotPromptType = '';

    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      const botMsg = (h.content || h.text || h.botResponse || h.response || h.message || '').toLowerCase();
      const isBot = h.role === 'assistant' || h.role === 'system' || h.botResponse || h.response || h.sender === 'bot';
      
      if (isBot && botMsg) {
        if (botMsg.includes('full name') || botMsg.includes('your name') || botMsg.includes('share your name') || botMsg.includes('may i have your name') || botMsg.includes('may i know your full name')) {
          askedName = true;
          if (!lastBotPromptType) lastBotPromptType = 'name';
        }
        if (botMsg.includes('roll / registration number') || botMsg.includes('registration / roll number') || botMsg.includes('registration number') || botMsg.includes('roll number') || botMsg.includes('student id')) {
          askedRoll = true;
          if (!lastBotPromptType) lastBotPromptType = 'roll';
        }
      }
    }

    // Check if user requested to bypass questions or skip all
    const isDirectCreate = /^(just\s+create(\s+ticket)?|skip\s+all|create\s+ticket\s+directly|file\s+ticket\s+directly|create\s+immediately)$/i.test(query.trim());
    const isSkip = /^(skip|no|none|proceed|continue|nah|nope|don't\s+have|dont\s+have|direct|directly)$/i.test(query.trim());

    // Extract student identity details from user history and current query
    const extractedConversationInfo = this.extractStudentInfoFromConversation(history, query, lastBotPromptType);

    const studentInfo = {
      name: extractedConversationInfo.name || '',
      email: extractedConversationInfo.email || '',
      phone: extractedConversationInfo.phone || '',
      rollNumber: extractedConversationInfo.rollNumber || '',
      department: extractedConversationInfo.department || department
    };

    // =========================================================================
    // STEP 1: Ask Minimum Question 1 (Full Name) if not yet asked and not known
    // =========================================================================
    if (!askedName && !studentInfo.name && !isDirectCreate) {
      const promptText = `I can help register an official ticket with **${department}** for your issue.\n\n` +
        `First, could you please share your **Full Name**?\n\n` +
        `*(Reply with your name, or type **"Skip"** to proceed)*`;

      return {
        text: promptText,
        intent: 'grievance',
        isAwaitingDetails: true,
        category,
        department,
        priority,
        tokens: { prompt: 20, completion: 40 },
        model: 'system/grievance-engine'
      };
    }

    // =========================================================================
    // STEP 2: Ask Minimum Question 2 (Roll / Registration Number) if not yet asked and not known
    // =========================================================================
    if (!askedRoll && !studentInfo.rollNumber && !isDirectCreate) {
      const greeting = studentInfo.name ? `Thanks **${studentInfo.name}**!` : `Got it!`;
      const promptText = `${greeting} Could you please share your **Roll / Registration Number**?\n\n` +
        `*(Or reply **"Skip"** to create the ticket immediately)*`;

      return {
        text: promptText,
        intent: 'grievance',
        isAwaitingDetails: true,
        category,
        department,
        priority,
        tokens: { prompt: 20, completion: 40 },
        model: 'system/grievance-engine'
      };
    }

    // =========================================================================
    // STEP 3: Minimum questions complete -> CREATE TICKET
    // =========================================================================
    const cleanTitle = triggeringProblemQuery
      ? (triggeringProblemQuery.length > 90 ? `${triggeringProblemQuery.slice(0, 87)}...` : triggeringProblemQuery)
      : `Grievance: ${category}`;

    const studentDetailsSummary = [
      studentInfo.name ? `Name: ${studentInfo.name}` : '',
      studentInfo.rollNumber ? `Roll No: ${studentInfo.rollNumber}` : '',
      studentInfo.department ? `Department: ${studentInfo.department}` : '',
      studentInfo.phone ? `Phone: ${studentInfo.phone}` : '',
      studentInfo.email ? `Email: ${studentInfo.email}` : ''
    ].filter(Boolean).join(', ');

    const description = `Triggering Query: ${triggeringProblemQuery || query}${studentDetailsSummary ? `\n\nStudent Info: ${studentDetailsSummary}` : ''}`;

    // Construct full chat transcript from history array and current query
    const chatTranscript = (history || []).map(h => ({
      sender: (h.role === 'user' || h.userQuery || h.sender === 'user') ? 'user' : 'bot',
      message: h.userQuery || h.content || h.text || h.botResponse || h.response || h.message || '',
      timestamp: h.timestamp || h.queryReceivedAt || h.responseGivenAt || new Date()
    })).filter(m => m.message && typeof m.message === 'string' && m.message.trim().length > 0);

    // Append current user message
    chatTranscript.push({
      sender: 'user',
      message: query,
      timestamp: new Date()
    });

    let ticket;
    try {
      ticket = await grievanceService.createTicket({
        tenantId,
        botId,
        sessionId,
        category,
        department,
        title: cleanTitle,
        description,
        priority,
        student: {
          name: studentInfo.name || 'Anonymous Student',
          email: studentInfo.email || '',
          phone: studentInfo.phone || '',
          rollNumber: studentInfo.rollNumber || '',
          department: studentInfo.department || department
        },
        chatTranscript,
        source: 'chatbot'
      });
    } catch (err) {
      logger.error('Error creating grievance ticket from chatbot:', err);
    }

    const ticketId = ticket ? ticket.ticketId : `GRV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const slaHours = ticket ? ticket.slaHours : (priority === 'urgent' ? 12 : 48);

    const displayName = studentInfo.name || 'Student';
    const rollSummary = studentInfo.rollNumber ? ` (${studentInfo.rollNumber})` : '';

    const responseText = `### 📋 Grievance Registered Successfully\n\n` +
      `Your concern has been officially logged and assigned to the relevant department:\n\n` +
      `* **Ticket ID:** \`${ticketId}\`\n` +
      `* **Student:** ${displayName}${rollSummary}\n` +
      `* **Category:** ${category}\n` +
      `* **Assigned Department:** ${department}\n` +
      `* **Priority:** **${priority.toUpperCase()}**\n` +
      `* **Resolution SLA:** Within **${slaHours} hours**\n\n` +
      `Our staff has been notified and will review your request. You can check the real-time status anytime by asking: *"Track ticket ${ticketId}"* or *"Status of ${ticketId}"*.`;

    return {
      text: responseText,
      intent: 'grievance',
      ticketId,
      category,
      department,
      priority,
      tokens: { prompt: 25, completion: 80 },
      model: 'system/grievance-engine'
    };
  }

  /**
   * Handles checking the status of an existing ticket
   */
  async handleCheckTicket({ query, ticketId = null, bot = {}, tenantId = 'default' }) {
    let resolvedTicketId = ticketId;
    if (!resolvedTicketId) {
      const match = query.match(/\b(grv-\d{4}-\w+)\b/i);
      if (match) resolvedTicketId = match[1].toUpperCase();
    }

    if (!resolvedTicketId) {
      return {
        text: `Please provide your Ticket Tracking ID (for example: \`GRV-${new Date().getFullYear()}-0012\`) so I can check its real-time status for you.`,
        intent: 'check_ticket',
        tokens: { prompt: 15, completion: 25 },
        model: 'system/grievance-engine'
      };
    }

    try {
      const ticket = await grievanceService.getTicketDetails(resolvedTicketId, tenantId);
      if (!ticket) {
        return {
          text: `I could not find an active ticket with ID **\`${resolvedTicketId}\`**. Please double-check the ID or reply with details to file a new grievance.`,
          intent: 'check_ticket',
          tokens: { prompt: 15, completion: 30 },
          model: 'system/grievance-engine'
        };
      }

      const statusBadges = {
        open: '🟡 **OPEN** (Awaiting staff assignment)',
        in_progress: '🔵 **IN PROGRESS** (Under active review by staff)',
        resolved: '🟢 **RESOLVED**',
        closed: '⚫ **CLOSED**'
      };

      const statusText = statusBadges[ticket.status] || ticket.status.toUpperCase();
      const assigned = ticket.assignedTo?.fullName || ticket.assignedTo?.username || 'Department Officer';

      let responseText = `### 🎫 Status for Ticket \`${ticket.ticketId}\`\n\n` +
        `* **Status:** ${statusText}\n` +
        `* **Category:** ${ticket.category}\n` +
        `* **Department:** ${ticket.department}\n` +
        `* **Assigned To:** ${assigned}\n` +
        `* **Created On:** ${new Date(ticket.createdAt).toLocaleDateString()}`;

      // Collect resolution notes and staff comments/feedback
      const staffNotes = [];
      const hasCustomResolution = ticket.resolution?.notes && !/^marked\s+as\s+resolved$/i.test(ticket.resolution.notes.trim());

      if (hasCustomResolution) {
        const resolvedBy = ticket.resolution.resolvedBy || assigned;
        const resolvedTime = ticket.resolution.resolvedAt ? ` *(${new Date(ticket.resolution.resolvedAt).toLocaleDateString()})*` : '';
        staffNotes.push(`> **${resolvedBy} (Resolution)**: "${ticket.resolution.notes}"${resolvedTime}`);
      }

      if (Array.isArray(ticket.comments) && ticket.comments.length > 0) {
        ticket.comments.forEach(c => {
          const author = c.author?.fullName || c.author?.username || assigned;
          const time = c.createdAt ? ` *(${new Date(c.createdAt).toLocaleDateString()})*` : '';
          staffNotes.push(`> **${author}**: "${c.comment}"${time}`);
        });
      }

      // If no custom resolution notes and no comments, show fallback resolution notes
      if (staffNotes.length === 0 && ticket.resolution?.notes) {
        const resolvedBy = ticket.resolution.resolvedBy || assigned;
        const resolvedTime = ticket.resolution.resolvedAt ? ` *(${new Date(ticket.resolution.resolvedAt).toLocaleDateString()})*` : '';
        staffNotes.push(`> **${resolvedBy} (Resolution)**: ${ticket.resolution.notes}${resolvedTime}`);
      }

      if (staffNotes.length > 0) {
        responseText += `\n\n**Resolution & Staff Feedback:**\n` + staffNotes.join('\n\n');
      }

      if (ticket.isOverdue) {
        responseText += `\n\n⚠️ *This ticket has been escalated for priority expedited review.*`;
      }

      return {
        text: responseText,
        intent: 'check_ticket',
        tokens: { prompt: 20, completion: 70 },
        model: 'system/grievance-engine'
      };
    } catch (err) {
      logger.error('Error tracking ticket:', err);
      return {
        text: `An error occurred while tracking ticket **\`${resolvedTicketId}\`**. Please try again shortly.`,
        intent: 'check_ticket',
        tokens: { prompt: 10, completion: 20 },
        model: 'system/grievance-engine'
      };
    }
  }

  safeParseJSON(str) {
    if (!str || typeof str !== 'string') return null;
    try {
      const match = str.match(/\{.*\}/s);
      return JSON.parse(match ? match[0] : str);
    } catch (e) {
      return null;
    }
  }
}

module.exports = new IntentService();

