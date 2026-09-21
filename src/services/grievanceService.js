const Grievance = require('../models/Grievance');
const ConversationHistory = require('../models/ConversationHistory');
const logger = require('../helpers/logger');

class GrievanceService {
  /**
   * Generate a unique human-readable Ticket ID: GRV-YYYY-XXXXX
   */
  async generateTicketId() {
    const year = new Date().getFullYear();
    const count = await Grievance.countDocuments();
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const seq = (count + 1).toString().padStart(4, '0');
    return `GRV-${year}-${seq}${randomSuffix.toString().slice(-2)}`;
  }

  /**
   * Calculate SLA deadline based on priority
   */
  calculateSlaDeadline(priority = 'medium') {
    const now = new Date();
    let hours = 48; // default medium: 48h
    if (priority === 'urgent') hours = 12;
    else if (priority === 'high') hours = 24;
    else if (priority === 'low') hours = 72;

    const deadline = new Date(now.getTime() + hours * 60 * 60 * 1000);
    return { slaHours: hours, slaDeadline: deadline };
  }

  /**
   * Fetch chat history for a session to snapshot into the ticket
   */
  async getChatHistoryForSession(sessionId, tenantId) {
    if (!sessionId) return [];
    try {
      const conversationService = require('./conversationService');
      const records = await conversationService.getHistory(sessionId, 50);

      const transcript = [];
      records.forEach(r => {
        if (r.query) {
          transcript.push({
            sender: 'user',
            message: r.query,
            timestamp: r.queryReceivedAt || r.createdAt || new Date()
          });
        }
        if (r.answer) {
          transcript.push({
            sender: 'bot',
            message: r.answer,
            timestamp: r.responseGivenAt || r.createdAt || new Date()
          });
        }
      });
      return transcript;
    } catch (err) {
      logger.error('Error fetching chat history snapshot for grievance:', err);
      return [];
    }
  }

  /**
   * Create a new Grievance / Ticket
   */
  async createTicket({
    tenantId,
    botId = 'isobot',
    sessionId = '',
    student = {},
    category = 'Other',
    department = 'Administration',
    title,
    description,
    priority = 'medium',
    source = 'chatbot',
    chatTranscript = [],
    createdByUser = null
  }) {
    const ticketId = await this.generateTicketId();
    const { slaHours, slaDeadline } = this.calculateSlaDeadline(priority);

    // Merge passed chatTranscript with session DB records
    let transcript = Array.isArray(chatTranscript) ? [...chatTranscript] : [];
    if (sessionId) {
      try {
        const dbTranscript = await this.getChatHistoryForSession(sessionId, tenantId);
        if (dbTranscript && dbTranscript.length > 0) {
          const seen = new Set(transcript.map(m => `${m.sender}:${m.message?.trim()}`));
          dbTranscript.forEach(dbItem => {
            const key = `${dbItem.sender}:${dbItem.message?.trim()}`;
            if (!seen.has(key)) {
              transcript.push(dbItem);
              seen.add(key);
            }
          });
          transcript.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        }
      } catch (e) {
        logger.warn(`[GrievanceService] Error loading session history in createTicket: ${e.message}`);
      }
    }

    const history = [
      {
        action: 'CREATED',
        performedBy: createdByUser?.fullName || createdByUser?.username || (source === 'chatbot' ? 'AI Chatbot' : 'Student'),
        details: `Ticket created via ${source} with priority "${priority}" and category "${category}".`,
        timestamp: new Date()
      }
    ];

    const grievance = new Grievance({
      ticketId,
      tenantId,
      botId,
      sessionId,
      student: {
        name: student.name || 'Anonymous Student',
        email: student.email || '',
        phone: student.phone || '',
        rollNumber: student.rollNumber || student.rollNo || '',
        department: student.department || department || 'General'
      },
      category,
      department,
      title: title || `Grievance: ${category}`,
      description,
      priority,
      status: 'open',
      slaHours,
      slaDeadline,
      chatTranscript: transcript,
      history,
      source
    });

    await grievance.save();
    logger.info(`[GrievanceService] Created ticket ${ticketId} for tenant ${tenantId}`);
    return grievance;
  }

  /**
   * List tickets with filters, pagination, search & RBAC scope
   */
  async listTickets({
    tenantId,
    status,
    category,
    priority,
    department,
    assignedTo,
    search,
    page = 1,
    limit = 20,
    isGlobalAdmin = false
  }) {
    const query = {};

    if (!isGlobalAdmin && tenantId) {
      query.tenantId = tenantId;
    } else if (tenantId && tenantId !== 'all') {
      query.tenantId = tenantId;
    }

    if (status && status !== 'all') {
      if (status === 'overdue') {
        query.status = { $in: ['open', 'in_progress'] };
        query.slaDeadline = { $lt: new Date() };
      } else {
        query.status = status;
      }
    }

    if (category && category !== 'all') {
      query.category = category;
    }

    if (priority && priority !== 'all') {
      query.priority = priority;
    }

    if (department && department !== 'all') {
      query.department = department;
    }

    if (assignedTo) {
      if (assignedTo === 'unassigned') {
        query['assignedTo.username'] = null;
      } else if (assignedTo !== 'all') {
        query['assignedTo.username'] = assignedTo;
      }
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [
        { ticketId: regex },
        { title: regex },
        { description: regex },
        { 'student.name': regex },
        { 'student.rollNumber': regex },
        { 'student.email': regex }
      ];
    }

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
    const take = parseInt(limit, 10);

    const [tickets, total] = await Promise.all([
      Grievance.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(take)
        .lean(),
      Grievance.countDocuments(query)
    ]);

    // Attach computed overdue flag
    const now = new Date();
    const enrichedTickets = tickets.map(t => ({
      ...t,
      isOverdue: (t.status === 'open' || t.status === 'in_progress') && new Date(t.slaDeadline) < now
    }));

    return {
      tickets: enrichedTickets,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: take,
        totalPages: Math.ceil(total / take) || 1
      }
    };
  }

  /**
   * Get single ticket by ticketId or _id with full details
   */
  async getTicketDetails(idOrTicketId, tenantId = null) {
    const query = {
      $or: [
        { ticketId: idOrTicketId }
      ]
    };
    if (idOrTicketId.match(/^[0-9a-fA-F]{24}$/)) {
      query.$or.push({ _id: idOrTicketId });
    }

    if (tenantId && tenantId !== 'admin') {
      query.tenantId = tenantId;
    }

    const ticket = await Grievance.findOne(query).lean();
    if (!ticket) return null;

    // Dynamically fetch full session history from master > conversationHistory
    let transcript = ticket.chatTranscript || ticket.conversationSnapshot || [];
    if (ticket.sessionId) {
      try {
        const liveTranscript = await this.getChatHistoryForSession(ticket.sessionId, ticket.tenantId);
        if (liveTranscript && liveTranscript.length > 0) {
          transcript = liveTranscript;
        }
      } catch (err) {
        logger.warn(`[GrievanceService] Could not fetch live session transcript for ticket ${ticket.ticketId}: ${err.message}`);
      }
    }

    const now = new Date();
    return {
      ...ticket,
      chatTranscript: transcript,
      conversationSnapshot: transcript,
      isOverdue: (ticket.status === 'open' || ticket.status === 'in_progress') && new Date(ticket.slaDeadline) < now
    };
  }

  /**
   * Claim ticket (Assign to currently logged-in staff member)
   */
  async claimTicket(ticketId, user, tenantId = null) {
    const ticket = await this.getTicketDocument(ticketId, tenantId);
    if (!ticket) throw new Error('Ticket not found');

    const previousAssignee = ticket.assignedTo?.fullName || ticket.assignedTo?.username || 'Unassigned';

    ticket.assignedTo = {
      userId: user._id?.toString() || user.userId,
      username: user.username,
      fullName: user.fullName || user.username,
      assignedAt: new Date(),
      assignedBy: user.username
    };

    if (ticket.status === 'open') {
      ticket.status = 'in_progress';
    }

    ticket.history.push({
      action: 'CLAIMED',
      performedBy: user.fullName || user.username,
      details: `Claimed ownership of ticket (previously: ${previousAssignee}). Status moved to In Progress.`,
      timestamp: new Date()
    });

    await ticket.save();
    return ticket;
  }

  /**
   * Assign ticket to another staff member (Admin action)
   */
  async assignTicket(ticketId, assignee, assignedByUser, tenantId = null) {
    const ticket = await this.getTicketDocument(ticketId, tenantId);
    if (!ticket) throw new Error('Ticket not found');

    const previousAssignee = ticket.assignedTo?.fullName || ticket.assignedTo?.username || 'Unassigned';

    ticket.assignedTo = {
      userId: assignee.userId || assignee._id?.toString(),
      username: assignee.username,
      fullName: assignee.fullName || assignee.username,
      assignedAt: new Date(),
      assignedBy: assignedByUser.username
    };

    if (ticket.status === 'open') {
      ticket.status = 'in_progress';
    }

    ticket.history.push({
      action: 'ASSIGNED',
      performedBy: assignedByUser.fullName || assignedByUser.username,
      details: `Assigned ticket to ${assignee.fullName || assignee.username} (previously: ${previousAssignee}).`,
      timestamp: new Date()
    });

    await ticket.save();
    return ticket;
  }

  /**
   * Update ticket status (open -> in_progress -> resolved -> closed)
   */
  async updateStatus(ticketId, status, resolutionNotes = '', user, tenantId = null) {
    const ticket = await this.getTicketDocument(ticketId, tenantId);
    if (!ticket) throw new Error('Ticket not found');

    const isAssigned = ticket.assignedTo?.username && (
      ticket.assignedTo.username === user.username ||
      ticket.assignedTo.userId === (user._id?.toString() || user.userId)
    );
    const isAdmin = Boolean(
      ['global_admin', 'super_admin', 'admin', 'tenant_admin'].includes(user.role?.toLowerCase()) ||
      (typeof user.role === 'string' && user.role.toLowerCase().includes('admin')) ||
      (typeof user.role === 'string' && user.role.toLowerCase().includes('manager')) ||
      user.tenantId === 'admin'
    );

    if (!isAssigned && !isAdmin) {
      if (!ticket.assignedTo?.username) {
        throw new Error('This ticket is unassigned. You must claim this ticket before updating its status.');
      }
      throw new Error(`This ticket is assigned to ${ticket.assignedTo.fullName || ticket.assignedTo.username}. Only the assigned owner can work on this ticket.`);
    }

    const prevStatus = ticket.status;
    ticket.status = status;

    if (status === 'resolved' || status === 'closed') {
      ticket.resolution = {
        notes: resolutionNotes || ticket.resolution?.notes || 'Marked as resolved',
        resolvedBy: user.fullName || user.username,
        resolvedAt: new Date()
      };
    }

    ticket.history.push({
      action: 'STATUS_CHANGED',
      performedBy: user.fullName || user.username,
      details: `Status updated from "${prevStatus}" to "${status}". ${resolutionNotes ? `Notes: ${resolutionNotes}` : ''}`.trim(),
      timestamp: new Date()
    });

    await ticket.save();
    return ticket;
  }

  /**
   * Add internal staff comment / note to ticket
   */
  async addComment(ticketId, commentText, user, isInternal = true, tenantId = null) {
    const ticket = await this.getTicketDocument(ticketId, tenantId);
    if (!ticket) throw new Error('Ticket not found');

    const isAssigned = ticket.assignedTo?.username && (
      ticket.assignedTo.username === user.username ||
      ticket.assignedTo.userId === (user._id?.toString() || user.userId)
    );
    const isAdmin = Boolean(
      ['global_admin', 'super_admin', 'admin', 'tenant_admin'].includes(user.role?.toLowerCase()) ||
      (typeof user.role === 'string' && user.role.toLowerCase().includes('admin')) ||
      (typeof user.role === 'string' && user.role.toLowerCase().includes('manager')) ||
      user.tenantId === 'admin'
    );

    if (!isAssigned && !isAdmin) {
      if (!ticket.assignedTo?.username) {
        throw new Error('This ticket is unassigned. You must claim this ticket before adding staff notes.');
      }
      throw new Error(`This ticket is assigned to ${ticket.assignedTo.fullName || ticket.assignedTo.username}. Only the assigned owner can work on this ticket.`);
    }

    const newComment = {
      author: {
        userId: user._id?.toString() || user.userId,
        username: user.username,
        fullName: user.fullName || user.username,
        role: user.role
      },
      comment: commentText,
      isInternal,
      createdAt: new Date()
    };

    ticket.comments.push(newComment);
    ticket.history.push({
      action: 'COMMENT_ADDED',
      performedBy: user.fullName || user.username,
      details: `Added note: "${commentText.slice(0, 60)}${commentText.length > 60 ? '...' : ''}"`,
      timestamp: new Date()
    });

    await ticket.save();
    return ticket;
  }

  /**
   * Update ticket priority or department
   */
  async updateTicketMeta(ticketId, { priority, department, category }, user, tenantId = null) {
    const ticket = await this.getTicketDocument(ticketId, tenantId);
    if (!ticket) throw new Error('Ticket not found');

    const changes = [];
    if (priority && priority !== ticket.priority) {
      changes.push(`Priority: ${ticket.priority} → ${priority}`);
      ticket.priority = priority;
      const { slaHours, slaDeadline } = this.calculateSlaDeadline(priority);
      ticket.slaHours = slaHours;
      ticket.slaDeadline = slaDeadline;
    }
    if (department && department !== ticket.department) {
      changes.push(`Department: ${ticket.department} → ${department}`);
      ticket.department = department;
    }
    if (category && category !== ticket.category) {
      changes.push(`Category: ${ticket.category} → ${category}`);
      ticket.category = category;
    }

    if (changes.length > 0) {
      ticket.history.push({
        action: 'METADATA_UPDATED',
        performedBy: user.fullName || user.username,
        details: changes.join(', '),
        timestamp: new Date()
      });
      await ticket.save();
    }

    return ticket;
  }

  /**
   * Get grievance metrics / statistics for dashboard
   */
  async getStats(tenantId = null, isGlobalAdmin = false) {
    const match = {};
    if (!isGlobalAdmin && tenantId) {
      match.tenantId = tenantId;
    } else if (tenantId && tenantId !== 'all') {
      match.tenantId = tenantId;
    }

    const now = new Date();

    const [statusCounts, categoryCounts, overdueCount, urgentCount] = await Promise.all([
      Grievance.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      Grievance.aggregate([
        { $match: match },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Grievance.countDocuments({
        ...match,
        status: { $in: ['open', 'in_progress'] },
        slaDeadline: { $lt: now }
      }),
      Grievance.countDocuments({
        ...match,
        status: { $in: ['open', 'in_progress'] },
        priority: 'urgent'
      })
    ]);

    const stats = {
      total: 0,
      open: 0,
      in_progress: 0,
      resolved: 0,
      closed: 0,
      overdue: overdueCount,
      urgent: urgentCount,
      byCategory: {}
    };

    statusCounts.forEach(sc => {
      stats[sc._id] = sc.count;
      stats.total += sc.count;
    });

    categoryCounts.forEach(cc => {
      if (cc._id) stats.byCategory[cc._id] = cc.count;
    });

    return stats;
  }

  /**
   * Helper to retrieve Mongoose document
   */
  async getTicketDocument(idOrTicketId, tenantId = null) {
    const query = {
      $or: [
        { ticketId: idOrTicketId }
      ]
    };
    if (idOrTicketId.match(/^[0-9a-fA-F]{24}$/)) {
      query.$or.push({ _id: idOrTicketId });
    }

    if (tenantId && tenantId !== 'admin') {
      query.tenantId = tenantId;
    }

    return Grievance.findOne(query);
  }
}

module.exports = new GrievanceService();
