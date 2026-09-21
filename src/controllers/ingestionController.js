const ragService = require('../services/ragService');
const crawlerService = require('../services/crawlerService');
const jobManagerService = require('../services/jobManagerService');
const logger = require('../helpers/logger');
const mongoose = require('mongoose');
const { cacheService } = require('../config/redis');

class IngestionController {
  /**
   * Helper: Resolve user details from session token or request headers
   */
  async resolveUser(req) {
    const sessionId = req.headers['x-session-id'] || 
      req.headers.authorization?.replace(/^Bearer\s+/i, '') || 
      req.body?.sessionId || 
      req.query?.sessionId;

    if (sessionId) {
      // 1. Try Redis cache
      try {
        const cached = await cacheService.get(`session:token:${sessionId}`);
        if (cached && cached.username) {
          return cached;
        }
      } catch (e) {}

      // 2. Try MongoDB master sessionManagement
      try {
        const masterDbName = process.env.MONGO_MASTER_DB || 'master';
        const db = mongoose.connection.useDb(masterDbName, { useCache: true });
        const session = await db.collection('sessionManagement').findOne({ sessionId, isActive: true });
        if (session) {
          return {
            username: session.username,
            role: session.role || 'user',
            tenantId: session.tenantId,
            tenantName: session.tenantName
          };
        }
      } catch (e) {}
    }

    // Fallback from request body / query
    const rawUsername = req.body?.createdBy || req.body?.username || req.query?.username || '';
    const rawRole = req.body?.userRole || req.query?.userRole || (rawUsername === 'admin' ? 'global_admin' : 'tenant_admin');
    const rawTenant = req.body?.tenantId || req.query?.tenantId || '';

    return {
      username: rawUsername || 'system',
      role: rawRole,
      tenantId: rawTenant
    };
  }

  /**
   * POST /api/ingestion/scrape
   * Scrapes a single webpage URL and vectors it
   */
  async scrapeAndIngest(req, res, next) {
    try {
      const { 
        url, 
        tenantId, 
        tenantName, 
        botId, 
        botName, 
        linkExpiry, 
        expiryNotificationEnabled, 
        notificationEmail,
        tenantDbName,
        createdBy
      } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'URL is required.' });
      }
      if (!tenantId || !botId) {
        return res.status(400).json({ error: 'Both tenantId and botId are required.' });
      }

      const requester = await this.resolveUser(req);
      const user = createdBy || requester.username || 'admin';

      // Create a trackable single ingestion job
      const job = jobManagerService.createJob({
        type: 'ingest',
        tenantId,
        tenantName,
        botId,
        botName,
        createdBy: user,
        title: `Ingesting ${url}`,
        params: { url, tenantName, botName, linkExpiry, notificationEmail }
      });

      const result = await ragService.ingestUrl({
        url,
        tenantId,
        tenantName,
        botId,
        botName,
        linkExpiry,
        expiryNotificationEnabled,
        notificationEmail,
        tenantDbName
      });

      jobManagerService.updateJob(job.jobId, {
        status: 'completed',
        progress: { current: 1, total: 1, percentage: 100 },
        stats: { ingestedCount: 1, discoveredCount: 1 },
        result
      });
      jobManagerService.addLog(job.jobId, `Successfully indexed ${url} into ${result.totalChunks || 0} vector chunks.`, 'success');

      return res.status(201).json({ ...result, jobId: job.jobId });
    } catch (err) {
      logger.error(`[Ingestion Controller] Scrape error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET /api/ingestion/sources
   */
  async getSources(req, res, next) {
    try {
      const { tenantId, botId, tenantDbName } = req.query;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required.' });
      }

      const sources = await ragService.getSources({ tenantId, botId, tenantDbName });
      return res.json(sources);
    } catch (err) {
      logger.error(`[Ingestion Controller] Get sources error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET /api/ingestion/chunks/:sourceId
   */
  async getSourceChunks(req, res, next) {
    try {
      const { sourceId } = req.params;
      const { tenantId, tenantDbName } = req.query;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required.' });
      }

      const chunks = await ragService.getSourceChunks({ sourceId, tenantId, tenantDbName });
      return res.json(chunks);
    } catch (err) {
      logger.error(`[Ingestion Controller] Get chunks error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /api/ingestion/rescrape/:sourceId
   */
  async rescrapeSource(req, res, next) {
    try {
      const { sourceId } = req.params;
      const { tenantId, tenantDbName } = req.body;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required.' });
      }

      const tenantDb = ragService.getTenantDb(tenantId, tenantDbName);
      let sId;
      try {
        sId = new mongoose.Types.ObjectId(sourceId);
      } catch (e) {
        sId = sourceId;
      }

      const source = await tenantDb.collection('ingestion_sources').findOne({ _id: sId });
      if (!source) {
        return res.status(404).json({ error: 'Knowledge source not found.' });
      }

      const result = await ragService.ingestUrl({
        url: source.sourceUrl,
        tenantId: source.tenantId,
        tenantName: source.tenantName,
        botId: source.botId,
        botName: source.botName,
        linkExpiry: source.linkExpiry,
        expiryNotificationEnabled: source.expiryNotificationEnabled,
        notificationEmail: source.notificationEmail,
        tenantDbName
      });

      return res.json(result);
    } catch (err) {
      logger.error(`[Ingestion Controller] Rescrape error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * DELETE /api/ingestion/sources/:sourceId
   */
  async deleteSource(req, res, next) {
    try {
      const { sourceId } = req.params;
      const { tenantId, tenantDbName } = req.query;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required.' });
      }

      const result = await ragService.deleteSource({ sourceId, tenantId, tenantDbName });
      return res.json(result);
    } catch (err) {
      logger.error(`[Ingestion Controller] Delete source error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /api/ingestion/search
   */
  async searchKnowledge(req, res, next) {
    try {
      const { query, tenantId, botId, topK, tenantDbName } = req.body;
      if (!query || !tenantId || !botId) {
        return res.status(400).json({ error: 'query, tenantId, and botId are required.' });
      }

      const results = await ragService.searchKnowledge({ query, tenantId, botId, topK, tenantDbName });
      return res.json(results);
    } catch (err) {
      logger.error(`[Ingestion Controller] Search error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /api/ingestion/crawl
   * Spawns non-blocking asynchronous website crawling job in background
   */
  async crawlWebsite(req, res, next) {
    try {
      const {
        startUrl,
        maxDepth = 2,
        maxPages = 50,
        includePatterns = [],
        excludePatterns = [],
        proxy = '',
        allowSubdomains = false,
        tenantId = 'default',
        tenantName = '',
        botId = 'default',
        botName = '',
        createdBy
      } = req.body;

      if (!startUrl) {
        return res.status(400).json({ error: 'Starting URL is required for crawling.' });
      }

      const requester = await this.resolveUser(req);
      const user = createdBy || requester.username || 'admin';

      // Create tracked background job
      const job = jobManagerService.createJob({
        type: 'crawl',
        tenantId,
        tenantName: tenantName || tenantId,
        botId,
        botName: botName || botId,
        createdBy: user,
        title: `Crawling ${startUrl}`,
        params: { startUrl, maxDepth, maxPages, proxy: !!proxy, allowSubdomains }
      });

      const activeJobId = job.jobId;

      // Launch crawl in background asynchronously (non-blocking)
      setImmediate(async () => {
        try {
          jobManagerService.addLog(activeJobId, `Starting crawl of ${startUrl} up to depth ${maxDepth}...`, 'info');
          const results = await crawlerService.crawl({
            startUrl,
            maxDepth,
            maxPages,
            includePatterns,
            excludePatterns,
            proxy,
            allowSubdomains,
            jobId: activeJobId
          });

          jobManagerService.updateJob(activeJobId, {
            status: 'completed',
            result: results,
            progress: { percentage: 100 }
          });
          jobManagerService.addLog(activeJobId, `Crawl finished: ${results.totalDiscovered || 0} pages discovered.`, 'success');
        } catch (err) {
          const currentJob = jobManagerService.getJob(activeJobId);
          if (currentJob && currentJob.status !== 'cancelled') {
            jobManagerService.updateJob(activeJobId, {
              status: 'failed',
              error: err.message
            });
            jobManagerService.addLog(activeJobId, `Crawl failed: ${err.message}`, 'error');
          }
        }
      });

      // Return immediately with jobId
      return res.status(202).json({
        success: true,
        jobId: activeJobId,
        message: `Web crawl started in background for ${startUrl}.`,
        job
      });
    } catch (err) {
      logger.error(`[Ingestion Controller] Crawl launch error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /api/ingestion/batch-ingest
   * Spawns non-blocking asynchronous batch ingestion job in background
   */
  async batchIngest(req, res, next) {
    try {
      const {
        urls = [],
        tenantId,
        tenantName,
        botId,
        botName,
        linkExpiry,
        expiryNotificationEnabled,
        notificationEmail,
        tenantDbName,
        createdBy,
        crawledJobId,
        crawlJobId
      } = req.body;

      if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'At least one URL is required for batch ingestion.' });
      }
      if (!tenantId || !botId) {
        return res.status(400).json({ error: 'Both tenantId and botId are required.' });
      }

      // If this batch ingestion came from a completed crawl job, delete that crawled job
      const parentCrawlId = crawledJobId || crawlJobId;
      if (parentCrawlId) {
        try {
          await jobManagerService.deleteJob(parentCrawlId);
          logger.info(`[Ingestion Controller] Deleted completed crawl job "${parentCrawlId}" as its URLs are now being ingested.`);
        } catch (delErr) {
          logger.warn(`[Ingestion Controller] Could not delete crawl job "${parentCrawlId}": ${delErr.message}`);
        }
      } else {
        // Also check if any completed crawl job for this tenant matches these URLs and delete it
        try {
          for (const [id, j] of jobManagerService.jobs.entries()) {
            if ((j.type === 'crawl' || j.type === 'website_crawl') && j.status === 'completed' && j.tenantId === tenantId) {
              const jUrls = (j.result?.discoveredUrls || []).map(u => typeof u === 'string' ? u : u.url);
              if (jUrls.length > 0 && urls.some(u => jUrls.includes(u))) {
                await jobManagerService.deleteJob(id);
                logger.info(`[Ingestion Controller] Cleaned up completed crawl job "${id}" matching batch ingested URLs.`);
              }
            }
          }
        } catch (e) {}
      }

      const requester = await this.resolveUser(req);
      const user = createdBy || requester.username || 'admin';

      // 1. Create tracked background job
      const job = jobManagerService.createJob({
        type: 'batch_ingest',
        tenantId,
        tenantName: tenantName || tenantId,
        botId,
        botName: botName || botId,
        createdBy: user,
        title: `Batch Ingestion (${urls.length} URLs)`,
        params: { totalUrls: urls.length, tenantName, botName, linkExpiry, notificationEmail }
      });

      const activeJobId = job.jobId;

      // 2. Launch batch ingestion worker in background asynchronously (non-blocking)
      setImmediate(async () => {
        jobManagerService.updateJob(activeJobId, {
          status: 'running',
          progress: { current: 0, total: urls.length, percentage: 0 },
          stats: {
            ingestedCount: 0,
            failedCount: 0,
            discoveredCount: urls.length,
            activeUrl: ''
          }
        });
        jobManagerService.addLog(activeJobId, `Batch ingestion started for ${urls.length} documents by ${user}.`, 'info');

        const results = [];
        const errors = [];
        let skippedCount = 0;

        for (let i = 0; i < urls.length; i++) {
          // Check if user requested cancellation
          const currentJob = jobManagerService.getJob(activeJobId);
          if (currentJob && currentJob.status === 'cancelled') {
            logger.info(`[Ingestion Controller] Batch ingestion "${activeJobId}" stopped due to cancellation.`);
            break;
          }

          const item = urls[i];
          const targetUrl = typeof item === 'string' ? item.trim() : item?.url?.trim();
          if (!targetUrl) continue;

          const pct = Math.round(((i) / urls.length) * 100);
          jobManagerService.updateJob(activeJobId, {
            progress: { current: i, total: urls.length, percentage: pct, currentUrl: targetUrl },
            stats: { activeUrl: targetUrl }
          });

          try {
            const result = await ragService.ingestUrl({
              url: targetUrl,
              tenantId,
              tenantName,
              botId,
              botName,
              linkExpiry,
              expiryNotificationEnabled,
              notificationEmail,
              tenantDbName,
              skipIfExists: true
            });

            if (result.skipped) {
              skippedCount++;
              jobManagerService.updateJob(activeJobId, {
                stats: { ingestedCount: results.length, skippedCount }
              });
              jobManagerService.addLog(activeJobId, `[${i + 1}/${urls.length}] Skipped (Already Indexed): ${targetUrl}`, 'info');
            } else {
              results.push(result);
              jobManagerService.updateJob(activeJobId, {
                stats: { ingestedCount: results.length, skippedCount }
              });
              jobManagerService.addLog(activeJobId, `[${i + 1}/${urls.length}] Ingested: ${targetUrl} (${result.totalChunks || 0} chunks)`, 'success');
            }
          } catch (itemErr) {
            logger.warn(`[Ingestion Controller] Batch item failed for "${targetUrl}": ${itemErr.message}`);
            errors.push({ url: targetUrl, error: itemErr.message });

            jobManagerService.updateJob(activeJobId, {
              stats: { failedCount: errors.length, skippedCount }
            });
            jobManagerService.addLog(activeJobId, `[${i + 1}/${urls.length}] Ingest failed: ${targetUrl} (${itemErr.message})`, 'warn');
          }
        }

        // Final check if cancelled
        const finalJob = jobManagerService.getJob(activeJobId);
        if (finalJob && finalJob.status === 'cancelled') {
          return;
        }

        const finalStatus = (errors.length === urls.length && urls.length > 0) ? 'failed' : 'completed';
        const batchResult = {
          jobId: activeJobId,
          total: urls.length,
          ingested: results.length,
          skipped: skippedCount,
          failed: errors.length,
          errors
        };

        jobManagerService.updateJob(activeJobId, {
          status: finalStatus,
          progress: { current: urls.length, total: urls.length, percentage: 100, currentUrl: '' },
          stats: {
            activeUrl: '',
            ingestedCount: results.length,
            skippedCount,
            failedCount: errors.length
          },
          result: batchResult
        });
        jobManagerService.addLog(activeJobId, `Batch ingestion finished: ${results.length} newly ingested, ${skippedCount} skipped (already indexed), ${errors.length} failed.`, finalStatus === 'completed' ? 'success' : 'error');
      });

      // Return immediately with HTTP 202 Accepted
      return res.status(202).json({
        success: true,
        jobId: activeJobId,
        message: `Batch ingestion started for ${urls.length} documents.`,
        job
      });
    } catch (err) {
      logger.error(`[Ingestion Controller] Batch ingest launch error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET /api/ingestion/jobs/active
   * Returns active and historical crawler/ingestion jobs for tenant / global admin
   */
  async getActiveJobs(req, res, next) {
    try {
      const { tenantId, botId, limit } = req.query;
      const requesterUser = await this.resolveUser(req);

      const jobs = jobManagerService.getJobs({
        tenantId,
        botId,
        requesterUser,
        limit: limit ? parseInt(limit, 10) : 50
      });

      const activeCount = jobs.filter(j => j.status === 'running' || j.status === 'pending').length;

      return res.json({
        activeCount,
        totalTracked: jobs.length,
        jobs
      });
    } catch (err) {
      logger.error(`[Ingestion Controller] Get active jobs error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET /api/ingestion/jobs/:jobId
   */
  async getJobById(req, res, next) {
    try {
      const { jobId } = req.params;
      const job = jobManagerService.getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: `Job not found: ${jobId}` });
      }
      return res.json(job);
    } catch (err) {
      logger.error(`[Ingestion Controller] Get job error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /api/ingestion/jobs/:jobId/cancel
   * Cancels / aborts an active running job (only creator or global admin allowed)
   */
  async cancelJob(req, res, next) {
    try {
      const { jobId } = req.params;
      const requesterUser = await this.resolveUser(req);

      const result = jobManagerService.cancelJob(jobId, requesterUser);
      if (!result.success) {
        const statusCode = result.error?.includes('Permission denied') ? 403 : 400;
        return res.status(statusCode).json({ success: false, error: result.error });
      }

      return res.json({
        success: true,
        jobId,
        message: result.message
      });
    } catch (err) {
      logger.error(`[Ingestion Controller] Cancel job error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * DELETE /api/ingestion/jobs/:jobId
   */
  async deleteJob(req, res, next) {
    try {
      const { jobId } = req.params;
      const requesterUser = await this.resolveUser(req);
      const deleted = await jobManagerService.deleteJob(jobId, requesterUser);
      if (!deleted) {
        return res.status(403).json({ success: false, error: 'Could not delete task or permission denied.' });
      }
      return res.json({ success: true, jobId });
    } catch (err) {
      logger.error(`[Ingestion Controller] Delete job error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /api/ingestion/jobs/clear-completed
   */
  async clearCompletedJobs(req, res, next) {
    try {
      const { tenantId, botId } = req.body;
      const requesterUser = await this.resolveUser(req);
      const count = await jobManagerService.clearCompletedJobs({ tenantId, botId, requesterUser });
      return res.json({ success: true, clearedCount: count });
    } catch (err) {
      logger.error(`[Ingestion Controller] Clear completed jobs error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }
}

module.exports = new IngestionController();
