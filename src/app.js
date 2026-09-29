const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const env = require('./config/env');
const requestLogger = require('./middlewares/requestLogger');
const errorHandler = require('./middlewares/errorHandler');
const apiRoutes = require('./routes');
const ApiResponse = require('./helpers/apiResponse');

const app = express();

// Security headers with embedding-friendly configuration for the chat widget
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
}));

// CORS configuration: enables cross-origin requests for chatbot embedding & multi-tenant portals (*.isomorphic.in)
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);

    if (env.CORS_ORIGIN === '*' || (env.CORS_ORIGIN && env.CORS_ORIGIN.split(',').includes(origin))) {
      return callback(null, true);
    }

    try {
      const parsed = new URL(origin);
      const host = parsed.hostname.toLowerCase();
      // Allow isomorphic.in and any *.isomorphic.in subdomain
      if (host === 'isomorphic.in' || host.endsWith('.isomorphic.in')) {
        return callback(null, true);
      }
      // Allow localhost and *.localhost
      if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1') {
        return callback(null, true);
      }
    } catch (e) {}

    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept',
    'X-Requested-With',
    'Cache-Control',
    'Pragma',
    'Expires',
    'x-session-id',
    'X-Session-Id',
    'x-tenant-id',
    'X-Tenant-Id',
    'x-api-key',
    'X-Api-Key'
  ],
  credentials: true
};
app.use(cors(corsOptions));

// HTTP request logging
app.use(requestLogger);

// Gzip compression
app.use(compression());

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Liveness probe directly at /health for Docker & load balancers
app.get('/health', (req, res) => {
  const healthController = require('./controllers/healthController');
  return healthController.getHealth(req, res);
});

// Mount all API endpoints under /api
app.use('/api', apiRoutes);

// Serve static assets from portal client build folder if present
const portalDistPath = path.join(__dirname, '../../iso-portal/client/dist');
const distPath = fs.existsSync(portalDistPath) ? portalDistPath : (fs.existsSync(path.join(__dirname, '../dist')) ? path.join(__dirname, '../dist') : path.join(__dirname, '../../iso-admin/client/dist'));
app.use(express.static(distPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000');
    }
  }
}));

// Fallback for SPA routing - serve index.html if not an /api route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/health') {
    return next();
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) {
      return ApiResponse.success(res, {
        service: 'ISO Chatbot Middleware & Admin Engine',
        version: '1.0.0',
        documentation: '/api/health',
        status: 'online'
      }, 'ISO Unified Middleware & Admin Engine is active');
    }
  });
});

// 404 handler
app.use((req, res) => {
  return ApiResponse.notFound(res, `Route not found: ${req.method} ${req.originalUrl}`);
});

// Centralized error handling
app.use(errorHandler);

module.exports = app;
