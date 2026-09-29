const mongoose = require('mongoose');
const env = require('../config/env');
const cacheService = require('./cacheService');
const { DEFAULT_BOT_UI_CONFIGS, DEFAULT_GREETING_MESSAGE, DEFAULT_CUSTOM_FORMS } = require('../constants/botDefaults');
const logger = require('../helpers/logger');

class BotService {
  /**
   * Resolve dynamic database name: "iso_${tenantName}"
   */
  resolveDbName(tenantName) {
    const raw = (tenantName || env.DEFAULT_TENANT_CODE || 'default').toString().trim().toLowerCase();
    return raw.startsWith('iso_') ? raw : `iso_${raw}`;
  }

  /**
   * Get dynamic tenant database instance from MongoDB connection
   */
  getTenantDb(tenantName) {
    const dbName = this.resolveDbName(tenantName);
    return mongoose.connection.useDb(dbName, { useCache: true });
  }

  /**
   * Fetch bot document from dynamic db `iso_${tenantName}` in collection `chatClientSettings`
   * Cached in Redis for 10 minutes (Cache-Aside pattern).
   */
  async findBotDocument(botId, tenantName) {
    const cleanTenant = this.resolveDbName(tenantName);
    const cleanBot = (botId || 'default').toString().trim().toLowerCase();
    const cacheKey = `bot:doc:${cleanTenant}:${cleanBot}`;

    return cacheService.wrap(cacheKey, async () => {
      if (mongoose.connection.readyState !== 1) {
        const { ensureConnected } = require('../config/database');
        const reconnected = await ensureConnected();
        if (!reconnected) {
          logger.warn(`MongoDB is not connected (readyState: ${mongoose.connection.readyState})`);
          return null;
        }
      }

      try {
        const tenantDb = this.getTenantDb(tenantName);
        const collection = tenantDb.collection('chatClientSettings');

        logger.info(`[Mongo Query] Querying database '${cleanTenant}', collection 'chatClientSettings' for botId='${botId}'`);

        let query = {};
        if (botId && botId !== 'default') {
          const orConditions = [
            { botId: botId },
            { botId: new RegExp(`^${botId}$`, 'i') },
            { code: botId },
            { botName: botId },
            { name: botId }
          ];

          if (mongoose.Types.ObjectId.isValid(botId)) {
            orConditions.push({ _id: new mongoose.Types.ObjectId(botId) });
          }

          query = { $or: orConditions };
        }

        let doc = await collection.findOne(query);

        if (!doc && botId) {
          doc = await collection.findOne({});
        }

        if (doc && doc._id) {
          doc._id = doc._id.toString();
        }

        return doc;
      } catch (err) {
        logger.error(`Error querying dynamic tenant DB: ${err.message}`);
        return null;
      }
    });
  }

  /**
   * Default fallback widget configuration if DB is offline or document not found
   */
  getDefaultWidgetConfig(botId, tenantName) {
    return {
      _id: 'default-iso-bot',
      botId: botId || 'ISOBot',
      botName: 'ISO AI Assistant',
      tenantId: tenantName || 'default',
      botActive: true,
      updatedSince: new Date().toISOString(),
      greetingMessage: DEFAULT_GREETING_MESSAGE,
      welcomeMessage: 'Hi! I’m your AI assistant. How can I assist you today?',
      customForms: DEFAULT_CUSTOM_FORMS,
      quickReplies: ['What can you do?', 'Contact support', 'Documentation'],
      botUIConfigs: {
        ...DEFAULT_BOT_UI_CONFIGS,
        botHeaderText: 'ISO AI Assistant'
      }
    };
  }

  /**
   * Get widget configuration directly from Redis cache / MongoDB Atlas
   */
  async getWidgetConfig(botId, tenantName) {
    const cleanTenant = this.resolveDbName(tenantName);
    const cleanBot = (botId || 'default').toString().trim().toLowerCase();
    const cacheKey = `bot:widget:${cleanTenant}:${cleanBot}`;

    return cacheService.wrap(cacheKey, async () => {
      try {
        const doc = await this.findBotDocument(botId, tenantName);

        if (doc) {
          logger.info(`[Mongo Query] Fetched bot widget document for botId='${botId}' in DB '${cleanTenant}'`);
          
          if (!doc.botId && doc._id) doc.botId = doc._id.toString();
          if (!doc.botName && doc.name) doc.botName = doc.name;
          if (doc.botActive === undefined && doc.status !== undefined) {
            doc.botActive = doc.status === 'active';
          }

          return doc;
        }

        return this.getDefaultWidgetConfig(botId, tenantName);
      } catch (err) {
        logger.error(`Error in getWidgetConfig: ${err.message}. Serving fallback defaults.`);
        return this.getDefaultWidgetConfig(botId, tenantName);
      }
    });
  }

  /**
   * List all bots for a given tenant database (Cached in Redis)
   */
  async getBots(tenantName) {
    const cleanTenant = this.resolveDbName(tenantName);
    const cacheKey = `bot:list:${cleanTenant}`;

    return cacheService.wrap(cacheKey, async () => {
      if (mongoose.connection.readyState !== 1) {
        return [];
      }

      const tenantDb = this.getTenantDb(tenantName);
      const collection = tenantDb.collection('chatClientSettings');
      const docs = await collection.find({}).toArray();
      return docs.map(d => ({ ...d, _id: d._id.toString() }));
    });
  }

  /**
   * Get single bot by ID from dynamic tenant DB
   */
  async getBotById(id, tenantName = 'default') {
    return this.findBotDocument(id, tenantName);
  }

  /**
   * Create a new bot in dynamic tenant DB
   */
  async createBot(botData = {}) {
    const tenantName = botData.tenantId || botData.tenantName || 'default';
    const cleanTenant = this.resolveDbName(tenantName);
    const tenantDb = this.getTenantDb(tenantName);
    const collection = tenantDb.collection('chatClientSettings');

    const botId = (botData.code || botData.botId || `bot_${Date.now()}`).toLowerCase().trim();
    const botName = botData.name || botData.botName || 'AI Assistant';

    const doc = {
      botId,
      code: botId,
      botName,
      name: botName,
      description: botData.description || '',
      model: botData.model || 'gpt-4o-mini',
      temperature: botData.temperature !== undefined ? Number(botData.temperature) : 0.7,
      systemPrompt: botData.systemPrompt || 'You are an intelligent, friendly AI assistant.',
      status: botData.status || 'active',
      botActive: botData.status !== 'inactive',
      greetingMessage: botData.greetingMessage || DEFAULT_GREETING_MESSAGE,
      welcomeMessage: botData.welcomeMessage || 'Hi! I’m your AI assistant. How can I assist you today?',
      quickReplies: botData.quickReplies || ['What can you do?', 'Contact support', 'Documentation'],
      customForms: botData.customForms || DEFAULT_CUSTOM_FORMS,
      botUIConfigs: {
        ...DEFAULT_BOT_UI_CONFIGS,
        ...(botData.botUIConfigs || {}),
        botHeaderText: botData.botUIConfigs?.botHeaderText || botName
      },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const res = await collection.insertOne(doc);
    const createdBot = { ...doc, _id: res.insertedId.toString() };
    await this.invalidateBotCache(tenantName, botId);
    return createdBot;
  }

  /**
   * Update bot in dynamic tenant DB
   */
  async updateBot(id, updateData = {}, tenantName = 'default') {
    const cleanTenant = this.resolveDbName(tenantName);
    const tenantDb = this.getTenantDb(tenantName);
    const collection = tenantDb.collection('chatClientSettings');

    let filter = {};
    if (mongoose.Types.ObjectId.isValid(id)) {
      filter = { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { botId: id }, { code: id }] };
    } else {
      filter = { $or: [{ botId: id }, { code: id }] };
    }

    const setPayload = {
      ...updateData,
      updatedAt: new Date()
    };
    if (setPayload._id) delete setPayload._id;
    if (setPayload.status !== undefined) {
      setPayload.botActive = setPayload.status === 'active';
    }

    const res = await collection.findOneAndUpdate(
      filter,
      { $set: setPayload },
      { returnDocument: 'after' }
    );

    const updated = (res && res.value !== undefined) ? res.value : res;
    if (updated) {
      await this.invalidateBotCache(tenantName, updated.botId || id);
      return { ...updated, _id: updated._id.toString() };
    }
    return null;
  }

  /**
   * Delete bot from dynamic tenant DB
   */
  async deleteBot(id, tenantName = 'default') {
    const cleanTenant = this.resolveDbName(tenantName);
    const tenantDb = this.getTenantDb(tenantName);
    const collection = tenantDb.collection('chatClientSettings');

    let filter = {};
    if (mongoose.Types.ObjectId.isValid(id)) {
      filter = { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { botId: id }, { code: id }] };
    } else {
      filter = { $or: [{ botId: id }, { code: id }] };
    }

    const bot = await collection.findOne(filter);
    if (!bot) return null;

    await collection.deleteOne(filter);
    await this.invalidateBotCache(tenantName, bot.botId || id);
    return true;
  }

  /**
   * Invalidate bot cache on update/create
   */
  async invalidateBotCache(tenantName, botId) {
    const cleanTenant = this.resolveDbName(tenantName);
    await cacheService.delPattern(`bot:*:${cleanTenant}:*`);
    await cacheService.del(`bot:list:${cleanTenant}`);
    if (botId) {
      await cacheService.del(`bot:doc:${cleanTenant}:${botId.toLowerCase()}`);
      await cacheService.del(`bot:widget:${cleanTenant}:${botId.toLowerCase()}`);
    }
  }
}

module.exports = new BotService();
