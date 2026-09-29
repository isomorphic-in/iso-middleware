const express = require('express');
const router = express.Router();
const mongoController = require('../controllers/mongoController');
const ApiResponse = require('../helpers/apiResponse');

// Authorization middleware for raw MongoDB operations
async function requireAdminAuth(req, res, next) {
  // Allow health/status check
  if (req.path === '/mongo/status') {
    return next();
  }

  const sessionId = req.headers['x-session-id'] || req.headers['authorization']?.replace('Bearer ', '');
  const apiKey = req.headers['x-api-key'];

  if (apiKey && process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
    return next();
  }

  if (sessionId) {
    try {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState === 1) {
        const masterDb = mongoose.connection.useDb('master', { useCache: true });
        const session = await masterDb.collection('sessionManagement').findOne({ sessionId, isActive: true });
        if (session && (session.role === 'global_admin' || session.role === 'super_admin' || session.role === 'admin')) {
          return next();
        }
      }
    } catch (e) {}
  }

  // If in development mode and no auth headers passed, allow local debugging
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    return next();
  }

  return ApiResponse.unauthorized(res, 'Administrator session required for direct MongoDB operations');
}

router.use('/mongo', requireAdminAuth);

// Direct MongoDB Fetch & Management APIs
router.get('/mongo/status', (req, res, next) => mongoController.getStatus(req, res, next));
router.get('/mongo/collections', (req, res, next) => mongoController.getCollections(req, res, next));
router.get('/mongo/fetch/:collection', (req, res, next) => mongoController.fetchFromCollection(req, res, next));
router.post('/mongo/insert/:collection', (req, res, next) => mongoController.insertDocument(req, res, next));
router.put('/mongo/update/:collection/:id', (req, res, next) => mongoController.updateDocument(req, res, next));
router.delete('/mongo/delete/:collection/:id', (req, res, next) => mongoController.deleteDocument(req, res, next));

module.exports = router;
