// Anonymous feedback mailbox (customIds mb:*, UI in bot/ui/mailbox.js). The privacy rule lives here:
//  - an anonymous letter keeps the sender ONLY as senderEnc = RSA-OAEP(SHA-256) of { discordId, at } under the owner's PUBLIC key
//    (config/mailbox-public.pem). The private key never reaches the bot's machine, so this module can encrypt and never decrypt;
//    only scripts/mailbox-who.js, run by the owner with the private key, can.
//  - nothing derived from the id (hash, HMAC...) is stored: Discord ids are enumerable, so it would be reversible.
//  - rate limits are in memory only (a persisted "who sent how many" list would be a sender list).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');

const PUBLIC_KEY_FILE = path.join(__dirname, '..', '..', 'config', 'mailbox-public.pem');
const CONTENT_MAX = 1000;
const TITLE_MAX = 80;

const CATEGORIES = {
  idea: { emoji: '💡', label: 'Góp ý' },
  war: { emoji: '⚔️', label: 'Bang chiến / xếp đội' },
  bug: { emoji: '🐞', label: 'Báo lỗi bot' },
  complaint: { emoji: '😤', label: 'Khiếu nại' },
  other: { emoji: '📝', label: 'Khác' },
};
const isCategory = (key) => typeof key === 'string' && Object.hasOwn(CATEGORIES, key); // user-controlled keys: never "__proto__" / "constructor"
const categoryLine = (key) => {
  const c = isCategory(key) ? CATEGORIES[key] : CATEGORIES.other;
  return `${c.emoji} ${c.label}`;
};

// ---------- public key ----------

const MIN_MODULUS = 3072; // a weaker key (a swapped-in 512-bit one, say) could be factored: refuse it

// -> the PEM text, or null when there is no usable PUBLIC key. A file holding a private key is refused: createPublicKey would
// happily derive the public half from it, and the bot must never be a machine that holds the private one.
function loadPublicKey(file = PUBLIC_KEY_FILE) {
  try {
    const pem = fs.readFileSync(file, 'utf8');
    if (/PRIVATE KEY/.test(pem)) return null;
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa') return null;
    const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
    return bits >= MIN_MODULUS ? pem : null;
  } catch {
    return null;
  }
}

// First 16 hex characters of sha256(SPKI DER) of a public key PEM: the owner compares it with the one keygen printed. null when unreadable.
function keyFingerprint(pem) {
  try {
    const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

const mailboxReady = (file) => loadPublicKey(file) !== null;

// What the letter looked like when it was sent, bound into the ciphertext: the owner script compares it with the stored letter, so a
// ciphertext copied from another letter (or guild) is noticed. Not secret, but it only ever travels inside senderEnc.
const letterDigest = (title, content) => crypto.createHash('sha256').update(JSON.stringify([String(content), String(title || '')])).digest('hex');

// { discordId, at, guildId, h } -> base64 ciphertext (RSA-OAEP, SHA-256). 3072-bit key: 318 bytes of plaintext fit, the JSON is ~190.
function encryptSender(publicPem, discordId, { guildId = null, title = '', content = '', at = new Date() } = {}) {
  const body = { discordId: String(discordId), at: new Date(at).toISOString() };
  if (guildId !== null) Object.assign(body, { guildId: String(guildId), h: letterDigest(title, content) });
  const plain = Buffer.from(JSON.stringify(body), 'utf8');
  return crypto.publicEncrypt({ key: publicPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, plain).toString('base64');
}

// ---------- letter code ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 symbols, no I L O U: a byte & 31 is unbiased
const CODE_LENGTH = 10;

function newCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

// "ABCDE-FGHJK" for display.
const formatCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

// What the member typed -> the canonical 10 characters, or null. Crockford reading: O -> 0, I / L -> 1, case and separators ignored.
function normalizeCode(text) {
  const s = String(text || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return s.length === CODE_LENGTH && [...s].every((c) => CROCKFORD.includes(c)) ? s : null;
}

const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

// ---------- untrusted text ----------

const ZWSP = '​';
// Members' words are shown to managers (and back to the sender): no mention, no clickable markdown link. Messages are also sent
// with allowedMentions { parse: [] }; this keeps the text from even looking like a ping or a masked link.
function defang(text) {
  return String(text)
    .replace(/@(everyone|here)/gi, `@${ZWSP}$1`)
    .replace(/<(@[!&]?|#)/g, `<${ZWSP}$1`)
    .replace(/\]\s*\(/g, `]${ZWSP}(`);
}

// A manager's words that the SENDER reads: defanged, and every plain URL wrapped in <...> so Discord shows no preview / embed.
const wrapLinks = (text) => String(text).replace(/(?<!<)https?:\/\/[^\s<>]+/gi, '<$&>');
const safeReply = (text) => wrapLinks(defang(text));
const LINK_WARNING = '⚠️ Cẩn thận khi mở link trong trả lời.';

// ---------- rate limits (memory only) ----------

// Rolling window: at most `max` hits per key within `windowMs`. clock is injectable for tests.
function createLimiter({ max, windowMs, clock = Date.now }) {
  const hits = new Map(); // key -> [timestamps]
  const live = (key) => {
    const cutoff = clock() - windowMs;
    const list = (hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  };
  return {
    allowed: (key) => live(key).length < max,
    hit(key) {
      const list = live(key);
      list.push(clock());
      hits.set(key, list);
    },
    // takes back the latest hit (the action it paid for did not happen)
    undo(key) {
      const list = live(key);
      list.pop();
      if (list.length) hits.set(key, list);
      else hits.delete(key);
    },
    clear: () => hits.clear(),
  };
}

const sendLimit = createLimiter({ max: 3, windowMs: 24 * 3600 * 1000 }); // letters per user per rolling day
const guessLimit = createLimiter({ max: 5, windowMs: 10 * 60 * 1000 }); // wrong codes per user per 10 minutes
const resetLimits = () => {
  sendLimit.clear();
  guessLimit.clear();
};

// ---------- daily counters (memory only) ----------

// Per-event log lines (mail.sent, mail.view_code) would carry an exact time next to a letter: with the Discord audit trail of who
// clicked when, that could correlate a sender with a letter. So nothing per event is logged; the counts are flushed ONCE a day as
// mail.daily { guild, day, sent, viewed, ... } by an hourly timer (never at the moment of a send).
const daily = new Map(); // "<day>|<guildId>" -> { sent, viewed, ... }
const pad2 = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
let dailyTimer = null;

// kind: sent | viewed | badCode | postFailed | blocked | ratelimited
function countDaily(guildId, kind, now = new Date()) {
  const key = `${dayOf(now)}|${guildId}`;
  const row = daily.get(key) || {};
  row[kind] = (row[kind] || 0) + 1;
  daily.set(key, row);
  if (!dailyTimer) {
    dailyTimer = setInterval(() => flushDaily(), 3600 * 1000);
    if (dailyTimer.unref) dailyTimer.unref();
  }
}

// Writes (and forgets) the counters of every day before today's. all = also today's (shutdown, tests). -> the lines written.
function flushDaily({ now = new Date(), all = false, log = require('../eventLog').logEvent } = {}) {
  const today = dayOf(now);
  const out = [];
  for (const [key, row] of [...daily]) {
    const [day, guild] = key.split('|');
    if (!all && day >= today) continue;
    daily.delete(key);
    log('mail', 'daily', { guild, day, ...row });
    out.push({ guild, day, ...row });
  }
  return out;
}

// ---------- db ----------

// A letter as the bot reads it (no sender_enc: only the owner's lookup script reads it, see getSenderEnc).
const LETTER_SQL = `select id as "_id", guild_id as "guildId", no, category, title, content, anonymous, sender_id as "senderId",
  code_hash as "codeHash", status, inbox_channel_id as "inboxChannelId", inbox_message_id as "inboxMessageId", replies,
  created_at as "createdAt", updated_at as "updatedAt" from mail_letters`;
const reviveReplies = (letter) => letter && { ...letter, replies: (letter.replies || []).map((r) => ({ ...r, at: r.at ? new Date(r.at) : null })) };
const letterWhere = async (where, params) => reviveReplies(await db.one(`${LETTER_SQL} where ${where}`, params));

// Atomic per-guild counter (guilds.mail_seq).
async function nextNo(guildId) {
  const row = await db.one('update guilds set mail_seq = mail_seq + 1 where id = $1 returning mail_seq', [guildId]);
  if (!row) throw new Error(`guild ${guildId} has no settings yet`);
  return row.mail_seq;
}

// -> { letter, code }. senderEnc (anonymous) or senderId (named) decides who the sender is; code is the plain code to show once.
async function createLetter({ guildId, category, title, content, anonymous, senderEnc = null, senderId = null }) {
  const code = newCode();
  const id = db.newId();
  await db.tx(async () => {
    const no = await nextNo(guildId);
    await db.q(
      `insert into mail_letters (id, guild_id, no, category, title, content, anonymous, sender_enc, sender_id, code_hash, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new')`,
      [id, guildId, no, category, title || '', content, !!anonymous, anonymous ? senderEnc : null, anonymous ? null : senderId, hashCode(code)]
    );
  });
  return { letter: await letterWhere('id = $1', [id]), code };
}

// Scoped to the guild: the same code in another guild finds nothing.
function findByCode(guildId, text) {
  const code = normalizeCode(text);
  if (!code) return Promise.resolve(null);
  return letterWhere('guild_id = $1 and code_hash = $2', [guildId, hashCode(code)]);
}

const getLetter = (guildId, no) => letterWhere('guild_id = $1 and no = $2', [guildId, Number(no)]);

// The letter WITH its encrypted sender (the owner's lookup script only). -> letter + senderEnc, or null
async function getLetterWithSender(guildId, no) {
  const letter = await getLetter(guildId, no);
  if (!letter) return null;
  const row = await db.one('select sender_enc from mail_letters where id = $1', [letter._id]);
  return { ...letter, senderEnc: row.sender_enc };
}

async function setInbox(guildId, no, channelId, messageId) {
  await db.q('update mail_letters set inbox_channel_id = $3, inbox_message_id = $4 where guild_id = $1 and no = $2', [guildId, Number(no), channelId, messageId]);
  return getLetter(guildId, no);
}

// 'seen' only moves a new letter forward; 'done' always applies. -> the letter, or null (no such letter / nothing to change).
async function setStatus(guildId, no, status) {
  const cond = status === 'seen' ? ` and status = 'new'` : '';
  const row = await db.one(`update mail_letters set status = $3 where guild_id = $1 and no = $2${cond} returning id`, [guildId, Number(no), status]);
  return row ? getLetter(guildId, no) : null;
}

// Appends a reply; a letter nobody has looked at yet becomes 'seen' (answering means reading).
async function addReply(guildId, no, { by, text }) {
  const reply = JSON.stringify([{ by, text, at: new Date() }]);
  const row = await db.one(
    `update mail_letters set replies = replies || $3::jsonb, status = case when status = 'new' then 'seen' else status end where guild_id = $1 and no = $2 returning id`,
    [guildId, Number(no), reply]
  );
  return row ? getLetter(guildId, no) : null;
}

module.exports = {
  CATEGORIES,
  CONTENT_MAX,
  TITLE_MAX,
  PUBLIC_KEY_FILE,
  CROCKFORD,
  categoryLine,
  isCategory,
  loadPublicKey,
  keyFingerprint,
  MIN_MODULUS,
  mailboxReady,
  encryptSender,
  letterDigest,
  newCode,
  formatCode,
  normalizeCode,
  hashCode,
  defang,
  wrapLinks,
  safeReply,
  LINK_WARNING,
  countDaily,
  flushDaily,
  createLimiter,
  sendLimit,
  guessLimit,
  resetLimits,
  nextNo,
  createLetter,
  findByCode,
  getLetter,
  getLetterWithSender,
  setInbox,
  setStatus,
  addReply,
};
