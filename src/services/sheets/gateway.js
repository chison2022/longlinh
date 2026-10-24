// The one place that knows where the Google key is and hands out the (lazy, shared) client. Everything that talks to
// Google goes through getClient(), so tests inject a fake with setClient() and the real API is never called there.
const fs = require('node:fs');
const path = require('node:path');
const { appRoot } = require('../../paths');
const { createGoogleClient, serviceEmail, SheetsError } = require('./googleClient');

let injected = null; // tests
let real = null; // { file, client }

// GOOGLE_KEY_FILE (absolute, or relative to the app folder), default <appRoot>/google-key.json. In the packaged exe appRoot is
// the install dir, so the key sits next to LongLinh.exe like the .env.
function keyFile(env = process.env) {
  const configured = env.GOOGLE_KEY_FILE && String(env.GOOGLE_KEY_FILE).trim();
  if (!configured) return path.join(appRoot(), 'google-key.json');
  return path.isAbsolute(configured) ? configured : path.join(appRoot(), configured);
}

const AVAILABLE_TTL_MS = 60 * 1000;
let availability = null; // { file, at, value }: the key-file check is cached (it runs on every registration click)

const hasKey = () => {
  const file = keyFile();
  if (availability && availability.file === file && Date.now() - availability.at < AVAILABLE_TTL_MS) return availability.value;
  let value = false;
  try {
    value = fs.existsSync(file);
  } catch {
    value = false;
  }
  availability = { file, at: Date.now(), value };
  return value;
};

// True when a Sheets call can be attempted at all (key file present, or a test client injected).
const isAvailable = () => Boolean(injected) || hasKey();
const resetAvailability = () => {
  availability = null;
};

function getClient() {
  if (injected) return injected;
  const file = keyFile();
  if (!real || real.file !== file) real = { file, client: createGoogleClient({ keyFile: file }) };
  return real.client;
}

function setClient(client) {
  injected = client || null;
}

// E-mail of the service account (shown to admins so they can share the Sheet with it); null without a readable key.
function accountEmail() {
  if (injected && typeof injected.email === 'function') {
    try {
      return injected.email();
    } catch {
      return null;
    }
  }
  return serviceEmail(keyFile());
}

// A pasted link or a bare id -> the spreadsheet id, or null.
function parseSpreadsheetId(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{15,})/.exec(text);
  const id = m ? m[1] : text;
  return /^[A-Za-z0-9_-]{15,}$/.test(id) ? id : null;
}

const sheetUrl = (id, gid) => `https://docs.google.com/spreadsheets/d/${id}/edit${Number.isInteger(gid) ? `#gid=${gid}` : ''}`;

const NO_KEY_HINT = () => `Bot chưa có file khoá Google. Đặt file khoá service account (.json) tên **google-key.json** cạnh bot (hoặc đặt biến GOOGLE_KEY_FILE). Đây là khoá bí mật: chỉ quản trị viên được đọc (khoá quyền thư mục/file như file .env).`;

// Any error from a Sheets call -> a short Vietnamese sentence (what to do), never the raw key / token.
function describeError(err) {
  const email = accountEmail();
  const who = email ? `\`${email}\`` : 'tài khoản service account của bot';
  if (err && err.code === 'NO_KEY') return NO_KEY_HINT();
  if (err && err.code === 'BAD_KEY') return `File khoá Google không dùng được: ${err.message}`;
  if (err && err.code === 'AUTH') return `Google từ chối khoá của bot: ${err.message}`;
  if (err && (err.status === 403 || err.status === 404)) return `Chưa chia sẻ quyền **Editor** cho ${who} (mở Google Sheet → Chia sẻ → thêm email này với quyền Chỉnh sửa), hoặc link/ID Sheet sai.`;
  if (err && err.status === 429) return 'Google đang giới hạn tốc độ, thử lại sau ít phút.';
  return `Lỗi Google Sheets: ${(err && err.message) || err}`;
}

// Reads the title of a spreadsheet AND proves the bot can WRITE to it (a Viewer-only share lets the read pass): a no-op
// properties update (the title set to itself) needs Editor. -> { ok: true, title } | { ok: false, message }.
async function checkSpreadsheet(id) {
  let info;
  try {
    info = await getClient().getSpreadsheet(id);
  } catch (err) {
    return { ok: false, message: describeError(err), err };
  }
  try {
    await getClient().batchUpdate(id, [{ updateSpreadsheetProperties: { properties: { title: info.title }, fields: 'title' } }]);
  } catch (err) {
    if (err && (err.status === 403 || err.status === 404)) {
      const email = accountEmail();
      return { ok: false, message: `Bot mới chỉ có quyền **xem** Sheet này. Hãy đổi quyền của ${email ? `\`${email}\`` : 'tài khoản service account của bot'} thành **Editor** (Chia sẻ → Chỉnh sửa).`, err };
    }
    return { ok: false, message: describeError(err), err };
  }
  return { ok: true, title: info.title };
}

module.exports = { keyFile, hasKey, isAvailable, resetAvailability, getClient, setClient, accountEmail, parseSpreadsheetId, sheetUrl, describeError, checkSpreadsheet, NO_KEY_HINT, SheetsError };
