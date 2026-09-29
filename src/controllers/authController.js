const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { User, RolePermission, Tenant } = require('../models');
const cacheService = require('../services/cacheService');
const emailService = require('../services/emailService');
const logger = require('../helpers/logger');

// Inactivity timeout: 2 Hours (7200000 milliseconds)
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

class AuthController {
  constructor() {
    this.indexEnsured = false;
  }

  // Helper: Verify password with bcrypt or plaintext fallback
  verifyPassword(provided, stored) {
    if (!provided || !stored) return false;
    try {
      if (bcrypt.compareSync(provided, stored)) return true;
    } catch (e) {
      // not a valid bcrypt hash
    }
    return provided === stored;
  }

  // Helper: Get master database instance
  getMasterDb() {
    return mongoose.connection.useDb('master', { useCache: true });
  }

  // Helper: Get master > sessionManagement collection & ensure TTL index
  getSessionCollection() {
    const col = this.getMasterDb().collection('sessionManagement');
    if (!this.indexEnsured && mongoose.connection.readyState === 1) {
      col.createIndex({ lastActivityTime: 1 }, { expireAfterSeconds: 7200, background: true }).catch(() => {});
      this.indexEnsured = true;
    }
    return col;
  }

  // Helper: Generate secure unique session ID
  generateSessionId() {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return crypto.randomBytes(24).toString('hex');
  }

  // Helper: Resolve dynamic allowed menus for user/role (Cached in Redis)
  async resolveAllowedMenus(userRole, tenantId) {
    const roleKey = (userRole || 'default').toLowerCase().replace(/\s+/g, '_');
    const cacheKey = `role:menus:${roleKey}:${tenantId || 'all'}`;

    return cacheService.wrap(cacheKey, async () => {
      try {
        const masterDb = this.getMasterDb();
        let allowedMenus = [];
        
        const roleDoc = await masterDb.collection('roles').findOne({
          $or: [
            { roleId: userRole },
            { roleName: userRole },
            { roleId: roleKey }
          ]
        });

        if (roleDoc && Array.isArray(roleDoc.allowedMenus) && roleDoc.allowedMenus.length > 0) {
          allowedMenus = roleDoc.allowedMenus;
        } else if (userRole === 'Super Admin' || userRole === 'super_admin' || userRole === 'global_admin' || !tenantId) {
          const activeMenus = await masterDb.collection('menus').find({ active: true }).sort({ sortOrder: 1 }).toArray();
          allowedMenus = activeMenus.length > 0 ? activeMenus.map(m => m.menuId) : ['tenants', 'grievances', 'analytics', 'ingestion', 'conversations', 'chat'];
        } else {
          allowedMenus = ['grievances', 'analytics', 'ingestion', 'chat'];
        }
        return allowedMenus;
      } catch (err) {
        logger.error(`Error resolving allowed menus: ${err.message}`);
        return ['tenants', 'grievances', 'analytics', 'ingestion', 'conversations', 'chat'];
      }
    });
  }

  // Helper: Resolve allowed analytics widgets for user/role (Cached in Redis)
  async resolveAllowedWidgets(userRole, tenantId) {
    const ALL_WIDGET_IDS = [
      'total_questions', 'total_sessions', 'avg_questions_day', 'avg_questions_session',
      'avg_session_length', 'csat_score', 'thumbs_up_score', 'avg_latency', 'token_usage',
      'daily_trend_chart', 'top_intents_chart', 'sentiment_donut_chart', 'hourly_heatmap_chart',
      'csat_breakdown_chart', 'top_queries_table', 'recent_sessions_table'
    ];

    if (userRole === 'Super Admin' || userRole === 'super_admin' || userRole === 'global_admin' || !tenantId) {
      return ALL_WIDGET_IDS;
    }

    const roleKey = (userRole || 'default').toLowerCase().replace(/\s+/g, '_');
    const cacheKey = `role:widgets:${roleKey}:${tenantId || 'all'}`;

    return cacheService.wrap(cacheKey, async () => {
      try {
        const masterDb = this.getMasterDb();
        const roleDoc = await masterDb.collection('roles').findOne({
          $or: [
            { roleId: userRole },
            { roleName: userRole },
            { roleId: roleKey }
          ]
        });

        if (roleDoc && Array.isArray(roleDoc.allowedWidgets) && roleDoc.allowedWidgets.length > 0) {
          return roleDoc.allowedWidgets;
        }

        return ALL_WIDGET_IDS;
      } catch (err) {
        logger.error(`Error resolving allowed widgets: ${err.message}`);
        return ALL_WIDGET_IDS;
      }
    });
  }


  // ==========================================
  // AUTH: LOGIN & SESSION CREATION
  // ==========================================
  async login(req, res, next) {
    try {
      const { username, password, tenant, tenantId } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
      }

      const cleanUsername = username.trim();
      const cleanPassword = password.trim();
      const userRegex = new RegExp(`^${cleanUsername}$`, 'i');
      const requestedTenant = (tenantId || tenant || '').trim().toLowerCase();

      const masterDb = this.getMasterDb();
      let authenticatedUser = null;
      let targetTenantName = null;
      let targetTenantConfig = {};

      // Helper: Verify password with bcrypt or plaintext fallback
      const checkPass = (stored) => {
        if (!stored) return false;
        try {
          if (bcrypt.compareSync(cleanPassword, stored)) return true;
        } catch (e) {}
        return cleanPassword === stored;
      };

      // 1. Search dynamic tenant database(s)
      const allTenants = await masterDb.collection('tenantInfo').find({}).toArray();

      if (requestedTenant) {
        // STRICT TENANT ISOLATION: Only search the specific requested tenant
        const targetTenantDoc = allTenants.find(t => 
          (t.tenantId && t.tenantId.toLowerCase() === requestedTenant) ||
          (t.code && t.code.toLowerCase() === requestedTenant) ||
          (t.tenantName && t.tenantName.toLowerCase() === requestedTenant) ||
          (t.name && t.name.toLowerCase() === requestedTenant) ||
          (t._id && t._id.toString().toLowerCase() === requestedTenant)
        );

        if (!targetTenantDoc) {
          return res.status(404).json({ error: `Organization "${requestedTenant}" not found.` });
        }

        if (targetTenantDoc.tenantActive === false) {
          return res.status(403).json({ error: `Organization "${targetTenantDoc.tenantName || requestedTenant}" is inactive.` });
        }

        const tDbName = targetTenantDoc.tenantDbName || (targetTenantDoc.tenantId ? `iso_${targetTenantDoc.tenantId}` : null);
        if (tDbName) {
          try {
            const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
            const tUser = await tDb.collection('users').findOne({ 
              $or: [{ username: cleanUsername }, { username: userRegex }] 
            });
            if (tUser && checkPass(tUser.password)) {
              authenticatedUser = {
                username: tUser.username,
                role: tUser.role || (targetTenantDoc.tenantId === 'admin' ? 'global_admin' : 'tenant_admin'),
                tenantId: targetTenantDoc.tenantId || targetTenantDoc._id?.toString(),
                tenantName: targetTenantDoc.tenantName || targetTenantDoc.name || targetTenantDoc.tenantId,
                fullName: tUser.fullName || tUser.username,
                email: tUser.email || `${tUser.username}@${targetTenantDoc.tenantId}.com`,
                phone: tUser.phone || '',
                photo: tUser.photo || '',
                tenantConfig: targetTenantDoc.tenantConfig || {}
              };
              targetTenantName = targetTenantDoc.tenantName || targetTenantDoc.name || targetTenantDoc.tenantId;
              targetTenantConfig = targetTenantDoc.tenantConfig || {};
            }
          } catch (e) {
            logger.error(`Error searching tenant db "${tDbName}": ${e.message}`);
          }
        }

        // If not found in tenant DB, check if user is a global administrator in master.users
        if (!authenticatedUser) {
          try {
            const masterUser = await masterDb.collection('users').findOne({ 
              $or: [{ username: cleanUsername }, { username: userRegex }] 
            });
            if (masterUser && checkPass(masterUser.password)) {
              const isGlobal = masterUser.role === 'global_admin' || masterUser.role === 'super_admin' || masterUser.isGlobalAdmin || targetTenantDoc.tenantId === 'admin';
              if (isGlobal) {
                authenticatedUser = {
                  username: masterUser.username,
                  role: masterUser.role || 'global_admin',
                  tenantId: targetTenantDoc.tenantId || targetTenantDoc._id?.toString(),
                  tenantName: targetTenantDoc.tenantName || targetTenantDoc.name || targetTenantDoc.tenantId,
                  fullName: masterUser.fullName || masterUser.username,
                  email: masterUser.email || `${masterUser.username}@isomorphic.com`,
                  phone: masterUser.phone || '',
                  photo: masterUser.photo || '',
                  tenantConfig: targetTenantDoc.tenantConfig || {}
                };
                targetTenantName = targetTenantDoc.tenantName || targetTenantDoc.name || targetTenantDoc.tenantId;
                targetTenantConfig = targetTenantDoc.tenantConfig || {};
              }
            }
          } catch (e) {}
        }

        if (!authenticatedUser) {
          return res.status(401).json({ error: `Invalid username or password for ${targetTenantDoc.tenantName || requestedTenant}.` });
        }
      } else {
        // No specific tenant specified (standard login): search across tenants
        for (const t of allTenants) {
          try {
            const tDbName = t.tenantDbName || (t.tenantId ? `iso_${t.tenantId}` : null);
            if (!tDbName) continue;
            const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
            const tUser = await tDb.collection('users').findOne({ 
              $or: [{ username: cleanUsername }, { username: userRegex }] 
            });
            if (tUser && checkPass(tUser.password)) {
              authenticatedUser = {
                username: tUser.username,
                role: tUser.role || (t.tenantId === 'admin' ? 'global_admin' : 'tenant_admin'),
                tenantId: t.tenantId || t._id?.toString(),
                tenantName: t.tenantName || t.name || t.tenantId,
                fullName: tUser.fullName || tUser.username,
                email: tUser.email || `${tUser.username}@${t.tenantId}.com`,
                phone: tUser.phone || '',
                photo: tUser.photo || '',
                tenantConfig: t.tenantConfig || {}
              };
              targetTenantName = t.tenantName || t.name || t.tenantId;
              targetTenantConfig = t.tenantConfig || {};
              break;
            }
          } catch (e) {
            // continue checking
          }
        }

        // Also check master.users for global administrators
        if (!authenticatedUser) {
          try {
            const masterUser = await masterDb.collection('users').findOne({ 
              $or: [{ username: cleanUsername }, { username: userRegex }] 
            });
            if (masterUser && checkPass(masterUser.password)) {
              authenticatedUser = {
                username: masterUser.username,
                role: masterUser.role || 'global_admin',
                tenantId: masterUser.tenantId || 'admin',
                tenantName: 'admin',
                fullName: masterUser.fullName || masterUser.username,
                email: masterUser.email || `${masterUser.username}@isomorphic.com`,
                phone: masterUser.phone || '',
                photo: masterUser.photo || '',
                tenantConfig: {}
              };
              targetTenantName = 'admin';
            }
          } catch (e) {}
        }

        if (!authenticatedUser) {
          return res.status(401).json({ error: 'Invalid username or password.' });
        }
      }

      // Resolve allowed menus & analytics widgets dynamically
      const allowedMenus = await this.resolveAllowedMenus(authenticatedUser.role, authenticatedUser.tenantId);
      const allowedWidgets = await this.resolveAllowedWidgets(authenticatedUser.role, authenticatedUser.tenantId);

      if (authenticatedUser.tenantId && !targetTenantName) {
        const t = await Tenant.findById(authenticatedUser.tenantId);
        if (t) {
          targetTenantName = t.name || t.tenantName;
          targetTenantConfig = t.tenantConfig || (t.settings ? { theme: t.settings.theme } : {});
        }
      }

      // Generate a new unique session ID
      const sessionId = this.generateSessionId();
      const now = new Date();

      // Store session in MongoDB Atlas master > sessionManagement
      const sessionCol = this.getSessionCollection();
      const sessionDoc = {
        sessionId,
        username: authenticatedUser.username,
        tenantId: authenticatedUser.tenantId || null,
        tenantName: targetTenantName || authenticatedUser.tenantName || null,
        tenantConfig: targetTenantConfig || authenticatedUser.tenantConfig || {},
        role: authenticatedUser.role || 'global_admin',
        fullName: authenticatedUser.fullName || authenticatedUser.username,
        email: authenticatedUser.email || `${authenticatedUser.username}@isomorphic.com`,
        phone: authenticatedUser.phone || '',
        photo: authenticatedUser.photo || '',
        loginTime: now,
        lastActivityTime: now,
        isActive: true,
        ipAddress: req.ip || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '',
        userAgent: req.headers?.['user-agent'] || '',
        createdAt: now,
        updatedAt: now
      };

      await sessionCol.insertOne(sessionDoc);
      logger.info(`Session created for user "${authenticatedUser.username}" (sessionId: ${sessionId}) in master.sessionManagement`);

      // Return sanitized user profile WITH sessionId, allowedWidgets, and tenantConfig
      return res.json({
        sessionId,
        username: authenticatedUser.username,
        role: authenticatedUser.role,
        tenantId: authenticatedUser.tenantId,
        tenantName: targetTenantName || authenticatedUser.tenantName,
        tenantConfig: targetTenantConfig || authenticatedUser.tenantConfig || {},
        fullName: authenticatedUser.fullName || 'System Administrator',
        email: authenticatedUser.email || `${authenticatedUser.username}@isomorphic.com`,
        phone: authenticatedUser.phone || '',
        photo: authenticatedUser.photo || '',
        allowedMenus,
        allowedWidgets,
        loginTime: now,
        lastActivityTime: now
      });
    } catch (err) {
      logger.error(`Login error: ${err.message}`);
      next(err);
    }
  }

  // ==========================================
  // AUTH: SESSION VERIFICATION & AUTO-EXPIRY (2 HOURS INACTIVITY)
  // Cached in Redis for 10 minutes to eliminate DB latency on route checks
  // ==========================================
  async verifySession(req, res, next) {
    try {
      const sessionId = req.headers['x-session-id'] || 
        req.headers.authorization?.replace(/^Bearer\s+/i, '') || 
        req.body?.sessionId || 
        req.query?.sessionId;

      if (!sessionId) {
        return res.status(401).json({ error: 'No active session token provided.', active: false });
      }

      // Check Redis Cache first
      const cacheKey = `session:token:${sessionId}`;
      const cached = await cacheService.get(cacheKey);
      if (cached && cached.active) {
        return res.json(cached);
      }

      const sessionCol = this.getSessionCollection();
      const session = await sessionCol.findOne({ sessionId });

      if (!session || !session.isActive) {
        await cacheService.del(cacheKey);
        return res.status(401).json({ 
          error: 'Session is invalid or does not exist.', 
          active: false 
        });
      }

      const now = Date.now();
      const lastActive = new Date(session.lastActivityTime || session.loginTime || session.createdAt).getTime();
      const inactiveDuration = now - lastActive;

      // Check if session has exceeded the 2-hour inactivity limit -> Delete immediately
      if (inactiveDuration > INACTIVITY_TIMEOUT_MS) {
        await sessionCol.deleteOne({ sessionId });
        await cacheService.del(cacheKey);
        logger.info(`Session deleted due to 2h inactivity for user "${session.username}" (sessionId: ${sessionId})`);
        return res.status(401).json({ 
          error: 'Session expired due to 2 hours of inactivity. Please log in again.', 
          active: false, 
          reason: 'inactivity' 
        });
      }

      // Update lastActivityTime to current time
      const currentDate = new Date();
      sessionCol.updateOne(
        { sessionId },
        { 
          $set: { 
            lastActivityTime: currentDate, 
            updatedAt: currentDate 
          } 
        }
      ).catch(() => {});

      // Re-fetch user record from tenant database to get any updated full name / photo / phone
      let tenantUser = null;
      if (session.tenantId) {
        const targetDbName = session.tenantId.startsWith('iso_') ? session.tenantId : `iso_${session.tenantId}`;
        const tDb = mongoose.connection.useDb(targetDbName, { useCache: true });
        tenantUser = await tDb.collection('users').findOne({ username: session.username });
      }
      if (!tenantUser) {
        const masterDb = this.getMasterDb();
        const allTenants = await masterDb.collection('tenantInfo').find({}).toArray();
        for (const t of allTenants) {
          try {
            const tDbName = t.tenantDbName || (t.tenantId ? `iso_${t.tenantId}` : null);
            if (!tDbName) continue;
            const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
            const u = await tDb.collection('users').findOne({ username: session.username });
            if (u) {
              tenantUser = u;
              break;
            }
          } catch (e) {}
        }
      }

      // Refresh allowed menus & analytics widgets dynamically
      const allowedMenus = await this.resolveAllowedMenus(session.role, session.tenantId);
      const allowedWidgets = await this.resolveAllowedWidgets(session.role, session.tenantId);

      // Resolve tenantConfig from master.tenantInfo
      let targetTenantConfig = session.tenantConfig || {};
      if (session.tenantId) {
        try {
          const masterDb = this.getMasterDb();
          const tDoc = await masterDb.collection('tenantInfo').findOne({
            $or: [
              { tenantId: session.tenantId },
              { code: session.tenantId },
              ...(mongoose.Types.ObjectId.isValid(session.tenantId) ? [{ _id: new mongoose.Types.ObjectId(session.tenantId) }] : [])
            ]
          });
          if (tDoc && tDoc.tenantConfig) {
            targetTenantConfig = tDoc.tenantConfig;
          }
        } catch (tErr) {}
      }

      const responsePayload = {
        active: true,
        sessionId: session.sessionId,
        user: {
          sessionId: session.sessionId,
          username: session.username,
          role: session.role,
          tenantId: session.tenantId,
          tenantName: session.tenantName,
          tenantConfig: targetTenantConfig,
          fullName: tenantUser?.fullName || session.fullName || session.username,
          email: tenantUser?.email || session.email || `${session.username}@isomorphic.com`,
          phone: tenantUser?.phone || session.phone || '',
          photo: tenantUser?.photo || session.photo || '',
          allowedMenus,
          allowedWidgets,
          loginTime: session.loginTime,
          lastActivityTime: currentDate
        }
      };

      // Cache session result in Redis for 10 minutes (600s)
      await cacheService.set(cacheKey, responsePayload, 600);

      return res.json(responsePayload);
    } catch (err) {
      logger.error(`Session verification error: ${err.message}`);
      next(err);
    }
  }

  // ==========================================
  // AUTH: HEARTBEAT (REFRESH LAST ACTIVITY)
  // ==========================================
  async heartbeat(req, res, next) {
    try {
      const sessionId = req.headers['x-session-id'] || 
        req.headers.authorization?.replace(/^Bearer\s+/i, '') || 
        req.body?.sessionId || 
        req.query?.sessionId;

      if (!sessionId) {
        return res.status(401).json({ active: false, error: 'Session ID required.' });
      }

      const sessionCol = this.getSessionCollection();
      const session = await sessionCol.findOne({ sessionId });

      if (!session || !session.isActive) {
        await cacheService.del(`session:token:${sessionId}`);
        return res.status(401).json({ active: false, error: 'Session is inactive.' });
      }

      const now = Date.now();
      const lastActive = new Date(session.lastActivityTime || session.loginTime || session.createdAt).getTime();

      // Check inactivity limit -> Delete immediately if timed out
      if (now - lastActive > INACTIVITY_TIMEOUT_MS) {
        await sessionCol.deleteOne({ sessionId });
        await cacheService.del(`session:token:${sessionId}`);
        return res.status(401).json({ active: false, reason: 'inactivity', error: 'Session timed out.' });
      }

      // Update activity timestamp
      const currentDate = new Date();
      sessionCol.updateOne(
        { sessionId },
        { 
          $set: { 
            lastActivityTime: currentDate, 
            updatedAt: currentDate 
          } 
        }
      ).catch(() => {});

      return res.json({ success: true, active: true, lastActivityTime: currentDate });
    } catch (err) {
      next(err);
    }
  }

  // ==========================================
  // AUTH: LOGOUT (IMMEDIATE SESSION DELETION)
  // ==========================================
  async logout(req, res, next) {
    try {
      const sessionId = req.headers['x-session-id'] || 
        req.headers.authorization?.replace(/^Bearer\s+/i, '') || 
        req.body?.sessionId || 
        req.query?.sessionId;

      if (sessionId) {
        const sessionCol = this.getSessionCollection();
        await sessionCol.deleteOne({ sessionId });
        // Immediately delete from Redis Cache
        await cacheService.del(`session:token:${sessionId}`);
        logger.info(`Session immediately deleted on logout for sessionId: ${sessionId}`);
      }

      return res.json({ success: true, message: 'Logged out and session deleted successfully.' });
    } catch (err) {
      logger.error(`Logout error: ${err.message}`);
      next(err);
    }
  }

  // ==========================================
  // SESSIONS MANAGEMENT (ACTIVE SESSIONS LIST)
  // ==========================================
  async getSessions(req, res, next) {
    try {
      const { tenantId, username } = req.query;
      const filter = { isActive: true };
      if (tenantId) filter.tenantId = tenantId;
      if (username) filter.username = username;

      const sessionCol = this.getSessionCollection();
      const sessions = await sessionCol.find(filter).sort({ loginTime: -1 }).limit(100).toArray();
      return res.json(sessions);
    } catch (err) {
      next(err);
    }
  }

  // ==========================================
  // USERS CRUD
  // ==========================================
  async getUsers(req, res, next) {
    try {
      const { tenantId } = req.query;
      const masterDb = this.getMasterDb();
      
      let users = [];
      if (tenantId && tenantId !== 'admin' && tenantId !== 'all') {
        const tDbName = tenantId.startsWith('iso_') ? tenantId : `iso_${tenantId}`;
        const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
        users = await tDb.collection('users').find({}, { projection: { password: 0 } }).sort({ createdAt: -1 }).toArray();
      } else {
        users = await masterDb.collection('users').find({}, { projection: { password: 0 } }).sort({ createdAt: -1 }).toArray();
        if (users.length === 0) {
          const fallback = await User.find({}, { password: 0 }).sort({ createdAt: -1 }).lean();
          users = fallback;
        }
      }
      
      return res.json(users.map(u => ({ ...u, _id: u._id?.toString() })));
    } catch (err) {
      next(err);
    }
  }

  async createUser(req, res, next) {
    try {
      const { username, password, role, tenantId, fullName, email, phone } = req.body;
      if (!username || !password || !role) {
        return res.status(400).json({ error: 'Username, password, and role are required.' });
      }

      const cleanUser = username.trim();
      const hashedPassword = bcrypt.hashSync(password.trim(), 10);
      const masterDb = this.getMasterDb();

      // Check existing across master and tenant DB
      const existingInMaster = await masterDb.collection('users').findOne({ username: cleanUser });
      if (existingInMaster) {
        return res.status(400).json({ error: 'Username already taken.' });
      }

      const userDoc = {
        username: cleanUser,
        password: hashedPassword,
        role,
        tenantId: tenantId || null,
        fullName: fullName || cleanUser,
        email: email || '',
        phone: phone || '',
        photo: '',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Insert into master users
      const masterRes = await masterDb.collection('users').insertOne({ ...userDoc });

      // If tenantId specified, mirror insert into tenant DB
      if (tenantId && tenantId !== 'admin') {
        const tDbName = tenantId.startsWith('iso_') ? tenantId : `iso_${tenantId}`;
        const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
        await tDb.collection('users').insertOne({ ...userDoc }).catch(() => {});
      }

      // Also create via Mongoose User model for schema compatibility
      await User.create({
        username: cleanUser,
        password: hashedPassword,
        role,
        tenantId: mongoose.Types.ObjectId.isValid(tenantId) ? tenantId : null,
        fullName: fullName || '',
        email: email || '',
        phone: phone || ''
      }).catch(() => {});

      const resUser = { ...userDoc, _id: masterRes.insertedId.toString() };
      delete resUser.password;
      return res.status(201).json(resUser);
    } catch (err) {
      next(err);
    }
  }

  async updateUser(req, res, next) {
    try {
      const { id } = req.params;
      const { password, role, fullName, email, phone, photo, tenantId } = req.body;
      
      const updateData = { updatedAt: new Date() };
      if (password && password.trim()) updateData.password = bcrypt.hashSync(password.trim(), 10);
      if (role) updateData.role = role;
      if (fullName !== undefined) updateData.fullName = fullName;
      if (email !== undefined) updateData.email = email;
      if (phone !== undefined) updateData.phone = phone;
      if (photo !== undefined) updateData.photo = photo;

      const masterDb = this.getMasterDb();
      let filter = {};
      if (mongoose.Types.ObjectId.isValid(id)) {
        filter = { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { username: id }] };
      } else {
        filter = { username: id };
      }

      await masterDb.collection('users').updateOne(filter, { $set: updateData });

      if (tenantId && tenantId !== 'admin') {
        const tDbName = tenantId.startsWith('iso_') ? tenantId : `iso_${tenantId}`;
        const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
        await tDb.collection('users').updateOne(filter, { $set: updateData }).catch(() => {});
      }

      if (mongoose.Types.ObjectId.isValid(id)) {
        await User.findByIdAndUpdate(id, updateData).catch(() => {});
      }

      const updatedUser = await masterDb.collection('users').findOne(filter, { projection: { password: 0 } });
      if (!updatedUser) return res.status(404).json({ error: 'User not found.' });
      
      return res.json({ ...updatedUser, _id: updatedUser._id?.toString() });
    } catch (err) {
      next(err);
    }
  }

  async deleteUser(req, res, next) {
    try {
      const { id } = req.params;
      const { tenantId } = req.query;
      const masterDb = this.getMasterDb();

      let filter = {};
      if (mongoose.Types.ObjectId.isValid(id)) {
        filter = { $or: [{ _id: new mongoose.Types.ObjectId(id) }, { username: id }] };
      } else {
        filter = { username: id };
      }

      await masterDb.collection('users').deleteOne(filter);

      if (tenantId && tenantId !== 'admin') {
        const tDbName = tenantId.startsWith('iso_') ? tenantId : `iso_${tenantId}`;
        const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
        await tDb.collection('users').deleteOne(filter).catch(() => {});
      }

      if (mongoose.Types.ObjectId.isValid(id)) {
        await User.findByIdAndDelete(id).catch(() => {});
      }

      return res.json({ success: true, message: 'User deleted.' });
    } catch (err) {
      next(err);
    }
  }

  // ==========================================
  // ROLES & PERMISSIONS
  // ==========================================
  async getRoles(req, res, next) {
    try {
      const { tenantId } = req.query;
      const filter = {};
      if (tenantId) filter.tenantId = tenantId;
      const roles = await RolePermission.find(filter);
      return res.json(roles);
    } catch (err) {
      next(err);
    }
  }

  async saveRole(req, res, next) {
    try {
      const { tenantId, roleName, allowedMenus } = req.body;
      if (!roleName) return res.status(400).json({ error: 'Role name is required.' });

      let role = await RolePermission.findOne({ tenantId, roleName });
      if (role) {
        role.allowedMenus = allowedMenus;
        await role.save();
      } else {
        role = await RolePermission.create({ tenantId, roleName, allowedMenus });
      }
      return res.json(role);
    } catch (err) {
      next(err);
    }
  }

  async createOrUpdateRole(req, res, next) {
    return this.saveRole(req, res, next);
  }

  async deleteRole(req, res, next) {
    try {
      const { id } = req.params;
      const role = await RolePermission.findByIdAndDelete(id);
      if (!role) return res.status(404).json({ error: 'Role not found.' });
      return res.json({ success: true, message: 'Role deleted.' });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/auth/profile
   * Fetch current user profile from master > users or tenantDb > users
   */
  async getProfile(req, res, next) {
    try {
      const sessionId = req.headers['x-session-id'] || req.query?.sessionId;
      let username = req.query?.username;
      let userRole = null;
      let tenantId = null;

      if (sessionId) {
        const sessionCol = this.getSessionCollection();
        const session = await sessionCol.findOne({ sessionId });
        if (session) {
          if (session.username) username = session.username;
          userRole = session.role;
          tenantId = session.tenantId;
        }
      }

      if (!username) {
        return res.status(400).json({ error: 'Username or active session is required.' });
      }

      const masterDb = this.getMasterDb();
      let user = null;
      let sourceDb = null;

      // If tenantId is known, check that tenant db first
      if (tenantId) {
        const targetDbName = tenantId.startsWith('iso_') ? tenantId : `iso_${tenantId}`;
        const tDb = mongoose.connection.useDb(targetDbName, { useCache: true });
        user = await tDb.collection('users').findOne({ username });
        if (user) {
          sourceDb = targetDbName;
        }
      }

      // If not found yet, scan all registered tenant databases
      if (!user) {
        const allTenants = await masterDb.collection('tenantInfo').find({}).toArray();
        for (const t of allTenants) {
          try {
            const tDbName = t.tenantDbName || (t.tenantId ? `iso_${t.tenantId}` : null);
            if (!tDbName) continue;
            const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
            const tUser = await tDb.collection('users').findOne({ username });
            if (tUser) {
              user = tUser;
              sourceDb = tDbName;
              tenantId = t.tenantId || t.code;
              break;
            }
          } catch (e) {}
        }
      }

      if (!user) {
        return res.status(404).json({ error: `User "${username}" not found in database.` });
      }

      return res.json({
        success: true,
        user: {
          username: user.username,
          fullName: user.fullName || user.username,
          email: user.email || `${user.username}@isomorphic.com`,
          phone: user.phone || '',
          photo: user.photo || '',
          role: user.role || userRole || (tenantId === 'admin' ? 'global_admin' : 'tenant_admin'),
          tenantId: user.tenantId || tenantId || null,
          title: user.title || (user.role === 'global_admin' || tenantId === 'admin' ? 'Principal Systems Architect' : 'Tenant Administrator'),
          bio: user.bio || '',
          status: user.status || 'active',
          sourceDb
        }
      });
    } catch (err) {
      logger.error(`Error fetching user profile: ${err.message}`);
      next(err);
    }
  }

  /**
   * PUT /api/auth/profile
   * Update current user profile in tenantDb > users and active sessions
   */
  async updateProfile(req, res, next) {
    try {
      const sessionId = req.headers['x-session-id'] || req.body?.sessionId;
      const { fullName, email, phone, photo, title, bio } = req.body;

      let targetUsername = req.body?.username;
      let userRole = 'global_admin';
      let userTenantId = null;
      const sessionCol = this.getSessionCollection();

      if (sessionId) {
        const session = await sessionCol.findOne({ sessionId });
        if (session) {
          if (session.username) targetUsername = session.username;
          if (session.role) userRole = session.role;
          if (session.tenantId) userTenantId = session.tenantId;
        }
      }

      if (!targetUsername) {
        return res.status(400).json({ error: 'Username or active session is required to update profile.' });
      }

      const masterDb = this.getMasterDb();
      const updateData = { updatedAt: new Date() };
      if (fullName !== undefined) updateData.fullName = fullName.trim();
      if (email !== undefined) updateData.email = email.trim();
      if (phone !== undefined) updateData.phone = phone.trim();
      if (photo !== undefined) updateData.photo = photo;
      if (title !== undefined) updateData.title = title.trim();
      if (bio !== undefined) updateData.bio = bio;

      let updatedDoc = null;

      // Update in tenant databases
      const allTenants = await masterDb.collection('tenantInfo').find({}).toArray();
      for (const t of allTenants) {
        try {
          const tDbName = t.tenantDbName || (t.tenantId ? `iso_${t.tenantId}` : null);
          if (!tDbName) continue;
          const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
          const tUser = await tDb.collection('users').findOne({ username: targetUsername });
          if (tUser) {
            const tResult = await tDb.collection('users').findOneAndUpdate(
              { username: targetUsername },
              { $set: updateData },
              { returnDocument: 'after' }
            );
            if (!updatedDoc) {
              // In native MongoDB driver v4+, returnDocument: 'after' returns document directly or in .value
              const doc = (tResult && tResult.value !== undefined) ? tResult.value : tResult;
              updatedDoc = doc || { ...tUser, ...updateData };
              userTenantId = t.tenantId;
              userRole = tUser.role || userRole;
            }
          }
        } catch (e) {
          logger.error(`Error updating user in tenant ${t.tenantId}: ${e.message}`);
        }
      }

      // If user wasn't in any registered tenant db yet, search all iso_* databases
      if (!updatedDoc) {
        try {
          const adminDbs = await mongoose.connection.db.admin().listDatabases();
          for (const d of adminDbs.databases) {
            if (d.name.startsWith('iso_')) {
              const tDb = mongoose.connection.useDb(d.name, { useCache: true });
              const tUser = await tDb.collection('users').findOne({ username: targetUsername });
              if (tUser) {
                const tResult = await tDb.collection('users').findOneAndUpdate(
                  { username: targetUsername },
                  { $set: updateData },
                  { returnDocument: 'after' }
                );
                const doc = (tResult && tResult.value !== undefined) ? tResult.value : tResult;
                updatedDoc = doc || { ...tUser, ...updateData };
                userTenantId = d.name.replace(/^iso_/, '');
                userRole = tUser.role || userRole;
                break;
              }
            }
          }
        } catch (e) {}
      }

      // 3. Update active session records in sessionManagement
      await sessionCol.updateMany(
        { username: targetUsername },
        { 
          $set: { 
            fullName: updateData.fullName,
            email: updateData.email,
            phone: updateData.phone,
            photo: updateData.photo,
            updatedAt: new Date()
          } 
        }
      );

      // Invalidate session cache in Redis
      if (sessionId) {
        await cacheService.del(`session:token:${sessionId}`);
      }

      const finalUser = updatedDoc || updateData;

      logger.info(`Profile updated for user "${targetUsername}"`);
      return res.json({
        success: true,
        message: 'Profile updated successfully.',
        user: {
          username: targetUsername,
          fullName: finalUser.fullName || updateData.fullName || targetUsername,
          email: finalUser.email || updateData.email,
          phone: finalUser.phone || updateData.phone || '',
          photo: finalUser.photo !== undefined ? finalUser.photo : updateData.photo,
          title: finalUser.title || updateData.title || 'Principal Systems Architect',
          bio: finalUser.bio || updateData.bio || '',
          role: finalUser.role || userRole,
          tenantId: finalUser.tenantId || userTenantId
        }
      });
    } catch (err) {
      logger.error(`Error updating user profile: ${err.message}`);
      next(err);
    }
  }

  // ==========================================
  // PUBLIC TENANT BRANDING (For /login/:tenant)
  // ==========================================
  async getTenantPublicBranding(req, res, next) {
    try {
      const identifier = (req.params.identifier || req.query.tenant || req.query.tenantId || req.query.code || '').trim();
      if (!identifier) {
        return res.status(400).json({ error: 'Tenant identifier is required.' });
      }

      const cacheKey = `tenant:branding:${identifier.toLowerCase()}`;
      const branding = await cacheService.wrap(cacheKey, async () => {
        const masterDb = this.getMasterDb();
        const escapedId = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const identRegex = new RegExp(`^${escapedId}$`, 'i');

        let query = {
          $or: [
            { tenantId: identRegex },
            { code: identRegex },
            { tenantName: identRegex },
            { name: identRegex }
          ]
        };

        if (mongoose.Types.ObjectId.isValid(identifier) && identifier.length === 24) {
          query.$or.push({ _id: new mongoose.Types.ObjectId(identifier) });
        }

        const tenantDoc = await masterDb.collection('tenantInfo').findOne(query);
        if (!tenantDoc) {
          if (identifier.toLowerCase() === 'admin') {
            return {
              _id: 'admin',
              tenantId: 'admin',
              tenantName: 'System Administration',
              name: 'System Administration',
              code: 'admin',
              tenantActive: true,
              tenantConfig: {
                instituteName: 'Enterprise AI Administration',
                ButtonandLeftBarColor: '#0A2240',
                buttonFontColor: '#ffffff',
                BordersColor: '#578b96'
              }
            };
          }
          return null;
        }

        return {
          _id: tenantDoc._id.toString(),
          tenantId: tenantDoc.tenantId || tenantDoc.code || tenantDoc._id.toString(),
          tenantName: tenantDoc.tenantName || tenantDoc.name || tenantDoc.tenantId,
          name: tenantDoc.name || tenantDoc.tenantName,
          code: tenantDoc.code || tenantDoc.tenantId,
          tenantActive: tenantDoc.tenantActive !== false,
          tenantConfig: tenantDoc.tenantConfig || {}
        };
      }, 300);

      if (!branding) {
        return res.status(404).json({ error: `Tenant "${identifier}" not found.` });
      }

      if (branding.tenantActive === false) {
        return res.status(403).json({ error: `Tenant "${identifier}" is currently inactive.` });
      }

      return res.json(branding);
    } catch (err) {
      logger.error(`Error fetching tenant public branding: ${err.message}`);
      next(err);
    }
  }

  /**
   * POST /api/auth/forgot-password
   * Verify user exists in tenant database and has emailId, generate reset token, and send email
   */
  async forgotPassword(req, res, next) {
    try {
      const { identifier, username, email, tenant, tenantId, baseUrl } = req.body;
      const cleanIdent = (identifier || username || email || '').trim();
      const requestedTenant = (tenant || tenantId || '').trim().toLowerCase();

      if (!cleanIdent) {
        return res.status(400).json({ error: 'Please provide your registered username or email address.' });
      }

      const masterDb = this.getMasterDb();
      const allTenants = await masterDb.collection('tenantInfo').find({}).toArray();

      let targetTenantDoc = null;
      if (requestedTenant) {
        targetTenantDoc = allTenants.find(t => 
          (t.tenantId && t.tenantId.toLowerCase() === requestedTenant) ||
          (t.code && t.code.toLowerCase() === requestedTenant) ||
          (t.tenantName && t.tenantName.toLowerCase() === requestedTenant) ||
          (t.name && t.name.toLowerCase() === requestedTenant) ||
          (t._id && t._id.toString().toLowerCase() === requestedTenant)
        );
      }

      const identRegex = new RegExp(`^${cleanIdent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

      let targetUser = null;
      let targetDbName = null;
      let resolvedTenantDoc = targetTenantDoc;

      if (targetTenantDoc) {
        targetDbName = targetTenantDoc.tenantDbName || (targetTenantDoc.tenantId ? `iso_${targetTenantDoc.tenantId}` : null);
        if (targetDbName) {
          try {
            const tDb = mongoose.connection.useDb(targetDbName, { useCache: true });
            targetUser = await tDb.collection('users').findOne({
              $or: [
                { username: cleanIdent },
                { username: identRegex },
                { email: cleanIdent },
                { email: identRegex }
              ]
            });
          } catch (err) {
            logger.error(`Error finding user in ${targetDbName}: ${err.message}`);
          }
        }
      }

      // If not found in specific tenant DB, check master users (global admins) or search across tenants
      if (!targetUser) {
        try {
          const masterUser = await masterDb.collection('users').findOne({
            $or: [
              { username: cleanIdent },
              { username: identRegex },
              { email: cleanIdent },
              { email: identRegex }
            ]
          });
          if (masterUser) {
            targetUser = masterUser;
            targetDbName = 'master';
          }
        } catch (e) {}
      }

      if (!targetUser && !requestedTenant) {
        for (const t of allTenants) {
          try {
            const tDbName = t.tenantDbName || (t.tenantId ? `iso_${t.tenantId}` : null);
            if (!tDbName) continue;
            const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
            const found = await tDb.collection('users').findOne({
              $or: [
                { username: cleanIdent },
                { username: identRegex },
                { email: cleanIdent },
                { email: identRegex }
              ]
            });
            if (found) {
              targetUser = found;
              targetDbName = tDbName;
              resolvedTenantDoc = t;
              break;
            }
          } catch (e) {}
        }
      }

      if (!targetUser) {
        const orgName = resolvedTenantDoc?.tenantName || resolvedTenantDoc?.name || requestedTenant || 'this organization';
        return res.status(404).json({
          error: `No user account matching "${cleanIdent}" was found in ${orgName}.`
        });
      }

      const userEmail = targetUser.email || (cleanIdent.includes('@') ? cleanIdent : null);
      if (!userEmail || !userEmail.includes('@')) {
        return res.status(400).json({
          error: `User "${targetUser.username}" does not have a registered email address. Please contact your organization administrator.`
        });
      }

      // Generate secure reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const tokenExpires = new Date(Date.now() + 3600000); // 1 Hour

      // Store in Redis with 1-hour TTL
      const tokenData = {
        username: targetUser.username,
        email: userEmail,
        tenantId: resolvedTenantDoc?.tenantId || resolvedTenantDoc?.code || requestedTenant || 'admin',
        tenantDbName: targetDbName,
        createdAt: Date.now()
      };
      await cacheService.set(`pwdreset:${resetToken}`, tokenData, 3600);

      // Also persist to user document in the database
      try {
        const db = mongoose.connection.useDb(targetDbName || 'master', { useCache: true });
        await db.collection('users').updateOne(
          { _id: targetUser._id },
          {
            $set: {
              passwordResetToken: resetToken,
              passwordResetExpires: tokenExpires,
              updatedAt: new Date()
            }
          }
        );
      } catch (dbErr) {
        logger.warn(`Could not persist reset token in DB document: ${dbErr.message}`);
      }

      // Construct Reset URL
      const hostUrl = baseUrl || req.headers.origin || (req.headers.referer ? req.headers.referer.split('/login')[0] : 'http://localhost:5173');
      const tenantSlug = resolvedTenantDoc ? (resolvedTenantDoc.tenantId || resolvedTenantDoc.code || resolvedTenantDoc.tenantName) : requestedTenant;
      const resetPath = tenantSlug ? `/login/${encodeURIComponent(tenantSlug)}` : '/login';
      const resetLink = `${hostUrl}${resetPath}?resetToken=${resetToken}&username=${encodeURIComponent(targetUser.username)}`;

      // Send Email
      let emailResult = null;
      try {
        emailResult = await emailService.sendPasswordResetEmail({
          to: userEmail,
          username: targetUser.fullName || targetUser.username,
          resetLink,
          tenantName: resolvedTenantDoc?.tenantName || resolvedTenantDoc?.name || 'isomorphic',
          tenantConfig: resolvedTenantDoc?.tenantConfig || {}
        });
      } catch (eErr) {
        logger.warn(`[Auth] Email sending failed: ${eErr.message}`);
        emailResult = { success: false, error: eErr.message };
      }

      // Mask email for privacy (e.g. j***@example.com)
      const parts = userEmail.split('@');
      const maskedEmail = parts[0].length > 2
        ? `${parts[0][0]}***${parts[0][parts[0].length - 1]}@${parts[1]}`
        : `${parts[0][0]}***@${parts[1]}`;

      const emailSent = emailResult && emailResult.success !== false;

      logger.info(`======================================================================`);
      logger.info(`🔑 PASSWORD RESET LINK FOR ${targetUser.username} (${userEmail}):`);
      logger.info(`${resetLink}`);
      logger.info(`Email Delivered: ${emailSent ? 'YES' : 'NO (Blocked by cloud host)'}`);
      logger.info(`======================================================================`);

      return res.json({
        success: true,
        emailSent,
        message: emailSent
          ? `A password reset link has been sent to ${maskedEmail}.`
          : `Password reset link generated for ${maskedEmail}.`,
        email: maskedEmail,
        tenant: tenantSlug,
        resetLink: emailSent ? undefined : resetLink
      });
    } catch (err) {
      logger.error(`Error in forgotPassword: ${err.message}`);
      return res.status(500).json({ error: err.message || 'Failed to process password reset request.' });
    }
  }

  /**
   * GET /api/auth/verify-reset-token
   * Check if a reset token is valid and not expired
   */
  async verifyResetToken(req, res, next) {
    try {
      const token = (req.query.token || req.body.token || '').trim();

      if (!token) {
        return res.status(400).json({ valid: false, error: 'Reset token is required.' });
      }

      // 1. Check Redis
      const cached = await cacheService.get(`pwdreset:${token}`);
      if (cached && cached.username) {
        return res.json({
          valid: true,
          username: cached.username,
          tenantId: cached.tenantId
        });
      }

      // 2. Check Database fallback
      const masterDb = this.getMasterDb();
      const allTenants = await masterDb.collection('tenantInfo').find({}).toArray();
      for (const t of allTenants) {
        const tDbName = t.tenantDbName || (t.tenantId ? `iso_${t.tenantId}` : null);
        if (!tDbName) continue;
        try {
          const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
          const user = await tDb.collection('users').findOne({
            passwordResetToken: token,
            passwordResetExpires: { $gt: new Date() }
          });
          if (user) {
            return res.json({
              valid: true,
              username: user.username,
              tenantId: t.tenantId
            });
          }
        } catch (e) {}
      }

      return res.status(400).json({
        valid: false,
        error: 'This password reset link has expired or has already been used.'
      });
    } catch (err) {
      logger.error(`Error verifying reset token: ${err.message}`);
      next(err);
    }
  }

  /**
   * POST /api/auth/reset-password
   * Update the user password in tenant database with verification of reset token
   */
  async resetPassword(req, res, next) {
    try {
      const { token, newPassword, username, tenant } = req.body;
      const cleanToken = (token || '').trim();
      const cleanPassword = (newPassword || '').trim();

      if (!cleanToken || !cleanPassword) {
        return res.status(400).json({ error: 'Reset token and new password are required.' });
      }

      if (cleanPassword.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters long.' });
      }

      // 1. Validate Token
      let tokenData = await cacheService.get(`pwdreset:${cleanToken}`);
      let targetUser = null;
      let targetDbName = tokenData?.tenantDbName || null;
      let targetTenantId = tokenData?.tenantId || tenant || null;

      const masterDb = this.getMasterDb();
      const allTenants = await masterDb.collection('tenantInfo').find({}).toArray();

      if (!targetDbName && targetTenantId) {
        const tDoc = allTenants.find(t => t.tenantId === targetTenantId || t.code === targetTenantId);
        if (tDoc) targetDbName = tDoc.tenantDbName || `iso_${tDoc.tenantId}`;
      }

      // If tokenData from Redis found
      if (tokenData && tokenData.username) {
        const db = mongoose.connection.useDb(targetDbName || 'master', { useCache: true });
        targetUser = await db.collection('users').findOne({ username: tokenData.username });
      }

      // Fallback: search by token in DBs
      if (!targetUser) {
        for (const t of allTenants) {
          const tDbName = t.tenantDbName || (t.tenantId ? `iso_${t.tenantId}` : null);
          if (!tDbName) continue;
          try {
            const tDb = mongoose.connection.useDb(tDbName, { useCache: true });
            const found = await tDb.collection('users').findOne({
              passwordResetToken: cleanToken,
              passwordResetExpires: { $gt: new Date() }
            });
            if (found) {
              targetUser = found;
              targetDbName = tDbName;
              targetTenantId = t.tenantId;
              break;
            }
          } catch (e) {}
        }
      }

      // Check master.users fallback
      if (!targetUser) {
        try {
          const mUser = await masterDb.collection('users').findOne({
            passwordResetToken: cleanToken,
            passwordResetExpires: { $gt: new Date() }
          });
          if (mUser) {
            targetUser = mUser;
            targetDbName = 'master';
          }
        } catch (e) {}
      }

      if (!targetUser) {
        return res.status(400).json({
          error: 'Invalid or expired password reset link. Please request a new link.'
        });
      }

      // Hash new password using bcrypt
      const hashedPassword = bcrypt.hashSync(cleanPassword, 10);

      // Update in tenant DB users collection
      const targetDb = mongoose.connection.useDb(targetDbName || 'master', { useCache: true });
      await targetDb.collection('users').updateOne(
        { _id: targetUser._id },
        {
          $set: {
            password: hashedPassword,
            updatedAt: new Date()
          },
          $unset: {
            passwordResetToken: '',
            passwordResetExpires: ''
          }
        }
      );

      // Invalidate token from Redis
      await cacheService.del(`pwdreset:${cleanToken}`);

      logger.info(`[Auth] Successfully updated password for user "${targetUser.username}" in database "${targetDbName}".`);

      return res.json({
        success: true,
        message: 'Password updated successfully! Please log in with your new credentials.',
        username: targetUser.username,
        tenant: targetTenantId
      });
    } catch (err) {
      logger.error(`Error in resetPassword: ${err.message}`);
      next(err);
    }
  }
}

module.exports = new AuthController();

