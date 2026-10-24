// Packaged (Windows service-like) runs have no console, so mirror console output into <dir>/longlinh.log and rotate it:
// longlinh.log -> longlinh.1.log ... longlinh.9.log (10 files max, 5 MB each). Never throws.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { logEvent, redact } = require('./eventLog'); // eventLog never requires this file

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 10;

function createRotatingLog(dir, { maxBytes = MAX_BYTES, keep = KEEP, base = 'longlinh' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (i) => path.join(dir, i === 0 ? `${base}.log` : `${base}.${i}.log`);
  let size = fs.existsSync(file(0)) ? fs.statSync(file(0)).size : 0;

  function rotate() {
    try {
      fs.rmSync(file(keep - 1), { force: true });
      for (let i = keep - 2; i >= 0; i--) if (fs.existsSync(file(i))) fs.renameSync(file(i), file(i + 1));
    } catch {
      /* e.g. file locked: keep appending to the current one */
    }
    size = 0;
  }

  return {
    write(text) {
      try {
        const safe = redact(text); // a connection string / token in a console line or a stack must not reach the disk
        const line = safe.endsWith('\n') ? safe : `${safe}\n`;
        if (size + Buffer.byteLength(line) > maxBytes) rotate();
        fs.appendFileSync(file(0), line);
        size += Buffer.byteLength(line);
      } catch {
        /* logging must never crash the bot */
      }
    },
    file,
  };
}

// Mirror console.log/info/warn/error (and fatal errors) into the rotating log; the original console still works.
// Fatal errors: by default the handlers log and exit(1) (packaged: the Scheduled Task restarts the bot a minute later).
// monitorOnly (a plain `node app.js` run, nothing restarts it): uncaughtExceptionMonitor only OBSERVES, so Node keeps its own
// behaviour (print the stack, exit code 1; an unhandled rejection is raised as an uncaught exception). Same crash as before
// the log existed, just recorded. A handler that did not exit would keep a half-broken bot alive, which is worse.
function installFileLogging(dir, { monitorOnly = false, ...options } = {}) {
  const log = createRotatingLog(dir, options);
  const stamp = () => new Date().toISOString();
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      log.write(`${stamp()} ${level} ${util.format(...args)}`);
      original(...args);
    };
  }
  const record = (label, err) => {
    log.write(`${stamp()} FATAL ${label}: ${(err && err.stack) || err}`);
    logEvent('boot', 'fatal', { label, err });
  };
  if (monitorOnly) {
    process.on('uncaughtExceptionMonitor', (err, origin) => record(origin || 'uncaughtException', err));
    return log;
  }
  const fatal = (label) => (err) => {
    record(label, err);
    process.exit(1); // the Scheduled Task restarts the bot after a minute
  };
  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));
  return log;
}

module.exports = { createRotatingLog, installFileLogging, MAX_BYTES, KEEP };
