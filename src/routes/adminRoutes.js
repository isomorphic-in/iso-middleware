const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// Tenants API
router.get('/admin/tenants', (req, res, next) => adminController.getTenants(req, res, next));
router.post('/admin/tenants', (req, res, next) => adminController.createTenant(req, res, next));
router.put('/admin/tenants/:id', (req, res, next) => adminController.updateTenant(req, res, next));
router.delete('/admin/tenants/:id', (req, res, next) => adminController.deleteTenant(req, res, next));

// Bots API
router.get('/admin/bots', (req, res, next) => adminController.getBots(req, res, next));
router.get('/admin/bots/:id', (req, res, next) => adminController.getBotById(req, res, next));
router.post('/admin/bots', (req, res, next) => adminController.createBot(req, res, next));
router.put('/admin/bots/:id', (req, res, next) => adminController.updateBot(req, res, next));
router.put('/admin/bots/:id/raw', (req, res, next) => adminController.rawUpdateBot(req, res, next));
router.post('/admin/bots/:id/duplicate', (req, res, next) => adminController.duplicateBot(req, res, next));
router.delete('/admin/bots/:id', (req, res, next) => adminController.deleteBot(req, res, next));

// Gen AI Settings API (genAISettings collection)
router.get('/admin/genai-settings', (req, res, next) => adminController.getGenAISettings(req, res, next));
router.put('/admin/genai-settings', (req, res, next) => adminController.updateGenAISettings(req, res, next));

// Menus API (master > menus)
router.get('/admin/menus', (req, res, next) => adminController.getMenus(req, res, next));
router.post('/admin/menus', (req, res, next) => adminController.createMenu(req, res, next));
router.put('/admin/menus/:id', (req, res, next) => adminController.updateMenu(req, res, next));
router.delete('/admin/menus/:id', (req, res, next) => adminController.deleteMenu(req, res, next));

// Roles API (master > roles)
router.get('/admin/roles', (req, res, next) => adminController.getRoles(req, res, next));
router.post('/admin/roles', (req, res, next) => adminController.createRole(req, res, next));
router.put('/admin/roles/:id', (req, res, next) => adminController.updateRole(req, res, next));
router.delete('/admin/roles/:id', (req, res, next) => adminController.deleteRole(req, res, next));

// Tenant Users API (tenantDb > users)
router.get('/admin/tenant-users', (req, res, next) => adminController.getTenantUsers(req, res, next));
router.post('/admin/tenant-users', (req, res, next) => adminController.createTenantUser(req, res, next));
router.put('/admin/tenant-users/:id', (req, res, next) => adminController.updateTenantUser(req, res, next));
router.delete('/admin/tenant-users/:id', (req, res, next) => adminController.deleteTenantUser(req, res, next));

// Conversations History API (master > conversationHistory)
router.get('/admin/conversations', (req, res, next) => adminController.getConversations(req, res, next));
router.get('/admin/conversations/:sessionId', (req, res, next) => adminController.getSessionMessages(req, res, next));
router.delete('/admin/conversations/:sessionId', (req, res, next) => adminController.deleteSession(req, res, next));

// Analytics Dashboard API
router.get('/admin/analytics', (req, res, next) => adminController.getAnalyticsDashboard(req, res, next));
router.get('/analytics', (req, res, next) => adminController.getAnalyticsDashboard(req, res, next));

// Bot Performance Dashboard API
router.get('/admin/performance', (req, res, next) => adminController.getPerformanceDashboard(req, res, next));
router.get('/performance', (req, res, next) => adminController.getPerformanceDashboard(req, res, next));

module.exports = router;


