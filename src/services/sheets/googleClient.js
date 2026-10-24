// Minimal Google Sheets v4 client for a SERVICE ACCOUNT, with no dependency: the JWT is signed with node:crypto and the
// calls use the global fetch (Node 24, also inside the packaged exe). Only what the bot needs: spreadsheet metadata,
// batchUpdate (structure), values get / batchUpdate / batchClear. 429 and 5xx are retried with backoff.
const fs = require('node:fs');
const crypto = require('node:crypto');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents'; // the Sheet feed + the events Google Doc (only the files shared with the service account)
const DOCS_API = 'https://docs.googleapis.com/v1/documents';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

// Error carrying the HTTP status (0 = network) and a stable `code` for the callers: NO_KEY | BAD_KEY | AUTH | HTTP.
class SheetsError extends Error {
  constructor(message, { status = 0, code = 'HTTP', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SheetsError';
    this.status = status;
    this.code = code;
  }
}

const b64url = (input) => Buffer.from(input).toString('base64url');

// Reads and checks the key file -> { client_email, private_key, token_uri }. Never logs the content.
function loadKey(keyFile, fsImpl = fs) {
  let raw;
  try {
    raw = fsImpl.readFileSync(keyFile, 'utf8');
  } catch (err) {
    throw new SheetsError(`Không đọc được file khoá Google: ${keyFile}`, { code: 'NO_KEY', cause: err });
  }
  let key;
  try {
    key = JSON.parse(raw);
  } catch (err) {
    throw new SheetsError('File khoá Google không phải JSON hợp lệ.', { code: 'BAD_KEY', cause: err });
  }
  if (!key || typeof key.client_email !== 'string' || typeof key.private_key !== 'string') {
    throw new SheetsError('File khoá Google thiếu client_email / private_key (cần khoá service account dạng JSON).', { code: 'BAD_KEY' });
  }
  return { client_email: key.client_email, private_key: key.private_key, token_uri: key.token_uri || TOKEN_URI };
}

// Only the service-account e-mail of a key file (to tell admins whom to share the Sheet with); null when unreadable.
function serviceEmail(keyFile, fsImpl = fs) {
  try {
    return loadKey(keyFile, fsImpl).client_email;
  } catch {
    return null;
  }
}

function signJwt(key, nowSec) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: nowSec, exp: nowSec + 3600 }));
  const data = `${head}.${claims}`;
  try {
    return `${data}.${crypto.createSign('RSA-SHA256').update(data).sign(key.private_key, 'base64url')}`;
  } catch (err) {
    throw new SheetsError('private_key trong file khoá Google không hợp lệ.', { code: 'BAD_KEY', cause: err });
  }
}

const a1 = (range) => encodeURIComponent(range);

// opts: { keyFile, fetchImpl, sleep, now, fsImpl }. All injectable for tests (no network there).
function createGoogleClient({ keyFile, fetchImpl = (...a) => globalThis.fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), fsImpl = fs } = {}) {
  let key = null;
  let token = null; // { value, expiresAt }
  let tokenFlight = null; // the token request in progress, shared by parallel calls

  const getKey = () => key || (key = loadKey(keyFile, fsImpl));

  // ONE token request at a time (parallel calls share it); 5xx / network errors are retried with backoff; the JWT is back-dated by
  // 30 s so a clock a little ahead of Google's does not make it "issued in the future".
  async function fetchToken() {
    const k = getKey();
    const assertion = signJwt(k, Math.floor(now() / 1000) - 30);
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(k.token_uri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        });
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new SheetsError(`Không kết nối được Google: ${err.message}`, { cause: err });
      }
      if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) {
        throw new SheetsError(`Google từ chối khoá service account (${body.error || res.status}${body.error_description ? `: ${body.error_description}` : ''}).`, { status: res.status, code: 'AUTH' });
      }
      token = { value: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 };
      return token.value;
    }
  }

  async function accessToken() {
    if (token && token.expiresAt - 60000 > now()) return token.value;
    if (!tokenFlight) tokenFlight = fetchToken().finally(() => (tokenFlight = null));
    return tokenFlight;
  }

  async function request(method, url, body) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        const auth = await accessToken();
        res = await fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        if (err instanceof SheetsError) throw err;
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new SheetsError(`Không kết nối được Google Sheets: ${err.message}`, { cause: err });
      }
      if (res.ok) return res.status === 204 ? {} : res.json();
      if (res.status === 401 && !refreshed) {
        refreshed = true; // the cached token was revoked / expired early: sign in again once (this does not use up a 5xx retry)
        token = null;
        attempt -= 1;
        continue;
      }
      if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        const wait = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        await sleep(wait > 0 ? Math.min(wait * 1000, 30000) : 1000 * 2 ** attempt);
        continue;
      }
      const detail = await res.json().catch(() => ({}));
      const message = (detail.error && detail.error.message) || `HTTP ${res.status}`;
      throw new SheetsError(message, { status: res.status });
    }
  }

  return {
    email: () => getKey().client_email,
    // -> { title, locale, sheets: [{ sheetId, title, rowCount, columnCount, tables: [{ tableId, name, range }], ruleCount }] } (ruleCount = conditional format rules)
    async getSpreadsheet(id) {
      const data = await request('GET', `${API}/${encodeURIComponent(id)}?fields=${a1('properties(title,locale),sheets(properties(sheetId,title,hidden,gridProperties),tables(tableId,name,range),conditionalFormats(ranges(sheetId)))')}`);
      return {
        title: (data.properties && data.properties.title) || '',
        locale: (data.properties && data.properties.locale) || '',
        sheets: ((data.sheets) || []).map((s) => ({
          sheetId: s.properties.sheetId,
          title: s.properties.title,
          hidden: Boolean(s.properties.hidden),
          rowCount: s.properties.gridProperties && s.properties.gridProperties.rowCount,
          columnCount: s.properties.gridProperties && s.properties.gridProperties.columnCount,
          tables: (s.tables || []).map((t) => ({ tableId: t.tableId, name: t.name, range: t.range || {} })),
          ruleCount: (s.conditionalFormats || []).length,
        })),
      };
    },
    batchUpdate: (id, requests) => request('POST', `${API}/${encodeURIComponent(id)}:batchUpdate`, { requests }),
    // -> string[][] (rows trimmed at the last filled cell, as the API returns them)
    async valuesGet(id, range, { render = 'FORMATTED_VALUE' } = {}) {
      const data = await request('GET', `${API}/${encodeURIComponent(id)}/values/${a1(range)}?valueRenderOption=${render}&majorDimension=ROWS`);
      return data.values || [];
    },
    // data = [{ range, values }]; input 'RAW' keeps strings as they are (ids, names), 'USER_ENTERED' evaluates formulas
    valuesBatchUpdate: (id, data, input = 'RAW') => request('POST', `${API}/${encodeURIComponent(id)}/values:batchUpdate`, { valueInputOption: input, data }),
    valuesBatchClear: (id, ranges) => request('POST', `${API}/${encodeURIComponent(id)}/values:batchClear`, { ranges }),
    // Google Docs (the events document): the structure the writer needs (indexes of the body and of the table cells) + the title
    docsGet: (id) => request('GET', `${DOCS_API}/${encodeURIComponent(id)}?fields=${a1('title,body.content(startIndex,endIndex,table(tableRows(tableCells(content(startIndex)))))')}`),
    docsBatchUpdate: (id, requests) => request('POST', `${DOCS_API}/${encodeURIComponent(id)}:batchUpdate`, { requests }),
  };
}

module.exports = { createGoogleClient, loadKey, serviceEmail, signJwt, SheetsError, SCOPE };
