const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Determine environment: test (default), stage, or prod
const rawEnv = (process.env.NODE_ENV || process.env.ENV || 'test').toLowerCase();
const envMap = {
  test: 'test',
  testing: 'test',
  dev: 'test',
  development: 'test',
  stage: 'stage',
  staging: 'stage',
  prod: 'prod',
  production: 'prod'
};
const activeEnv = envMap[rawEnv] || 'test';

// Search locations for .env.<environment>
const envCandidatePaths = [
  path.join(process.cwd(), 'envs', `.env.${activeEnv}`),
  path.join(process.cwd(), '..', 'envs', `.env.${activeEnv}`),
  path.join(process.cwd(), `.env.${activeEnv}`),
  path.join(process.cwd(), 'envs', '.env'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), '..', '.env')
];

for (const envPath of envCandidatePaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
    break;
  }
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV === 'development',
  
  // Server Port (defaults to 5000)
  PORT: parseInt(process.env.PORT || '5000', 10),
  HOST: process.env.HOST || '0.0.0.0',

  // MongoDB Configuration
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/isochat',
  MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'isochat',
  MONGODB_POOL_SIZE: parseInt(process.env.MONGODB_POOL_SIZE || '10', 10),

  // CORS Settings
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',

  // AI Service Settings
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  
  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10), // 1 minute
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '120', 10), // 120 requests/min per IP
  
  // Default Tenant & Bot identifiers
  DEFAULT_TENANT_CODE: process.env.DEFAULT_TENANT_CODE || 'default',
  DEFAULT_BOT_ID: process.env.DEFAULT_BOT_ID || 'ISOBot',

  // Redis Cache Configuration
  REDIS_URI: process.env.REDIS_URI || 'redis://localhost:6379',
  REDIS_CACHE_TTL: parseInt(process.env.REDIS_CACHE_TTL || '600', 10) // 10 minutes (600 seconds)
};

module.exports = env;
