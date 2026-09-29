const { getRedisClient, isRedisReady } = require('../config/redis');
const env = require('../config/env');
const logger = require('../helpers/logger');

class CacheService {
  constructor() {
    this.defaultTtl = env.REDIS_CACHE_TTL || 600; // 10 minutes default
  }

  /**
   * Get parsed value from Redis by key
   */
  async get(key) {
    if (!isRedisReady()) return null;
    try {
      const client = getRedisClient();
      const raw = await client.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      logger.warn(`[CacheService] GET error for key "${key}": ${err.message}`);
      return null;
    }
  }

  /**
   * Set JSON value in Redis with TTL
   */
  async set(key, value, ttlSeconds = this.defaultTtl) {
    if (!isRedisReady()) return false;
    try {
      const client = getRedisClient();
      const payload = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await client.set(key, payload, 'EX', ttlSeconds);
      } else {
        await client.set(key, payload);
      }
      return true;
    } catch (err) {
      logger.warn(`[CacheService] SET error for key "${key}": ${err.message}`);
      return false;
    }
  }

  /**
   * Delete a key from Redis
   */
  async del(key) {
    if (!isRedisReady()) return false;
    try {
      const client = getRedisClient();
      await client.del(key);
      return true;
    } catch (err) {
      logger.warn(`[CacheService] DEL error for key "${key}": ${err.message}`);
      return false;
    }
  }

  /**
   * Delete all keys matching a wildcard pattern (e.g. 'bot:*', 'genai:*')
   * Uses non-blocking SCAN stream to prevent freezing Redis event loop
   */
  async delPattern(pattern) {
    if (!isRedisReady()) return false;
    try {
      const client = getRedisClient();
      if (!client) return false;

      return new Promise((resolve) => {
        const stream = client.scanStream({
          match: pattern,
          count: 100
        });

        let totalDeleted = 0;

        stream.on('data', async (keys = []) => {
          if (keys.length > 0) {
            stream.pause();
            try {
              await client.del(...keys);
              totalDeleted += keys.length;
            } catch (e) {}
            stream.resume();
          }
        });

        stream.on('end', () => {
          if (totalDeleted > 0) {
            logger.info(`[CacheService] Invalidation: deleted ${totalDeleted} keys matching "${pattern}"`);
          }
          resolve(true);
        });

        stream.on('error', (err) => {
          logger.warn(`[CacheService] delPattern stream error for pattern "${pattern}": ${err.message}`);
          resolve(false);
        });
      });
    } catch (err) {
      logger.warn(`[CacheService] delPattern error for pattern "${pattern}": ${err.message}`);
      return false;
    }
  }

  /**
   * Cache-Aside Helper:
   * Returns cached value if available. If cache miss, executes fetchFn(),
   * stores result in Redis with TTL, and returns it.
   */
  async wrap(key, fetchFn, ttlSeconds = this.defaultTtl) {
    // 1. Try Cache Hit
    const cached = await this.get(key);
    if (cached !== null && cached !== undefined) {
      return cached;
    }

    // 2. Cache Miss -> Execute Database Query
    const fresh = await fetchFn();

    // 3. Store in Redis asynchronously
    if (fresh !== null && fresh !== undefined) {
      this.set(key, fresh, ttlSeconds).catch(() => {});
    }

    return fresh;
  }

  /**
   * Alias for wrap (getOrSet)
   */
  async getOrSet(key, fetchFn, ttlSeconds = this.defaultTtl) {
    return this.wrap(key, fetchFn, ttlSeconds);
  }
}

module.exports = new CacheService();
