const path = require('path');
const { appRoot, isPackaged, logDir } = require('./src/paths');
// Packaged: the .env sits next to the executable (install dir); otherwise the usual lookup in the working directory.
require('dotenv').config(isPackaged() ? { path: path.join(appRoot(), '.env'), quiet: true } : {});
const eventLog = require('./src/eventLog');
// Packaged: logs go to %ProgramData%\LongLinh\logs (installer-created, ACL'd). Plain `node app.js`: <repo>/logs. Logging problems
// must never stop the bot. Packaged, a fatal error logs and exits (the Scheduled Task restarts the bot); not packaged nothing
// restarts it, so the fatal handlers only record the error and Node crashes exactly as it did before (see installFileLogging).
try {
  require('./src/logFile').installFileLogging(logDir(), { monitorOnly: !isPackaged() });
  eventLog.init(logDir());
} catch (err) {
  console.error(`File logging disabled: ${err.message}`);
}
let version = null;
try {
  version = require('./package.json').version;
} catch {
  /* the version is only informational */
}
eventLog.logEvent('boot', 'start', { version, node: process.version, packaged: isPackaged(), pid: process.pid });
const express = require('express');

const db = require('./src/db');
const { startBotWithRetry, describeLoginError, getClient } = require('./src/bot/client');
const healthRoutes = require('./src/health');
const { listen } = require('./src/listen');
const { connectWithRetry } = require('./src/dbRetry');
const { startHealthPing } = require('./src/healthPing');
const { runSelftest } = require('./src/selftest');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.BIND_HOST || '127.0.0.1'; // local only

app.use('/', healthRoutes);

async function selftest() {
  const { ok, lines } = await runSelftest({
    connectDb: () => db.connectPg({ max: 1 }),
    disconnect: () => db.disconnectPg(),
    pingDb: () => db.ping(),
  });
  console.log(lines.join('\n'));
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--selftest')) {
    return selftest();
  }
  // Take the port first, before any DB work: a second copy must not touch the DB at all.
  try {
    await listen(app, PORT, HOST);
    console.log(`Server running at http://${HOST}:${PORT}`);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      // Exit 0 on purpose: the Scheduled Task only restarts a FAILED run (every 1 min, up to 999 times). Exit 0 = no restart
      // storm; the 5-minute watchdog trigger tries again and finds the port free once the other copy is gone.
      eventLog.logEvent('boot', 'port_in_use', { port: PORT, lvl: 'warn' });
      console.error(`Port ${PORT} is already in use: another instance is running. Exiting.`);
      process.exit(0);
    }
    console.error(`Cannot listen on ${HOST}:${PORT}: ${err.message}`);
    eventLog.logEvent('boot', 'fatal', { stage: 'listen', err });
    process.exit(1);
  }

  let attempts = 0;
  try {
    // A laptop may boot before its network is up: retry with backoff instead of exiting.
    await connectWithRetry({ connect: () => (attempts++, db.connectPg()) });
    console.log('PostgreSQL connected');
    eventLog.logEvent('boot', 'db_connected', { attempts });
  } catch (err) {
    console.error(`Cannot connect to PostgreSQL: ${err.message}`);
    eventLog.logEvent('boot', 'fatal', { stage: 'db', attempts, err });
    process.exit(1);
  }
  try {
    if (await db.ensureSchema()) console.log('Database tables created (empty database)');
  } catch (err) {
    console.error(err.message);
    eventLog.logEvent('boot', 'fatal', { stage: 'schema', err });
    process.exit(1);
  }

  startHealthPing({
    url: process.env.HEALTHCHECK_URL,
    isHealthy: () => {
      const client = getClient();
      return db.isConnected() && Boolean(client && client.isReady());
    },
  });

  if (!process.env.DISCORD_TOKEN) {
    console.warn('DISCORD_TOKEN is missing in .env - running web server only.');
    eventLog.logEvent('boot', 'no_token', { lvl: 'warn' });
    return;
  }
  try {
    // Transient failures (network, DNS, gateway timeout) are retried with backoff while the web server stays up.
    await startBotWithRetry(process.env.DISCORD_TOKEN, {
      onRetry: (err, delay) => {
        console.error(`${describeLoginError(err)}
Retrying in ${delay / 1000}s.`);
        eventLog.logEvent('boot', 'login_retry', { delayMs: delay, err });
      },
    });
  } catch (err) {
    console.error(describeLoginError(err));
    eventLog.logEvent('boot', 'fatal', { stage: 'login', err });
    process.exit(1); // unrecoverable (bad token / disallowed intents): the Scheduled Task watchdog restarts it (see packaging/install-task.ps1)
  }
}

main();
