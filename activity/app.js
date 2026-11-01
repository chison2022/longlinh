// The Activity web server (Express app, no listen here): the lineup board API + the static client. Every /api route except
// /api/config and /api/token needs the Discord user's access token; the war must belong to a guild the user is a member of.
// Not the bot: no discord.js, no canvas. Discord is reached through REST only (discordApi.js, fetch injectable for tests).
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const db = require('../src/db');
const defaults = require('../config/defaults');
const lineupService = require('../src/services/lineupService');
const rules = require('../src/services/lineupRules');
const { getConfigOrDefault } = require('../src/services/guildConfigService');
const { layoutOf } = require('../src/services/teamService');
const { chipColor, plainClass } = require('../src/services/lineupStyle');
const { matchClassStyles, styleOf, classCodes } = require('../src/bot/classStyle');
const { createDiscordApi } = require('./discordApi');
const { isManager } = require('./adminRule');

const SNOWFLAKE = /^\d{5,25}$/;

// Fixed-window counter per key; -> middleware factory. Memory only (one process).
function limiter(max, windowMs = 60 * 1000) {
  const hits = new Map();
  return (keyOf) => (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    const key = keyOf(req);
    const h = hits.get(key);
    if (!h || h.reset <= now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return next();
    }
    h.n += 1;
    if (h.n > max) return res.status(429).json({ error: 'Thao tác quá nhanh, thử lại sau ít giây.' });
    return next();
  };
}

const ROLE_LABEL = (pref) => (pref && pref !== 'any' && defaults.roles[pref] ? defaults.roles[pref].plain : '');

// The publish request of a lineup row as the client shows it: none / pending (waiting for the bot) / published / error.
function publishState(row) {
  if (!row || !row.publishRequestedAt) return { state: 'none' };
  const base = { requestedAt: row.publishRequestedAt, publishedAt: row.publishedAt, publishedVersion: row.publishedVersion, error: row.publishError };
  const served = row.publishedAt && row.publishedAt >= row.publishRequestedAt;
  if (row.publishError && !served) return { state: 'error', ...base };
  if (!served) return { state: 'pending', ...base };
  return { state: 'published', ...base };
}

// Security headers of every response: the page may only be framed by Discord, and loads only its own files (no inline scripts or styles).
const CSP = "default-src 'self'; frame-ancestors https://discord.com https://*.discordsays.com";

function createApp({ fetchFn = globalThis.fetch, env = process.env, staticDir = path.join(__dirname, 'public'), limits = {} } = {}) {
  const discord = createDiscordApi({ fetchFn, clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET, botToken: env.DISCORD_TOKEN });
  const app = express();
  app.set('trust proxy', 1); // Render sits behind a proxy
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP });
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  const perIp = limiter(limits.ip || 1200); // before the token check: random tokens cannot make us call Discord without end (Discord's proxy may share one IP between many users, hence generous)
  const general = limiter(240);
  const writes = limiter(40);
  const tokens = limiter(20);
  const ipKey = (req) => `ip:${req.ip}`;
  const authKey = (req) => `t:${crypto.createHash('sha256').update(String(req.headers.authorization || req.ip)).digest('hex').slice(0, 16)}`;

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/config', (req, res) => res.json({ clientId: env.CLIENT_ID || null }));

  // Class emoji images. An <img> cannot send the bearer token, so only ids resolved as the class emoji of a guild this server has served
  // are answered (never an open proxy), and by IP rate limit.
  const knownEmojis = new Set();
  api.get('/emoji/:id', perIp(ipKey), async (req, res) => {
    const id = String(req.params.id);
    if (!SNOWFLAKE.test(id)) return res.status(400).json({ error: 'Mã emoji không hợp lệ.' });
    if (!knownEmojis.has(id)) return res.status(404).json({ error: 'Không tìm thấy.' });
    const png = await discord.emojiImage(id);
    if (!png) return res.status(404).json({ error: 'Không tìm thấy.' });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.send(png);
  });

  api.post('/token', tokens(ipKey), async (req, res) => {
    const code = req.body && req.body.code;
    if (typeof code !== 'string' || !code || code.length > 200) return res.status(400).json({ error: 'Thiếu mã đăng nhập.' });
    if (!env.CLIENT_ID || !env.CLIENT_SECRET) return res.status(500).json({ error: 'Server chưa cấu hình CLIENT_ID / CLIENT_SECRET.' });
    const accessToken = await discord.exchangeCode(code);
    if (!accessToken) return res.status(401).json({ error: 'Discord từ chối mã đăng nhập.' });
    return res.json({ access_token: accessToken });
  });

  // every other route: a valid user token
  api.use(perIp(ipKey));
  api.use(async (req, res, next) => {
    const m = /^Bearer (\S{10,300})$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'Chưa đăng nhập.' });
    const user = await discord.userOf(m[1]);
    if (!user) return res.status(401).json({ error: 'Phiên đăng nhập hết hạn.' });
    req.token = m[1];
    req.user = user;
    return next();
  });
  api.use(general(authKey));

  // -> { admin, member, config } or null (already answered 403)
  async function access(req, res, guildId) {
    const member = await discord.memberOf(req.token, guildId);
    if (!member) {
      res.status(403).json({ error: 'Bạn không ở trong máy chủ này.' });
      return null;
    }
    const config = await getConfigOrDefault(guildId);
    const guild = await discord.guildInfo(guildId);
    const admin = isManager({ userId: req.user.id, member, guild, adminRoleIds: config.adminRoleIds || [] });
    return { member, admin, config };
  }

  // the war of the URL, only when the user is in its guild -> { war, ...access } or null (answered)
  async function warAccess(req, res) {
    const warId = String(req.params.warId || '');
    const war = db.isId(warId) ? await db.one('select id, guild_id as "guildId", title, start_at as "startAt", status from war_events where id = $1', [warId]) : null;
    if (!war) {
      res.status(404).json({ error: 'Bang chiến không tồn tại.' });
      return null;
    }
    const acc = await access(req, res, war.guildId);
    return acc && { war, ...acc };
  }

  api.get('/wars', async (req, res) => {
    const guildId = String(req.query.guild || '');
    if (!SNOWFLAKE.test(guildId)) return res.status(400).json({ error: 'Thiếu mã máy chủ.' });
    const acc = await access(req, res, guildId);
    if (!acc) return undefined;
    const wars = await db.q(
      `select id, title, start_at as "startAt", status from war_events where guild_id = $1 and status in ('open', 'locked', 'published') order by start_at desc limit 10`,
      [guildId]
    );
    return res.json({ wars, canEdit: acc.admin });
  });

  api.get('/lineup/:warId/version', async (req, res) => {
    const acc = await warAccess(req, res);
    if (!acc) return undefined;
    const row = await lineupService.getLineup(acc.war.id);
    return res.json({ version: row ? row.version : 0 });
  });

  api.get('/lineup/:warId', async (req, res) => {
    const acc = await warAccess(req, res);
    if (!acc) return undefined;
    const { war, config } = acc;
    const shape = layoutOf(config);
    const joiners = await lineupService.listJoiners(war.id);
    const order = config.classes || [];
    const colorOf = (className) => chipColor(Math.max(order.findIndex((c) => rules.sameClass(c, className)), 0));
    // the guild's class emojis, matched exactly as the bot does (settings override, slug, initials); colour dots when unavailable
    const emojiList = (await discord.guildEmojis(war.guildId)) || [];
    const styles = matchClassStyles(order, [], emojiList, config.classEmojis);
    const emojiIdOf = (className) => {
      const e = className ? styleOf(styles, className).emoji : null;
      if (e) knownEmojis.add(e.id);
      return e ? e.id : null;
    };
    const codes = classCodes(order);
    const seenClasses = [...order.map((c) => plainClass(c)), ...joiners.map((j) => (j.className ? plainClass(j.className) : '')).filter(Boolean)];
    const classes = [...new Set(seenClasses)].map((name) => ({ name, tag: codes.get(name) || '', color: colorOf(name), emojiId: emojiIdOf(name) }));
    const members = joiners.map((j) => ({
      id: j.id,
      name: j.name || j.id,
      className: j.className ? plainClass(j.className) : '',
      classColor: colorOf(j.className),
      classEmoji: emojiIdOf(j.className),
      rolePref: ROLE_LABEL(j.rolePref),
      createdAt: j.createdAt,
    }));
    const row = await lineupService.getLineup(war.id);
    const joinedIds = new Set(members.map((m) => m.id));
    // fitted to the CURRENT shape (the group count may have changed since it was saved), so what the client sends back is saveable
    const lineup = rules.filterLayout(rules.reshapeLayout(row && row.layout, shape), (id) => joinedIds.has(id));
    return res.json({
      war: { id: war.id, title: war.title, startAt: war.startAt, status: war.status },
      layout: shape,
      rules: { healerClass: defaults.healerClass, tankClass: defaults.tankClass },
      members,
      classes,
      lineup,
      version: row ? row.version : 0,
      updatedBy: row ? row.updatedBy : null,
      canEdit: acc.admin && war.status !== 'done',
      me: { id: req.user.id, name: req.user.name },
      publish: publishState(row),
    });
  });

  api.put('/lineup/:warId', writes(authKey), async (req, res) => {
    const acc = await warAccess(req, res);
    if (!acc) return undefined;
    if (!acc.admin) return res.status(403).json({ error: 'Chỉ quản lý mới được xếp đội.' });
    const body = req.body || {};
    const out = await lineupService.saveLineup({ warId: acc.war.id, guildId: acc.war.guildId, layout: body.layout, expectedVersion: body.version, userId: req.user.id });
    if (out.conflict) {
      const cur = out.current;
      return res.status(409).json({ error: 'Đội hình vừa được người khác sửa.', current: cur && { layout: cur.layout, version: cur.version, updatedBy: cur.updatedBy } });
    }
    if (out.error) return res.status(400).json({ error: out.error });
    return res.json({ version: out.lineup.version, layout: out.lineup.layout });
  });

  api.post('/lineup/:warId/publish', writes(authKey), async (req, res) => {
    const acc = await warAccess(req, res);
    if (!acc) return undefined;
    if (!acc.admin) return res.status(403).json({ error: 'Chỉ quản lý mới được công bố.' });
    const row = await lineupService.requestPublish(acc.war.id, req.user.id, acc.war.guildId);
    if (!row) return res.status(400).json({ error: 'Bang chiến đã kết thúc.' });
    return res.json({ publish: publishState(row) });
  });

  api.use((req, res) => res.status(404).json({ error: 'Không tìm thấy.' }));
  app.use('/api', api);
  app.use(express.static(staticDir));
  // Express 5 forwards async rejections here
  app.use((err, req, res, next) => {
    const status = Number(err && (err.status || err.statusCode));
    if (res.headersSent) return next(err);
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'Yêu cầu không hợp lệ.' }); // body-parser: bad JSON (400), too large (413)
    console.error('[activity] request failed:', err && err.message);
    return res.status(500).json({ error: 'Lỗi máy chủ.' });
  });
  return app;
}

module.exports = { createApp, publishState };
