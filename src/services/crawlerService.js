const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../helpers/logger');
const jobManagerService = require('./jobManagerService');

// Ignored extensions: only media and raw binary executables (PDF, DOCX, TXT, CSV, JSON, XML etc. are permitted)
const IGNORED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
  'mp3', 'mp4', 'm4a', 'wav', 'avi', 'mov', 'mkv', 'webm', 'ogg',
  'css', 'js', 'map',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'exe', 'dmg', 'apk', 'iso', 'bin'
]);

class CrawlerService {
  parseProxy(proxyStr) {
    if (!proxyStr || typeof proxyStr !== 'string') return undefined;
    const clean = proxyStr.trim();
    if (!clean) return undefined;

    try {
      const urlObj = new URL(clean.startsWith('http') ? clean : `http://${clean}`);
      const proxyConfig = {
        protocol: urlObj.protocol.replace(':', ''),
        host: urlObj.hostname,
        port: parseInt(urlObj.port) || (urlObj.protocol === 'https:' ? 443 : 80)
      };

      if (urlObj.username || urlObj.password) {
        proxyConfig.auth = {
          username: decodeURIComponent(urlObj.username || ''),
          password: decodeURIComponent(urlObj.password || '')
        };
      }

      return proxyConfig;
    } catch (err) {
      logger.warn(`[Web Crawler] Invalid proxy format: "${proxyStr}"`);
      return undefined;
    }
  }

  normalizeUrl(rawUrl, baseUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
      return null;
    }

    try {
      const resolved = new URL(trimmed, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        return null;
      }

      resolved.hash = '';

      const pathname = resolved.pathname.toLowerCase();
      const dotIdx = pathname.lastIndexOf('.');
      if (dotIdx !== -1) {
        const ext = pathname.slice(dotIdx + 1);
        if (IGNORED_EXTENSIONS.has(ext)) {
          return null;
        }
      }

      let normalized = resolved.href;
      if (normalized.endsWith('/') && resolved.pathname !== '/') {
        normalized = normalized.slice(0, -1);
      }

      return normalized;
    } catch (e) {
      return null;
    }
  }

  matchesPattern(url, pattern) {
    if (!pattern || typeof pattern !== 'string') return false;
    const p = pattern.trim().toLowerCase();
    if (!p) return false;

    const u = url.toLowerCase();

    if (p.includes('*')) {
      const regexStr = '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      try {
        const regex = new RegExp(regexStr);
        try {
          const urlObj = new URL(url);
          if (regex.test(urlObj.pathname) || regex.test(u)) return true;
        } catch (_) {
          if (regex.test(u)) return true;
        }
      } catch (e) {}
    }

    return u.includes(p);
  }

  isUrlAllowed(url, includePatterns = [], excludePatterns = []) {
    if (Array.isArray(excludePatterns) && excludePatterns.length > 0) {
      for (const pattern of excludePatterns) {
        if (pattern && pattern.trim() && this.matchesPattern(url, pattern.trim())) {
          return false;
        }
      }
    }

    if (Array.isArray(includePatterns) && includePatterns.length > 0) {
      const validIncludes = includePatterns.filter(p => p && p.trim());
      if (validIncludes.length > 0) {
        const matched = validIncludes.some(p => this.matchesPattern(url, p.trim()));
        if (!matched) return false;
      }
    }

    return true;
  }

  /**
   * Fast Sitemap XML pre-discovery
   */
  async tryFetchSitemaps(startUrlObj, axiosInstance, pageLimit) {
    const sitemapCandidates = [
      `${startUrlObj.origin}/sitemap.xml`,
      `${startUrlObj.origin}/sitemap_index.xml`,
      `${startUrlObj.origin}/wp-sitemap.xml`
    ];

    const discoveredFromSitemaps = [];

    const fetchPromises = sitemapCandidates.map(async (smUrl) => {
      try {
        const res = await axiosInstance.get(smUrl, { timeout: 3000 });
        const xml = typeof res.data === 'string' ? res.data : '';
        if (xml.includes('<urlset') || xml.includes('<sitemapindex') || xml.includes('<loc>')) {
          const locRegex = /<loc>(https?:\/\/[^<]+)<\/loc>/gi;
          let match;
          while ((match = locRegex.exec(xml)) !== null) {
            const locUrl = match[1].trim();
            discoveredFromSitemaps.push(locUrl);
            if (discoveredFromSitemaps.length >= pageLimit) break;
          }
        }
      } catch (_) {}
    });

    await Promise.allSettled(fetchPromises);
    return discoveredFromSitemaps;
  }

  async crawl({
    startUrl,
    maxDepth = 2,
    maxPages = 50,
    includePatterns = [],
    excludePatterns = [],
    proxy = '',
    allowSubdomains = false,
    jobId = null
  }) {
    if (!startUrl || typeof startUrl !== 'string') {
      throw new Error('A valid starting URL is required.');
    }

    let initialUrl = startUrl.trim();
    if (!/^https?:\/\//i.test(initialUrl)) {
      initialUrl = `https://${initialUrl}`;
    }

    let startUrlObj;
    try {
      startUrlObj = new URL(initialUrl);
    } catch (e) {
      throw new Error(`Invalid start URL format: "${initialUrl}"`);
    }

    const baseHost = startUrlObj.hostname.toLowerCase();
    const depthLimit = Math.min(Math.max(parseInt(maxDepth) || 2, 1), 5);
    const pageLimit = Math.min(Math.max(parseInt(maxPages) || 50, 1), 10000);

    const parsedProxy = this.parseProxy(proxy);

    if (jobId) {
      jobManagerService.updateJob(jobId, {
        status: 'running',
        progress: { current: 0, total: pageLimit },
        stats: {
          startUrl: initialUrl,
          activeUrl: initialUrl,
          currentDepth: 1,
          maxDepth: depthLimit,
          discoveredCount: 0
        }
      });
      jobManagerService.addLog(jobId, `High-speed crawler started for ${initialUrl} (Depth ${depthLimit}, Max Pages ${pageLimit})`, 'info');
    }

    const queue = [{ url: initialUrl, depth: 1, foundOn: 'Root Entry' }];
    const visited = new Set();
    const queuedSet = new Set([initialUrl]);
    const discoveredUrls = [];

    const axiosInstance = axios.create({
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ISO-WebCrawler/2.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/pdf,text/plain,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      proxy: parsedProxy || false,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400
    });

    // Fast sitemap discovery attempt in parallel
    try {
      const sitemapUrls = await this.tryFetchSitemaps(startUrlObj, axiosInstance, pageLimit);
      if (sitemapUrls.length > 0) {
        logger.info(`[Web Crawler] Discovered ${sitemapUrls.length} URLs from sitemap XML.`);
        for (const sUrl of sitemapUrls) {
          const norm = this.normalizeUrl(sUrl, initialUrl);
          if (norm && !queuedSet.has(norm) && this.isUrlAllowed(norm, includePatterns, excludePatterns)) {
            queuedSet.add(norm);
            queue.push({ url: norm, depth: 2, foundOn: 'Sitemap XML' });
          }
        }
      }
    } catch (_) {}

    const CONCURRENCY = 8;

    while (queue.length > 0 && discoveredUrls.length < pageLimit) {
      // Check if job was cancelled
      if (jobId) {
        const currentJob = jobManagerService.getJob(jobId);
        if (currentJob && currentJob.status === 'cancelled') {
          logger.info(`[Web Crawler] Crawl job "${jobId}" stopped due to cancellation.`);
          break;
        }
      }

      // Take a batch of up to CONCURRENCY items
      const batch = [];
      while (queue.length > 0 && batch.length < CONCURRENCY && (discoveredUrls.length + batch.length) < pageLimit) {
        const item = queue.shift();
        if (!visited.has(item.url)) {
          visited.add(item.url);
          batch.push(item);
        }
      }

      if (batch.length === 0) continue;

      // Process batch concurrently
      await Promise.allSettled(batch.map(async (current) => {
        const currentUrl = current.url;

        try {
          const response = await axiosInstance.get(currentUrl, {
            responseType: 'text',
            maxContentLength: 10 * 1024 * 1024
          });

          const contentType = response.headers['content-type'] || '';
          let pageTitle = currentUrl;
          let isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');

          // Extract title if HTML
          if (isHtml && typeof response.data === 'string') {
            const $ = cheerio.load(response.data);
            pageTitle = $('title').text().trim() || 
                        $('meta[property="og:title"]').attr('content') || 
                        $('h1').first().text().trim() || 
                        currentUrl;

            // Extract more links if depth limit not reached
            if (current.depth < depthLimit && (discoveredUrls.length + queue.length) < (pageLimit * 2)) {
              $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                const normalized = this.normalizeUrl(href, currentUrl);
                if (!normalized) return;

                try {
                  const linkObj = new URL(normalized);
                  const linkHost = linkObj.hostname.toLowerCase();

                  if (allowSubdomains) {
                    if (linkHost !== baseHost && !linkHost.endsWith(`.${baseHost}`)) return;
                  } else {
                    if (linkHost !== baseHost) return;
                  }

                  if (!this.isUrlAllowed(normalized, includePatterns, excludePatterns)) return;

                  if (!visited.has(normalized) && !queuedSet.has(normalized)) {
                    queuedSet.add(normalized);
                    queue.push({
                      url: normalized,
                      depth: current.depth + 1,
                      foundOn: currentUrl
                    });
                  }
                } catch (e) {}
              });
            }
          } else {
            // For documents/files (PDF, DOCX, TXT, CSV, etc.)
            try {
              const urlObj = new URL(currentUrl);
              const pathParts = urlObj.pathname.split('/');
              pageTitle = decodeURIComponent(pathParts[pathParts.length - 1]) || currentUrl;
            } catch (_) {
              pageTitle = currentUrl;
            }
          }

          discoveredUrls.push({
            url: currentUrl,
            title: pageTitle,
            depth: current.depth,
            foundOn: current.foundOn,
            contentType: contentType.split(';')[0] || 'text/html',
            status: 'discovered',
            selected: true
          });

        } catch (err) {
          logger.warn(`[Web Crawler] Failed to fetch "${currentUrl}": ${err.message}`);
          discoveredUrls.push({
            url: currentUrl,
            title: currentUrl,
            depth: current.depth,
            foundOn: current.foundOn,
            status: 'error',
            error: err.message,
            selected: false
          });
        }
      }));

      // Update progress after each parallel batch
      if (jobId) {
        const pct = Math.min(99, Math.round((discoveredUrls.length / pageLimit) * 100));
        jobManagerService.updateJob(jobId, {
          progress: { current: discoveredUrls.length, total: pageLimit, percentage: pct, percent: pct },
          stats: {
            activeUrl: batch[batch.length - 1]?.url || '',
            currentDepth: batch[0]?.depth || 1,
            discoveredCount: discoveredUrls.length
          }
        });
      }
    }

    const crawlResult = {
      startUrl: initialUrl,
      baseHost,
      totalDiscovered: discoveredUrls.length,
      maxDepth: depthLimit,
      maxPages: pageLimit,
      discoveredUrls
    };

    if (jobId) {
      jobManagerService.updateJob(jobId, {
        status: 'completed',
        progress: { current: discoveredUrls.length, total: discoveredUrls.length, percentage: 100 },
        stats: {
          activeUrl: '',
          discoveredCount: discoveredUrls.length
        },
        result: crawlResult
      });
      jobManagerService.addLog(jobId, `Crawler finished. Discovered ${discoveredUrls.length} total pages.`, 'info');
    }

    logger.info(`[Web Crawler] Finished crawl for "${initialUrl}". Total URLs discovered: ${discoveredUrls.length}`);
    return crawlResult;
  }
}

module.exports = new CrawlerService();
