const { Bot, Analytics } = require('../models');

class ClientController {
  async getAnalytics(req, res, next) {
    try {
      const adminController = require('./adminController');
      req.query.botId = req.params.id || req.query.botId;
      return adminController.getAnalyticsDashboard(req, res, next);
    } catch (err) {
      next(err);
    }
  }

  async ingestSource(req, res, next) {
    try {
      const { type, name, path, size } = req.body;
      if (!type || !name || !path) {
        return res.status(400).json({ error: 'Type, Name, and Path are required.' });
      }

      const bot = await Bot.findById(req.params.id);
      if (!bot) return res.status(404).json({ error: 'Bot not found.' });

      const simulatedStatus = path.toLowerCase().includes('error') ? 'failed' : 'pending';

      const newSource = {
        name,
        type,
        path,
        size: size || 'N/A',
        status: simulatedStatus,
        updatedAt: new Date()
      };

      bot.ingestionSources.push(newSource);
      await bot.save();

      const createdSource = bot.ingestionSources[bot.ingestionSources.length - 1];

      // Async sync simulation
      if (simulatedStatus === 'pending') {
        setTimeout(async () => {
          try {
            const freshBot = await Bot.findById(req.params.id);
            if (freshBot) {
              const src = freshBot.ingestionSources.id(createdSource._id);
              if (src && src.status === 'pending') {
                src.status = 'synced';
                src.updatedAt = new Date();
                await freshBot.save();
              }
            }
          } catch (err) {}
        }, 5000);
      }

      return res.status(201).json({ bot, source: createdSource });
    } catch (err) {
      next(err);
    }
  }

  async deleteSource(req, res, next) {
    try {
      const bot = await Bot.findById(req.params.id);
      if (!bot) return res.status(404).json({ error: 'Bot not found.' });

      bot.ingestionSources.pull(req.params.sourceId);
      await bot.save();
      return res.json(bot);
    } catch (err) {
      next(err);
    }
  }

  async testChat(req, res, next) {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Message is required.' });

      const bot = await Bot.findById(req.params.id);
      if (!bot) return res.status(404).json({ error: 'Bot not found.' });
      if (bot.status !== 'active') {
        return res.json({
          reply: `[System Error] This chatbot (${bot.name}) is currently inactive. Please set its status to Active before testing.`,
          botName: bot.name,
          timestamp: new Date()
        });
      }

      const msgLower = message.toLowerCase();
      let reply = '';

      if (msgLower.includes('hello') || msgLower.includes('hi')) {
        reply = `Hello! I am ${bot.name}, running on ${bot.model}. How can I assist you today?`;
      } else if (msgLower.includes('tps report')) {
        reply = `Did you get the memo? We're putting cover sheets on all TPS reports now. I'll search the guidelines for you!`;
      } else if (msgLower.includes('reset') && msgLower.includes('password')) {
        reply = `To reset your account password, navigate to Settings and click 'Forgot Password'. A security link will be emailed to your recovery address.`;
      } else if (msgLower.includes('shipping') || msgLower.includes('delivery')) {
        reply = `Our standard shipping takes 3-5 business days. Express shipping takes 1-2 business days.`;
      } else {
        reply = `[Simulated ${bot.model} response]: I've processed your question based on my active system instructions.
        
System Instruction Profile: "${bot.systemPrompt ? bot.systemPrompt.slice(0, 100) : ''}"
        
You said: "${message}"`;
      }

      // Increment metrics
      try {
        const analytics = await Analytics.findOne({ botId: bot._id });
        if (analytics) {
          analytics.summary.totalMessages += 1;
          const todayStr = new Date().toISOString().split('T')[0];
          const dayRecord = analytics.dailyActivity.find(d => d.date === todayStr);
          if (dayRecord) {
            dayRecord.messages += 1;
          } else {
            analytics.dailyActivity.push({ date: todayStr, messages: 1, conversations: 1 });
          }
          await analytics.save();
        }
      } catch (aErr) {}

      return res.json({
        reply,
        botName: bot.name,
        timestamp: new Date()
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ClientController();
