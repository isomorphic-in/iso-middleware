const mongoose = require('mongoose');

const grievanceCommentSchema = new mongoose.Schema({
  author: {
    userId: { type: String },
    username: { type: String, required: true },
    fullName: { type: String },
    role: { type: String }
  },
  comment: { type: String, required: true },
  isInternal: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const grievanceSchema = new mongoose.Schema({
  ticketId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  botId: {
    type: String,
    default: 'isobot'
  },
  sessionId: {
    type: String,
    index: true
  },
  student: {
    name: { type: String, default: 'Anonymous Student' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    rollNumber: { type: String, default: '' },
    department: { type: String, default: 'General' }
  },
  category: {
    type: String,
    enum: ['Examination', 'Fees & Finance', 'Scholarship', 'Hostel & Housing', 'Attendance', 'Academics & Faculty', 'Certificates & Documents', 'Technical & Portal', 'Other'],
    default: 'Other',
    index: true
  },
  department: {
    type: String,
    default: 'Administration',
    index: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
    index: true
  },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'resolved', 'closed'],
    default: 'open',
    index: true
  },
  assignedTo: {
    userId: { type: String, default: null },
    username: { type: String, default: null },
    fullName: { type: String, default: null },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: String, default: null }
  },
  slaHours: {
    type: Number,
    default: 48 // default 48h SLA
  },
  slaDeadline: {
    type: Date,
    required: true
  },
  resolution: {
    notes: { type: String, default: '' },
    resolvedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null }
  },
  chatTranscript: [
    {
      sender: { type: String, enum: ['user', 'bot', 'system'] },
      message: { type: String },
      timestamp: { type: Date, default: Date.now }
    }
  ],
  comments: [grievanceCommentSchema],
  history: [
    {
      action: { type: String, required: true },
      performedBy: { type: String, default: 'System' },
      details: { type: String },
      timestamp: { type: Date, default: Date.now }
    }
  ],
  source: {
    type: String,
    enum: ['chatbot', 'portal', 'admin_manual', 'api'],
    default: 'chatbot'
  }
}, {
  timestamps: true
});

grievanceSchema.index({ tenantId: 1, status: 1 });
grievanceSchema.index({ tenantId: 1, department: 1 });
grievanceSchema.index({ tenantId: 1, 'assignedTo.username': 1 });

const Grievance = mongoose.models.Grievance || mongoose.model('Grievance', grievanceSchema);

module.exports = Grievance;
