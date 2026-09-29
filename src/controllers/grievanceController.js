const grievanceService = require('../services/grievanceService');
const ApiResponse = require('../helpers/apiResponse');
const logger = require('../helpers/logger');
const mongoose = require('mongoose');

class GrievanceController {
  /**
   * Helper to extract user & tenant info from request headers / session
   */
  async resolveRequestUser(req) {
    const sessionId = req.headers['x-session-id'] || 
      req.headers.authorization?.replace(/^Bearer\s+/i, '') || 
      req.body?.sessionId || 
      req.query?.sessionId;

    let user = {
      username: req.body?.username || req.query?.username || 'Staff User',
      fullName: req.body?.fullName || req.body?.username || 'Staff User',
      role: req.body?.userRole || req.query?.userRole || 'admin',
      tenantId: req.headers['x-tenant-id'] || req.query?.tenantId || req.body?.tenantId || 'admin'
    };

    if (sessionId && mongoose.connection.readyState === 1) {
      try {
        const masterDb = mongoose.connection.useDb('master', { useCache: true });
        const session = await masterDb.collection('sessionManagement').findOne({ sessionId, isActive: true });
        if (session) {
          user = {
            userId: session.userId?.toString(),
            username: session.username,
            fullName: session.fullName || session.username,
            role: session.role,
            tenantId: session.tenantId || user.tenantId
          };
        }
      } catch (e) {
        logger.warn('[GrievanceController] Could not resolve session details:', e.message);
      }
    }

    return user;
  }

  /**
   * GET /api/grievances
   * List tickets with filtering, pagination, and RBAC
   */
  async listTickets(req, res, next) {
    try {
      const user = await this.resolveRequestUser(req);
      const isGlobalAdmin = Boolean(
        user.role === 'global_admin' || 
        user.role === 'super_admin' || 
        user.role === 'admin' ||
        user.tenantId === 'admin'
      );

      const {
        tenantId = user.tenantId,
        status,
        category,
        priority,
        department,
        assignedTo,
        search,
        page = 1,
        limit = 20
      } = req.query;

      const result = await grievanceService.listTickets({
        tenantId: isGlobalAdmin && req.query.tenantId ? req.query.tenantId : user.tenantId,
        status,
        category,
        priority,
        department,
        assignedTo,
        search,
        page,
        limit,
        isGlobalAdmin
      });

      return ApiResponse.success(res, result, 'Tickets retrieved successfully');
    } catch (err) {
      logger.error('[GrievanceController] Error listing tickets:', err);
      next(err);
    }
  }

  /**
   * GET /api/grievances/stats
   * Retrieve metric counts for the dashboard
   */
  async getStats(req, res, next) {
    try {
      const user = await this.resolveRequestUser(req);
      const isGlobalAdmin = Boolean(
        user.role === 'global_admin' || 
        user.role === 'super_admin' || 
        user.role === 'admin' ||
        user.tenantId === 'admin'
      );

      const tenantId = req.query.tenantId || user.tenantId;
      const stats = await grievanceService.getStats(tenantId, isGlobalAdmin);

      return ApiResponse.success(res, stats, 'Grievance statistics retrieved');
    } catch (err) {
      logger.error('[GrievanceController] Error getting stats:', err);
      next(err);
    }
  }

  /**
   * GET /api/grievances/:id
   * Get ticket details with full chat transcript & comments
   */
  async getTicket(req, res, next) {
    try {
      const { id } = req.params;
      const user = await this.resolveRequestUser(req);
      const ticket = await grievanceService.getTicketDetails(id, user.tenantId);

      if (!ticket) {
        return ApiResponse.notFound(res, `Ticket "${id}" not found`);
      }

      return ApiResponse.success(res, ticket, 'Ticket details retrieved');
    } catch (err) {
      logger.error('[GrievanceController] Error getting ticket details:', err);
      next(err);
    }
  }

  /**
   * POST /api/grievances
   * Create a new ticket (called by Chatbot or Admin Portal)
   */
  async createTicket(req, res, next) {
    try {
      const user = await this.resolveRequestUser(req);
      const {
        tenantId = user.tenantId || 'default',
        botId = 'isobot',
        sessionId,
        student,
        category,
        department,
        title,
        description,
        priority,
        source = 'portal',
        chatTranscript
      } = req.body;

      if (!title || !description) {
        return ApiResponse.badRequest(res, 'Title and description are required to create a ticket.');
      }

      const ticket = await grievanceService.createTicket({
        tenantId,
        botId,
        sessionId,
        student,
        category,
        department,
        title,
        description,
        priority,
        source,
        chatTranscript,
        createdByUser: user
      });

      return ApiResponse.created(res, ticket, 'Grievance ticket created successfully');
    } catch (err) {
      logger.error('[GrievanceController] Error creating ticket:', err);
      next(err);
    }
  }

  /**
   * POST /api/grievances/:id/claim
   * Any authorized staff/user claims an open ticket ("Assign to Me")
   */
  async claimTicket(req, res, next) {
    try {
      const { id } = req.params;
      const user = await this.resolveRequestUser(req);

      const ticket = await grievanceService.claimTicket(id, user, user.tenantId);
      return ApiResponse.success(res, ticket, `Ticket ${ticket.ticketId} claimed successfully`);
    } catch (err) {
      logger.error('[GrievanceController] Error claiming ticket:', err);
      next(err);
    }
  }

  /**
   * POST /api/grievances/:id/assign
   * Admin assigns ticket to any designated staff member
   */
  async assignTicket(req, res, next) {
    try {
      const { id } = req.params;
      const user = await this.resolveRequestUser(req);
      const { assignee } = req.body;

      if (!assignee || (!assignee.username && !assignee.userId)) {
        return ApiResponse.badRequest(res, 'Assignee details (username or userId) are required.');
      }

      const ticket = await grievanceService.assignTicket(id, assignee, user, user.tenantId);
      return ApiResponse.success(res, ticket, `Ticket ${ticket.ticketId} assigned to ${assignee.fullName || assignee.username}`);
    } catch (err) {
      logger.error('[GrievanceController] Error assigning ticket:', err);
      next(err);
    }
  }

  /**
   * PUT /api/grievances/:id/status
   * Update status (open -> in_progress -> resolved -> closed)
   */
  async updateStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status, resolutionNotes } = req.body;
      const user = await this.resolveRequestUser(req);

      if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
        return ApiResponse.badRequest(res, `Invalid status "${status}". Allowed: open, in_progress, resolved, closed.`);
      }

      const ticket = await grievanceService.updateStatus(id, status, resolutionNotes, user, user.tenantId);
      return ApiResponse.success(res, ticket, `Ticket ${ticket.ticketId} status updated to ${status}`);
    } catch (err) {
      logger.error('[GrievanceController] Error updating ticket status:', err);
      next(err);
    }
  }

  /**
   * POST /api/grievances/:id/comments
   * Add internal staff comment or student reply
   */
  async addComment(req, res, next) {
    try {
      const { id } = req.params;
      const { comment, isInternal = true } = req.body;
      const user = await this.resolveRequestUser(req);

      if (!comment || !comment.trim()) {
        return ApiResponse.badRequest(res, 'Comment text is required.');
      }

      const ticket = await grievanceService.addComment(id, comment.trim(), user, isInternal, user.tenantId);
      return ApiResponse.success(res, ticket, 'Comment added successfully');
    } catch (err) {
      logger.error('[GrievanceController] Error adding comment:', err);
      next(err);
    }
  }

  /**
   * PUT /api/grievances/:id/meta
   * Update priority, department, or category
   */
  async updateMeta(req, res, next) {
    try {
      const { id } = req.params;
      const { priority, department, category } = req.body;
      const user = await this.resolveRequestUser(req);

      const ticket = await grievanceService.updateTicketMeta(id, { priority, department, category }, user, user.tenantId);
      return ApiResponse.success(res, ticket, 'Ticket metadata updated successfully');
    } catch (err) {
      logger.error('[GrievanceController] Error updating ticket metadata:', err);
      next(err);
    }
  }

  /**
   * GET /api/grievances/staff
   * Retrieve list of staff members for the tenant (excluding Super Admin)
   */
  async getTenantStaff(req, res, next) {
    try {
      const user = await this.resolveRequestUser(req);
      const isGlobalAdmin = Boolean(
        user.role === 'global_admin' || 
        user.role === 'super_admin' || 
        user.role === 'admin' ||
        user.tenantId === 'admin'
      );

      const targetTenantId = (isGlobalAdmin && req.query.tenantId && req.query.tenantId !== 'all')
        ? req.query.tenantId
        : (user.tenantId || 'default');

      const staffMap = new Map();

      // 1. Fetch from tenant dynamic DB
      if (mongoose.connection.readyState === 1 && targetTenantId && targetTenantId !== 'admin') {
        const targetDbName = targetTenantId.startsWith('iso_') ? targetTenantId : `iso_${targetTenantId}`;
        const dynamicDb = mongoose.connection.useDb(targetDbName, { useCache: true });
        const tenantUsers = await dynamicDb.collection('users').find({}, { projection: { password: 0 } }).toArray();
        tenantUsers.forEach(u => {
          if (!['super_admin', 'global_admin'].includes(u.role?.toLowerCase()) && u.role !== 'Super Admin') {
            staffMap.set(u.username, {
              _id: u._id.toString(),
              username: u.username,
              fullName: u.fullName || u.username,
              role: u.role || 'Staff',
              email: u.email || ''
            });
          }
        });
      }

      // 2. Also fetch from master.users scoped to this tenant
      if (mongoose.connection.readyState === 1) {
        const masterDb = mongoose.connection.useDb('master', { useCache: true });
        let masterQuery = { tenantId: { $ne: null } };
        if (targetTenantId && targetTenantId !== 'admin') {
          const tenantDoc = await masterDb.collection('tenantInfo').findOne({
            $or: [{ tenantId: targetTenantId }, { code: targetTenantId }, { tenantName: new RegExp(`^${targetTenantId}$`, 'i') }]
          });
          const tenantIds = [targetTenantId];
          if (tenantDoc && tenantDoc._id) tenantIds.push(tenantDoc._id.toString(), tenantDoc._id);

          masterQuery = {
            $or: [
              { tenantId: { $in: tenantIds } },
              { tenantName: targetTenantId }
            ]
          };
        }

        const masterUsers = await masterDb.collection('users').find(masterQuery, { projection: { password: 0 } }).toArray();
        masterUsers.forEach(u => {
          if (!['super_admin', 'global_admin'].includes(u.role?.toLowerCase()) && u.role !== 'Super Admin') {
            if (!staffMap.has(u.username)) {
              staffMap.set(u.username, {
                _id: u._id.toString(),
                username: u.username,
                fullName: u.fullName || u.username,
                role: u.role || 'Staff',
                email: u.email || ''
              });
            }
          }
        });
      }

      const staffList = Array.from(staffMap.values());
      return ApiResponse.success(res, staffList, 'Staff users retrieved');
    } catch (err) {
      logger.error('[GrievanceController] Error fetching staff:', err);
      next(err);
    }
  }
}

module.exports = new GrievanceController();
