const mongoose = require('mongoose');

const conversationHistorySchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  botId: {
    type: String,
    required: true,
    index: true
  },
  query: {
    type: String,
    required: true
  },
  answer: {
    type: String,
    required: true
  },
  intent: {
    type: String,
    default: 'information_seeking',
    index: true
  },
  sources: {
    type: [String],
    default: []
  },
  retrievedChunksCount: {
    type: Number,
    default: 0
  },
  latencyMs: {
    type: Number,
    default: 0
  },
  queryReceivedAt: {
    type: Date,
    default: Date.now
  },
  responseGivenAt: {
    type: Date,
    default: Date.now
  },
  sessionStartAt: {
    type: Date,
    default: Date.now
  },
  sessionEndAt: {
    type: Date,
    default: null
  },
  sessionStatus: {
    type: String,
    enum: ['active', 'ended'],
    default: 'active',
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  clientInfo: {
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    referer: { type: String, default: '' }
  }
}, {
  timestamps: true,
  collection: 'conversationHistory'
});

// Compound index for fast analytics and session queries
conversationHistorySchema.index({ tenantId: 1, botId: 1, createdAt: -1 });
conversationHistorySchema.index({ sessionId: 1, createdAt: 1 });

const ConversationHistory = mongoose.models.ConversationHistory || mongoose.model('ConversationHistory', conversationHistorySchema);
ConversationHistory.schema = conversationHistorySchema;

module.exports = ConversationHistory;
