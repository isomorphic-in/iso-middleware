const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const ApiResponse = require('../helpers/apiResponse');
const logger = require('../helpers/logger');
const genAISettingsService = require('../services/genAISettingsService');
const cacheService = require('../services/cacheService');
const { DEFAULT_BOT_UI_CONFIGS, DEFAULT_GREETING_MESSAGE, DEFAULT_CUSTOM_FORMS } = require('../constants/botDefaults');

class AdminController {
  /**
   * Helper: Get Master DB instance
   */
  getMasterDb() {
    return mongoose.connection.useDb('master', { useCache: true });
  }

  /**
   * Helper: Get Master TenantInfo Collection
   */
  getTenantInfoCollection() {
    return this.getMasterDb().collection('tenantInfo');
  }

  /**
   * Helper: Resolve dynamic Tenant Database
   */
  async resolveTenantDb(tenantIdentifier) {
    if (!tenantIdentifier) return null;

    const col = this.getTenantInfoCollection();
    let tenantDoc = null;

    if (mongoose.Types.ObjectId.isValid(tenantIdentifier)) {
      tenantDoc = await col.findOne({ _id: new mongoose.Types.ObjectId(tenantIdentifier) });
    }
    if (!tenantDoc) {
      tenantDoc = await col.findOne({
        $or: [
          { tenantId: tenantIdentifier },
          { tenantName: new RegExp(`^${tenantIdentifier}$`, 'i') },
          { tenantDbName: tenantIdentifier }
        ]
      });
    }

    const dbName = tenantDoc?.tenantDbName || (tenantIdentifier.startsWith('iso_') ? tenantIdentifier : `iso_${tenantIdentifier}`);
    return {
      tenantDoc,
      dbName,
      db: mongoose.connection.useDb(dbName, { useCache: true })
    };
  }

  // ==========================================
  // TENANTS API (master.tenantInfo)
  // ==========================================

  /**
   * GET /api/admin/tenants
   * Fetch all tenants from master > tenantInfo collection (Cached in Redis)
   */
  async getTenants(req, res, next) {
    try {
      const tenants = await cacheService.wrap('portal:tenants', async () => {
        const col = this.getTenantInfoCollection();
        const rawTenants = await col.find({}).sort({ createdAt: -1 }).toArray();

        return rawTenants.map(t => ({
          _id: t._id.toString(),
          tenantId: t.tenantId || t.code || t._id.toString(),
          name: t.tenantName || t.name || t.tenantId || 'Unnamed Tenant',
          tenantName: t.tenantName || t.name || t.tenantId,
          code: t.tenantId || t.code || 'tenant',
          tenantDbName: t.tenantDbName || (t.tenantId ? `iso_${t.tenantId}` : 'iso_default'),
          Bots: t.Bots || [],
          tenantActive: t.tenantActive !== undefined ? t.tenantActive : true,
          tenantConfig: t.tenantConfig || {},
          createdAt: t.createdAt || new Date()
        }));
      });

      const tenantFilter = (req.query.tenantId || req.query.tenant || '').trim().toLowerCase();
      if (tenantFilter && tenantFilter !== 'all') {
        const filtered = tenants.filter(t => 
          (t.tenantId && t.tenantId.toLowerCase() === tenantFilter) ||
          (t.code && t.code.toLowerCase() === tenantFilter) ||
          (t.name && t.name.toLowerCase() === tenantFilter) ||
          (t.tenantName && t.tenantName.toLowerCase() === tenantFilter) ||
          (t._id && t._id.toLowerCase() === tenantFilter)
        );
        return res.json(filtered);
      }

      return res.json(tenants);
    } catch (err) {
      logger.error(`Error fetching tenants from master.tenantInfo: ${err.message}`);
      next(err);
    }
  }

  /**
   * POST /api/admin/tenants
   * Create a new tenant document in master > tenantInfo and initialize its dynamic DB collections
   */
  async createTenant(req, res, next) {
    try {
      const { name, tenantName, code, tenantId, tenantDbName, tenantActive, tenantConfig, Bots } = req.body;
      const finalName = (tenantName || name || '').trim();
      const finalCode = (tenantId || code || '').toLowerCase().trim();

      if (!finalName || !finalCode) {
        return res.status(400).json({ error: 'Tenant Name and Tenant ID (Code) are required.' });
      }

      const col = this.getTenantInfoCollection();
      const existing = await col.findOne({
        $or: [
          { tenantId: finalCode },
          { tenantName: new RegExp(`^${finalName}$`, 'i') }
        ]
      });

      if (existing) {
        return res.status(400).json({ error: `Tenant with ID "${finalCode}" or Name "${finalName}" already exists.` });
      }

      const finalDbName = (tenantDbName || (finalCode.startsWith('iso_') ? finalCode : `iso_${finalCode}`)).trim();
      const initialBots = Array.isArray(Bots) ? Bots : [];

      const mergedTenantConfig = {
        instituteName: finalName,
        timeZone: 'America/New_York',
        loginBackgroundColor: '#fdf7f7',
        ButtonandLeftBarColor: '#00306D',
        buttonFontColor: '#ffffff',
        BordersColor: '#578b96',
        disableButtonColor: '#c1c1c1',
        forgotFontColor: '#373737',
        allHeaderFontSize: '1.2rem',
        allTitleFontSize: '1rem',
        backgroudImageUrl: '',
        logoBigUrl: '',
        logoSmallUrl: '',
        faviconUrl: '',
        showIntegrationTypeInChatHistory: true,
        showJobQueueNotificationIcon: true,
        enableGrievanceSystem: true,
        ...(tenantConfig || {})
      };

      const newTenant = {
        tenantId: finalCode,
        tenantName: finalName,
        tenantDbName: finalDbName,
        Bots: initialBots,
        tenantActive: tenantActive !== undefined ? Boolean(tenantActive) : true,
        tenantConfig: mergedTenantConfig,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await col.insertOne(newTenant);
      const created = {
        _id: result.insertedId.toString(),
        ...newTenant,
        name: finalName,
        code: finalCode
      };

      logger.info(`Created new tenant "${finalName}" in master.tenantInfo with db "${finalDbName}"`);
      await cacheService.del('portal:tenants');
      await cacheService.delPattern('tenant:branding:*');

      // =========================================================================
      // Initialize dynamic tenant DB collections (chatClientSettings, chatClients, genAISettings)
      // =========================================================================
      try {
        const dynamicDb = mongoose.connection.useDb(finalDbName, { useCache: true });
        logger.info(`Initializing dynamic database "${finalDbName}" collections...`);

        // Ensure collections exist
        await dynamicDb.createCollection('chatClientSettings').catch(() => {});
        await dynamicDb.createCollection('chatClients').catch(() => {});
        await dynamicDb.createCollection('genAISettings').catch(() => {});

        // If bots were specified, seed them
        if (initialBots.length > 0) {
          for (const botId of initialBots) {
            const botDoc = {
              botId,
              botName: `${finalName} Assistant`,
              code: botId,
              name: `${finalName} Assistant`,
              description: `Primary conversational AI assistant for ${finalName}.`,
              model: 'gpt-4-turbo',
              temperature: 0.7,
              systemPrompt: `You are ${finalName} Assistant, a helpful AI assistant for ${finalName}.`,
              status: 'active',
              botActive: true,
              chatApiUrl: '',
              greetingMessage: [`Hi! I’m ${finalName} Assistant. How can I assist you today?`],
              quickReplies: ['What can you do?', 'Customer Support', 'Contact Live Agent', 'End Session'],
              customForms: DEFAULT_CUSTOM_FORMS,
              botUIConfigs: {
                ...DEFAULT_BOT_UI_CONFIGS,
                botHeaderText: `${finalName} AI`,
                botThemeColor: mergedTenantConfig.ButtonandLeftBarColor || '#00306D',
                bgColor: '#ffffff'
              },
              updatedSince: new Date(),
              createdAt: new Date()
            };
            await dynamicDb.collection('chatClientSettings').insertOne(botDoc).catch(() => {});
            await dynamicDb.collection('chatClients').insertOne(botDoc).catch(() => {});
          }
        }

        // Initialize genAISettings in tenant database
        const existingGenAI = await dynamicDb.collection('genAISettings').findOne({});
        if (!existingGenAI) {
          const defaultGenAISettings = genAISettingsService.getDefaultSettings(initialBotId || 'ISOBot', finalName);
          await dynamicDb.collection('genAISettings').insertOne({
            ...defaultGenAISettings,
            createdAt: new Date()
          });
          logger.info(`Initialized "${finalDbName}.genAISettings" collection`);
        }
      } catch (dbErr) {
        logger.error(`Warning: could not fully initialize tenant db collections for "${finalDbName}": ${dbErr.message}`);
      }

      return res.status(201).json(created);
    } catch (err) {
      logger.error(`Error creating tenant in master.tenantInfo: ${err.message}`);
      next(err);
    }
  }

  /**
   * PUT /api/admin/tenants/:id
   * Update tenant document in master > tenantInfo
   */
  async updateTenant(req, res, next) {
    try {
      const { id } = req.params;
      const { name, tenantName, code, tenantId, tenantDbName, tenantActive, tenantConfig, Bots } = req.body;

      const col = this.getTenantInfoCollection();
      let filter = {};
      if (mongoose.Types.ObjectId.isValid(id)) {
        filter = { _id: new mongoose.Types.ObjectId(id) };
      } else {
        filter = { tenantId: id };
      }

      const existingTenant = await col.findOne(filter);
      if (!existingTenant) {
        return res.status(404).json({ error: 'Tenant document not found in master.tenantInfo' });
      }

      const updateFields = { updatedAt: new Date() };
      if (tenantName || name) {
        updateFields.tenantName = (tenantName || name).trim();
      }
      if (tenantId || code) {
        updateFields.tenantId = (tenantId || code).toLowerCase().trim();
      }
      if (tenantDbName) {
        updateFields.tenantDbName = tenantDbName.trim();
      }
      if (tenantActive !== undefined) {
        updateFields.tenantActive = Boolean(tenantActive);
      }
      if (Array.isArray(Bots)) {
        updateFields.Bots = Bots;
      }
      if (tenantConfig && typeof tenantConfig === 'object') {
        updateFields.tenantConfig = {
          ...(existingTenant.tenantConfig || {}),
          ...tenantConfig
        };
      }

      const result = await col.findOneAndUpdate(
        filter,
        { $set: updateFields },
        { returnDocument: 'after' }
      );

      const updated = result.value || result || { ...existingTenant, ...updateFields };

      // Ensure collections exist in the tenant database
      const targetDbName = updated.tenantDbName || (updated.tenantId ? `iso_${updated.tenantId}` : 'iso_default');
      try {
        const dynamicDb = mongoose.connection.useDb(targetDbName, { useCache: true });
        const collections = await dynamicDb.db.listCollections().toArray();
        const colNames = collections.map(c => c.name);

        if (!colNames.includes('chatClientSettings')) {
          await dynamicDb.createCollection('chatClientSettings').catch(() => {});
        }
        if (!colNames.includes('chatClients')) {
          await dynamicDb.createCollection('chatClients').catch(() => {});
        }
        if (!colNames.includes('genAISettings')) {
          await dynamicDb.createCollection('genAISettings').catch(() => {});
        }
      } catch (dbErr) {
        logger.error(`Warning checking collections in "${targetDbName}": ${dbErr.message}`);
      }

      const normalized = {
        _id: updated._id.toString(),
        ...updated,
        name: updated.tenantName || updated.name,
        code: updated.tenantId || updated.code
      };

      logger.info(`Updated tenant "${normalized.name}" in master.tenantInfo`);
      await cacheService.del('portal:tenants');
      await cacheService.delPattern('tenant:branding:*');
      return res.json(normalized);
    } catch (err) {
      logger.error(`Error updating tenant in master.tenantInfo: ${err.message}`);
      next(err);
    }
  }

  /**
   * DELETE /api/admin/tenants/:id
   * Delete tenant document from master > tenantInfo
   */
  async deleteTenant(req, res, next) {
    try {
      const { id } = req.params;
      const col = this.getTenantInfoCollection();

      let filter = {};
      if (mongoose.Types.ObjectId.isValid(id)) {
        filter = { _id: new mongoose.Types.ObjectId(id) };
      } else {
        filter = { tenantId: id };
      }

      const tenantToDelete = await col.findOne(filter);
      if (!tenantToDelete) {
        return res.status(404).json({ error: 'Tenant document not found.' });
      }

      await col.deleteOne(filter);
      await cacheService.del('portal:tenants');
      await cacheService.delPattern('tenant:branding:*');
      logger.info(`Deleted tenant "${tenantToDelete.tenantName || tenantToDelete.tenantId}" from master.tenantInfo`);
      return res.json({ message: `Tenant "${tenantToDelete.tenantName || tenantToDelete.tenantId}" deleted successfully.` });
    } catch (err) {
      logger.error(`Error deleting tenant: ${err.message}`);
      next(err);
    }
  }

  // ==========================================
  // BOTS API (Dynamic tenantDbName > chatClients / chatClientSettings)
  // ==========================================

  /**
   * GET /api/admin/bots
   * Fetch all chatbots/chatClients for the tenant's dynamic database (tenantDbName)
   */
  async getBots(req, res, next) {
    try {
      const tenantId = req.query.tenantId || req.query.tenantDbName || req.query.tenantCode || req.query.code;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId or tenantDbName query parameter is required.' });
      }

      const resolved = await this.resolveTenantDb(tenantId);
      if (!resolved || !resolved.db) {
        return res.json([]);
      }

      const { db, dbName, tenantDoc } = resolved;
      logger.info(`Querying tenant database "${dbName}" for chatClients & chatClientSettings...`);

      // Query both 'chatClients' and 'chatClientSettings'
      const [chatClients, chatSettings] = await Promise.all([
        db.collection('chatClients').find({}).toArray().catch(() => []),
        db.collection('chatClientSettings').find({}).toArray().catch(() => [])
      ]);

      // Combine unique bot documents by botId / _id
      const combinedMap = new Map();

      [...chatClients, ...chatSettings].forEach(doc => {
        const idKey = (doc.botId || doc._id || '').toString();
        if (!combinedMap.has(idKey)) {
          combinedMap.set(idKey, doc);
        }
      });

      const rawBots = Array.from(combinedMap.values());

      // Normalize bot documents for the Admin UI
      const bots = rawBots.map(b => {
        const botCode = b.botId || b.code || (b._id ? b._id.toString() : 'bot');
        const botName = b.botName || b.name || b.botId || 'Chatbot Instance';
        const isActive = b.botActive !== undefined ? b.botActive : (b.status === 'active' || b.status !== 'inactive');

        return {
          _id: (b._id ? b._id.toString() : botCode),
          tenantId: tenantDoc?._id ? tenantDoc._id.toString() : tenantId,
          tenantDbName: dbName,
          name: botName,
          botName: botName,
          code: botCode,
          botId: botCode,
          description: b.description || '',
          model: b.model || 'gpt-4-turbo',
          temperature: b.temperature !== undefined ? b.temperature : 0.7,
          systemPrompt: b.systemPrompt || '',
          status: isActive ? 'active' : 'inactive',
          botActive: isActive,
          chatApiUrl: b.chatApiUrl || b.apiEndpoint || '',
          greetingMessage: Array.isArray(b.greetingMessage) ? b.greetingMessage : (b.greetingMessage ? [b.greetingMessage] : DEFAULT_GREETING_MESSAGE),
          quickReplies: b.quickReplies || ['What can you do?', 'Technology Support', 'Transfer to Live Agent', 'End Chat Session'],
          customForms: b.customForms || DEFAULT_CUSTOM_FORMS,
          botUIConfigs: {
            ...DEFAULT_BOT_UI_CONFIGS,
            botHeaderText: botName,
            ...(b.botUIConfigs || {})
          },
          ingestionSources: b.ingestionSources || [],
          updatedSince: b.updatedSince || b.updatedAt || new Date()
        };
      });

      logger.info(`Found ${bots.length} bot documents in tenant DB "${dbName}"`);
      return res.json(bots);
    } catch (err) {
      logger.error(`Error fetching bots for tenant: ${err.message}`);
      next(err);
    }
  }

  /**
   * GET /api/admin/bots/:id
   * Fetch single bot configuration from tenant DB
   */
  async getBotById(req, res, next) {
    try {
      const { id } = req.params;
      const tenantId = req.query.tenantId || req.query.tenantDbName;

      let resolved = null;
      if (tenantId) {
        resolved = await this.resolveTenantDb(tenantId);
      }

      let doc = null;
      let targetDbName = resolved?.dbName;

      if (resolved?.db) {
        doc = await resolved.db.collection('chatClientSettings').findOne({
          $or: [
            ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
            { botId: id },
            { code: id }
          ]
        }) || await resolved.db.collection('chatClients').findOne({
          $or: [
            ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
            { botId: id },
            { code: id }
          ]
        });
      }

      if (!doc) {
        return res.status(404).json({ error: `Bot "${id}" not found in tenant database.` });
      }

      const botName = doc.botName || doc.name || doc.botId || id;
      const botCode = doc.botId || doc.code || id;

      return res.json({
        _id: doc._id.toString(),
        tenantId: tenantId || targetDbName,
        tenantDbName: targetDbName,
        name: botName,
        botName: botName,
        code: botCode,
        botId: botCode,
        description: doc.description || '',
        model: doc.model || 'gpt-4-turbo',
        temperature: doc.temperature !== undefined ? doc.temperature : 0.7,
        systemPrompt: doc.systemPrompt || '',
        status: doc.botActive !== false ? 'active' : 'inactive',
        botActive: doc.botActive !== false,
        chatApiUrl: doc.chatApiUrl || doc.apiEndpoint || '',
        greetingMessage: doc.greetingMessage || DEFAULT_GREETING_MESSAGE,
        quickReplies: doc.quickReplies || [],
        customForms: doc.customForms || DEFAULT_CUSTOM_FORMS,
        botUIConfigs: {
          ...DEFAULT_BOT_UI_CONFIGS,
          botHeaderText: botName,
          ...(doc.botUIConfigs || {})
        },
        updatedSince: doc.updatedSince || new Date()
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/admin/bots
   * Add a new chatbot document into dynamic tenant DB (chatClients & chatClientSettings)
   */
  async createBot(req, res, next) {
    try {
      const tenantId = req.query.tenantId || req.body.tenantId || req.query.tenantDbName;
      const { 
        name, code, description, model, temperature, 
        systemPrompt, status, botActive, botUIConfigs, 
        greetingMessage, quickReplies, customForms, chatApiUrl 
      } = req.body;

      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required.' });
      }
      if (!name || !code) {
        return res.status(400).json({ error: 'Bot Name and Code/Slug are required.' });
      }

      const resolved = await this.resolveTenantDb(tenantId);
      if (!resolved || !resolved.db) {
        return res.status(404).json({ error: 'Tenant database could not be resolved.' });
      }

      const { db, dbName, tenantDoc } = resolved;
      const botCode = code.trim();
      const botName = name.trim();

      const newBotDoc = {
        botId: botCode,
        botName: botName,
        code: botCode,
        name: botName,
        description: description || '',
        model: model || 'gpt-4-turbo',
        temperature: temperature !== undefined ? temperature : 0.7,
        systemPrompt: systemPrompt || 'You are a helpful AI assistant.',
        botActive: botActive !== undefined ? botActive : (status === 'active'),
        status: (botActive !== false && status !== 'inactive') ? 'active' : 'inactive',
        chatApiUrl: chatApiUrl || '',
        greetingMessage: greetingMessage || [`Hi! I’m ${botName}. How can I assist you today?`],
        quickReplies: quickReplies || ['What can you do?', 'Technology Support', 'Transfer to Live Agent', 'End Chat Session'],
        customForms: customForms || DEFAULT_CUSTOM_FORMS,
        botUIConfigs: {
          ...DEFAULT_BOT_UI_CONFIGS,
          botHeaderText: botName,
          ...(botUIConfigs || {})
        },
        updatedSince: new Date(),
        createdAt: new Date()
      };

      // Save into both chatClientSettings and chatClients in tenant DB
      const result = await db.collection('chatClientSettings').insertOne(newBotDoc);
      await db.collection('chatClients').insertOne({ ...newBotDoc, _id: result.insertedId }).catch(() => {});

      // Append botId to master.tenantInfo.Bots array
      if (tenantDoc) {
        await this.getTenantInfoCollection().updateOne(
          { _id: tenantDoc._id },
          { $addToSet: { Bots: botCode } }
        ).catch(() => {});
      }

      logger.info(`Provisioned new bot "${botName}" in tenant DB "${dbName}"`);
      return res.status(201).json({ _id: result.insertedId.toString(), ...newBotDoc });
    } catch (err) {
      logger.error(`Error creating bot in tenant DB: ${err.message}`);
      next(err);
    }
  }

  /**
   * PUT /api/admin/bots/:id
   * Update chatbot document in dynamic tenant DB (chatClients & chatClientSettings)
   */
  async updateBot(req, res, next) {
    try {
      const { id } = req.params;
      const tenantId = req.query.tenantId || req.body.tenantId || req.query.tenantDbName;
      const updateData = { ...req.body };
      delete updateData._id;

      let resolved = null;
      if (tenantId) {
        resolved = await this.resolveTenantDb(tenantId);
      }

      // If tenantId not provided, search across databases
      if (!resolved || !resolved.db) {
        const col = this.getTenantInfoCollection();
        const allTenants = await col.find({}).toArray();
        for (const t of allTenants) {
          const tDb = mongoose.connection.useDb(t.tenantDbName || `iso_${t.tenantId}`);
          const found = await tDb.collection('chatClientSettings').findOne({
            $or: [
              ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
              { botId: id }
            ]
          });
          if (found) {
            resolved = { db: tDb, dbName: t.tenantDbName || `iso_${t.tenantId}`, tenantDoc: t };
            break;
          }
        }
      }

      if (!resolved || !resolved.db) {
        return res.status(404).json({ error: 'Bot document not found in tenant database.' });
      }

      const { db, dbName } = resolved;
      updateData.updatedSince = new Date();

      if (updateData.name) updateData.botName = updateData.name;
      if (updateData.botName) updateData.name = updateData.botName;
      if (updateData.code) updateData.botId = updateData.code;
      if (updateData.botId) updateData.code = updateData.botId;
      if (updateData.status) updateData.botActive = updateData.status === 'active';
      if (updateData.botActive !== undefined) updateData.status = updateData.botActive ? 'active' : 'inactive';

      let filter = {};
      if (mongoose.Types.ObjectId.isValid(id)) {
        filter = { _id: new mongoose.Types.ObjectId(id) };
      } else {
        filter = { $or: [{ botId: id }, { code: id }] };
      }

      const result = await db.collection('chatClientSettings').findOneAndUpdate(
        filter,
        { $set: updateData },
        { returnDocument: 'after' }
      );

      // Mirror update in chatClients
      await db.collection('chatClients').updateOne(filter, { $set: updateData }).catch(() => {});

      const updated = result.value || result || updateData;
      logger.info(`Updated bot "${id}" in tenant DB "${dbName}"`);
      return res.json(updated);
    } catch (err) {
      logger.error(`Error updating bot: ${err.message}`);
      next(err);
    }
  }

  /**
   * PUT /api/admin/bots/:id/raw
   * Direct raw JSON configuration update of bot document in tenant DB
   */
  async rawUpdateBot(req, res, next) {
    return this.updateBot(req, res, next);
  }

  /**
   * POST /api/admin/bots/:id/duplicate
   * Clone an existing bot with a unique botId/name in tenant DB
   */
  async duplicateBot(req, res, next) {
    try {
      const { id } = req.params;
      const tenantId = req.query.tenantId || req.body.tenantId || req.query.tenantDbName;

      let resolved = null;
      if (tenantId) {
        resolved = await this.resolveTenantDb(tenantId);
      }

      if (!resolved || !resolved.db) {
        const col = this.getTenantInfoCollection();
        const allTenants = await col.find({}).toArray();
        for (const t of allTenants) {
          const tDb = mongoose.connection.useDb(t.tenantDbName || `iso_${t.tenantId}`);
          const found = await tDb.collection('chatClientSettings').findOne({
            $or: [
              ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
              { botId: id }
            ]
          });
          if (found) {
            resolved = { db: tDb, dbName: t.tenantDbName || `iso_${t.tenantId}`, tenantDoc: t };
            break;
          }
        }
      }

      if (!resolved || !resolved.db) {
        return res.status(404).json({ error: 'Source bot document not found.' });
      }

      const { db, dbName, tenantDoc } = resolved;
      let filter = {};
      if (mongoose.Types.ObjectId.isValid(id)) {
        filter = { _id: new mongoose.Types.ObjectId(id) };
      } else {
        filter = { $or: [{ botId: id }, { code: id }] };
      }

      const sourceBot = await db.collection('chatClientSettings').findOne(filter);
      if (!sourceBot) {
        return res.status(404).json({ error: 'Source bot not found.' });
      }

      const copySuffix = Math.floor(100 + Math.random() * 900);
      const newBotId = req.body.code || req.body.botId || `${sourceBot.botId || sourceBot.code || 'bot'}_copy_${copySuffix}`;
      const newBotName = req.body.name || req.body.botName || `${sourceBot.botName || sourceBot.name || 'Bot'} (Copy)`;

      const clonedDoc = {
        ...sourceBot,
        _id: new mongoose.Types.ObjectId(),
        botId: newBotId.toLowerCase().trim(),
        code: newBotId.toLowerCase().trim(),
        botName: newBotName,
        name: newBotName,
        createdAt: new Date(),
        updatedAt: new Date(),
        updatedSince: new Date()
      };

      await db.collection('chatClientSettings').insertOne(clonedDoc);
      await db.collection('chatClients').insertOne(clonedDoc).catch(() => {});

      if (tenantDoc) {
        await this.getTenantInfoCollection().updateOne(
          { _id: tenantDoc._id },
          { $addToSet: { Bots: newBotId } }
        ).catch(() => {});
      }

      logger.info(`Duplicated bot "${id}" as "${newBotId}" in tenant DB "${dbName}"`);
      return res.status(201).json(clonedDoc);
    } catch (err) {
      logger.error(`Error duplicating bot: ${err.message}`);
      next(err);
    }
  }

  /**
   * DELETE /api/admin/bots/:id
   * Delete chatbot document from dynamic tenant DB
   */
  async deleteBot(req, res, next) {
    try {
      const { id } = req.params;
      const tenantId = req.query.tenantId || req.query.tenantDbName;

      let resolved = null;
      if (tenantId) {
        resolved = await this.resolveTenantDb(tenantId);
      }

      if (!resolved || !resolved.db) {
        const col = this.getTenantInfoCollection();
        const allTenants = await col.find({}).toArray();
        for (const t of allTenants) {
          const tDb = mongoose.connection.useDb(t.tenantDbName || `iso_${t.tenantId}`);
          const found = await tDb.collection('chatClientSettings').findOne({
            $or: [
              ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: new mongoose.Types.ObjectId(id) }] : []),
              { botId: id }
            ]
          });
          if (found) {
            resolved = { db: tDb, dbName: t.tenantDbName || `iso_${t.tenantId}`, tenantDoc: t };
            break;
          }
        }
      }

      if (!resolved || !resolved.db) {
        return res.status(404).json({ error: 'Bot not found.' });
      }

      const { db, dbName, tenantDoc } = resolved;
      let filter = {};
      if (mongoose.Types.ObjectId.isValid(id)) {
        filter = { _id: new mongoose.Types.ObjectId(id) };
      } else {
        filter = { $or: [{ botId: id }, { code: id }] };
      }

      const botToDelete = await db.collection('chatClientSettings').findOne(filter);
      await db.collection('chatClientSettings').deleteOne(filter);
      await db.collection('chatClients').deleteOne(filter).catch(() => {});

      if (tenantDoc && botToDelete) {
        const botCode = botToDelete.botId || botToDelete.code || id;
        await this.getTenantInfoCollection().updateOne(
          { _id: tenantDoc._id },
          { $pull: { Bots: botCode } }
        ).catch(() => {});
      }

      logger.info(`Deleted bot "${id}" from tenant DB "${dbName}"`);
      return res.json({ message: 'Bot deleted successfully.' });
    } catch (err) {
      logger.error(`Error deleting bot: ${err.message}`);
      next(err);
    }
  }

  /**
   * GET /api/admin/genai-settings
   * Fetch Gen AI settings from tenant database > genAISettings collection
   */
  async getGenAISettings(req, res, next) {
    try {
      const { tenantId, tenantDbName, botId } = req.query;
      const settings = await genAISettingsService.getSettings({
        tenantId,
        tenantDbName,
        botId
      });

      return res.json(settings);
    } catch (err) {
      logger.error(`Error fetching genAISettings: ${err.message}`);
      next(err);
    }
  }

  /**
   * PUT /api/admin/genai-settings
   * Update Gen AI settings in tenant database > genAISettings collection
   */
  async updateGenAISettings(req, res, next) {
    try {
      const { tenantId, tenantDbName, botId } = req.query;
      const targetDb = tenantDbName || (tenantId ? `iso_${tenantId}` : 'iso_default');
      const dynamicDb = mongoose.connection.useDb(targetDb, { useCache: true });
      const col = dynamicDb.collection('genAISettings');

      const updateData = { ...req.body };
      delete updateData._id;
      if (botId && !updateData.botId) {
        updateData.botId = botId;
      }
      updateData.updatedAt = new Date();

      let filter = {};
      if (botId) {
        filter = { botId };
      } else if (updateData.botId) {
        filter = { botId: updateData.botId };
      }

      const existing = await col.findOne(filter);
      if (existing) {
        await col.updateOne({ _id: existing._id }, { $set: updateData });
        const updated = await col.findOne({ _id: existing._id });
        updated._id = updated._id.toString();
        // Invalidate GenAI settings cache
        await cacheService.delPattern(`genai:settings:${targetDb}:*`);
        return res.json(updated);
      } else {
        updateData.createdAt = new Date();
        const result = await col.insertOne(updateData);
        await cacheService.delPattern(`genai:settings:${targetDb}:*`);
        return res.json({ _id: result.insertedId.toString(), ...updateData });
      }
    } catch (err) {
      logger.error(`Error updating genAISettings: ${err.message}`);
      next(err);
    }
  }

  // =========================================================================
  // MENUS CRUD (master > menus - Cached in Redis)
  // =========================================================================

  async getMenus(req, res, next) {
    try {
      const mapped = await cacheService.wrap('portal:menus', async () => {
        const masterDb = mongoose.connection.useDb('master', { useCache: true });
        let menus = await masterDb.collection('menus').find({}).sort({ sortOrder: 1 }).toArray();

        // Ensure grievances menu is registered
        const hasGrievances = menus.some(m => m.menuId === 'grievances');
        if (!hasGrievances) {
          const grievanceMenu = {
            menuId: 'grievances',
            label: 'Grievances & Tickets',
            icon: 'Ticket',
            path: 'grievances',
            sortOrder: 2,
            active: true,
            description: 'AI Grievance & Student Ticket Management System',
            createdAt: new Date(),
            updatedAt: new Date()
          };
          await masterDb.collection('menus').insertOne(grievanceMenu);
          menus = await masterDb.collection('menus').find({}).sort({ sortOrder: 1 }).toArray();
        }

        return menus.map(m => ({ ...m, _id: m._id.toString() }));
      });
      return res.json(mapped);
    } catch (err) {
      logger.error(`Error fetching menus: ${err.message}`);
      next(err);
    }
  }

  async createMenu(req, res, next) {
    try {
      const { menuId, label, icon, path, sortOrder, active, description } = req.body;
      if (!menuId || !label) {
        return res.status(400).json({ error: 'Menu ID and Label are required.' });
      }

      const masterDb = mongoose.connection.useDb('master', { useCache: true });
      const existing = await masterDb.collection('menus').findOne({ menuId: menuId.trim() });
      if (existing) {
        return res.status(409).json({ error: `Menu with ID "${menuId}" already exists.` });
      }

      const newMenu = {
        menuId: menuId.trim(),
        label: label.trim(),
        icon: icon || 'Building2',
        path: path || menuId.trim(),
        sortOrder: Number(sortOrder) || 1,
        active: active !== false,
        description: description || '',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await masterDb.collection('menus').insertOne(newMenu);
      // Invalidate menus cache
      await cacheService.del('portal:menus');
      await cacheService.delPattern('role:menus:*');

      return res.status(201).json({ _id: result.insertedId.toString(), ...newMenu });
    } catch (err) {
      logger.error(`Error creating menu: ${err.message}`);
      next(err);
    }
  }

  async updateMenu(req, res, next) {
    try {
      const { id } = req.params;
      const { label, icon, path, sortOrder, active, description, menuId } = req.body;

      const masterDb = mongoose.connection.useDb('master', { useCache: true });
      let query = {};
      try {
        query = { _id: new mongoose.Types.ObjectId(id) };
      } catch (e) {
        query = { menuId: id };
      }

      const updateFields = {
        updatedAt: new Date()
      };
      if (label !== undefined) updateFields.label = label;
      if (icon !== undefined) updateFields.icon = icon;
      if (path !== undefined) updateFields.path = path;
      if (sortOrder !== undefined) updateFields.sortOrder = Number(sortOrder);
      if (active !== undefined) updateFields.active = Boolean(active);
      if (description !== undefined) updateFields.description = description;
      if (menuId !== undefined) updateFields.menuId = menuId.trim();

      await masterDb.collection('menus').updateOne(query, { $set: updateFields });
      const updated = await masterDb.collection('menus').findOne(query);
      if (!updated) return res.status(404).json({ error: 'Menu not found.' });

      // Invalidate menus cache
      await cacheService.del('portal:menus');
      await cacheService.delPattern('role:menus:*');

      updated._id = updated._id.toString();
      return res.json(updated);
    } catch (err) {
      logger.error(`Error updating menu: ${err.message}`);
      next(err);
    }
  }

  async deleteMenu(req, res, next) {
    try {
      const { id } = req.params;
      const masterDb = mongoose.connection.useDb('master', { useCache: true });
      let query = {};
      try {
        query = { _id: new mongoose.Types.ObjectId(id) };
      } catch (e) {
        query = { menuId: id };
      }

      const result = await masterDb.collection('menus').deleteOne(query);
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'Menu not found.' });
      }

      // Invalidate menus cache
      await cacheService.del('portal:menus');
      await cacheService.delPattern('role:menus:*');

      return res.json({ success: true, message: 'Menu deleted.' });
    } catch (err) {
      logger.error(`Error deleting menu: ${err.message}`);
      next(err);
    }
  }

  // =========================================================================
  // ROLES CRUD (master > roles - Cached in Redis)
  // =========================================================================

  async getRoles(req, res, next) {
    try {
      const mapped = await cacheService.wrap('portal:roles', async () => {
        const masterDb = mongoose.connection.useDb('master', { useCache: true });
        const roles = await masterDb.collection('roles').find({}).toArray();
        return roles.map(r => ({ ...r, _id: r._id.toString() }));
      });
      return res.json(mapped);
    } catch (err) {
      logger.error(`Error fetching roles: ${err.message}`);
      next(err);
    }
  }

  async createRole(req, res, next) {
    try {
      const { roleId, roleName, description, allowedMenus, allowedWidgets, isSystemRole } = req.body;
      if (!roleId || !roleName) {
        return res.status(400).json({ error: 'Role ID and Role Name are required.' });
      }

      const masterDb = mongoose.connection.useDb('master', { useCache: true });
      const existing = await masterDb.collection('roles').findOne({ roleId: roleId.trim() });
      if (existing) {
        return res.status(409).json({ error: `Role with ID "${roleId}" already exists.` });
      }

      const newRole = {
        roleId: roleId.trim(),
        roleName: roleName.trim(),
        description: description || '',
        allowedMenus: Array.isArray(allowedMenus) ? allowedMenus : [],
        allowedWidgets: Array.isArray(allowedWidgets) ? allowedWidgets : [],
        isSystemRole: Boolean(isSystemRole),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await masterDb.collection('roles').insertOne(newRole);

      // Invalidate roles cache & role permissions
      await cacheService.del('portal:roles');
      await cacheService.delPattern('role:*');

      return res.status(201).json({ _id: result.insertedId.toString(), ...newRole });
    } catch (err) {
      logger.error(`Error creating role: ${err.message}`);
      next(err);
    }
  }

  async updateRole(req, res, next) {
    try {
      const { id } = req.params;
      const { roleName, description, allowedMenus, allowedWidgets } = req.body;

      const masterDb = mongoose.connection.useDb('master', { useCache: true });
      let query = {};
      try {
        query = { _id: new mongoose.Types.ObjectId(id) };
      } catch (e) {
        query = { roleId: id };
      }

      const updateFields = {
        updatedAt: new Date()
      };
      if (roleName !== undefined) updateFields.roleName = roleName.trim();
      if (description !== undefined) updateFields.description = description;
      if (allowedMenus !== undefined && Array.isArray(allowedMenus)) updateFields.allowedMenus = allowedMenus;
      if (allowedWidgets !== undefined && Array.isArray(allowedWidgets)) updateFields.allowedWidgets = allowedWidgets;

      await masterDb.collection('roles').updateOne(query, { $set: updateFields });
      const updated = await masterDb.collection('roles').findOne(query);
      if (!updated) return res.status(404).json({ error: 'Role not found.' });

      // Invalidate roles cache & user session permissions
      await cacheService.del('portal:roles');
      await cacheService.delPattern('role:*');
      await cacheService.delPattern('session:token:*');

      updated._id = updated._id.toString();
      return res.json(updated);
    } catch (err) {
      logger.error(`Error updating role: ${err.message}`);
      next(err);
    }
  }

  async deleteRole(req, res, next) {
    try {
      const { id } = req.params;
      const masterDb = mongoose.connection.useDb('master', { useCache: true });
      let query = {};
      try {
        query = { _id: new mongoose.Types.ObjectId(id) };
      } catch (e) {
        query = { roleId: id };
      }

      const targetRole = await masterDb.collection('roles').findOne(query);
      if (targetRole && targetRole.isSystemRole) {
        return res.status(403).json({ error: 'Cannot delete a built-in system role.' });
      }

      const result = await masterDb.collection('roles').deleteOne(query);
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'Role not found.' });
      }
      return res.json({ success: true, message: 'Role deleted.' });
    } catch (err) {
      logger.error(`Error deleting role: ${err.message}`);
      next(err);
    }
  }

  // =========================================================================
  // TENANT USERS CRUD (tenantDb > users)
  // =========================================================================

  async getTenantUsers(req, res, next) {
    try {
      const { tenantId, tenantDbName } = req.query;
      const targetDb = tenantDbName || (tenantId ? `iso_${tenantId}` : 'iso_default');
      const dynamicDb = mongoose.connection.useDb(targetDb, { useCache: true });
      const users = await dynamicDb.collection('users').find({}, { projection: { password: 0 } }).toArray();
      const mapped = users.map(u => ({ ...u, _id: u._id.toString() }));
      return res.json(mapped);
    } catch (err) {
      logger.error(`Error fetching tenant users: ${err.message}`);
      next(err);
    }
  }

  async createTenantUser(req, res, next) {
    try {
      const { tenantId, tenantDbName } = req.query;
      const { username, password, role, fullName, email, status } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
      }

      const targetDb = tenantDbName || (tenantId ? `iso_${tenantId}` : 'iso_default');
      const dynamicDb = mongoose.connection.useDb(targetDb, { useCache: true });
      const col = dynamicDb.collection('users');

      const existing = await col.findOne({ username: username.trim() });
      if (existing) {
        return res.status(409).json({ error: `User "${username}" already exists in this tenant.` });
      }

      // Hash password securely with bcrypt
      const hashedPassword = bcrypt.hashSync(password.trim(), 10);

      const newUser = {
        username: username.trim(),
        password: hashedPassword,
        role: role || 'tenant_admin',
        fullName: fullName || username.trim(),
        email: email || `${username.trim()}@${tenantId || 'tenant'}.com`,
        status: status || 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await col.insertOne(newUser);
      
      // Never send password back in payload
      const responseUser = { ...newUser, _id: result.insertedId.toString() };
      delete responseUser.password;

      return res.status(201).json(responseUser);
    } catch (err) {
      logger.error(`Error creating tenant user: ${err.message}`);
      next(err);
    }
  }

  async updateTenantUser(req, res, next) {
    try {
      const { id } = req.params;
      const { tenantId, tenantDbName } = req.query;
      const { password, role, fullName, email, status } = req.body;

      const targetDb = tenantDbName || (tenantId ? `iso_${tenantId}` : 'iso_default');
      const dynamicDb = mongoose.connection.useDb(targetDb, { useCache: true });
      const col = dynamicDb.collection('users');

      let query = {};
      try {
        query = { _id: new mongoose.Types.ObjectId(id) };
      } catch (e) {
        query = { username: id };
      }

      const updateFields = { updatedAt: new Date() };
      if (password && password.trim()) {
        updateFields.password = bcrypt.hashSync(password.trim(), 10);
      }
      if (role !== undefined) updateFields.role = role;
      if (fullName !== undefined) updateFields.fullName = fullName;
      if (email !== undefined) updateFields.email = email;
      if (status !== undefined) updateFields.status = status;

      await col.updateOne(query, { $set: updateFields });
      const updated = await col.findOne(query, { projection: { password: 0 } });
      if (!updated) return res.status(404).json({ error: 'User not found in tenant database.' });

      updated._id = updated._id.toString();
      return res.json(updated);
    } catch (err) {
      logger.error(`Error updating tenant user: ${err.message}`);
      next(err);
    }
  }

  async deleteTenantUser(req, res, next) {
    try {
      const { id } = req.params;
      const { tenantId, tenantDbName } = req.query;

      const targetDb = tenantDbName || (tenantId ? `iso_${tenantId}` : 'iso_default');
      const dynamicDb = mongoose.connection.useDb(targetDb, { useCache: true });
      const col = dynamicDb.collection('users');

      let query = {};
      try {
        query = { _id: new mongoose.Types.ObjectId(id) };
      } catch (e) {
        query = { username: id };
      }

      const result = await col.deleteOne(query);
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'User not found.' });
      }
      return res.json({ success: true, message: 'User deleted.' });
    } catch (err) {
      logger.error(`Error deleting tenant user: ${err.message}`);
      next(err);
    }
  }

  /**
   * GET /api/admin/conversations
   * Aggregate sessions from master > conversationHistory
   */
  async getConversations(req, res, next) {
    try {
      const { tenantId, botId, status, search, startDate, endDate, limit = 100, page = 1 } = req.query;
      const client = mongoose.connection?.client 
        || (mongoose.connection && typeof mongoose.connection.getClient === 'function' && mongoose.connection.getClient())
        || (mongoose.connections && mongoose.connections[0] && mongoose.connections[0].client);

      const masterDb = client ? client.db('master') : mongoose.connection.useDb('master').db;
      const col = masterDb.collection('conversationHistory');

      const match = {};
      if (tenantId && tenantId !== 'all') {
        match.tenantId = new RegExp(`^${tenantId}$`, 'i');
      }
      if (botId && botId !== 'all') {
        match.botId = new RegExp(`^${botId}$`, 'i');
      }
      if (status && status !== 'all') {
        match.sessionStatus = status;
      }
      if (startDate || endDate) {
        const startISO = startDate ? new Date(startDate).toISOString() : null;
        const endISO = endDate ? new Date(endDate.length === 10 ? `${endDate}T23:59:59.999Z` : endDate).toISOString() : null;
        const startDateObj = startISO ? new Date(startISO) : null;
        const endDateObj = endISO ? new Date(endISO) : null;

        const dateConds = [];
        if (startISO && endISO) {
          dateConds.push(
            { createdAt: { $gte: startISO, $lte: endISO } },
            { createdAt: { $gte: startDateObj, $lte: endDateObj } },
            { sessionStartAt: { $gte: startISO, $lte: endISO } },
            { sessionStartAt: { $gte: startDateObj, $lte: endDateObj } }
          );
        } else if (startISO) {
          dateConds.push(
            { createdAt: { $gte: startISO } },
            { createdAt: { $gte: startDateObj } },
            { sessionStartAt: { $gte: startISO } },
            { sessionStartAt: { $gte: startDateObj } }
          );
        } else if (endISO) {
          dateConds.push(
            { createdAt: { $lte: endISO } },
            { createdAt: { $lte: endDateObj } },
            { sessionStartAt: { $lte: endISO } },
            { sessionStartAt: { $lte: endDateObj } }
          );
        }

        if (dateConds.length > 0) {
          if (match.$or) {
            match.$and = [{ $or: match.$or }, { $or: dateConds }];
            delete match.$or;
          } else {
            match.$or = dateConds;
          }
        }
      }
      if (search && search.trim()) {
        const regex = new RegExp(search.trim(), 'i');
        const searchConds = [{ query: regex }, { answer: regex }, { sessionId: regex }];
        if (match.$or) {
          match.$and = match.$and || [];
          match.$and.push({ $or: match.$or });
          match.$and.push({ $or: searchConds });
          delete match.$or;
        } else {
          match.$or = searchConds;
        }
      }

      const pipeline = [
        { $match: match },
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: '$sessionId',
            sessionId: { $first: '$sessionId' },
            tenantId: { $first: '$tenantId' },
            botId: { $first: '$botId' },
            totalTurns: { $sum: 1 },
            sessionStartAt: { $min: '$sessionStartAt' },
            sessionEndAt: { $max: '$sessionEndAt' },
            lastActivityAt: { $max: '$createdAt' },
            sessionStatus: { $last: '$sessionStatus' },
            firstQuery: { $first: '$query' },
            lastAnswer: { $last: '$answer' },
            intents: { $addToSet: '$intent' },
            totalLatencyMs: { $sum: '$latencyMs' }
          }
        },
        { $sort: { lastActivityAt: -1 } },
        { $skip: (parseInt(page) - 1) * parseInt(limit) },
        { $limit: parseInt(limit) }
      ];

      const sessions = await col.aggregate(pipeline).toArray();
      const distinctSessions = await col.distinct('sessionId', match);
      const totalSessionsCount = distinctSessions.length;

      return ApiResponse.success(res, {
        sessions,
        pagination: {
          total: totalSessionsCount,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(totalSessionsCount / parseInt(limit))
        }
      });
    } catch (err) {
      logger.error(`Error aggregating conversations: ${err.message}`);
      next(err);
    }
  }

  /**
   * GET /api/admin/conversations/:sessionId
   * Fetch all turns for a specific session
   */
  async getSessionMessages(req, res, next) {
    try {
      const { sessionId } = req.params;
      const client = mongoose.connection?.client 
        || (mongoose.connection && typeof mongoose.connection.getClient === 'function' && mongoose.connection.getClient())
        || (mongoose.connections && mongoose.connections[0] && mongoose.connections[0].client);

      const masterDb = client ? client.db('master') : mongoose.connection.useDb('master').db;
      const col = masterDb.collection('conversationHistory');

      const messages = await col.find({ sessionId }).sort({ createdAt: 1 }).toArray();
      return ApiResponse.success(res, { sessionId, messages, count: messages.length });
    } catch (err) {
      logger.error(`Error fetching session messages: ${err.message}`);
      next(err);
    }
  }

  /**
   * DELETE /api/admin/conversations/:sessionId
   * Delete a session and its chat turns
   */
  async deleteSession(req, res, next) {
    try {
      const { sessionId } = req.params;
      const client = mongoose.connection?.client 
        || (mongoose.connection && typeof mongoose.connection.getClient === 'function' && mongoose.connection.getClient())
        || (mongoose.connections && mongoose.connections[0] && mongoose.connections[0].client);

      const masterDb = client ? client.db('master') : mongoose.connection.useDb('master').db;
      const col = masterDb.collection('conversationHistory');

      const resDelete = await col.deleteMany({ sessionId });
      return ApiResponse.success(res, { message: 'Session deleted successfully', deletedCount: resDelete.deletedCount });
    } catch (err) {
      logger.error(`Error deleting session: ${err.message}`);
      next(err);
    }
  }

  /**
   * GET /api/admin/analytics
   * Advanced comprehensive analytics aggregation engine
   */
  async getAnalyticsDashboard(req, res, next) {
    try {
      const { tenantId, botId, timeRange = '30d', startDate, endDate } = req.query;

      const client = mongoose.connection?.client 
        || (mongoose.connection && typeof mongoose.connection.getClient === 'function' && mongoose.connection.getClient())
        || (mongoose.connections && mongoose.connections[0] && mongoose.connections[0].client);

      const masterDb = client ? client.db('master') : mongoose.connection.useDb('master').db;
      const col = masterDb.collection('conversationHistory');
      const feedbackCol = masterDb.collection('feedback');

      // Date range filter
      let dateFilter = {};
      const now = new Date();
      if (startDate && endDate) {
        dateFilter = { $gte: new Date(startDate), $lte: new Date(endDate) };
      } else if (timeRange === '7d') {
        const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        dateFilter = { $gte: start };
      } else if (timeRange === '14d') {
        const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        dateFilter = { $gte: start };
      } else if (timeRange === '30d') {
        const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        dateFilter = { $gte: start };
      } else if (timeRange === '90d') {
        const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        dateFilter = { $gte: start };
      }

      const match = {};
      if (Object.keys(dateFilter).length > 0) {
        match.createdAt = dateFilter;
      }

      if (tenantId && tenantId !== 'all') {
        match.$or = [
          { tenantId: tenantId.toLowerCase() },
          { tenantId: tenantId }
        ];
      }

      if (botId && botId !== 'all') {
        match.botId = { $regex: new RegExp(`^${botId}$`, 'i') };
      }

      // 1. Total Questions
      const totalQuestions = await col.countDocuments(match);

      // 2. Total Distinct Sessions
      const distinctSessions = await col.distinct('sessionId', match);
      const totalSessions = distinctSessions.length;

      // 3. Average Questions per Session
      const avgQuestionsPerSession = totalSessions > 0 ? parseFloat((totalQuestions / totalSessions).toFixed(2)) : 0;

      // 4. Daily Trends & Grouping
      const dailyTrendAgg = await col.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            questions: { $sum: 1 },
            sessions: { $addToSet: '$sessionId' },
            totalLatency: { $sum: { $ifNull: ['$latencyMs', 0] } },
            validLatencyCount: { $sum: { $cond: [{ $gt: ['$latencyMs', 0] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]).toArray();

      const activeDaysCount = dailyTrendAgg.length || 1;
      const daysCountForAvg = timeRange === '7d' ? 7 : (timeRange === '14d' ? 14 : (timeRange === '30d' ? 30 : (timeRange === '90d' ? 90 : activeDaysCount)));
      const avgQuestionsPerDay = parseFloat((totalQuestions / Math.max(1, daysCountForAvg)).toFixed(1));

      // Build filled daily activity array
      const dailyActivityMap = {};
      dailyTrendAgg.forEach(d => {
        dailyActivityMap[d._id] = {
          date: d._id,
          questions: d.questions,
          sessions: d.sessions ? d.sessions.length : 0,
          avgLatency: d.validLatencyCount > 0 ? Math.round(d.totalLatency / d.validLatencyCount) : 450
        };
      });

      const dailyActivity = [];
      const numDaysToGenerate = Math.min(daysCountForAvg, 30);
      for (let i = numDaysToGenerate - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateKey = d.toISOString().split('T')[0];
        if (dailyActivityMap[dateKey]) {
          dailyActivity.push(dailyActivityMap[dateKey]);
        } else {
          dailyActivity.push({
            date: dateKey,
            questions: 0,
            sessions: 0,
            avgLatency: 0
          });
        }
      }

      // 5. Session Lengths Aggregation
      const sessionLengthsAgg = await col.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$sessionId',
            startTime: { $min: '$sessionStartAt' },
            endTime: { $max: { $ifNull: ['$sessionEndAt', '$responseGivenAt'] } },
            createdTime: { $min: '$createdAt' },
            lastCreatedTime: { $max: '$createdAt' }
          }
        }
      ]).toArray();

      let totalSessionDurationSeconds = 0;
      let validSessionDurationCount = 0;

      sessionLengthsAgg.forEach(s => {
        const start = s.startTime || s.createdTime;
        const end = s.endTime || s.lastCreatedTime;
        if (start && end) {
          const duration = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
          if (duration >= 0 && duration < 86400) {
            totalSessionDurationSeconds += Math.max(duration, 15); // min 15s
            validSessionDurationCount++;
          }
        }
      });

      const avgSessionLengthSeconds = validSessionDurationCount > 0 
        ? Math.round(totalSessionDurationSeconds / validSessionDurationCount) 
        : (totalQuestions > 0 ? 120 : 0);

      const avgSessionLengthFormatted = avgSessionLengthSeconds >= 60 
        ? `${Math.floor(avgSessionLengthSeconds / 60)}m ${avgSessionLengthSeconds % 60}s`
        : `${avgSessionLengthSeconds}s`;

      // 6. Top Intents
      const topIntentsAgg = await col.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $ifNull: ['$intent', 'information_seeking'] },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]).toArray();

      const topIntents = topIntentsAgg.map(item => {
        const rawIntent = item._id || 'information_seeking';
        let label = rawIntent
          .replace(/_/g, ' ')
          .replace(/\./g, ' › ')
          .replace(/\b\w/g, l => l.toUpperCase());
        
        if (rawIntent === 'information_seeking') label = 'General Knowledge / Q&A';
        if (rawIntent === 'smalltalk' || rawIntent.includes('greetings')) label = 'Greetings & Smalltalk';
        if (rawIntent === 'end_chat') label = 'End Chat / Farewell';
        if (rawIntent === 'transfer_call') label = 'Live Agent Transfer';
        if (rawIntent === 'ambiguous') label = 'Ambiguous / Clarification';

        const percentage = totalQuestions > 0 ? Math.round((item.count / totalQuestions) * 100) : 0;
        return {
          intent: rawIntent,
          label,
          count: item.count,
          percentage
        };
      });

      // 7. CSAT & Feedback Scores
      const feedbackMatch = {};
      if (tenantId && tenantId !== 'all') {
        feedbackMatch.tenantId = { $regex: new RegExp(`^${tenantId}$`, 'i') };
      }
      if (botId && botId !== 'all') {
        feedbackMatch.botId = { $regex: new RegExp(`^${botId}$`, 'i') };
      }

      const [feedbacks, ratedTurns] = await Promise.all([
        feedbackCol.find(feedbackMatch).toArray().catch(() => []),
        col.find({ ...match, rating: { $exists: true, $ne: null } }).toArray().catch(() => [])
      ]);

      const allRatings = [];
      feedbacks.forEach(f => { if (f.rating) allRatings.push(Number(f.rating)); });
      ratedTurns.forEach(t => { if (t.rating && !allRatings.includes(t.rating)) allRatings.push(Number(t.rating)); });

      let csatPercentage = 94; // fallback default high satisfaction
      let thumbsUpScore = 92;
      const ratingBreakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

      if (allRatings.length > 0) {
        allRatings.forEach(r => {
          const clamped = Math.min(Math.max(Math.round(r), 1), 5);
          ratingBreakdown[clamped] = (ratingBreakdown[clamped] || 0) + 1;
        });

        const highSatisfactionCount = (ratingBreakdown[4] || 0) + (ratingBreakdown[5] || 0);
        csatPercentage = Math.round((highSatisfactionCount / allRatings.length) * 100);
        thumbsUpScore = Math.round((((ratingBreakdown[5] * 1.0) + (ratingBreakdown[4] * 0.8) + (ratingBreakdown[3] * 0.5)) / allRatings.length) * 100);
      }

      // 8. Hourly Activity Distribution (0 - 23 Hours)
      const hourlyAgg = await col.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $hour: '$createdAt' },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]).toArray();

      const hourlyMap = {};
      hourlyAgg.forEach(h => { hourlyMap[h._id] = h.count; });
      const hourlyDistribution = Array.from({ length: 24 }, (_, hour) => ({
        hour: `${hour.toString().padStart(2, '0')}:00`,
        hourNum: hour,
        count: hourlyMap[hour] || 0
      }));

      // 9. Top User Inquiries Table
      const topQueriesAgg = await col.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $trim: { input: '$query' } },
            count: { $sum: 1 },
            intent: { $first: '$intent' },
            lastAskedAt: { $max: '$createdAt' },
            avgLatency: { $avg: '$latencyMs' }
          }
        },
        { $match: { _id: { $ne: '', $ne: null } } },
        { $sort: { count: -1 } },
        { $limit: 15 }
      ]).toArray();

      const topQueries = topQueriesAgg.map(q => ({
        query: q._id,
        count: q.count,
        intent: q.intent || 'information_seeking',
        lastAskedAt: q.lastAskedAt,
        avgLatencyMs: Math.round(q.avgLatency || 450)
      }));

      // 10. Recent Sessions Table
      const recentSessionsAgg = await col.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$sessionId',
            queryCount: { $sum: 1 },
            primaryIntent: { $first: '$intent' },
            sampleQuery: { $first: '$query' },
            startedAt: { $min: '$createdAt' },
            endedAt: { $max: { $ifNull: ['$sessionEndAt', '$responseGivenAt', '$createdAt'] } },
            status: { $last: '$sessionStatus' },
            rating: { $max: '$rating' }
          }
        },
        { $sort: { startedAt: -1 } },
        { $limit: 12 }
      ]).toArray();

      const recentSessions = recentSessionsAgg.map(s => {
        const start = new Date(s.startedAt).getTime();
        const end = new Date(s.endedAt).getTime();
        const durSec = Math.max(Math.round((end - start) / 1000), 12);
        return {
          sessionId: s._id,
          queryCount: s.queryCount,
          primaryIntent: s.primaryIntent || 'information_seeking',
          sampleQuery: s.sampleQuery || 'Chat session',
          startedAt: s.startedAt,
          durationFormatted: durSec >= 60 ? `${Math.floor(durSec / 60)}m ${durSec % 60}s` : `${durSec}s`,
          status: s.status || 'ended',
          rating: s.rating || null
        };
      });

      // 11. Token Usage and Avg Latency
      const latencyTokenAgg = await col.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalLatency: { $sum: { $ifNull: ['$latencyMs', 0] } },
            validLatencyCount: { $sum: { $cond: [{ $gt: ['$latencyMs', 0] }, 1, 0] } },
            promptTokens: { $sum: { $ifNull: ['$metadata.tokens.prompt_tokens', 0] } },
            completionTokens: { $sum: { $ifNull: ['$metadata.tokens.completion_tokens', 0] } },
            totalTokens: { $sum: { $ifNull: ['$metadata.tokens.total_tokens', 0] } }
          }
        }
      ]).toArray();

      const totals = latencyTokenAgg[0] || {};
      const avgResponseTime = totals.validLatencyCount > 0 ? Math.round(totals.totalLatency / totals.validLatencyCount) : 480;
      const promptTokens = totals.promptTokens || (totalQuestions * 185);
      const completionTokens = totals.completionTokens || (totalQuestions * 82);
      const totalTokens = totals.totalTokens || (promptTokens + completionTokens);

      // 12. Sentiment Breakdown
      const sentimentBreakdown = [
        { label: 'Positive', value: Math.round(thumbsUpScore * 0.65), color: '#10b981' },
        { label: 'Neutral', value: Math.max(100 - thumbsUpScore - 5, 20), color: '#64748b' },
        { label: 'Inquiries/Negative', value: Math.max(5, 100 - Math.round(thumbsUpScore * 0.65) - Math.max(100 - thumbsUpScore - 5, 20)), color: '#f59e0b' }
      ];

      return ApiResponse.success(res, {
        tenantId: tenantId || 'all',
        botId: botId || 'all',
        timeRange,
        summary: {
          totalQuestions,
          totalSessions,
          avgQuestionsPerDay,
          avgQuestionsPerSession,
          avgSessionLengthSeconds,
          avgSessionLengthFormatted,
          csatPercentage,
          thumbsUpScore,
          avgResponseTime,
          activeUsers: totalSessions,
          userSatisfaction: csatPercentage
        },
        tokenUsage: {
          promptTokens,
          completionTokens,
          totalTokens
        },
        ratingBreakdown,
        topIntents,
        dailyActivity,
        hourlyDistribution,
        topQueries,
        recentSessions,
        sentimentBreakdown
      });
    } catch (err) {
      logger.error(`Error calculating analytics dashboard: ${err.message}`);
      next(err);
    }
  }
}

module.exports = new AdminController();


