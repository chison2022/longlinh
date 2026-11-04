// The Activity web server (Express app, no listen here): the lineup board API + the static client. Every /api route except
// /api/config and /api/token needs the Discord user's access token; the war must belong to a guild the user is a member of.
// Not the bot: no discord.js, no canvas. Discord is reached through REST only (discordApi.js, fetch injectable for tests).
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const db = require('../src/sideDb');
const lineupService = require('../src/services/lineupService');
const rules = require('../src/services/lineupRules');
const { chipColor } = require('../src/services/lineupStyle');
const defaults = require('../config/defaults');
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
  const discord = createDiscordApi({ fetchFn, clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET });
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
  // Discord bans an IP that sends many invalid requests: failed token lookups are counted apart (30 / min / IP) and past that we stop asking Discord
  const missMax = limits.miss || 30;
  const misses = new Map(); // ip -> { n, reset }
  const missBlocked = (ip) => {
    const m = misses.get(ip);
    return Boolean(m) && m.reset > Date.now() && m.n >= missMax;
  };
  const noteMiss = (ip) => {
    const now = Date.now();
    if (misses.size > 5000) for (const [k, v] of misses) if (v.reset <= now) misses.delete(k);
    const m = misses.get(ip);
    if (!m || m.reset <= now) misses.set(ip, { n: 1, reset: now + 60 * 1000 });
    else m.n += 1;
  };
  const authKey = (req) => `t:${crypto.createHash('sha256').update(String(req.headers.authorization || req.ip)).digest('hex').slice(0, 16)}`;

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/config', (req, res) => res.json({ clientId: env.CLIENT_ID || null }));

  // Class emoji images. An <img> cannot send the bearer token, so only ids resolved as the class emoji of a guild this server has served
  // are answered (never an open proxy), and by IP rate limit.
  api.get('/emoji/:id', perIp(ipKey), async (req, res) => {
    const id = String(req.params.id);
    if (!SNOWFLAKE.test(id)) return res.status(400).json({ error: 'Mã emoji không hợp lệ.' });
    const known = await db.one('select 1 as ok from act_guilds where classes @> $1::jsonb limit 1', [JSON.stringify([{ emojiId: id }])]);
    if (!known) return res.status(404).json({ error: 'Không tìm thấy.' });
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
    if (missBlocked(req.ip)) return res.status(429).json({ error: 'Quá nhiều lần đăng nhập sai, thử lại sau ít phút.' });
    const user = await discord.userOf(m[1]);
    if (!user) {
      noteMiss(req.ip);
      return res.status(401).json({ error: 'Phiên đăng nhập hết hạn.' });
    }
    req.token = m[1];
    req.user = user;
    return next();
  });
  api.use(general(authKey));

  // -> { member, guild } of a MANAGER, or null (already answered 403 / 404). The guild is the snapshot the bot took: who may edit comes from it.
  async function access(req, res, guildId) {
    const member = await discord.memberOf(req.token, guildId);
    if (!member) {
      res.status(403).json({ error: 'Bạn không ở trong máy chủ này.' });
      return null;
    }
    const guild = await lineupService.getGuild(guildId);
    if (!guild) {
      res.status(404).json({ error: 'Bang chưa có dữ liệu cho bảng xếp đội (bot chưa chốt đăng ký).' });
      return null;
    }
    // the board is for Leaders only: everybody else gets the friendly card from the client (members see the posted image instead)
    if (!isManager({ userId: req.user.id, member, guild })) {
      res.status(403).json({ error: 'Bảng xếp đội chỉ dành cho Leader.', code: 'not_manager' });
      return null;
    }
    return { member, guild };
  }

  // the war of the URL, only when the user is in its guild -> { war, ...access } or null (answered)
  async function warAccess(req, res) {
    const war = await lineupService.getWar(String(req.params.warId || ''));
    if (!war) {
      res.status(404).json({ error: 'Bang chiến không tồn tại.' });
      return null;
    }
    const acc = await access(req, res, war.guildId);
    return acc && { war: { ...war, id: war.warId }, ...acc };
  }

  api.get('/wars', async (req, res) => {
    const guildId = String(req.query.guild || '');
    if (!SNOWFLAKE.test(guildId)) return res.status(400).json({ error: 'Thiếu mã máy chủ.' });
    const acc = await access(req, res, guildId);
    if (!acc) return undefined;
    const wars = (await lineupService.listWars(guildId)).map((w) => ({ id: w.warId, title: w.title, startAt: w.startAt, status: w.status }));
    return res.json({ wars });
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
    const { war, guild } = acc;
    const shape = lineupService.shapeOfGuild(guild);
    const order = (guild.classes || []).map((c) => c.name);
    const classInfo = new Map((guild.classes || []).map((c) => [c.name, c]));
    const colorOf = (className) => chipColor(Math.max(order.findIndex((c) => rules.sameClass(c, className)), 0));
    const toMember = (j) => ({
      id: j.id,
      name: j.name || j.id, // the in-game name when the member is linked to a character, else the Discord name
      discordName: j.discordName,
      linked: j.linked,
      manual: j.manual,
      className: j.className,
      classColor: colorOf(j.className),
      classEmoji: (classInfo.get(j.className) || {}).emojiId || null,
      rolePref: ROLE_LABEL(j.rolePref),
      taskDefault: rules.taskOfWish(j.rolePref), // the member's own wish = the task unless the leader chose another
      createdAt: j.createdAt,
    });
    const members = (await lineupService.listMembers(war.id)).map(toMember);
    const removedMembers = (await lineupService.listMembers(war.id, { removed: true })).map(toMember);
    const seen = [...new Set([...order, ...members.map((m) => m.className)].filter(Boolean))];
    const classes = seen.map((name) => ({ name, tag: (classInfo.get(name) || {}).tag || '', color: colorOf(name), emojiId: (classInfo.get(name) || {}).emojiId || null }));
    const row = await lineupService.getLineup(war.id);
    const joinedIds = new Set(members.map((m) => m.id));
    // fitted to the CURRENT shape (the group count may have changed since it was saved), so what the client sends back is saveable
    const lineup = rules.filterLayout(rules.reshapeLayout(row && row.layout, shape), (id) => joinedIds.has(id));
    // a task belongs to a person on the list (placed or not: a hand-added person may get his task before he is placed)
    const tasks = Object.fromEntries(Object.entries((row && row.tasks) || {}).filter(([k]) => joinedIds.has(k)));
    const partyNotes = rules.validateNotes(row && row.partyNotes, shape).notes;
    const taskList = await lineupService.listTasks(war.guildId);
    return res.json({
      war: { id: war.id, title: war.title, startAt: war.startAt, status: war.status },
      layout: shape,
      rules: lineupService.rulesOfGuild(guild),
      members,
      removedMembers,
      linkGroups: war.linkGroups || [],
      classes,
      lineup,
      tasks,
      partyNotes,
      taskList,
      version: row ? row.version : 0,
      updatedBy: row ? row.updatedBy : null,
      publish: publishState(row),
    });
  });

  api.put('/lineup/:warId', writes(authKey), async (req, res) => {
    const acc = await warAccess(req, res);
    if (!acc) return undefined;
    const body = req.body || {};
    const out = await lineupService.saveLineup({ warId: acc.war.id, guildId: acc.war.guildId, layout: body.layout, expectedVersion: body.version, userId: req.user.id, tasks: body.tasks, partyNotes: body.partyNotes });
    if (out.conflict) {
      const cur = out.current;
      return res.status(409).json({ error: 'Đội hình vừa được người khác sửa.', current: cur && { layout: cur.layout, version: cur.version, updatedBy: cur.updatedBy } });
    }
    if (out.error) return res.status(400).json({ error: out.error });
    return res.json({ version: out.lineup.version, layout: out.lineup.layout, tasks: out.lineup.tasks, partyNotes: out.lineup.partyNotes });
  });

  api.post('/lineup/:warId/publish', writes(authKey), async (req, res) => {
    const acc = await warAccess(req, res);
    if (!acc) return undefined;
    if (acc.war.status === 'open') return res.status(409).json({ error: 'Đăng ký đang mở lại — chờ quản lý chốt lại rồi mới công bố.' });
    const row = await lineupService.requestPublish(acc.war.id, req.user.id, acc.war.guildId);
    if (!row) return res.status(400).json({ error: 'Bang chiến đã kết thúc.' });
    return res.json({ publish: publishState(row) });
  });

  // people: a manager adds somebody by hand, takes somebody off the list, puts them back
  const memberReply = (res, out) => (out.error ? res.status(400).json({ error: out.error }) : res.json({ ok: true, member: out.member || null }));
  const managerOfWar = async (req, res) => {
    const acc = await warAccess(req, res);
    if (!acc) return null;
    return acc;
  };
  api.post('/lineup/:warId/members', writes(authKey), async (req, res) => {
    const acc = await managerOfWar(req, res);
    if (!acc) return undefined;
    const b = req.body || {};
    return memberReply(res, await lineupService.addManualMember({ warId: acc.war.id, guildId: acc.war.guildId, userId: req.user.id, name: b.name, className: b.className, rolePref: b.rolePref, task: b.task }));
  });
  api.delete('/lineup/:warId/members/:key', writes(authKey), async (req, res) => {
    const acc = await managerOfWar(req, res);
    if (!acc) return undefined;
    return memberReply(res, await lineupService.removeMember({ warId: acc.war.id, guildId: acc.war.guildId, userId: req.user.id, key: req.params.key }));
  });
  api.post('/lineup/:warId/members/:key/restore', writes(authKey), async (req, res) => {
    const acc = await managerOfWar(req, res);
    if (!acc) return undefined;
    return memberReply(res, await lineupService.restoreMember({ warId: acc.war.id, guildId: acc.war.guildId, userId: req.user.id, key: req.params.key }));
  });

  // custom tasks of a guild (managers only): POST /tasks {guild, label, emoji}, PUT /tasks/:key {guild, label, emoji}, DELETE /tasks/:key?guild=
  async function managerOf(req, res, guildId) {
    if (!SNOWFLAKE.test(String(guildId || ''))) {
      res.status(400).json({ error: 'Thiếu mã máy chủ.' });
      return null;
    }
    return access(req, res, guildId);
  }
  const taskReply = (res, out) => (out.error ? res.status(400).json({ error: out.error }) : res.json({ taskList: out.tasks, affected: out.affected || 0 }));
  api.post('/tasks', writes(authKey), async (req, res) => {
    const body = req.body || {};
    if (!(await managerOf(req, res, body.guild))) return undefined;
    return taskReply(res, await lineupService.addTask(String(body.guild), body));
  });
  api.put('/tasks/:key', writes(authKey), async (req, res) => {
    const body = req.body || {};
    if (!rules.CUSTOM_KEY.test(req.params.key)) return res.status(404).json({ error: 'Nhiệm vụ không tồn tại.' });
    if (!(await managerOf(req, res, body.guild))) return undefined;
    return taskReply(res, await lineupService.renameTask(String(body.guild), req.params.key, body));
  });
  api.delete('/tasks/:key', writes(authKey), async (req, res) => {
    if (!rules.CUSTOM_KEY.test(req.params.key)) return res.status(404).json({ error: 'Nhiệm vụ không tồn tại.' });
    if (!(await managerOf(req, res, req.query.guild))) return undefined;
    return taskReply(res, await lineupService.deleteTask(String(req.query.guild), req.params.key));
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
