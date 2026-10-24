// Where files live. Normal run: the repo. Packaged run (@yao-pkg/pkg): code is inside a read-only snapshot, so anything a
// native module must open by real path (fonts) and the .env live next to the executable (the install dir, Program Files:
// read-only for the service account). Logs live in %ProgramData%\LongLinh\logs (created + ACL'd by the installer).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isPackaged = () => Boolean(process.pkg);
const appRoot = () => (isPackaged() ? path.dirname(process.execPath) : path.join(__dirname, '..'));

// Log directory. Override: --log-dir=<path> or LONGLINH_LOG_DIR. Packaged default: %ProgramData%\LongLinh\logs.
// Not packaged: <repo>/logs.
function logDir({ argv = process.argv, env = process.env } = {}) {
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith('--log-dir='));
  if (arg && arg.length > '--log-dir='.length) return arg.slice('--log-dir='.length);
  if (env.LONGLINH_LOG_DIR) return env.LONGLINH_LOG_DIR;
  if (!isPackaged()) return path.join(__dirname, '..', 'logs');
  return path.join(env.ProgramData || 'C:\\ProgramData', 'LongLinh', 'logs');
}

// Fonts must exist as real files. Prefer <install dir>/assets/fonts (the installer ships it); if absent, copy them out of
// the snapshot into the install dir, or into a fresh private temp dir (mkdtemp: unpredictable name, mode 0700) when that
// is not writable.
function ensureRealDir(snapshotDir, wanted, files) {
  const ok = (dir) => files.every((f) => fs.existsSync(path.join(dir, f)));
  if (ok(wanted)) return wanted;
  const targets = [() => wanted, () => fs.mkdtempSync(path.join(os.tmpdir(), 'longlinh-assets-'))];
  for (const makeTarget of targets) {
    try {
      const target = makeTarget();
      fs.mkdirSync(target, { recursive: true });
      for (const f of files) fs.copyFileSync(path.join(snapshotDir, f), path.join(target, f));
      return target;
    } catch {
      /* try next target */
    }
  }
  return wanted;
}

function fontDir(files = ['BeVietnamPro-Regular.ttf', 'BeVietnamPro-Bold.ttf']) {
  const snapshot = path.join(__dirname, '..', 'assets', 'fonts');
  if (!isPackaged()) return snapshot;
  return ensureRealDir(snapshot, path.join(appRoot(), 'assets', 'fonts'), files);
}

module.exports = { isPackaged, appRoot, fontDir, ensureRealDir, logDir };
