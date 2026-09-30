const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, lowercase: true, trim: true },
  description: { type: String, default: '' },
  active: { type: Boolean, default: true },
  settings: {
    allowedDomains: [{ type: String }],
    maxBots: { type: Number, default: 10 },
    theme: { type: String, default: 'default' }
  },
  contract: {
    contractNumber: { type: String, default: '' },
    startDate: { type: Date },
    endDate: { type: Date },
    renewedOn: { type: Date },
    contractTerm: { type: String, default: '1 Year' },
    contractStatus: { type: String, default: 'Active' },
    billingCycle: { type: String, default: 'Annually' },
    contractValue: { type: String, default: '' },
    currency: { type: String, default: 'USD' },
    paymentTerms: { type: String, default: 'Net 30' },
    paymentStatus: { type: String, default: 'Current' },
    autoRenew: { type: Boolean, default: false },
    renewalNoticeDays: { type: Number, default: 30 },
    slaTier: { type: String, default: 'Standard (99.5%)' },
    maxBotsIncluded: { type: Number, default: 5 },
    monthlyInquiryLimit: { type: String, default: '50,000 inquiries' },
    accountManager: { type: String, default: '' },
    primaryContactName: { type: String, default: '' },
    primaryContactEmail: { type: String, default: '' },
    primaryContactPhone: { type: String, default: '' },
    documentUrl: { type: String, default: '' },
    notes: { type: String, default: '' }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

const Tenant = mongoose.models.Tenant || mongoose.model('Tenant', TenantSchema);
module.exports = Tenant;
