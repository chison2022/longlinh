// The local HTTP endpoint (127.0.0.1 only): GET /health, read by tools/status.ps1 and the watchdog.
const express = require('express');
const db = require('./db');
const { getClient } = require('./bot/client');

const router = express.Router();

router.get('/health', (req, res) => {
  const client = getClient();
  const dbUp = db.isConnected();
  const bot = Boolean(client && client.isReady());
  res.json({ ok: dbUp && (bot || !process.env.DISCORD_TOKEN), db: dbUp, bot });
});

module.exports = router;
