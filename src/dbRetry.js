// Connect to the database, retrying with backoff (15s, 30s, 60s, 2min, 4min, then 5min) instead of exiting: a laptop may boot
// before its network is up. `beforeRetry` (optional) runs before every retry. A missing PG_URL / PG_CA is a config error and fails at once.
const { logEvent } = require('./eventLog');

const DELAYS_MS = [15000, 30000, 60000, 120000, 240000, 300000];
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry({ connect, beforeRetry, sleep = sleepMs, delays = DELAYS_MS, log = console, maxAttempts = Infinity }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await connect();
    } catch (err) {
      if (/(PG_URL|PG_CA|DB_URL) is missing/.test(err.message) || attempt + 1 >= maxAttempts) throw err;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      log.error(`Cannot connect to the database: ${err.message}\nRetrying in ${delay / 1000}s.`);
      logEvent('db', 'connect_failed', { attempt: attempt + 1, delayMs: delay, err });
      await sleep(delay);
      if (beforeRetry) await beforeRetry();
    }
  }
}

module.exports = { connectWithRetry, DELAYS_MS };
