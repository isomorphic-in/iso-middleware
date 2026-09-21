const express = require('express');
const router = express.Router();

const botRoutes = require('./botRoutes');
const chatRoutes = require('./chatRoutes');
const feedbackRoutes = require('./feedbackRoutes');
const formRoutes = require('./formRoutes');
const conversationRoutes = require('./conversationRoutes');
const mongoRoutes = require('./mongoRoutes');
const healthRoutes = require('./healthRoutes');
const adminRoutes = require('./adminRoutes');
const authRoutes = require('./authRoutes');
const clientRoutes = require('./clientRoutes');
const ingestionRoutes = require('./ingestionRoutes');
const grievanceRoutes = require('./grievanceRoutes');

// Mount sub-routers under /api
router.use('/', healthRoutes);
router.use('/', botRoutes);
router.use('/', chatRoutes);
router.use('/', feedbackRoutes);
router.use('/', formRoutes);
router.use('/', conversationRoutes);
router.use('/', mongoRoutes);
router.use('/', adminRoutes);
router.use('/', authRoutes);
router.use('/', clientRoutes);
router.use('/', grievanceRoutes);
router.use('/ingestion', ingestionRoutes);
router.use('/admin/ingestion', ingestionRoutes);

module.exports = router;
