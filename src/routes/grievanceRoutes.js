const express = require('express');
const router = express.Router();
const grievanceController = require('../controllers/grievanceController');

// Grievance & Ticket Routes (/api/grievances)
router.get('/grievances', (req, res, next) => grievanceController.listTickets(req, res, next));
router.get('/grievances/stats', (req, res, next) => grievanceController.getStats(req, res, next));
router.get('/grievances/staff', (req, res, next) => grievanceController.getTenantStaff(req, res, next));
router.get('/grievances/:id', (req, res, next) => grievanceController.getTicket(req, res, next));
router.post('/grievances', (req, res, next) => grievanceController.createTicket(req, res, next));
router.post('/grievances/:id/claim', (req, res, next) => grievanceController.claimTicket(req, res, next));
router.post('/grievances/:id/assign', (req, res, next) => grievanceController.assignTicket(req, res, next));
router.put('/grievances/:id/status', (req, res, next) => grievanceController.updateStatus(req, res, next));
router.put('/grievances/:id/meta', (req, res, next) => grievanceController.updateMeta(req, res, next));
router.post('/grievances/:id/comments', (req, res, next) => grievanceController.addComment(req, res, next));

module.exports = router;
