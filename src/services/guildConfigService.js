const db = require('../db');
const defaults = require('../../config/defaults');
const { parseDayTime, formatDayTime } = require('../utils/time');
const { computeCycle } = require('./warService');
const { splitClassToken, plainClass } = require('./lineupStyle');
const { classId } = require('./registrationService');
const features = require('./features');

const MAX_CLASSES = 25; // one string select holds 25 options
const MAX_CLASS_LENGTH = 40; // class name ends up inside customIds (100 chars max)
const MAX_GROUPS = 4;

// ---------- pure ----------

// Current config -> prefill strings for the settings modal. Classes show as "<plain name> :emoji:" (modal inputs cannot
// render custom emojis): the stored override, else the server emoji auto-matching picks (`styles` = Map from
// resolveClassStyles), else just the name.
function formatSettings(config, styles) {
  const s = config.schedule;
  return {
    classes: config.classes
      .map((c) => {
        const o = (config.classEmojis || []).find((x) => classId(x.className) === classId(c));
        const style = styles && styles.get(c);
        const token = (o && o.emoji) || (style && style.emoji && style.emoji.name);
        return token ? `${plainClass(c)} :${token}:` : plainClass(c);
      })
      .join('\n'),
    groupCount: String(config.groupCount ?? defaults.groupCount),
    war: formatDayTime(s.warDay, s.warTime),
    open: s.enabled ? formatDayTime(s.openDay, s.openTime) : '',
    timing: `${s.lockBeforeHours}/${s.remindBeforeHours}`,
  };
}

// Raw modal strings -> { value } or { error }.
// value.schedule is partial: openDay/openTime are omitted when auto-open is turned off.
// `autoEmoji(classList)` -> Map<className, name|null> of the server emoji auto-matching picks: a :token: equal to it is NOT
// stored as an override (auto-matching stays the default) - unless it equals the override already stored for that class
// (`prevEmojis` = config.classEmojis): a deliberate choice is preserved. Anything else is an explicit override.
function parseSettings({ classes, groupCount, war, open, timing }, { autoEmoji, prevEmojis = [] } = {}) {
  // "🩸 Huyết Hà :HH_icon:" -> class "🩸 Huyết Hà" (the identity stored in registrations) + emoji override "HH_icon".
  const parsed = String(classes || '')
    .split(/\r?\n/)
    .map(splitClassToken)
    .filter((c) => c.name);
  const classList = [];
  const seen = new Map(); // classId -> first label
  for (const c of parsed) {
    const id = classId(c.name);
    if (!id) return { error: `Tên môn phái không hợp lệ (chỉ có biểu tượng): ${c.name}` };
    if (seen.has(id)) return { error: `Môn phái bị trùng: "${seen.get(id)}" và "${c.name}" là một.` };
    seen.set(id, c.name);
    classList.push(c.name);
  }
  const auto = autoEmoji && classList.length <= MAX_CLASSES ? autoEmoji(classList) : new Map();
  const stored = (name) => {
    const o = (prevEmojis || []).find((x) => classId(x.className) === classId(name));
    return o && o.emoji ? o.emoji.toLowerCase() : null;
  };
  const classEmojis = [];
  for (const c of parsed) {
    if (!c.emoji || classEmojis.some((x) => x.className === c.name)) continue;
    const picked = auto.get(c.name);
    const token = c.emoji.toLowerCase();
    if (picked && picked.toLowerCase() === token && stored(c.name) !== token) continue;
    classEmojis.push({ className: c.name, emoji: c.emoji });
  }
  if (classList.length === 0) return { error: 'Cần ít nhất 1 môn phái.' };
  if (classList.length > MAX_CLASSES) return { error: `Tối đa ${MAX_CLASSES} môn phái.` };
  const tooLong = classList.find((c) => c.length > MAX_CLASS_LENGTH);
  if (tooLong) return { error: `Tên môn phái quá dài (tối đa ${MAX_CLASS_LENGTH} ký tự): ${tooLong}` };

  const countText = String(groupCount).trim();
  const count = /^\d+$/.test(countText) ? Number(countText) : NaN;
  if (!Number.isInteger(count) || count < 1 || count > MAX_GROUPS) {
    return { error: `Số nhóm phải là số nguyên từ 1 đến ${MAX_GROUPS}.` };
  }

  const warDt = parseDayTime(war);
  if (!warDt) return { error: 'Lịch đánh không hợp lệ. Ví dụ: T7 20:00' };

  const m = /^\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*$/.exec(String(timing || ''));
  if (!m) return { error: 'Hạn chốt/nhắc không hợp lệ. Ví dụ: 2/3' };
  const lockBeforeHours = Number(m[1].replace(',', '.'));
  const remindBeforeHours = Number(m[2].replace(',', '.'));
  if (lockBeforeHours > 168 || remindBeforeHours > 168) return { error: 'Số giờ tối đa là 168.' };

  const schedule = { warDay: warDt.day, warTime: warDt.time, lockBeforeHours, remindBeforeHours, enabled: false };

  if (String(open || '').trim()) {
    const openDt = parseDayTime(open);
    if (!openDt) return { error: 'Giờ mở đăng ký không hợp lệ. Ví dụ: T2 00:00 (để trống = tắt tự động)' };
    Object.assign(schedule, { enabled: true, openDay: openDt.day, openTime: openDt.time });
    const cycle = computeCycle(schedule, new Date());
    if (cycle.openAt >= cycle.deadline) return { error: 'Giờ mở đăng ký phải trước hạn chốt.' };
  }

  return { value: { classes: classList, classEmojis, groupCount: count, schedule } };
}

// ---------- db ----------

// guilds row -> the config object the bot reads (settings + guildId + timestamps). Dates kept in the JSON come back as Date.
const DATE_KEYS = ['departNoticeImportedAt', 'departNoticeAt', 'offNoticeImportedAt'];
function rowToConfig(row) {
  if (!row) return null;
  const config = { ...row.settings, guildId: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
  for (const k of DATE_KEYS) if (config[k]) config[k] = new Date(config[k]);
  return config;
}

// What a new guilds row stores: every field with its default (the old document defaults), features at the new-guild values.
function newSettings(guildId) {
  const { guildId: _g, ...base } = defaultConfig(guildId);
  return {
    ...base,
    departNoticeRosterId: null,
    departNoticeImportedAt: null,
    departNoticeIds: [],
    departNoticeMore: 0,
    departNoticeAt: null,
    offNoticeRosterId: null,
    offNoticeImportedAt: null,
    features: { ...features.NEW_GUILD_DEFAULTS },
  };
}

// The field rules the old schema enforced on every write. -> error message or null.
const EMOJI_TOKEN = /^([A-Za-z0-9_]{2,32}|none)$/;
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
function invalidPatch(patch) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has('groupCount') && !intIn(patch.groupCount, 1, MAX_GROUPS)) return 'groupCount';
  if (has('rosterTarget') && !intIn(patch.rosterTarget, 1, defaults.officialCap)) return 'rosterTarget';
  if (has('offWarnDays') && !intIn(patch.offWarnDays, 0, 60)) return 'offWarnDays';
  if (has('classEmojis') && !(patch.classEmojis || []).every((x) => String(x.className || '').length <= 40 && (x.emoji == null || EMOJI_TOKEN.test(x.emoji)))) return 'classEmojis';
  const maxLen = { gateGuildName: 60, gateWelcomeMember: 4000, gateWelcomeGuest: 2000 };
  for (const [k, n] of Object.entries(maxLen)) if (has(k) && patch[k] != null && String(patch[k]).length > n) return k;
  if (has('schedule') && patch.schedule) {
    const sc = patch.schedule;
    const day = (v) => v === undefined || intIn(v, 0, 6);
    if (!day(sc.warDay) || !day(sc.openDay)) return 'schedule';
    if (sc.warDurationMinutes !== undefined && !(sc.warDurationMinutes >= 1)) return 'schedule';
    if ([sc.lockBeforeHours, sc.remindBeforeHours].some((v) => v !== undefined && !(v >= 0))) return 'schedule';
  }
  return null;
}

// Read-only config lookups sit on the hot path (every button click), so they are cached briefly.
// Every write made by this process refreshes the entry; other processes catch up within the TTL.
const CONFIG_TTL_MS = 60 * 1000;
const cache = new Map(); // guildId -> { config, at }
// Bumped around every write: a read that started before a write must not cache what it saw (it may be stale).
const generations = new Map(); // guildId -> number

function generationOf(guildId) {
  return generations.get(guildId) || 0;
}

function bumpGeneration(guildId) {
  generations.set(guildId, generationOf(guildId) + 1);
}

function remember(guildId, config) {
  if (config) cache.set(guildId, { config, at: Date.now() });
  else cache.delete(guildId);
  return config;
}

function clearConfigCache() {
  cache.clear();
}

// What an un-configured guild behaves like (same as a freshly created GuildConfig).
function defaultConfig(guildId) {
  return {
    guildId,
    announceChannelId: null,
    adminChannelId: null,
    panelChannelId: null,
    panelMessageId: null,
    adminRoleIds: [],
    memberRoleId: null,
    classes: normalizeConfig({ classes: [...defaults.classes] }).classes,
    classEmojis: [],
    sheetId: null,
    gnChannelId: null,
    gnPanelChannelId: null,
    gnPanelMessageId: null,
    mailChannelId: null,
    mailInboxChannelId: null,
    mailPanelChannelId: null,
    mailPanelMessageId: null,
    mailBlocked: [],
    eventChannelId: null,
    eventAdminChannelId: null,
    eventPanelChannelId: null,
    eventPanelMessageId: null,
    eventDocId: null,
    hangChannelId: null,
    gateEnabled: false,
    gateChannelId: null,
    gatePanelChannelId: null,
    gatePanelMessageId: null,
    gateAdminChannelId: null,
    gateAutoApprove: true,
    guestRoleId: null,
    pendingRoleId: null,
    strangerRoleId: null,
    gateGuildName: null,
    gateWelcomeMember: null,
    gateWelcomeGuest: null,
    offWarnDays: 5,
    rosterTarget: defaults.rosterTarget,
    groupCount: defaults.groupCount,
    schedule: { ...defaults.schedule },
  };
}

// A config whose class list repeats a class (same classId) would give selects duplicate defaults: keep the first spelling.
function normalizeConfig(config) {
  if (!config || !Array.isArray(config.classes)) return config;
  const seen = new Set();
  const classes = config.classes.filter((c) => {
    const id = classId(c);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return classes.length === config.classes.length ? config : { ...config, classes };
}

// Never writes. Returns null when the guild has no config document yet. `fresh` bypasses the cache (and refreshes it):
// for decisions that rewrite stored data and must not act on a config another process has already changed.
async function getConfig(guildId, { fresh = false } = {}) {
  const hit = cache.get(guildId);
  if (!fresh && hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.config;
  const generation = generationOf(guildId);
  const config = normalizeConfig(rowToConfig(await db.one('select id, settings, created_at, updated_at from guilds where id = $1', [guildId])));
  return generation === generationOf(guildId) ? remember(guildId, config) : config;
}

async function getConfigOrDefault(guildId, options) {
  return (await getConfig(guildId, options)) || defaultConfig(guildId);
}

// Runs a write and refreshes the cache with its result, unless another writer overlapped (its result may be newer
// than ours, or ours newer than what it will return): then the entry is dropped and the next read reloads it.
async function cachedWrite(guildId, write) {
  bumpGeneration(guildId); // a read in flight must not re-cache the old value (see getConfig)
  const myGen = generationOf(guildId);
  let config;
  try {
    config = await write();
  } finally {
    bumpGeneration(guildId); // ... including reads that began before the write finished (also on failure)
  }
  if (generationOf(guildId) !== myGen + 1) {
    cache.delete(guildId);
    return config;
  }
  return remember(guildId, config);
}

// Creates the document if missing: only for /setup.
function getOrCreateConfig(guildId) {
  return cachedWrite(guildId, async () =>
    rowToConfig(
      await db.one(
        `with ins as (insert into guilds (id, settings) values ($1, $2) on conflict (id) do nothing returning id, settings, created_at, updated_at)
         select * from ins union all select id, settings, created_at, updated_at from guilds where id = $1 and not exists (select 1 from ins)`,
        [guildId, JSON.stringify(newSettings(guildId))]
      )
    )
  );
}

async function updateConfig(guildId, patch) {
  const bad = invalidPatch(patch);
  if (bad) {
    const err = new Error(`invalid config value: ${bad}`);
    err.name = 'ValidationError';
    throw err;
  }
  cache.delete(guildId);
  // top-level keys replace the stored ones (jsonb ||), like $set did; a missing row starts from the defaults
  return cachedWrite(guildId, async () =>
    rowToConfig(
      await db.one(
        `insert into guilds (id, settings) values ($1, $2::jsonb || $3::jsonb)
         on conflict (id) do update set settings = guilds.settings || $3::jsonb
         returning id, settings, created_at, updated_at`,
        [guildId, JSON.stringify(newSettings(guildId)), JSON.stringify(patch)]
      )
    )
  );
}

// Clears the stored dashboard ids only while the stored message id is still `messageId` (the one that just failed): a
// dashboard stored meanwhile (e.g. by /setup) is kept. The cache entry is dropped either way. -> true when it cleared them.
async function clearPanelIf(guildId, messageId) {
  let matched = false;
  await cachedWrite(guildId, async () => {
    const row = await db.one(
      `update guilds set settings = settings || '{"panelChannelId": null, "panelMessageId": null}'::jsonb
       where id = $1 and settings->>'panelMessageId' = $2 returning id, settings, created_at, updated_at`,
      [guildId, String(messageId)]
    );
    matched = !!row;
    return rowToConfig(row);
  });
  cache.delete(guildId);
  return matched;
}

async function listScheduledConfigs() {
  const rows = await db.q(`select id, settings, created_at, updated_at from guilds where (settings->'schedule'->>'enabled')::boolean and settings->>'announceChannelId' is not null`);
  return rows.map(rowToConfig);
}

// Guilds with a stored dashboard message (startup redraw).
async function listPanelConfigs() {
  const rows = await db.q(`select id, settings, created_at, updated_at from guilds where settings->>'panelMessageId' is not null and settings->>'panelChannelId' is not null`);
  return rows.map(rowToConfig);
}

module.exports = {
  MAX_CLASSES,
  MAX_CLASS_LENGTH,
  formatSettings,
  parseSettings,
  CONFIG_TTL_MS,
  defaultConfig,
  getConfig,
  getConfigOrDefault,
  clearConfigCache,
  getOrCreateConfig,
  updateConfig,
  clearPanelIf,
  listScheduledConfigs,
  listPanelConfigs,
  invalidPatch,
  rowToConfig,
  isOn: features.isOn,
  featuresOf: features.featuresOf,
};
