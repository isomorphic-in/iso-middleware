const app = require('./app');
const env = require('./config/env');
const { connectDB, disconnectDB } = require('./config/database');
const logger = require('./helpers/logger');
const expiryWorker = require('./services/expiryWorker');

let server;

async function startServer() {
  try {
    // 1. Initialize MongoDB connection
    await connectDB();

    // 2. Initialize Redis Cloud Cache
    const { initRedis } = require('./config/redis');
    initRedis();

    // 3. Start background link expiry & notification worker
    expiryWorker.start();

    // 3. Start Express HTTP Server
    server = app.listen(env.PORT, env.HOST, () => {
      logger.info(`=======================================================`);
      logger.info(` ISO Middleware Service running on http://${env.HOST}:${env.PORT}`);
      logger.info(` Environment: ${env.NODE_ENV}`);
      logger.info(` Health check: http://${env.HOST}:${env.PORT}/health`);
      logger.info(` Ingestion API: http://${env.HOST}:${env.PORT}/api/ingestion`);
      logger.info(` Chat endpoint: http://${env.HOST}:${env.PORT}/api/chat`);
      logger.info(`=======================================================`);
    });

  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown handling for Docker containers and orchestration
async function handleShutdown(signal) {
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  // Stop background workers
  try {
    expiryWorker.stop();
  } catch (e) {}

  if (server) {
    server.close(async () => {
      logger.info('HTTP server closed.');
      try {
        const { getRedisClient } = require('./config/redis');
        const redisClient = getRedisClient();
        if (redisClient) {
          await redisClient.quit().catch(() => {});
        }
        await disconnectDB();
        logger.info('Graceful shutdown completed successfully.');
        process.exit(0);
      } catch (err) {
        logger.error('Error during database disconnect:', err);
        process.exit(1);
      }
    });

    // Force close after timeout if cleanup hangs
    setTimeout(() => {
      logger.error('Forced shutdown: Clean exit timeout exceeded.');
      process.exit(1);
    }, 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception thrown:', err);
  if (env.isProduction) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', { reason, promise });
});

startServer();
