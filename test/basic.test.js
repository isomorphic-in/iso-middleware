const assert = require('assert');
const app = require('../src/app');
const { DEFAULT_BOT_UI_CONFIGS } = require('../src/constants/botDefaults');
const { buildSystemPrompt, formatMessagesForLLM } = require('../src/helpers/promptBuilder');
const aiService = require('../src/services/aiService');

async function runTests() {
  console.log('Running ISO Middleware unit tests...');

  // 1. Test Bot UI Config Defaults
  assert(DEFAULT_BOT_UI_CONFIGS.botThemeColor === '#00306D', 'Default theme color should match');
  assert(typeof DEFAULT_BOT_UI_CONFIGS.botHeaderText === 'string', 'Header text should be a string');
  console.log('✔ Bot defaults test passed');

  // 2. Test Prompt Builder
  const botMock = {
    name: 'TestBot',
    systemPrompt: 'You are a test assistant.',
    ingestionSources: [
      { name: 'faq.pdf', type: 'file', path: '/uploads/faq.pdf', status: 'synced', content: 'Support hours are 9-5.' }
    ]
  };
  const prompt = buildSystemPrompt(botMock, botMock.ingestionSources);
  assert(prompt.includes('Support hours are 9-5'), 'Prompt should include synced ingestion source');
  console.log('✔ Prompt builder test passed');

  // 3. Test LLM Message Formatting
  const historyMock = [
    { sender: 'user', text: 'Hello' },
    { sender: 'bot', text: 'Hi, how can I help?' }
  ];
  const messages = formatMessagesForLLM(prompt, historyMock, 'What are your hours?');
  assert(messages.length === 4, `Expected 4 messages, got ${messages.length}`);
  assert(messages[0].role === 'system', 'First message should be system');
  assert(messages[messages.length - 1].content === 'What are your hours?', 'Last message should be current query');
  console.log('✔ Message formatting test passed');

  // 4. Test AI Engine Fallback & Intent Handling
  const transferRes = await aiService.generateResponse({
    bot: botMock,
    query: 'I want to speak with a human agent'
  });
  assert(transferRes.form === 'transferCall', 'Should trigger transferCall form for human agent request');
  console.log('✔ AI intent detection test passed');

  // 5. Test Conversation History Model Export
  const { ConversationHistory } = require('../src/models');
  assert(typeof ConversationHistory === 'function', 'ConversationHistory should be a Mongoose model constructor');
  console.log('✔ ConversationHistory model export test passed');

  // 6. Test Conversation Transcript Generator
  const conversationService = require('../src/services/conversationService');
  assert(typeof conversationService.generateTranscript === 'function', 'generateTranscript should exist on conversationService');
  console.log('✔ ConversationService transcript method test passed');

  // 7. Test Bot Service CRUD Methods
  const botService = require('../src/services/botService');
  assert(typeof botService.getBotById === 'function', 'getBotById should exist on botService');
  assert(typeof botService.createBot === 'function', 'createBot should exist on botService');
  assert(typeof botService.updateBot === 'function', 'updateBot should exist on botService');
  assert(typeof botService.deleteBot === 'function', 'deleteBot should exist on botService');
  console.log('✔ BotService CRUD methods test passed');

  // 8. Test Admin Controller Raw Update & Duplicate Methods
  const adminController = require('../src/controllers/adminController');
  assert(typeof adminController.rawUpdateBot === 'function', 'rawUpdateBot should exist on adminController');
  assert(typeof adminController.duplicateBot === 'function', 'duplicateBot should exist on adminController');
  console.log('✔ AdminController bot duplicate & raw update methods test passed');

  // 9. Test Analytics Service Robust BotId Handling
  const analyticsService = require('../src/services/analyticsService');
  const nullAnalytics = await analyticsService.getBotAnalytics(null);
  assert(nullAnalytics === null, 'getBotAnalytics should safely return null on null botId');
  console.log('✔ AnalyticsService safe botId handling test passed');

  // 10. Test Cache Service DelPattern Function
  const cacheService = require('../src/services/cacheService');
  assert(typeof cacheService.delPattern === 'function', 'delPattern should exist on cacheService');
  console.log('✔ CacheService scanStream delPattern test passed');

  // 11. Test Ingestion Controller User Resolver
  const ingestionController = require('../src/controllers/ingestionController');
  const resolvedUser = await ingestionController.resolveUser({ headers: {}, body: { createdBy: 'test_user' } });
  assert(resolvedUser.username === 'test_user', 'resolveUser should resolve body createdBy');
  console.log('✔ IngestionController resolveUser test passed');

  // 12. Test RAG Search Safe Execution when DB is offline
  const ragSearchService = require('../src/services/ragSearchService');
  const ragResults = await ragSearchService.performKnnSearch({ queries: ['test query'], tenantId: 'test_tenant', botId: 'test_bot' });
  assert(Array.isArray(ragResults) && ragResults.length === 0, 'performKnnSearch should return empty array safely');
  console.log('✔ RAGSearchService offline safety test passed');

  // 13. Test Crawler Service URL Normalization & Filtering
  const crawlerService = require('../src/services/crawlerService');
  const normalized = crawlerService.normalizeUrl('/about-us#team', 'https://example.com/home');
  assert(normalized === 'https://example.com/about-us', `Normalized URL mismatch: ${normalized}`);
  assert(crawlerService.isUrlAllowed('https://example.com/blog', ['*blog*'], ['*admin*']) === true, 'Include pattern should match');
  assert(crawlerService.isUrlAllowed('https://example.com/admin/settings', [], ['*admin*']) === false, 'Exclude pattern should block');
  console.log('✔ CrawlerService URL normalization and pattern filtering test passed');

  console.log('\nAll tests passed successfully! 🎉');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
