const mongoose = require('mongoose');
const logger = require('../helpers/logger');
const cacheService = require('./cacheService');

class JobManagerService {
  constructor() {
    this.jobs = new Map();
    this.abortControllers = new Map();
    this.MAX_SAVED_JOBS = 200;
    this._initialized = false;
  }

  getMasterDb() {
    const masterDbName = process.env.MONGO_MASTER_DB || 'master';
    return mongoose.connection.useDb(masterDbName, { useCache: true });
  }

  getJobsCollection() {
    const db = this.getMasterDb();
    return db.collection('ingestion_jobs');
  }

  /**
   * Load existing active and recent jobs from MongoDB on startup
   */
  async init() {
    if (this._initialized) return;
    if (mongoose.connection.readyState !== 1) return;
    try {
      const col = this.getJobsCollection();
      const docs = await col.find({}).sort({ createdAt: -1 }).limit(100).toArray();
      
      for (const doc of docs) {
        const jobId = doc.jobId || doc.id || doc._id?.toString();
        // If server restarted while a job was running, mark it as stopped or restore
        if (doc.status === 'running' || doc.status === 'pending') {
          doc.status = 'failed';
          doc.error = doc.error || 'Server restarted while job was in progress.';
          doc.endTime = doc.endTime || new Date().toISOString();
          col.updateOne({ _id: doc._id }, { $set: { status: doc.status, error: doc.error, endTime: doc.endTime } }).catch(() => {});
        }
        this.jobs.set(jobId, doc);
      }
      this._initialized = true;
      logger.info(`[JobManager] Loaded ${docs.length} historical ingestion jobs from MongoDB.`);
    } catch (err) {
      logger.warn(`[JobManager] Could not load jobs from MongoDB on init: ${err.message}`);
    }
  }

  /**
   * Create a new tracked background job and persist to MongoDB & Redis
   * @param {Object} params
   * @returns {Object} job
   */
  createJob({ 
    type = 'crawl', 
    tenantId = 'default', 
    tenantName = '', 
    botId = 'default', 
    botName = '', 
    createdBy = 'system', 
    title = '', 
    params = {} 
  }) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const abortController = new AbortController();
    this.abortControllers.set(jobId, abortController);

    const nowIso = new Date().toISOString();
    const job = {
      id: jobId,
      jobId,
      type, // 'crawl' | 'ingest' | 'batch_ingest' | 'rescrape'
      title: title || `${type.toUpperCase()} Task`,
      status: 'running', // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
      tenantId: tenantId || 'default',
      tenantName: tenantName || tenantId || 'Default',
      botId: botId || 'default',
      botName: botName || botId || 'Default',
      createdBy: createdBy || 'admin',
      params,
      progress: {
        current: 0,
        total: params.totalUrls || params.maxPages || 0,
        percentage: 0,
        percent: 0,
        currentUrl: params.startUrl || ''
      },
      stats: {
        startUrl: params.startUrl || '',
        activeUrl: params.startUrl || '',
        currentDepth: 1,
        maxDepth: params.maxDepth || 2,
        discoveredCount: 0,
        ingestedCount: 0,
        failedCount: 0
      },
      logs: [
        {
          time: nowIso,
          message: `Job initialized by ${createdBy}: ${title || type}`,
          level: 'info'
        }
      ],
      result: null,
      error: null,
      startTime: nowIso,
      createdAt: nowIso,
      endTime: null,
      updatedAt: nowIso
    };

    this.jobs.set(jobId, job);
    this._pruneOldJobs();

    // Persist asynchronously to MongoDB & Redis
    this._persistJobInsert(job);

    logger.info(`[JobManager] Created ${type} job "${jobId}" by user "${createdBy}" for tenant "${tenantId}"`);
    return this.serializeJob(job);
  }

  /**
   * Update job progress and statistics
   */
  updateJob(jobId, updates = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    const nowIso = new Date().toISOString();
    job.updatedAt = nowIso;

    if (updates.status) job.status = updates.status;
    if (updates.error !== undefined) job.error = updates.error;
    if (updates.result !== undefined) job.result = updates.result;
    if (updates.title) job.title = updates.title;

    if (updates.progress) {
      job.progress = { ...job.progress, ...updates.progress };
      if (job.progress.total > 0) {
        const pct = Math.min(100, Math.round((job.progress.current / job.progress.total) * 100));
        job.progress.percentage = pct;
        job.progress.percent = pct;
      }
    }

    if (updates.stats) {
      job.stats = { ...job.stats, ...updates.stats };
    }

    if (updates.status === 'completed' || updates.status === 'failed' || updates.status === 'cancelled') {
      if (!job.endTime) job.endTime = nowIso;
      this.abortControllers.delete(jobId);
    }

    // Persist update to DB & Redis
    this._persistJobUpdate(job);

    return this.serializeJob(job);
  }

  /**
   * Add a timestamped log to the job
   */
  addLog(jobId, message, level = 'info') {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const entry = {
      time: new Date().toISOString(),
      message,
      level
    };

    job.logs.push(entry);

    // Limit logs array length in memory
    if (job.logs.length > 300) {
      job.logs = job.logs.slice(-300);
    }

    // Push log to MongoDB asynchronously (batched/throttled)
    try {
      const col = this.getJobsCollection();
      col.updateOne(
        { jobId },
        { 
          $push: { logs: { $each: [entry], $slice: -300 } },
          $set: { updatedAt: entry.time }
        }
      ).catch(() => {});
    } catch (e) {}
  }

  /**
   * Cancel / Abort a running job
   * Enforces: only the user who started the job or a global admin can cancel it
   */
  cancelJob(jobId, requesterUser = null) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { success: false, error: `Job not found: ${jobId}` };
    }

    // Authorization check
    if (requesterUser) {
      const reqUsername = (requesterUser.username || '').toLowerCase().trim();
      const reqRole = (requesterUser.role || '').toLowerCase().trim();
      const reqTenant = (requesterUser.tenantId || '').toLowerCase().trim();
      const isGlobalAdmin = reqRole === 'global_admin' || reqRole === 'super_admin' || reqRole === 'admin' || reqTenant === 'admin';
      const isCreator = job.createdBy && job.createdBy.toLowerCase().trim() === reqUsername;

      if (!isCreator && !isGlobalAdmin) {
        return {
          success: false,
          error: `Permission denied: Job was created by "${job.createdBy}". Only the creator or a Global Admin can cancel this operation.`
        };
      }
    }

    if (job.status === 'running' || job.status === 'pending') {
      const controller = this.abortControllers.get(jobId);
      if (controller) {
        try {
          controller.abort();
        } catch (e) {}
        this.abortControllers.delete(jobId);
      }

      job.status = 'cancelled';
      job.endTime = new Date().toISOString();
      const cancelUser = requesterUser?.username || 'user';
      this.addLog(jobId, `Job cancelled by ${cancelUser}.`, 'warn');

      this._persistJobUpdate(job);
      logger.info(`[JobManager] Job "${jobId}" cancelled by "${cancelUser}".`);
      return { success: true, jobId, message: 'Job cancelled successfully.' };
    }

    return { 
      success: false, 
      error: `Job is already ${job.status} and cannot be cancelled.` 
    };
  }

  /**
   * Get single job by ID
   */
  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return this.serializeJob(job);
  }

  /**
   * Get active and recent jobs for a tenant/bot with role-based filtering
   */
  getJobs({ tenantId, botId, requesterUser = null, limit = 50 } = {}) {
    let all = Array.from(this.jobs.values());

    const reqRole = (requesterUser?.role || '').toLowerCase().trim();
    const reqTenant = (requesterUser?.tenantId || '').toLowerCase().trim();
    const reqUser = (requesterUser?.username || '').toLowerCase().trim();
    const isGlobalAdmin = reqRole === 'global_admin' || reqRole === 'super_admin' || reqRole === 'admin' || reqTenant === 'admin';

    // Tenant Isolation Filter:
    // If NOT global admin, strictly filter by user's assigned tenant
    if (!isGlobalAdmin) {
      const effectiveTenant = (reqTenant || tenantId || '').toLowerCase().trim();
      if (effectiveTenant && effectiveTenant !== 'all') {
        all = all.filter(j => 
          (j.tenantId && j.tenantId.toLowerCase() === effectiveTenant) ||
          (j.tenantId === 'default')
        );
      }
    } else if (tenantId && tenantId !== 'all' && tenantId !== 'admin') {
      // Global admin requested a specific tenant view
      const cleanT = tenantId.toLowerCase().trim();
      all = all.filter(j => 
        (j.tenantId && j.tenantId.toLowerCase() === cleanT) ||
        (j.tenantId === 'default')
      );
    }

    if (botId && botId !== 'all') {
      all = all.filter(j => j.botId === botId || j.botId === 'default');
    }

    // Sort: running/pending first, then by startTime/createdAt descending
    all.sort((a, b) => {
      const aActive = a.status === 'running' || a.status === 'pending';
      const bActive = b.status === 'running' || b.status === 'pending';
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      const timeA = new Date(a.createdAt || a.startTime).getTime() || 0;
      const timeB = new Date(b.createdAt || b.startTime).getTime() || 0;
      return timeB - timeA;
    });

    return all.slice(0, limit).map(j => {
      const serialized = this.serializeJob(j);
      // Attach computed canCancel permission for the current requester
      const isCreator = j.createdBy && j.createdBy.toLowerCase().trim() === reqUser;
      serialized.canCancel = Boolean(isCreator || isGlobalAdmin);
      return serialized;
    });
  }

  /**
   * Delete a single job from memory and MongoDB
   */
  async deleteJob(jobId, requesterUser = null) {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (requesterUser) {
      const reqRole = (requesterUser.role || '').toLowerCase().trim();
      const reqTenant = (requesterUser.tenantId || '').toLowerCase().trim();
      const isGlobalAdmin = reqRole === 'global_admin' || reqRole === 'super_admin' || reqTenant === 'admin';
      const isCreator = job.createdBy && job.createdBy.toLowerCase().trim() === (requesterUser.username || '').toLowerCase().trim();

      if (!isCreator && !isGlobalAdmin) {
        return false;
      }
    }

    this.jobs.delete(jobId);
    this.abortControllers.delete(jobId);

    try {
      const col = this.getJobsCollection();
      await col.deleteOne({ jobId });
      await cacheService.del(`job:${jobId}`);
    } catch (e) {}

    return true;
  }

  /**
   * Clear all completed, cancelled, or failed jobs for a tenant
   */
  async clearCompletedJobs({ tenantId, botId, requesterUser = null } = {}) {
    let count = 0;
    const toDeleteIds = [];

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        if (tenantId && tenantId !== 'all' && job.tenantId !== tenantId && job.tenantId !== 'default') {
          continue;
        }
        toDeleteIds.push(jobId);
        this.jobs.delete(jobId);
        this.abortControllers.delete(jobId);
        count++;
      }
    }

    if (toDeleteIds.length > 0) {
      try {
        const col = this.getJobsCollection();
        await col.deleteMany({ jobId: { $in: toDeleteIds } });
        for (const id of toDeleteIds) {
          cacheService.del(`job:${id}`).catch(() => {});
        }
      } catch (e) {}
    }

    return count;
  }

  /**
   * Helper: Strip internal props
   */
  serializeJob(job) {
    if (!job) return null;
    const { ...rest } = job;
    return rest;
  }

  async _persistJobInsert(job) {
    try {
      const col = this.getJobsCollection();
      await col.insertOne({ ...job });
      await cacheService.set(`job:${job.jobId}`, job, 3600);
    } catch (err) {
      logger.warn(`[JobManager] DB insert warning for job "${job.jobId}": ${err.message}`);
    }
  }

  async _persistJobUpdate(job) {
    try {
      const col = this.getJobsCollection();
      await col.updateOne(
        { jobId: job.jobId },
        { 
          $set: { 
            status: job.status,
            progress: job.progress,
            stats: job.stats,
            result: job.result,
            error: job.error,
            endTime: job.endTime,
            updatedAt: job.updatedAt
          } 
        },
        { upsert: true }
      );
      await cacheService.set(`job:${job.jobId}`, job, 3600);
    } catch (err) {
      logger.warn(`[JobManager] DB update warning for job "${job.jobId}": ${err.message}`);
    }
  }

  _pruneOldJobs() {
    if (this.jobs.size > this.MAX_SAVED_JOBS) {
      const sorted = Array.from(this.jobs.entries()).sort((a, b) => {
        const timeA = new Date(a[1].createdAt || a[1].startTime).getTime() || 0;
        const timeB = new Date(b[1].createdAt || b[1].startTime).getTime() || 0;
        return timeA - timeB;
      });

      while (this.jobs.size > this.MAX_SAVED_JOBS) {
        const oldest = sorted.shift();
        if (oldest) {
          this.jobs.delete(oldest[0]);
          this.abortControllers.delete(oldest[0]);
        }
      }
    }
  }
}

const jobManager = new JobManagerService();
// Initialize from DB once MongoDB connects
setTimeout(() => jobManager.init(), 1000);

module.exports = jobManager;
