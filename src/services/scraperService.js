const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const logger = require('../helpers/logger');

class ScraperService {
  /**
   * Scrapes webpage or document content, extracts clean text and metadata
   * Supports HTML, PDF, TXT, CSV, JSON, Markdown
   * @param {string} url - Target URL to scrape
   * @returns {Promise<{ title: string, description: string, cleanText: string, charCount: number, url: string }>}
   */
  async scrapeUrl(url) {
    if (!url || typeof url !== 'string') {
      throw new Error('Valid URL string is required.');
    }

    let targetUrl = url.trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
    }

    try {
      logger.info(`[RAG Scraper] Fetching content from: ${targetUrl}`);

      const response = await axios.get(targetUrl, {
        timeout: 20000,
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ISO-RAG-Ingest/2.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml,application/pdf,text/plain,text/csv,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        maxRedirects: 5
      });

      const buffer = Buffer.from(response.data);
      const contentType = (response.headers['content-type'] || '').toLowerCase();
      const urlLower = targetUrl.toLowerCase();

      let title = '';
      let description = '';
      let cleanText = '';

      // Derive fallback title from URL pathname
      let urlFileName = targetUrl;
      try {
        const u = new URL(targetUrl);
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length > 0) {
          urlFileName = decodeURIComponent(segments[segments.length - 1]);
        }
      } catch (_) {}

      // 1. PDF File Parsing
      if (contentType.includes('application/pdf') || urlLower.endsWith('.pdf')) {
        logger.info(`[RAG Scraper] Parsing PDF document: ${targetUrl}`);
        const pdfData = await pdfParse(buffer);
        title = pdfData.info?.Title || urlFileName || targetUrl;
        description = pdfData.info?.Subject || pdfData.info?.Author ? `Author: ${pdfData.info?.Author || ''}` : '';
        cleanText = (pdfData.text || '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\t/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
      // 2. Plain Text, CSV, JSON, Markdown
      else if (
        contentType.includes('text/plain') ||
        contentType.includes('text/csv') ||
        contentType.includes('application/json') ||
        contentType.includes('text/markdown') ||
        urlLower.endsWith('.txt') ||
        urlLower.endsWith('.csv') ||
        urlLower.endsWith('.json') ||
        urlLower.endsWith('.md')
      ) {
        title = urlFileName || targetUrl;
        const raw = buffer.toString('utf-8');
        cleanText = raw
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\t/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
      // 3. HTML / Webpage Content
      else {
        const html = buffer.toString('utf-8');
        if (!html || typeof html !== 'string') {
          throw new Error('Empty response received from URL.');
        }

        const $ = cheerio.load(html);

        // Remove non-content elements
        $('script, style, nav, footer, header, noscript, iframe, svg, [role="navigation"], [role="banner"], .ad, .advertisement, .cookie-banner').remove();

        title = $('title').text().trim() || 
                $('meta[property="og:title"]').attr('content') || 
                $('h1').first().text().trim() || 
                urlFileName ||
                targetUrl;

        description = $('meta[name="description"]').attr('content') || 
                      $('meta[property="og:description"]').attr('content') || 
                      '';

        let contentContainer = $('main, article, [role="main"], #content, .content, .main-content');
        let rawText = '';

        if (contentContainer.length > 0) {
          rawText = contentContainer.text();
        } else {
          rawText = $('body').text();
        }

        cleanText = rawText
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\t/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      if (!cleanText || cleanText.length < 10) {
        throw new Error('Could not extract sufficient text content from URL. The document may be empty or protected.');
      }

      logger.info(`[RAG Scraper] Successfully extracted ${cleanText.length} characters from: ${targetUrl}`);

      return {
        url: targetUrl,
        title,
        description,
        cleanText,
        charCount: cleanText.length
      };
    } catch (err) {
      logger.error(`[RAG Scraper] Failed to scrape URL ${targetUrl}: ${err.message}`);
      throw new Error(`Failed to scrape URL: ${err.message}`);
    }
  }
}

module.exports = new ScraperService();
