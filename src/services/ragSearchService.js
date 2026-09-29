const mongoose = require('mongoose');
const embeddingService = require('./embeddingService');
const genAISettingsService = require('./genAISettingsService');
const logger = require('../helpers/logger');

class RagSearchService {
  /**
   * Helper: Resolve native MongoDB tenant database connection
   */
  getTenantDb(tenantId, tenantDbName) {
    const dbName = tenantDbName || (tenantId ? (tenantId.startsWith('iso_') ? tenantId : `iso_${tenantId}`) : 'iso_default');
    
    // Check primary mongoose connection
    if (mongoose.connection) {
      if (typeof mongoose.connection.getClient === 'function') {
        const client = mongoose.connection.getClient();
        if (client && typeof client.db === 'function') {
          return client.db(dbName);
        }
      }
      if (mongoose.connection.client && typeof mongoose.connection.client.db === 'function') {
        return mongoose.connection.client.db(dbName);
      }
    }

    if (mongoose.connections && mongoose.connections[0] && mongoose.connections[0].client) {
      return mongoose.connections[0].client.db(dbName);
    }

    const conn = mongoose.connection.useDb(dbName, { useCache: true });
    return (conn && conn.client && typeof conn.client.db === 'function') ? conn.client.db(dbName) : conn;
  }

  /**
   * Helper: Resolve canonical tenantId string slug from tenantInfo
   */
  async resolveCanonicalTenantId(tenantIdentifier) {
    if (!tenantIdentifier) return 'default';
    const str = String(tenantIdentifier).trim();
    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(str) && str.length === 24) {
      try {
        const masterDb = this.getTenantDb('master', 'master');
        const tenantDoc = await masterDb.collection('tenantInfo').findOne({ _id: new mongoose.Types.ObjectId(str) });
        if (tenantDoc && (tenantDoc.tenantId || tenantDoc.code)) {
          return (tenantDoc.tenantId || tenantDoc.code).toLowerCase();
        }
      } catch (e) {}
    }
    return str.toLowerCase();
  }

  /**
   * Helper: Resolve canonical botId string slug
   */
  async resolveCanonicalBotId(botIdentifier, tenantDb) {
    if (!botIdentifier) return 'default_bot';
    const str = String(botIdentifier).trim();
    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(str) && str.length === 24) {
      try {
        const botDoc = await tenantDb.collection('chatClientSettings').findOne({ _id: new mongoose.Types.ObjectId(str) });
        if (botDoc && (botDoc.botId || botDoc.code)) {
          return (botDoc.botId || botDoc.code).toLowerCase();
        }
      } catch (e) {}
    }
    return str.toLowerCase();
  }

  /**
   * Perform KNN Vector Search across multiple expanded queries
   */
  async performKnnSearch({
    queries = [],
    tenantId,
    botId,
    topK = 4,
    scoreThreshold = 0.05,
    tenantDbName
  }) {
    if (!tenantId || !botId || !queries || queries.length === 0 || mongoose.connection.readyState !== 1) {
      return [];
    }

    const cleanTenantId = await this.resolveCanonicalTenantId(tenantId);
    const tenantDb = this.getTenantDb(cleanTenantId, tenantDbName);
    const cleanBotId = await this.resolveCanonicalBotId(botId, tenantDb);

    const vectorIndexName = `${cleanTenantId.replace(/\s+/g, '_')}_${cleanBotId.replace(/\s+/g, '_')}`;

    // 1. Fetch bot's genAISettings from tenant database
    const genAISettings = await genAISettingsService.getSettings({
      tenantId: cleanTenantId,
      botId: cleanBotId,
      tenantDbName
    });

    const embeddingDimensions = parseInt(genAISettings.embeddingsModelDimentions) || 1024;
    const embeddingModel = genAISettings.embeddingsGenerationModel || 'amazon.titan-embed-text-v2:0';
    const finalTopK = topK || parseInt(genAISettings.topK) || 4;
    const finalScoreThreshold = scoreThreshold !== undefined ? scoreThreshold : (parseFloat(genAISettings.scoreThreshold) || 0.05);

    // 2. Fetch all active chunks for this vector index partition from MongoDB Atlas
    const chunks = await tenantDb.collection('rag_chunks').find({
      $or: [
        { vectorIndexName: vectorIndexName.toLowerCase() },
        { vectorIndexName: new RegExp(`^${cleanTenantId}_${cleanBotId}$`, 'i') },
        { 'metadata.botId': new RegExp(`^${cleanBotId}$`, 'i') }
      ],
      'metadata.status': { $ne: 'expired' }
    }).toArray();

    if (chunks.length === 0) {
      logger.info(`[RAG Search] No chunks found under index partition "${vectorIndexName}"`);
      return [];
    }

    // 3. Generate embeddings for all search queries (original + rewritten variations)
    const queryEmbeddings = [];
    for (const q of queries) {
      if (q && q.trim()) {
        const vec = await embeddingService.generateEmbedding(q.trim(), embeddingModel, embeddingDimensions);
        queryEmbeddings.push({ query: q.trim(), embedding: vec });
      }
    }

    // 4. Calculate Hybrid KNN Vector & Keyword Similarity across all queries
    const chunkScoreMap = new Map();

    for (const chunk of chunks) {
      const chunkId = chunk._id.toString();
      const chunkTextLower = (chunk.text || '').toLowerCase();
      const chunkTitleLower = (chunk.metadata?.title || '').toLowerCase();

      let vectorScore = 0;
      let keywordScore = 0;
      let matchedQuery = '';

      // 4A. Dense vector similarity
      if (Array.isArray(chunk.embedding) && chunk.embedding.length > 0) {
        for (const qObj of queryEmbeddings) {
          const sim = embeddingService.cosineSimilarity(qObj.embedding, chunk.embedding);
          const scorePercent = parseFloat((sim * 100).toFixed(2));
          if (scorePercent > vectorScore) {
            vectorScore = scorePercent;
            matchedQuery = qObj.query;
          }
        }
      }

      // 4B. Exact phrase and keyword matching with role/synonym expansion
      for (const qObj of queryEmbeddings) {
        const queryClean = (qObj.query || '').toLowerCase().trim();
        if (!queryClean) continue;

        // Exact phrase match (e.g. "ankit rathore")
        if (chunkTextLower.includes(queryClean) || chunkTitleLower.includes(queryClean)) {
          keywordScore = Math.max(keywordScore, 95.0);
          if (!matchedQuery) matchedQuery = qObj.query;
        }

        // Tokenized word matching with synonym expansion
        const tokens = queryClean.match(/[\w]+/g) || [];
        const stopwords = new Set(['what', 'is', 'the', 'who', 'for', 'are', 'you', 'how', 'why', 'where', 'when', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'and', 'about']);
        const meaningfulTokens = tokens.filter(t => !stopwords.has(t) && t.length > 1);

        if (meaningfulTokens.length > 0) {
          let tokenMatches = 0;
          for (const token of meaningfulTokens) {
            const synonyms = [token];
            if (token === 'founder' || token === 'founders') synonyms.push('co-founder', 'cofounder', 'co-founders', 'cofounders', 'founding', 'founded');
            if (token === 'cofounder' || token === 'co-founder' || token === 'cofounders' || token === 'co-founders') synonyms.push('founder', 'founders');
            if (token === 'cost' || token === 'price') synonyms.push('tuition', 'fee', 'fees');

            const matched = synonyms.some(syn => chunkTextLower.includes(syn) || chunkTitleLower.includes(syn));
            if (matched) tokenMatches++;
          }

          const ratio = (tokenMatches / meaningfulTokens.length) * 85.0;
          if (ratio > keywordScore) {
            keywordScore = ratio;
            if (!matchedQuery) matchedQuery = qObj.query;
          }
        }
      }

      // 4C. Combine vector and keyword scores (Hybrid Search)
      let bestScore = 0;
      if (vectorScore > 0 && keywordScore > 0) {
        bestScore = parseFloat((vectorScore * 0.55 + keywordScore * 0.45).toFixed(2));
        if (keywordScore >= 80) bestScore = Math.min(100, bestScore + 15);
      } else if (vectorScore > 0) {
        bestScore = vectorScore;
      } else {
        bestScore = keywordScore;
      }

      chunkScoreMap.set(chunkId, {
        _id: chunkId,
        sourceId: chunk.sourceId?.toString(),
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        title: chunk.metadata?.title || 'Knowledge Document',
        sourceUrl: chunk.metadata?.sourceUrl || '',
        score: bestScore,
        matchedQuery
      });
    }

    // 5. Filter by threshold and sort by highest similarity
    const results = Array.from(chunkScoreMap.values())
      .filter(item => item.score >= finalScoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, finalTopK);

    logger.info(`[RAG Search] Retrieved ${results.length} chunks (best score: ${results[0]?.score || 0}%) for index "${vectorIndexName}"`);
    return results;
  }
}

module.exports = new RagSearchService();
