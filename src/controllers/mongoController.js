const mongoose = require('mongoose');
const ApiResponse = require('../helpers/apiResponse');
const logger = require('../helpers/logger');

class MongoController {
  /**
   * GET /api/mongo/status
   * Real-time MongoDB connection details & ping
   */
  async getStatus(req, res, next) {
    try {
      const isConnected = mongoose.connection.readyState === 1;
      let pingResult = null;

      if (isConnected && mongoose.connection.db) {
        const pingStart = Date.now();
        await mongoose.connection.db.admin().ping();
        pingResult = `${Date.now() - pingStart}ms`;
      }

      return ApiResponse.success(res, {
        status: isConnected ? 'connected' : 'disconnected',
        readyState: mongoose.connection.readyState,
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        dbName: mongoose.connection.name,
        pingLatency: pingResult
      }, 'MongoDB status retrieved');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/mongo/collections
   * List available collections with document counts
   */
  async getCollections(req, res, next) {
    try {
      if (mongoose.connection.readyState !== 1) {
        return ApiResponse.error(res, 'Database not connected', 503);
      }

      const collections = await mongoose.connection.db.listCollections().toArray();
      const summary = await Promise.all(
        collections.map(async (col) => {
          const count = await mongoose.connection.db.collection(col.name).estimatedDocumentCount();
          return {
            name: col.name,
            type: col.type,
            estimatedCount: count
          };
        })
      );

      return ApiResponse.success(res, summary, 'Collections retrieved');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/mongo/fetch/:collection
   * Generalized MongoDB fetch API for chatbot data
   * Supports ?page=1&limit=20&sort=-createdAt&filter={"status":"active"}&fields=name,code
   */
  async fetchFromCollection(req, res, next) {
    try {
      if (mongoose.connection.readyState !== 1) {
        return ApiResponse.error(res, 'Database not connected', 503);
      }

      const { collection: colName } = req.params;
      const {
        page = 1,
        limit = 50,
        sort = '_id',
        filter = '{}',
        fields = ''
      } = req.query;

      // Validate collection name to prevent internal collection snooping
      const cleanColName = colName.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!cleanColName || cleanColName.startsWith('system.')) {
        return ApiResponse.badRequest(res, 'Invalid collection name');
      }

      // Parse filter safely
      let parsedFilter = {};
      try {
        parsedFilter = typeof filter === 'string' ? JSON.parse(filter) : filter;
      } catch (e) {
        return ApiResponse.badRequest(res, 'Invalid JSON format for filter parameter');
      }

      // Sanitize filter to prevent arbitrary code execution or operator injection
      if (parsedFilter && typeof parsedFilter === 'object') {
        delete parsedFilter.$where;
        delete parsedFilter.$accumulator;
        delete parsedFilter.$function;
      }

      // Build projection
      let projection = {};
      if (fields && typeof fields === 'string') {
        fields.split(',').forEach(f => {
          const cleanF = f.trim();
          if (cleanF) projection[cleanF] = 1;
        });
      }

      // Build sort
      let sortObj = {};
      if (sort.startsWith('-')) {
        sortObj[sort.substring(1)] = -1;
      } else {
        sortObj[sort] = 1;
      }

      const col = mongoose.connection.db.collection(cleanColName);
      const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
      const skip = ((Math.max(Number(page) || 1, 1)) - 1) * safeLimit;

      const [items, total] = await Promise.all([
        col.find(parsedFilter, { projection }).sort(sortObj).skip(skip).limit(safeLimit).toArray(),
        col.countDocuments(parsedFilter)
      ]);

      return ApiResponse.success(res, items, `Fetched documents from ${cleanColName}`, 200, {
        pagination: {
          total,
          page: Number(page),
          limit: safeLimit,
          pages: Math.ceil(total / safeLimit)
        }
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/mongo/insert/:collection
   * Insert a document into MongoDB collection
   */
  async insertDocument(req, res, next) {
    try {
      if (mongoose.connection.readyState !== 1) {
        return ApiResponse.error(res, 'Database not connected', 503);
      }

      const { collection: colName } = req.params;
      const cleanColName = colName.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!cleanColName || cleanColName.startsWith('system.')) {
        return ApiResponse.badRequest(res, 'Invalid collection name');
      }

      const document = req.body;
      if (!document || typeof document !== 'object' || Object.keys(document).length === 0) {
        return ApiResponse.badRequest(res, 'Document data is required');
      }

      const col = mongoose.connection.db.collection(cleanColName);
      const result = await col.insertOne({
        ...document,
        createdAt: document.createdAt || new Date(),
        updatedAt: new Date()
      });

      return ApiResponse.created(res, { insertedId: result.insertedId, ...document }, `Document inserted into ${cleanColName}`);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PUT /api/mongo/update/:collection/:id
   * Update a document by ID in MongoDB collection
   */
  async updateDocument(req, res, next) {
    try {
      if (mongoose.connection.readyState !== 1) {
        return ApiResponse.error(res, 'Database not connected', 503);
      }

      const { collection: colName, id } = req.params;
      const cleanColName = colName.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!cleanColName || cleanColName.startsWith('system.')) {
        return ApiResponse.badRequest(res, 'Invalid collection name');
      }

      const updateData = req.body;
      delete updateData._id;
      updateData.updatedAt = new Date();

      const col = mongoose.connection.db.collection(cleanColName);
      let filter = {};
      if (mongoose.Types.ObjectId.isValid(id)) {
        filter = { _id: new mongoose.Types.ObjectId(id) };
      } else {
        filter = { _id: id };
      }

      const result = await col.findOneAndUpdate(
        filter,
        { $set: updateData },
        { returnDocument: 'after' }
      );

      const updatedDoc = (result && result.value !== undefined) ? result.value : result;
      if (!updatedDoc) {
        return ApiResponse.notFound(res, 'Document not found');
      }

      return ApiResponse.success(res, updatedDoc, `Document updated in ${cleanColName}`);
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/mongo/delete/:collection/:id
   * Delete a document by ID from MongoDB collection
   */
  async deleteDocument(req, res, next) {
    try {
      if (mongoose.connection.readyState !== 1) {
        return ApiResponse.error(res, 'Database not connected', 503);
      }

      const { collection: colName, id } = req.params;
      const cleanColName = colName.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!cleanColName || cleanColName.startsWith('system.')) {
        return ApiResponse.badRequest(res, 'Invalid collection name');
      }

      const col = mongoose.connection.db.collection(cleanColName);
      let filter = {};
      if (mongoose.Types.ObjectId.isValid(id)) {
        filter = { _id: new mongoose.Types.ObjectId(id) };
      } else {
        filter = { _id: id };
      }

      const result = await col.deleteOne(filter);
      if (result.deletedCount === 0) {
        return ApiResponse.notFound(res, 'Document not found');
      }

      return ApiResponse.success(res, { deletedId: id }, `Document deleted from ${cleanColName}`);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new MongoController();
