// The new-member gate: /setup view + health checks, the one-button panel, the retired guest path (gate:guest / swguest / tg answer
// "đang tắt"), the member flow (roster picker reuse), the request, the approval card and the two manager buttons, the gateway events and
// the texts. There are no Khách / Chờ duyệt roles: nothing is added on send, nothing but the member / class roles on approve. DB access is stubbed (in-memory request
// store with the same atomic rules); the partial unique index and the atomic transitions on a real MongoDB are in
// test/gameRosterDb.test.js (in-memory PostgreSQL).
const { describe, it, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const gameRoster = require('../src/services/gameRosterService');
const registrationService = require('../src/services/registrationService');
const guildConfigService = require('../src/services/guildConfigService');
const gateService = require('../src/services/gateService');
const eventLog = require('../src/eventLog');
const { assertMessage, assertV2Message, assertModal } = require('./discordLimits');
const { oid, sid } = require('./helpers');

const GUILD = '800000000000000001';
const ADMIN = sid(900);
const USER = sid(5000);
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
const MANAGE_ROLES = new PermissionsBitField(PermissionFlagsBits.ManageRoles);
const NOW = Date.now();
const DAY = 24 * 3600 * 1000;
const snowflakeAt = (ms) => String(BigInt(ms - 1420070400000) << 22n) ; // a Discord id created at `ms`
const NEW_USER = snowflakeAt(NOW - DAY); // a 1-day-old account

// ---------- stubs installed before the handlers are required ----------

let config;
let roster;
let mappings;
let saved;
let reqs;
let uidHeld; // game ID -> { name, left } : a character that holds it (the DB check is stubbed; the format check is the real one)
let uidClaims; // [[name, uid]] the grant gave to a character
let claimResult;
const UID = '12345678';
let uidOwn; // character name key -> the ID it already carries (the chosen character)
let uidReleased; // [[guildId, characterId]] IDs taken back after a failed approval
gameRoster.checkGameUid = async (_g, input, { exceptName = null } = {}) => {
  const c = gameRoster.cleanGameUid(input);
  const h = c.uid && uidHeld.get(c.uid);
  if (h && exceptName && gameRoster.nameKey(h.name) === gameRoster.nameKey(exceptName)) return c; // the chosen character's own ID
  const own = exceptName && uidOwn.get(gameRoster.nameKey(exceptName));
  if (c.uid && own && own !== c.uid) return { error: 'Nhân vật này đã có một ID game khác. Nhập đúng ID của nhân vật, hoặc báo quản lý nếu ID cũ bị nhầm.' };
  return h ? { error: h.left ? `ID này thuộc nhân vật **${h.name}** (đã rời bang) — có thể là cùng người đổi tên: dùng ✏️ Đổi tên.` : `ID game này đang thuộc nhân vật **${h.name}**.` } : c;
};
gameRoster.claimGameUid = async (_g, name, uid) => (uidClaims.push([name, uid]), claimResult);
gameRoster.releaseGameUid = async (g, id) => uidReleased.push([g, id]);
gameRoster.releaseRequestUid = async (g, o) => (uidReleased.push(['revoke', g, o.uid, o.gameName, o.discordId]), o.uid ? o.gameName : null);
guildConfigService.getConfigOrDefault = async () => config;
guildConfigService.getConfig = async () => config;
registrationService.saveMemberClass = async (...a) => {
  if (saved.classError) throw saved.classError;
  return saved.classes.push(a);
};
gameRoster.latest = async () => roster;
gameRoster.loadMappings = async () => mappings;
gameRoster.getLink = async () => null;
gameRoster.setMappings = async (guildId, pairs) => {
  if (saved.mapError) throw saved.mapError;
  saved.mappings.push(pairs);
  return pairs.length;
};
gameRoster.removeMappings = async (guildId, ids) => (saved.unlinked.push([guildId, ids]), ids.length);
const same = (r, g, d) => r.guildId === g && r.discordId === d;
gateService.findPending = async (g, d) => reqs.find((r) => same(r, g, d) && r.status === 'pending') || null;
gateService.getRequest = async (id, guildId) => reqs.find((r) => String(r._id) === String(id) && (r.guildId === undefined || r.guildId === guildId)) || null;
// the cooldown query: a request that ended badly with decidedAt inside the window (the stub `decide` leaves decidedAt unset: no cooldown)
gateService.recentDecision = async (g, d, { now = Date.now(), cooldownMs = gateService.COOLDOWN_MS } = {}) =>
  reqs.find((r) => same(r, g, d) && ['rejected', 'cancelled', 'guest'].includes(r.status) && r.decidedAt && r.decidedAt.getTime() >= now - cooldownMs && ![gateService.CARD_FAILED_REASON, gateService.UID_CLASH_REASON].includes(r.reason)) || null;
guildConfigService.getOrCreateConfig = async () => config;
guildConfigService.updateConfig = async (_g, patch) => (config = { ...config, ...patch });
gateService.createPending = async (data) => {
  const ex = reqs.find((r) => same(r, data.guildId, data.discordId) && r.status === 'pending');
  if (ex) return { request: ex, created: false };
  const r = { _id: oid(reqs.length + 1), ...data, status: 'pending', reason: '' };
  reqs.push(r);
  return { request: r, created: true };
};
// the same atomic rule as the real one: only a pending request moves
gateService.decide = async (id, status, { by = null, reason = '' } = {}) => {
  const r = reqs.find((x) => String(x._id) === String(id));
  if (!r || r.status !== 'pending') return null;
  Object.assign(r, { status, decidedBy: by, reason });
  return { ...r };
};
gateService.decidePendingOf = async (g, d, status, { by = null, reason = '' } = {}) => {
  const r = reqs.find((x) => same(x, g, d) && x.status === 'pending');
  if (!r) return null;
  Object.assign(r, { status, decidedBy: by, reason });
  return { ...r };
};
gateService.reopen = async (id, from) => {
  const r = reqs.find((x) => String(x._id) === String(id) && x.status === from);
  if (!r) return null;
  Object.assign(r, { status: 'pending', decidedBy: null, reason: '' });
  return { ...r };
};
// the real one is a transaction: the ID clash decides nothing, otherwise the claim and the status change go together
gateService.decideWithUid = async (id, status, opts, claim) => {
  let got = null;
  if (claim) {
    got = await gameRoster.claimGameUid(claim.guildId, claim.name, claim.uid);
    if (got.status === 'clash') return { clash: got.text };
  }
  const decided = await gateService.decide(id, status, opts);
  return decided ? { decided, claim: got } : { decided: null };
};
// the same atomic rule as the real one: only an approved request is revoked
gateService.revoke = async (id, { by = null, reason = '' } = {}) => {
  const r = reqs.find((x) => String(x._id) === String(id));
  if (!r || r.status !== 'approved') return null;
  Object.assign(r, { status: 'revoked', decidedBy: by, reason });
  return { ...r };
};
gateService.setCard = async (id, channelId, messageId) => Object.assign(reqs.find((x) => String(x._id) === String(id)), { adminChannelId: channelId, adminMessageId: messageId });

const gate = require('../src/bot/interactions/gate');
const ui = require('../src/bot/ui/gate');
const { buildSetupView } = require('../src/bot/ui/panel');
const { gateHealth } = require('../src/bot/gateRoles');
const { onGateMemberAdd, onGateMemberRemove } = require('../src/bot/gateEvents');
const { postOrUpdateGatePanel } = require('../src/bot/gatePanel');
const { clearMemberCache } = require('../src/bot/memberCache');
const { routeInteraction } = require('../src/bot/interactions/router');
const { NO_PERMISSION } = require('../src/bot/interactions/common');
const { tracked, groupUnregistered } = require('../src/services/rosterService');

// ---------- fakes ----------

const g = (name, extra = {}) => ({ name, rank: 'Bang Chúng', className: 'Thiết Y', daysInGuild: 1, status: '', ...extra });
const makeMappings = (entries = []) => {
  const map = new Map(entries.map(([id, name]) => [id, name]));
  map.sources = new Map(entries.map(([id, , source]) => [id, source || 'admin']));
  return map;
};

let lines;
const events = () => lines.map((l) => JSON.parse(l));
const ev = (name) => events().filter((e) => `${e.area}.${e.ev}` === name);

// A guild with roles (id -> position), the bot below/above them, channels and members. Everything the code does to it is recorded in `rec`.
function world({ botPosition = 10, manageRoles = true, rolePositions = {}, everyoneView = true, everyoneSend = false, members = [], dmFails = [], roleFails = {} } = {}) {
  const rec = { sent: [], roleCalls: [], dms: [], edits: [] };
  const positions = { 'r-member': 2, 'r-guest': 1, 'r-pending': 1, 'r-ty': 3, ...rolePositions };
  const names = { 'r-member': 'Bang Chúng', 'r-guest': 'Khách', 'r-pending': 'Chờ duyệt', 'r-ty': 'Thiết Y' };
  const roles = new Collection();
  for (const [id, position] of Object.entries(positions)) roles.set(id, { id, name: names[id], position, managed: false });
  roles.set('r-bot', { id: 'r-bot', name: 'LongLinh', position: botPosition, managed: true });
  const everyone = { id: GUILD, name: '@everyone', position: 0 };
  roles.set(GUILD, everyone);

  const cache = new Collection();
  const guild = {
    id: GUILD,
    name: 'Bang Thử Nghiệm',
    roles: { cache: roles, everyone },
    members: { cache, fetch: null, me: null },
    channels: { cache: new Collection() },
    get memberCount() {
      return cache.size;
    },
  };
  const mk = (id, name, roleIds = [], opts = {}) => {
    const rc = new Collection(roleIds.map((r) => [r, roles.get(r)]));
    const m = {
      id,
      guild,
      displayName: name,
      joinedAt: opts.joinedAt === undefined ? new Date(NOW - 3600 * 1000) : opts.joinedAt,
      user: { id, username: opts.username || name.toLowerCase(), globalName: null, bot: Boolean(opts.bot) },
      roles: {
        cache: rc,
        add: async (ids, reason) => {
          const list = [].concat(ids);
          rec.roleCalls.push(['add', id, list, reason]);
          if (roleFails.add && list.some((r) => roleFails.add.includes(r))) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
          for (const r of list) rc.set(r, roles.get(r));
        },
        remove: async (ids, reason) => {
          const list = [].concat(ids);
          rec.roleCalls.push(['remove', id, list, reason]);
          if (roleFails.remove && list.some((r) => roleFails.remove.includes(r))) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
          for (const r of list) rc.delete(r);
        },
      },
      send: async (p) => {
        if (dmFails.includes(id)) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
        rec.dms.push([id, p]);
        return {};
      },
    };
    cache.set(id, m);
    return m;
  };
  guild.members.me = {
    id: 'bot',
    user: { id: 'bot', username: 'longlinh', bot: true },
    permissions: manageRoles ? MANAGE_ROLES : NOBODY,
    roles: { cache: new Collection([['r-bot', roles.get('r-bot')]]), highest: { position: botPosition } },
  };
  guild.members.fetch = async (id) => {
    if (id === undefined) return cache;
    const m = cache.get(id);
    if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
    return m;
  };
  for (const [id, name, roleIds, opts] of members) mk(id, name, roleIds, opts);

  const full = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]);
  const everyonePerms = new PermissionsBitField([...(everyoneView ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] : []), ...(everyoneSend ? [PermissionFlagsBits.SendMessages] : [])]);
  const channelOf = (id) => ({
    id,
    guild,
    permissionsFor: (who) => (who === guild.members.me ? full : everyonePerms),
    send: async (p) => {
      rec.sent.push([id, p]);
      return { id: `msg-${rec.sent.length}` };
    },
    messages: {
      fetch: async (mid) => {
        const entry = rec.sent.find((s) => `msg-${rec.sent.indexOf(s) + 1}` === mid);
        return { id: mid, components: entry ? entry[1].components.map((c) => c.toJSON()) : [], edit: async (p) => rec.edits.push([id, mid, p]) };
      },
      edit: async (mid, p) => rec.edits.push([id, mid, p]),
    },
  });
  for (const id of ['c-gate', 'c-admin', 'c-war', 'c-gn', 'c-mail', 'c-ev']) guild.channels.cache.set(id, channelOf(id));
  const client = { channels: { fetch: async (id) => guild.channels.cache.get(id) }, guilds: { cache: new Map() } };
  guild.client = client;
  return { guild, client, rec, mk, roles };
}

function interactionOf(w, { user = USER, name = 'Beta Boss', roleIds = [], admin = false, values, fields, message, customId, fromMessage = true } = {}) {
  const log = [];
  const member = w.guild.members.cache.get(user) || w.mk(user, name, roleIds);
  const i = {
    guildId: GUILD,
    guild: w.guild,
    client: w.client,
    customId,
    user: member.user,
    member,
    memberPermissions: admin ? MANAGE : NOBODY,
    values,
    fields: { getTextInputValue: (k) => (fields || {})[k] ?? (k === 'uid' ? UID : '') }, // the send form's ID is filled unless a test says otherwise
    message,
    deferReply: async (o) => log.push(['deferReply', o]),
    deferUpdate: async () => log.push(['deferUpdate']),
    editReply: async (o) => log.push(['editReply', o]),
    followUp: async (o) => log.push(['followUp', o]),
    reply: async (o) => log.push(['reply', o]),
    showModal: async (m) => log.push(['showModal', m]),
    isFromMessage: () => fromMessage,
  };
  return { i, log, member };
}
const last = (log, kind = 'editReply') => log.filter((l) => l[0] === kind).pop()[1];
const jsonRows = (view) => view.components.map((r) => r.toJSON());
const optionsOf = (view) => jsonRows(view)[0].components[0].options;
const textOf = (payload) => assertV2Message(payload, { forCreate: !('embeds' in payload) }).text;
const cardMessageOf = (sentPayload) => ({ components: sentPayload.components.map((c) => c.toJSON()) });
const VER = '00000099';

beforeEach(() => {
  config = {
    ...guildConfigService.defaultConfig(GUILD),
    gateEnabled: true,
    memberRoleId: 'r-member',
    gateChannelId: 'c-gate',
    adminChannelId: 'c-admin',
    announceChannelId: 'c-war',
    gnChannelId: 'c-gn',
    mailChannelId: 'c-mail',
    eventChannelId: 'c-ev',
    gateAutoApprove: false, // the manual path; the auto-approval has its own describe
  };
  roster = { _id: oid(99), members: [g('Alpha', { rank: 'Trưởng Lão', className: 'Tố Vấn' }), g('Beta Boss'), g('Gamma'), g('Delta')] };
  mappings = makeMappings();
  saved = { classes: [], mappings: [], mapError: null, unlinked: [] };
  reqs = [];
  uidHeld = new Map();
  uidClaims = [];
  claimResult = { status: 'set', characterId: 7, created: false };
  uidReleased = [];
  uidOwn = new Map();
  lines = [];
  gateService.resetRequestLimits();
  eventLog.setSink((l) => lines.push(l));
  clearMemberCache();
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
after(() => {
  eventLog.setSink(null);
  require('../src/bot/sheetSync').cancelScheduled();
  require('../src/bot/refresher').cancelScheduled();
});

// A request that went through the member flow, with its card posted. -> { w, applicant, card, request }
async function sendRequest({ w = world({ members: [[ADMIN, 'Quản Lý', []]] }), user = USER, name = 'Beta Boss', pick = '1', classIndex = 0 } = {}) {
  const a = interactionOf(w, { user, name });
  await gate.handle(a.i, ['gate', 'member']);
  const p = interactionOf(w, { user, name, fields: { name: roster.members[Number(pick)].name } });
  await gate.handle(p.i, ['gate', 'freeModal']);
  const s = interactionOf(w, { user, name });
  await gate.handle(s.i, ['gate', 'sendModal', `r${pick}-${VER}`, String(classIndex)]);
  const cardEntry = w.rec.sent.filter((x) => x[0] === 'c-admin').pop();
  return { w, applicant: a, request: reqs[reqs.length - 1], card: cardEntry && cardEntry[1], sendLog: s.log };
}

// ---------- config + texts ----------

describe('config defaults and the welcome texts', () => {
  it('a guild without a config has the gate off and nothing chosen', () => {
    const d = guildConfigService.defaultConfig(GUILD);
    assert.equal(d.gateEnabled, false);
    for (const k of ['gateChannelId', 'gatePanelMessageId', 'gateAdminChannelId', 'guestRoleId', 'pendingRoleId', 'gateGuildName', 'gateWelcomeMember', 'gateWelcomeGuest']) assert.equal(d[k], null, k);
  });
  it('a config write bounds the welcome texts (4000 / 2000) and the guild name (60)', () => {
    const { invalidPatch } = guildConfigService;
    assert.equal(invalidPatch({ gateWelcomeMember: 'x'.repeat(4001) }), 'gateWelcomeMember');
    assert.equal(invalidPatch({ gateWelcomeGuest: 'x'.repeat(2001) }), 'gateWelcomeGuest');
    assert.equal(invalidPatch({ gateGuildName: 'x'.repeat(61) }), 'gateGuildName');
    assert.equal(invalidPatch({ gateWelcomeMember: 'x'.repeat(4000), gateWelcomeGuest: 'x'.repeat(2000), gateGuildName: null }), null);
  });
  it('the default member text links the war, name-link, mailbox and event channels that are configured - and only those', () => {
    const text = gateService.defaultWelcomeMember(config, { name: 'Bang Thử Nghiệm' });
    assert.match(text, /Bang Thử Nghiệm/);
    for (const id of ['c-war', 'c-gn', 'c-mail', 'c-ev']) assert.ok(text.includes(`<#${id}>`), id);
    assert.match(text, /bang chiến|Đăng ký/);
    const bare = gateService.defaultWelcomeMember({ ...config, announceChannelId: null, mailChannelId: null, eventChannelId: null }, { name: 'X' });
    assert.ok(bare.includes('<#c-gn>') && !bare.includes('<#c-war>') && !bare.includes('<#c-mail>') && !bare.includes('<#c-ev>'));
    assert.ok(!/<#/.test(gateService.defaultWelcomeMember({ ...guildConfigService.defaultConfig(GUILD) }, { name: 'X' })));
  });
  it('the war line uses the guild schedule (not a hard-coded day); no schedule = no time', () => {
    assert.match(gateService.defaultWelcomeMember({ ...config, schedule: { warDay: 0, warTime: '20:00' } }, { name: 'X' }), /bang chiến \(CN 20:00\) ở <#c-war>/);
    assert.match(gateService.defaultWelcomeMember({ ...config, schedule: undefined }, { name: 'X' }), /bang chiến ở <#c-war>/);
    assert.ok(!/T7 20-21h/.test(gateService.defaultWelcomeMember({ ...config, schedule: { warDay: 0, warTime: '20:00' } }, { name: 'X' })));
  });
  it('a custom text wins; blank falls back to the default; there is no guest text any more', () => {
    assert.equal(gateService.welcomeMemberText({ ...config, gateWelcomeMember: 'Chào!' }, { name: 'X' }), 'Chào!');
    assert.match(gateService.welcomeMemberText({ ...config, gateWelcomeMember: '   ' }, { name: 'X' }), /Chào mừng/);
    assert.equal(gateService.welcomeGuestText, undefined);
    assert.equal(gateService.defaultWelcomeGuest, undefined);
    assert.equal(gateService.MAX_WELCOME_GUEST, undefined);
  });
  it('chunkText keeps every part within a DM (2000)', () => {
    const parts = gateService.chunkText(`${'a'.repeat(1500)}\n${'b'.repeat(1500)}\n${'c'.repeat(900)}`);
    assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 2000));
    assert.equal(parts.join('').replace(/\n/g, '').length, 3900);
  });
});

// ---------- /setup ----------

describe('the /setup 🚪 Cổng vào sub-view and its health checks', () => {
  const guildFor = (opts) => world(opts).guild;

  it('the 🚪 button lives in ⚙️ Nâng cao (only while the gate is on); the main view adds "Chuyển bài" next to its three buttons', () => {
    const adv = (cfg) => buildSetupView(cfg, null, { view: 'adv' }).components[0].toJSON().components.map((c) => c.custom_id);
    assert.ok(adv({ ...config, features: { gate: true } }).includes('setup:gateview'));
    assert.ok(!adv({ ...config, features: { gate: false }, gateEnabled: true }).includes('setup:gateview'), 'the stored toggle wins over the legacy gateEnabled');
    assert.ok(adv({ ...config, gateEnabled: true }).includes('setup:gateview'), 'no stored toggle: gateEnabled still counts');
    const moving = buildSetupView(config, null, { moveEvent: { _id: oid(5), title: 'T', channelId: 'c-war' } }).components.at(-1).toJSON().components.map((c) => c.custom_id);
    assert.deepEqual(moving, ['setup:postall', 'setup:featview', 'setup:advview', `adm:move:${oid(5)}`]);
  });
  it('shows the gate channel + approval channel + Người lạ + Khách role selects, ✏️ Lời chào, toggle, post, back (no Chờ duyệt select); passes the Discord limits', () => {
    const guild = guildFor({});
    const v = buildSetupView(config, null, { view: 'gate', guild, health: gateHealth(config, guild) });
    const { rows } = assertMessage(v);
    assert.deepEqual(rows.map((r) => r.components.map((c) => c.custom_id)), [['setup:gatechan'], ['setup:gateadmin'], ['setup:gatestranger'], ['setup:gateguestrole'], ['setup:gatewelcome', 'setup:gateauto', 'setup:gatetoggle', 'setup:gatepost', 'setup:main']]);
    assert.ok(!JSON.stringify(rows).includes('"setup:gateguest"') && !JSON.stringify(rows).includes('gatepending'), 'the retired selects stay retired');
    const guestRow = rows[3].components[0];
    assert.deepEqual([guestRow.min_values, guestRow.max_values, guestRow.placeholder], [0, 1, 'Role khách (người bấm 🤝 Khách tự nhận) — để trống = không có nút Khách']);
    assert.match(v.content, /🟢 Cổng đang \*\*BẬT\*\*/);
    assert.match(v.content, /Ẩn các kênh khác với @everyone \(chỉ kênh welcome cho xem\); role thành viên xem các kênh còn lại\./);
    assert.ok(!/Chờ duyệt/.test(v.content), 'no pending text');
    assert.match(v.content, /🤝 Nút Khách: \*\*TẮT\*\*/);
    const legacy = buildSetupView({ ...config, pendingRoleId: 'r-pending', gateWelcomeGuest: 'x' }, null, { view: 'gate', guild, health: gateHealth(config, guild) });
    assert.equal(legacy.content, v.content, 'the unused legacy fields change nothing');
    const withGuest = buildSetupView({ ...config, guestRoleId: 'r-guest' }, null, { view: 'gate', guild, health: gateHealth({ ...config, guestRoleId: 'r-guest' }, guild) });
    assert.match(withGuest.content, /🤝 Nút Khách: \*\*BẬT\*\* .*<@&r-guest>/);
    assert.match(withGuest.content, /Role \*\*Khách\*\*: <@&r-guest>/);
    assert.deepEqual(assertMessage(withGuest).rows[3].components[0].default_values, [{ id: 'r-guest', type: 'role' }]);
    const off = buildSetupView({ ...config, gateEnabled: false, gateChannelId: null }, null, { view: 'gate', guild });
    const offRows = assertMessage(off).rows;
    assert.equal(offRows[4].components[2].label, '▶ Bật cổng');
    assert.equal(offRows[4].components[3].disabled, true, 'nothing to post without a gate channel');
    assert.match(off.content, /⚪ Cổng đang \*\*TẮT\*\*/);
  });
  it('the admin-channel select falls back to the admin channel and says so', () => {
    const v = buildSetupView(config, null, { view: 'gate', guild: guildFor({}) });
    assert.match(v.content, /Kênh nhận yêu cầu: <#c-admin> \(= kênh admin\)/);
    assert.match(buildSetupView({ ...config, gateAdminChannelId: 'c-war' }, null, { view: 'gate', guild: guildFor({}) }).content, /Kênh nhận yêu cầu: <#c-war>(?! \()/);
  });
  it('healthy setup: no warning except the reminder', () => {
    const health = gateHealth(config, guildFor({}));
    assert.deepEqual(health.filter((h) => !h.ok), []);
    assert.ok(health.some((h) => /Quản lý vai trò/.test(h.text) && h.ok));
  });
  it('warns when the bot lacks Manage Roles', () => {
    const health = gateHealth(config, guildFor({ manageRoles: false }));
    assert.ok(health.some((h) => !h.ok && /Quản lý vai trò/.test(h.text)));
  });
  it('warns for each role the bot cannot manage: the member role and a class role (bot top role must be ABOVE them)', () => {
    const health = gateHealth(config, guildFor({ botPosition: 2, rolePositions: { 'r-member': 5, 'r-ty': 3 } }));
    const bad = health.filter((h) => !h.ok).map((h) => h.text);
    assert.equal(bad.length, 2, bad.join('\n'));
    assert.ok(bad.some((t) => t.includes('<@&r-member>') && /DƯỚI/.test(t)));
    assert.ok(bad.some((t) => t.includes('<@&r-ty>') && /Thiết Y/.test(t)), 'the class role named like the class');
    const equal = gateHealth(config, guildFor({ botPosition: 2, rolePositions: { 'r-member': 2, 'r-ty': 1 } })).filter((h) => !h.ok);
    assert.equal(equal.length, 1, 'equal position is not above');
  });
  it('warns when the member role is not set / was deleted; no line asks for a role, the Chờ duyệt one is never checked, a guest role is checked like the others', () => {
    assert.ok(gateHealth({ ...config, memberRoleId: null }, guildFor({})).some((h) => !h.ok && /role thành viên/.test(h.text)));
    assert.ok(gateHealth({ ...config, memberRoleId: 'r-gone' }, guildFor({})).some((h) => !h.ok && /không còn trong server/.test(h.text)));
    const text = (cfg) => gateHealth(cfg, guildFor({})).map((h) => h.text).join('\n');
    assert.ok(!/Khách|Chờ duyệt/.test(text(config)));
    const legacy = { ...config, pendingRoleId: 'r-member' };
    assert.equal(text(legacy), text(config), 'a duplicate legacy role raises nothing');
    assert.deepEqual(gateHealth(legacy, guildFor({})).filter((h) => !h.ok), []);
    const warn = (cfg, opts = {}) => gateHealth(cfg, guildFor(opts)).filter((h) => !h.ok).map((h) => h.text).join('\n');
    assert.match(warn({ ...config, guestRoleId: 'r-gone' }), /Role \*\*Khách\*\* <@&r-gone>: role không còn trong server/);
    assert.match(warn({ ...config, guestRoleId: 'r-member' }), /Role \*\*Khách\*\*.*trùng role Thành viên/);
    assert.match(warn({ ...config, guestRoleId: 'r-guest' }, { botPosition: 1 }), /Role \*\*Khách\*\*.*DƯỚI/);
    assert.match(warn({ ...config, guestRoleId: GUILD }), /Role \*\*Khách\*\*.*@everyone/);
    assert.match(warn({ ...config, guestRoleId: 'r-ty', adminRoleIds: ['r-ty'] }), /Role \*\*Khách\*\*.*role quản lý/);
    assert.equal(warn({ ...config, guestRoleId: 'r-guest' }), '');
  });
  it('warns when @everyone cannot view the gate channel (and when it can send there)', () => {
    const hidden = gateHealth(config, guildFor({ everyoneView: false }));
    assert.ok(hidden.some((h) => !h.ok && /@everyone \*\*không xem được\*\*/.test(h.text)));
    const chatty = gateHealth(config, guildFor({ everyoneSend: true }));
    assert.ok(chatty.some((h) => !h.ok && /gửi được tin/.test(h.text)));
    assert.ok(gateHealth(config, guildFor({})).some((h) => h.ok && /@everyone xem được/.test(h.text)));
  });
  it('the handler renders the view with the live checks, toggles the gate and saves the channels (the old role selects save nothing)', async () => {
    const writes = [];
    guildConfigService.updateConfig = async (id, patch) => {
      writes.push(patch);
      config = { ...config, ...patch };
      return config;
    };
    guildConfigService.getOrCreateConfig = async () => config;
    const w = world({ botPosition: 1 });
    // handlers destructure getOrCreateConfig/updateConfig at require time: drive them through a fresh load
    delete require.cache[require.resolve('../src/bot/interactions/setup')];
    const fresh = require('../src/bot/interactions/setup');
    const runFresh = async (id, values) => {
      const { i, log } = interactionOf(w, { user: ADMIN, admin: true, values });
      await fresh.handle(i, ['setup', id]);
      return last(log);
    };
    const view = await runFresh('gateview');
    assert.match(view.content, /DƯỚI/, 'hierarchy warnings come from the real guild');
    await runFresh('gatetoggle');
    const toggled = writes.pop(); // features.gate is the source of truth; gateEnabled is kept in step
    assert.equal(toggled.gateEnabled, false);
    assert.equal(toggled.features.gate, false);
    const writesBefore = writes.length;
    await runFresh('gateguest', ['r-guest']); // old /setup messages: the role selects are gone, nothing is saved
    await runFresh('gatepending', ['r-pending']);
    assert.equal(writes.length, writesBefore);
    await runFresh('gatechan', ['c-gate']);
    assert.deepEqual(writes.pop(), { gateChannelId: 'c-gate' });
    config.adminRoleIds = [];
    await runFresh('gateadmin', ['c-war']);
    assert.deepEqual(writes.pop(), { gateAdminChannelId: 'c-war' });
  });
  it('only managers: a member pressing a gate setup control gets the no-permission message and nothing is saved', async () => {
    const writes = [];
    guildConfigService.updateConfig = async (id, patch) => writes.push(patch);
    guildConfigService.getOrCreateConfig = async () => config;
    delete require.cache[require.resolve('../src/bot/interactions/setup')];
    const fresh = require('../src/bot/interactions/setup');
    const w = world();
    const { i, log } = interactionOf(w, { admin: false, values: ['x'] });
    await fresh.handle(i, ['setup', 'gatechan']);
    assert.deepEqual(writes, []);
    assert.equal(last(log, 'followUp').content, NO_PERMISSION);
    const m = interactionOf(w, { admin: false });
    await fresh.handle(m.i, ['setup', 'gatewelcome']);
    assert.equal(last(m.log, 'reply').content, NO_PERMISSION);
    assert.ok(!m.log.some((l) => l[0] === 'showModal'));
  });
  it('✏️ Lời chào opens a modal with the guild name and the member welcome only (prefilled with the effective text); saving the default stores null', async () => {
    const writes = [];
    guildConfigService.updateConfig = async (id, patch) => (writes.push(patch), (config = { ...config, ...patch }));
    guildConfigService.getOrCreateConfig = async () => config;
    delete require.cache[require.resolve('../src/bot/interactions/setup')];
    const fresh = require('../src/bot/interactions/setup');
    const w = world();
    const open = interactionOf(w, { user: ADMIN, admin: true });
    await fresh.handle(open.i, ['setup', 'gatewelcome']);
    const modal = assertModal(open.log.find((l) => l[0] === 'showModal')[1]);
    assert.deepEqual(modal.components.map((c) => [c.component.custom_id, c.component.style]), [['guildName', 1], ['member', 2]]);
    assert.ok(modal.components[1].component.value.includes('<#c-war>'), 'the default text is shown for editing');
    // submit the untouched default + a custom guild name
    const { buildWelcomeModal } = require('../src/bot/ui/gateSetup');
    const fields = Object.fromEntries(buildWelcomeModal(config, w.guild).toJSON().components.map((c) => [c.component.custom_id, c.component.value || '']));
    fields.guildName = 'Bang Thử';
    const submit = interactionOf(w, { user: ADMIN, admin: true, fields });
    await fresh.handle(submit.i, ['setup', 'gatewelcomeModal']);
    assert.deepEqual(writes.pop(), { gateGuildName: 'Bang Thử', gateWelcomeMember: null });
  });
});

// ---------- the panel ----------

describe('the gate panel', () => {
  it('greets with the server name, has ONE button (no Khách) and the approval hint, and passes the V2 limits', () => {
    const payload = ui.buildGatePanel({ guildName: 'Bang Thử Nghiệm' });
    const v2 = assertV2Message(payload);
    assert.match(v2.text, /### 👋 Chào mừng đến Bang Thử Nghiệm!\nBấm nút bên dưới để xin vào bang\./);
    assert.match(v2.text, /-# Nhập đúng tên nhân vật của bạn: tên có trong danh sách game là vào bang ngay/, "auto-approval on by default");
    assert.match(textOf(ui.buildGatePanel({ guildName: "X", autoApprove: false })), /-# Thành viên bang cần quản lý duyệt trước khi thấy các kênh của bang./);
    assert.ok(!/Khách|ghé chơi/.test(v2.text));
    assert.deepEqual(v2.buttons.map((b) => [b.custom_id, b.label]), [['gate:member', '⚔️ Thành viên bang Bang Thử Nghiệm']]);
    assertV2Message(require('../src/bot/ui/common').v2Create(payload), { forCreate: true });
  });
  it('postOrUpdateGatePanel uses gateGuildName when set, else the server name; posts, edits in place, re-posts when deleted', async () => {
    const w = world();
    const stored = [];
    guildConfigService.updateConfig = async (id, patch) => stored.push(patch);
    delete require.cache[require.resolve('../src/bot/gatePanel')];
    const { postOrUpdateGatePanel: post } = require('../src/bot/gatePanel');
    let res = await post(w.client, { ...config, gateGuildName: 'Long Pan' });
    assert.equal(res.action, 'posted');
    assert.match(textOf(w.rec.sent[0][1]), /Chào mừng đến Long Pan/);
    assert.match(assertV2Message(w.rec.sent[0][1], { forCreate: true }).buttons[0].label, /Thành viên bang Long Pan/);
    res = await post(w.client, { ...config, gatePanelChannelId: 'c-gate', gatePanelMessageId: 'msg-1' });
    assert.equal(res.action, 'edited');
    assert.match(textOf(w.rec.edits[0][2]), /Chào mừng đến Bang Thử Nghiệm/);
    w.guild.channels.cache.get('c-gate').messages.edit = async () => {
      throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    };
    res = await post(w.client, { ...config, gatePanelChannelId: 'c-gate', gatePanelMessageId: 'msg-1' });
    assert.equal(res.action, 'posted');
    assert.ok(typeof postOrUpdateGatePanel === 'function');
  });
});

// ---------- the retired guest path ----------

describe('gate:guest / gate:swguest / gate:tg: the guest path is gone', () => {
  const GONE = /Lối vào Khách đang tắt/;
  it('gate:guest answers ephemerally that it is off, changes no role, even with a legacy guest role configured', async () => {
    config.guestRoleId = 'r-guest';
    config.gateWelcomeGuest = 'Hi khách';
    const w = world();
    const { i, log, member } = interactionOf(w);
    await gate.handle(i, ['gate', 'guest']);
    assert.equal(log[0][0], 'deferReply');
    assert.equal(log[0][1].flags, 64);
    assert.match(last(log).content, GONE);
    assert.ok(!last(log).content.includes('Hi khách'));
    assert.deepEqual(w.rec.roleCalls, []);
    assert.ok(!member.roles.cache.has('r-guest'));
    assert.deepEqual(ev('gate.guest'), []);
  });
  it('gate:swguest of an old "pending" notice answers the same, cancels nothing and touches no role', async () => {
    const { w } = await sendRequest();
    const before = w.rec.roleCalls.length;
    const { i, log } = interactionOf(w);
    await gate.handle(i, ['gate', 'swguest']);
    assert.equal(log[0][0], 'deferUpdate');
    assert.match(last(log).content, GONE);
    assert.equal(reqs[0].status, 'pending');
    assert.equal(w.rec.roleCalls.length, before);
    assert.deepEqual(w.rec.edits, []);
  });
  it('the pending notice has no "Chuyển sang Khách" button any more', async () => {
    const { w } = await sendRequest();
    const { i, log } = interactionOf(w);
    await gate.handle(i, ['gate', 'member']);
    const notice = last(log);
    assert.match(notice.content, /chờ quản lý duyệt/);
    assert.deepEqual(notice.components, []);
    assert.ok(!/Khách/.test(notice.content));
  });
  it('gate:tg on an old approval card: a manager is told it is no longer available; the request stays pending, no role changes', async () => {
    const { w, request, card } = await sendRequest();
    const before = w.rec.roleCalls.length;
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'tg', String(request._id)]);
    assert.match(last(log, 'reply').content, /không còn dùng nữa/);
    assert.equal(last(log, 'reply').flags, 64);
    assert.equal(reqs[0].status, 'pending');
    assert.equal(w.rec.roleCalls.length, before);
    assert.ok(!log.some((l) => l[0] === 'deferUpdate'));
  });
  it('through the router the three ids answer too (gate on)', async () => {
    const w = world();
    for (const [customId, kind] of [['gate:guest', 'deferReply'], ['gate:swguest', 'deferUpdate']]) {
      const { i, log } = interactionOf(w, { customId });
      Object.assign(i, { inGuild: () => true, isChatInputCommand: () => false, isMessageComponent: () => true, isModalSubmit: () => false, isButton: () => true });
      await routeInteraction(i);
      assert.equal(log[0][0], kind, customId);
      assert.match(last(log).content, /đang tắt/, customId);
    }
    assert.deepEqual(w.rec.roleCalls, []);
  });
});

// ---------- member flow ----------

describe('gate:member', () => {
  it('opens an ephemeral step with ONE button that opens the name form: no list of names to pick from, whatever the roster', async () => {
    const w = world();
    const { i, log } = interactionOf(w);
    await gate.handle(i, ['gate', 'member']);
    assert.equal(log[0][1].flags, 64);
    const v = last(log);
    assertMessage(v);
    assert.match(v.content, /\(1\/3\): nhập tên nhân vật trong game/);
    assert.deepEqual(jsonRows(v).map((r) => r.components.map((c) => [c.custom_id, c.label])), [[['gate:free', '⌨️ Nhập tên nhân vật']]]);
    assert.ok(!JSON.stringify(jsonRows(v)).includes('Beta Boss'), 'no roster name is shown');
    roster = null;
    const none = interactionOf(w);
    await gate.handle(none.i, ['gate', 'member']);
    assert.deepEqual(jsonRows(last(none.log)).map((r) => r.components.map((c) => c.custom_id)), [['gate:free']]);
  });
  it('the list of an older message (gate:p / gate:pick) answers with the name step: nothing can be picked any more', async () => {
    const w = world();
    for (const parts of [['gate', 'pick', '0', VER], ['gate', 'p', '1', VER]]) {
      const { i, log } = interactionOf(w, { values: ['1'] });
      await gate.handle(i, parts);
      const v = last(log);
      assert.match(v.content, /Danh sách chọn tên đã bỏ/);
      assert.deepEqual(jsonRows(v).map((r) => r.components.map((c) => c.custom_id)), [['gate:free']]);
    }
    assert.equal(reqs.length, 0);
  });
  it('a typed name somebody holds is refused with the gn wording and no class step follows', async () => {
    const w = world();
    mappings = makeMappings([[sid(8), 'Delta', 'admin']]);
    const { i, log } = interactionOf(w, { fields: { name: 'Delta' } });
    await gate.handle(i, ['gate', 'freeModal']);
    const v = last(log);
    assert.match(v.content, new RegExp(gameRoster.TAKEN_ADMIN_MSG));
    assert.equal(jsonRows(v)[0].components[0].custom_id, 'gate:free', 'back on the name step');
    mappings = makeMappings([[sid(8), 'Delta', 'self']]);
    const self = interactionOf(w, { fields: { name: 'delta' } });
    await gate.handle(self.i, ['gate', 'freeModal']);
    assert.match(last(self.log).content, new RegExp(gameRoster.TAKEN_SELF_MSG));
    assert.deepEqual(ev('gate.name_refused').map((e) => e.reason), ['admin', 'self']);
  });
  it('a roster that changed since the summary was drawn: asks to type the name again', async () => {
    const w = world();
    const { i, log } = interactionOf(w, { values: ['1'] });
    await gate.handle(i, ['gate', 'cls', 'r1-deadbeef']);
    assert.match(last(log).content, /Danh sách game vừa được cập nhật — nhập lại tên nhân vật/);
    assert.equal(jsonRows(last(log))[0].components[0].custom_id, 'gate:free');
  });
  it('picking a free name goes through the same checks: a name held by somebody (any spelling) is refused, a typed roster name is that character, a new one is "tự nhập"', async () => {
    const w = world();
    mappings = makeMappings([[sid(8), 'Quỷ Vương', 'selfFree']]);
    const taken = interactionOf(w, { fields: { name: 'quy vuong' } });
    await gate.handle(taken.i, ['gate', 'freeModal']);
    assert.match(last(taken.log).content, new RegExp(gameRoster.TAKEN_SELF_MSG));
    const bad = interactionOf(w, { fields: { name: '😀😀' } });
    await gate.handle(bad.i, ['gate', 'freeModal']);
    assert.match(last(bad.log).content, /⚠️/);
    const inRoster = interactionOf(w, { fields: { name: 'ALPHA' } });
    await gate.handle(inRoster.i, ['gate', 'freeModal']);
    assert.equal(jsonRows(last(inRoster.log))[0].components[0].custom_id, `gate:send:r0-${VER}:1`, 'the roster entry (its class Tố Vấn known), not a free name');
    const fresh = interactionOf(w, { fields: { name: 'Tên Lạ' } });
    await gate.handle(fresh.i, ['gate', 'freeModal']);
    const v = last(fresh.log);
    assert.equal(jsonRows(v)[0].components[0].custom_id, 'gate:cls:f-Tên Lạ');
    assert.match(v.content, /tự nhập/);
    const open = interactionOf(w);
    await gate.handle(open.i, ['gate', 'free']);
    assertModal(open.log[0][1]);
    assert.equal(open.log[0][1].toJSON().custom_id, 'gate:freeModal');
  });
  it('a typed roster character whose class is known skips step 2: the summary shows that class with 🎭 Đổi phái; an unknown class still asks', async () => {
    const w = world();
    const pick = interactionOf(w, { fields: { name: 'beta boss' } }); // Beta Boss, Thiết Y in the roster
    await gate.handle(pick.i, ['gate', 'freeModal']);
    const summary = last(pick.log);
    assertMessage(summary);
    assert.match(summary.content, /Thiết Y \(theo danh sách game/);
    assert.deepEqual(jsonRows(summary)[0].components.map((c) => c.custom_id), [`gate:send:r1-${VER}:0`, `gate:chc:r1-${VER}`, 'gate:back']);
    roster.members[2] = g('Gamma', { className: 'Phái Lạ' });
    const unknown = interactionOf(w, { fields: { name: 'Gamma' } });
    await gate.handle(unknown.i, ['gate', 'freeModal']);
    assert.equal(jsonRows(last(unknown.log))[0].components[0].custom_id, `gate:cls:r2-${VER}`, 'class not in config.classes -> step 2');
  });
  it('step 2 (via 🎭 Đổi phái) lists config.classes (with their emoji), step 3 summarises and offers 📨 Gửi yêu cầu', async () => {
    const w = world();
    const pick = interactionOf(w);
    await gate.handle(pick.i, ['gate', 'chc', `r1-${VER}`]);
    const step2 = last(pick.log);
    assertMessage(step2);
    const select = jsonRows(step2)[0].components[0];
    assert.equal(select.custom_id, `gate:cls:r1-${VER}`);
    assert.equal(select.options.length, config.classes.length);
    assert.ok(select.options.every((o) => o.emoji && o.emoji.name), 'class emojis');
    assert.deepEqual(select.options.map((o) => o.label).slice(0, 2), ['Thiết Y', 'Tố Vấn']);
    const cls = interactionOf(w, { values: ['1'] });
    await gate.handle(cls.i, ['gate', 'cls', `r1-${VER}`]);
    const step3 = last(cls.log);
    assertMessage(step3);
    assert.match(step3.content, /Beta Boss/);
    assert.match(step3.content, /Tố Vấn/);
    assert.deepEqual(jsonRows(step3)[0].components.map((c) => c.custom_id), [`gate:send:r1-${VER}:1`, 'gate:back']);
  });
  it('send: saves ONE pending request, adds NO role (even with a legacy pending role configured), posts a card in the admin channel and confirms', async () => {
    config.pendingRoleId = 'r-pending'; // legacy field: never read
    const { w, request, card, sendLog } = await sendRequest({ classIndex: 1 });
    assert.equal(reqs.length, 1);
    assert.deepEqual({ ...request, _id: undefined }, { _id: undefined, guildId: GUILD, discordId: USER, displayName: 'Beta Boss', gameName: 'Beta Boss', gameNameFree: false, className: 'Tố Vấn', gameUid: UID, adminChannelId: 'c-admin', status: 'pending', reason: '', adminMessageId: 'msg-1' });
    assert.deepEqual(w.rec.roleCalls, [], 'no role is added or removed on send');
    assert.ok(card);
    assert.ok(!last(sendLog).content.includes('Chờ duyệt'));
    assert.match(last(sendLog).content, /Đã gửi yêu cầu/);
    const [ev1] = ev('gate.request');
    assert.deepEqual([ev1.gameInRoster, ev1.free, ev1.user], [true, false, USER]);
  });
  it('a second send (parallel or repeated click) shows the pending status and posts no second card', async () => {
    const { w } = await sendRequest();
    const again = interactionOf(w);
    await gate.handle(again.i, ['gate', 'sendModal', `r1-${VER}`, '0']);
    assert.match(last(again.log).content, /đang \*\*chờ quản lý duyệt\*\*/);
    assert.equal(reqs.length, 1);
    assert.equal(w.rec.sent.filter((s) => s[0] === 'c-admin').length, 1);
    const reopen = interactionOf(w);
    await gate.handle(reopen.i, ['gate', 'member']);
    assert.match(last(reopen.log).content, /chờ quản lý duyệt/);
    // truly parallel clicks: one wins
    const w2 = world();
    const run = () => gate.handle(interactionOf(w2).i, ['gate', 'sendModal', `r1-${VER}`, '0']);
    await Promise.all([run(), run()]);
    assert.equal(reqs.filter((r) => r.status === 'pending' && r.discordId === USER).length, 1);
  });
  it('a name taken between picking and sending is refused at send', async () => {
    const w = world();
    mappings = makeMappings([[sid(8), 'Beta Boss', 'self']]);
    const { i, log } = interactionOf(w);
    await gate.handle(i, ['gate', 'sendModal', `r1-${VER}`, '0']);
    assert.match(last(log).content, new RegExp(gameRoster.TAKEN_SELF_MSG));
    assert.equal(reqs.length, 0);
    assert.deepEqual(w.rec.sent, []);
  });
  it('no approval channel at all: nothing is saved and the member is told to ask a manager', async () => {
    config.adminChannelId = null;
    const w = world();
    const { i, log } = interactionOf(w);
    await gate.handle(i, ['gate', 'sendModal', `r1-${VER}`, '0']);
    assert.match(last(log).content, /chưa chọn kênh nhận yêu cầu/);
    assert.equal(reqs.length, 0);
  });
  it('the card goes to gateAdminChannelId when it is set', async () => {
    config.gateAdminChannelId = 'c-war';
    const { w } = await sendRequest();
    assert.equal(w.rec.sent[0][0], 'c-war');
    assert.equal(reqs[0].adminChannelId, 'c-war');
  });
  it('a card that cannot be posted: the request is cancelled, no role is touched, the member is told', async () => {
    const w = world();
    w.guild.channels.cache.get('c-admin').send = async () => {
      throw Object.assign(new Error('Missing Access'), { code: 50001 });
    };
    const { i, log } = interactionOf(w);
    await gate.handle(i, ['gate', 'sendModal', `r1-${VER}`, '0']);
    assert.equal(reqs[0].status, 'cancelled');
    assert.deepEqual(w.rec.roleCalls, []);
    assert.match(last(log).content, /Không gửi được yêu cầu/);
  });
  it('an already-member is told so at every step; the gate switched off blocks the member path', async () => {
    const w = world();
    const m = interactionOf(w, { roleIds: ['r-member'] });
    await gate.handle(m.i, ['gate', 'member']);
    assert.match(last(m.log).content, /Bạn đã là thành viên bang\./);
    const s = interactionOf(w, { user: USER, roleIds: ['r-member'] });
    await gate.handle(s.i, ['gate', 'sendModal', `r1-${VER}`, '0']);
    assert.match(last(s.log).content, /Bạn đã là thành viên bang\./);
    config.gateEnabled = false;
    const off = interactionOf(world());
    await gate.handle(off.i, ['gate', 'member']);
    assert.match(last(off.log).content, /đang tắt/);
  });
  it('without a game roster the member types the name (free) and the request says it is not in the roster', async () => {
    roster = null;
    const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
    const a = interactionOf(w);
    await gate.handle(a.i, ['gate', 'member']);
    assert.match(last(a.log).content, /nhập tên nhân vật trong game/);
    const s = interactionOf(w);
    await gate.handle(s.i, ['gate', 'sendModal', 'f-Người Lạ', '0']);
    assert.equal(reqs[0].gameNameFree, true);
    const text = textOf(w.rec.sent.at(-1)[1]);
    assert.match(text, /\(tự nhập\)/);
    assert.match(text, /không có trong danh sách game/);
    assert.deepEqual(ev('gate.request').map((e) => [e.gameInRoster, e.free]), [[false, true]]);
  });
});

// ---------- the approval card ----------

describe('the approval card', () => {
  it('has the title, the member line with account age and join time, the game name with roster rank, the class; no mentions, V2 limits', async () => {
    const { card } = await sendRequest({ pick: '0', name: 'Alpha Fan' });
    const v2 = assertV2Message(card, { forCreate: true });
    assert.match(v2.text, /### 🚪 Yêu cầu vào bang/);
    assert.match(v2.text, new RegExp(`<@${USER}> \\(Discord: \\*\\*Alpha Fan\\*\\*, tài khoản tạo <t:\\d+:R>, vào server <t:\\d+:R>\\)`));
    assert.match(v2.text, /🎮 Tên game: \*\*Alpha\*\* · ✅ có trong danh sách game mới nhất · cấp bậc Trưởng Lão/);
    assert.match(v2.text, /🧙 Phái: .*Thiết Y/);
    assert.ok(!/⚠️ Tài khoản/.test(v2.text), 'an old account has no warning');
    assert.deepEqual(v2.buttons.map((b) => [b.custom_id, b.label]), [[`gate:ok:${oid(1)}`, '✅ Duyệt'], [`gate:no:${oid(1)}`, '❌ Từ chối']]);
    assert.ok(!v2.text.includes('Khách'));
  });
  it('warns when the account is younger than 7 days', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
    const { card } = await sendRequest({ w, user: NEW_USER });
    assert.match(textOf(card), /⚠️ Tài khoản Discord mới tạo \(dưới 7 ngày\)/);
  });
  it('a free name is marked "tự nhập" and "không có trong danh sách"; a held name shows the holder warning', () => {
    const request = { _id: oid(3), discordId: USER, displayName: 'Z', gameName: 'Tên Lạ', gameNameFree: true, className: 'Thiết Y' };
    const texts = ui.approvalTexts({ request, member: { displayName: 'Z', createdAt: new Date(NOW - 30 * DAY), joinedAt: null }, entry: null, classText: '🛡️ Thiết Y', warnings: ['⚠️ Tên game này đang do <@123> giữ (không nên xảy ra): kiểm tra trước khi duyệt.'] });
    assert.match(texts[0], /\(tự nhập\)/);
    assert.match(texts[0], /không có trong danh sách game mới nhất/);
    assert.ok(!/vào server/.test(texts[0]), 'no join time known');
    assert.match(texts[1], /đang do <@123> giữ/);
  });
  it('user text cannot ping or break the markdown: names and reasons are neutralised', () => {
    const request = { _id: oid(3), discordId: USER, displayName: '@everyone', gameName: '<@999> **x**', gameNameFree: true, className: 'Thiết Y' };
    const [main] = ui.approvalTexts({ request, member: { displayName: '@everyone <@1>', createdAt: new Date(NOW), joinedAt: null }, classText: 'x' });
    assert.ok(!/<@999>/.test(main) && !/@everyone/.test(main) && !/<@1>/.test(main));
  });
});

// ---------- manager buttons ----------

describe('✅ Duyệt', () => {
  const press = (w, request, card, extra = {}) => interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card), ...extra });

  it('adds the member role (and the class role), removes NOTHING even when the applicant holds legacy Khách / Chờ duyệt roles; saves the admin link + class; DMs the welcome; edits the card green with who approved', async () => {
    const { w, request, card } = await sendRequest({ classIndex: 1 }); // Tố Vấn: no such role in this guild -> skipped with a note
    config.pendingRoleId = 'r-pending'; // legacy field: never read, so the role the applicant holds is left alone
    w.guild.members.cache.get(USER).roles.cache.set('r-pending', w.roles.get('r-pending'));
    const before = w.rec.roleCalls.length;
    const { i, log } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(log[0][0], 'deferUpdate');
    assert.deepEqual(w.rec.roleCalls.slice(before).map((c) => c.slice(0, 3)), [['add', USER, ['r-member']]]);
    assert.ok(!w.rec.roleCalls.some((c) => c[0] === 'remove'), 'no pending-role removal');
    assert.equal(reqs[0].status, 'approved');
    assert.equal(reqs[0].decidedBy, ADMIN);
    assert.deepEqual(saved.mappings, [[{ discordId: USER, gameName: 'Beta Boss', displayName: 'Beta Boss' }]]);
    assert.deepEqual(saved.classes[0].slice(0, 4), [GUILD, USER, 'Beta Boss', 'Tố Vấn']);
    assert.equal(w.rec.dms.length, 1);
    assert.equal(w.rec.dms[0][1].content, gateService.welcomeMemberText(config, w.guild));
    assert.ok(w.rec.dms[0][1].content.includes('<#c-war>'));
    const done = last(log);
    const v2 = assertV2Message(done);
    assert.equal(v2.buttons.length, 0);
    assert.match(v2.text, new RegExp(`✅ <@${ADMIN}> đã duyệt`));
    assert.match(v2.text, /Yêu cầu vào bang/);
    assert.match(v2.text, /chưa gán role phái/, 'a class without a role is skipped with a note');
    assert.equal(done.components[0].toJSON().accent_color, 0x2ecc71);
    assert.deepEqual(ev('gate.approve').map((e) => [e.by, e.dm]), [[ADMIN, true]]);
    assert.deepEqual(w.rec.sent.filter((s) => s[0] === 'c-gate'), [], 'no public line when the DM worked');
  });
  it('the class role (a guild role named like the class) is added together with the member role, in ONE call', async () => {
    const { w, request, card } = await sendRequest({ classIndex: 0 }); // Thiết Y has r-ty
    const before = w.rec.roleCalls.length;
    const { i } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.deepEqual(w.rec.roleCalls.slice(before).map((c) => c.slice(0, 3)), [['add', USER, ['r-member', 'r-ty']]]);
  });
  it('DM closed: one short public line in the gate channel that can ping only that member', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]], dmFails: [USER] });
    const { request, card } = await sendRequest({ w });
    const { i, log } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    const [id, payload] = w.rec.sent.filter((s) => s[0] === 'c-gate').pop();
    assert.equal(id, 'c-gate');
    assert.equal(payload.content, `✅ <@${USER}> đã được duyệt vào bang. Kiểm tra các kênh mới nhé!`);
    assert.deepEqual(payload.allowedMentions, { users: [USER] });
    assert.equal(reqs[0].status, 'approved');
    assert.deepEqual(ev('gate.dm_failed').map((e) => [e.kind, e.user]), [['approve', ADMIN]]);
    assert.match(textOf(last(log)), /Không nhắn riêng được/);
  });
  it('a role the bot cannot manage: NOTHING is changed, the request stays pending, the card and the manager are told exactly which role', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]], rolePositions: {} });
    const { request, card } = await sendRequest({ w, classIndex: 0 });
    w.roles.get('r-member').position = 50; // the owner moved the Bang Chúng role above the bot
    const before = w.rec.roleCalls.length;
    const { i, log } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(w.rec.roleCalls.length, before, 'no role call at all');
    assert.equal(reqs[0].status, 'pending');
    assert.deepEqual(saved.mappings, []);
    assert.deepEqual(w.rec.dms, []);
    const cardAfter = assertV2Message(last(log));
    assert.match(cardAfter.text, /Role \*\*Thành viên\*\* <@&r-member>/);
    assert.match(cardAfter.text, /DƯỚI/);
    assert.equal(cardAfter.buttons.length, 2, 'the buttons stay so a retry works');
    const toManager = last(log, 'followUp');
    assert.match(toManager.content, /Role \*\*Thành viên\*\* <@&r-member>/);
    assert.equal(toManager.flags, 64);
    assert.deepEqual(ev('gate.role_failed').map((e) => [e.kind, e.problem]), [['member', 'hierarchy']]);
    // fixed -> retry works
    w.roles.get('r-member').position = 2;
    const retry = press(w, request, cardMessageOf(card) && card);
    await gate.handle(retry.i, ['gate', 'ok', String(request._id)]);
    assert.equal(reqs[0].status, 'approved');
  });
  it('Discord refusing the role call (permission changed after our check): the request goes back to pending and the roles it names are reported', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]], roleFails: { add: ['r-member'] } });
    const { request, card } = await sendRequest({ w });
    const { i, log } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(reqs[0].status, 'pending', 'a retry is possible');
    assert.deepEqual(saved.mappings, []);
    assert.deepEqual(w.rec.dms, []);
    assert.match(textOf(last(log)), /Discord từ chối khi gán role \(Thành viên, phái Thiết Y\)/);
    assert.equal(assertV2Message(last(log)).buttons.length, 2);
  });
  it('a legacy pending role above the bot is never looked at: the approval goes through with no removal and no note', async () => {
    config.pendingRoleId = 'r-pending';
    const w = world({ members: [[ADMIN, 'Quản Lý', []]], roleFails: { remove: ['r-pending'] } });
    w.roles.get('r-pending').position = 99;
    const { request, card } = await sendRequest({ w });
    const { i, log } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(reqs[0].status, 'approved');
    assert.doesNotMatch(textOf(last(log)), /Chưa gỡ được role|Chờ duyệt/);
    assert.deepEqual(ev('gate.role_failed'), []);
  });
  it('the name taken by somebody else meanwhile: not approved, the card names the holder', async () => {
    const { w, request, card } = await sendRequest();
    mappings = makeMappings([[sid(8), 'Beta Boss', 'self']]);
    const { i, log } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(reqs[0].status, 'pending');
    assert.match(textOf(last(log)), new RegExp(`đang do <@${sid(8)}> giữ`));
    assert.ok(!w.rec.roleCalls.some((c) => c[2].includes('r-member')));
  });
  it('the member role not chosen: pending, reported', async () => {
    const { w, request, card } = await sendRequest();
    config.memberRoleId = null;
    const { i, log } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(reqs[0].status, 'pending');
    assert.match(textOf(last(log)), /Chưa chọn role thành viên/);
  });
  it('the member left before approval: the request is cancelled and the card says so', async () => {
    const { w, request, card } = await sendRequest();
    w.guild.members.cache.delete(USER);
    const { i, log } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(reqs[0].status, 'cancelled');
    assert.match(textOf(last(log)), /đã rời server/);
  });
  it('two managers pressing at once: one wins (roles added once, one DM, the loser is told it was handled)', async () => {
    const { w, request, card } = await sendRequest();
    const a = press(w, request, card);
    const b = press(w, request, card);
    await Promise.all([gate.handle(a.i, ['gate', 'ok', String(request._id)]), gate.handle(b.i, ['gate', 'ok', String(request._id)])]);
    assert.equal(w.rec.roleCalls.filter((c) => c[0] === 'add' && c[2].includes('r-member')).length, 1);
    assert.equal(w.rec.dms.length, 1);
    assert.equal(ev('gate.approve').length, 1);
    const losers = [a, b].filter((x) => x.log.some((l) => l[0] === 'followUp'));
    assert.equal(losers.length, 1);
    assert.match(last(losers[0].log, 'followUp').content, /xử lý/);
  });
  it('an already decided request: told, nothing touched', async () => {
    const { w, request, card } = await sendRequest();
    reqs[0].status = 'rejected';
    const before = w.rec.roleCalls.length;
    const { i, log } = press(w, request, card);
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.match(last(log, 'followUp').content, /đã bị từ chối rồi/);
    assert.equal(w.rec.roleCalls.length, before);
  });
  it('an unknown request id: told, nothing touched', async () => {
    const w = world();
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, message: { components: [] } });
    await gate.handle(i, ['gate', 'ok', oid(77)]);
    assert.match(last(log, 'followUp').content, /Không tìm thấy/);
  });
});

describe('❌ Từ chối', () => {
  it('the button opens the reason modal (optional field)', async () => {
    const { w, request, card } = await sendRequest();
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'no', String(request._id)]);
    const modal = assertModal(log.find((l) => l[0] === 'showModal')[1]);
    assert.equal(modal.custom_id, `gate:noModal:${request._id}`);
    assert.equal(modal.components[0].component.required, false);
    assert.equal(reqs[0].status, 'pending');
  });
  it('with a reason: marks rejected (no role touched), DMs the reason, edits the card red with the reason', async () => {
    const { w, request, card } = await sendRequest();
    const before = w.rec.roleCalls.length;
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, fields: { reason: '  Chưa đủ lực chiến  ' }, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'noModal', String(request._id)]);
    assert.equal(w.rec.roleCalls.length, before, 'no pending role to remove: no role call at all');
    assert.equal(reqs[0].status, 'rejected');
    assert.equal(reqs[0].reason, 'Chưa đủ lực chiến');
    assert.equal(reqs[0].decidedBy, ADMIN);
    assert.match(w.rec.dms[0][1].content, /Lý do: Chưa đủ lực chiến/);
    const done = last(log);
    assert.match(assertV2Message(done).text, new RegExp(`❌ <@${ADMIN}> đã từ chối`));
    assert.match(assertV2Message(done).text, /Lý do: Chưa đủ lực chiến/);
    assert.equal(done.components[0].toJSON().accent_color, 0xe74c3c);
    assert.deepEqual(ev('gate.reject').map((e) => [e.by, e.reason]), [[ADMIN, true]]);
    assert.deepEqual(saved.mappings, [], 'a rejection links nothing');
  });
  it('without a reason: no DM', async () => {
    const { w, request, card } = await sendRequest();
    const { i } = interactionOf(w, { user: ADMIN, admin: true, fields: { reason: '' }, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'noModal', String(request._id)]);
    assert.equal(reqs[0].status, 'rejected');
    assert.deepEqual(w.rec.dms, []);
  });
  it('rejecting just closes the request: a legacy pending role above the bot does not block it, and the cooldown applies afterwards', async () => {
    config.pendingRoleId = 'r-pending';
    const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
    const { request, card } = await sendRequest({ w });
    w.roles.get('r-pending').position = 99;
    const { i } = interactionOf(w, { user: ADMIN, admin: true, fields: { reason: 'x' }, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'noModal', String(request._id)]);
    assert.equal(reqs[0].status, 'rejected');
    assert.deepEqual(ev('gate.role_failed'), []);
    reqs[0].decidedAt = new Date();
    const again = interactionOf(w);
    await gate.handle(again.i, ['gate', 'member']);
    assert.match(last(again.log).content, /Yêu cầu trước của bạn vừa được xử lý/);
  });
});

describe('only managers press the card buttons', () => {
  it('a member without the manager permission is refused and nothing happens (both buttons, the retired one and the modal)', async () => {
    const { w, request, card } = await sendRequest();
    const before = w.rec.roleCalls.length;
    for (const [action, extra] of [['ok', {}], ['no', {}], ['tg', {}], ['noModal', { fields: { reason: 'x' } }]]) {
      const { i, log } = interactionOf(w, { user: USER, admin: false, message: cardMessageOf(card), ...extra });
      await gate.handle(i, ['gate', action, String(request._id)]);
      assert.equal(last(log, 'reply').content, NO_PERMISSION, action);
      assert.ok(!log.some((l) => l[0] === 'showModal' || l[0] === 'deferUpdate'), action);
    }
    assert.equal(reqs[0].status, 'pending');
    assert.equal(w.rec.roleCalls.length, before);
  });
  it('a manager role from the config also counts', async () => {
    config.adminRoleIds = ['r-mod'];
    const { w, request, card } = await sendRequest();
    const { i, log } = interactionOf(w, { user: ADMIN, admin: false, message: cardMessageOf(card) });
    i.member.roles = { cache: new Collection([['r-mod', { id: 'r-mod' }]]), add: async () => {}, remove: async () => {} };
    await gate.handle(i, ['gate', 'no', String(request._id)]);
    assert.ok(log.some((l) => l[0] === 'showModal'));
  });
});

describe('🤝 Khách: the self-serve guest path', () => {
  const panelOf = (cfg) => ui.buildGatePanel({ guildName: 'Bang Thử Nghiệm', guest: Boolean(cfg.guestRoleId) });
  beforeEach(() => {
    config.guestRoleId = 'r-guest';
  });
  const click = async (w, id, opts = {}) => {
    const x = interactionOf(w, opts);
    await gate.handle(x.i, ['gate', id]);
    return x;
  };

  it('the panel shows a secondary 🤝 Khách button and the hint only while a guest role is set; without it the panel is unchanged', () => {
    const on = assertV2Message(panelOf(config));
    assert.deepEqual(on.buttons.map((b) => [b.custom_id, b.label, b.style]), [['gate:member', '⚔️ Thành viên bang Bang Thử Nghiệm', 1], ['gate:gst', '🤝 Khách', 2]]);
    assert.match(on.text, /-# Không chơi trong bang \(bạn bè, khách\)\? Bấm Khách để vào server ngay, không cần duyệt\./);
    const off = assertV2Message(panelOf({ ...config, guestRoleId: null }));
    assert.deepEqual(off.buttons.map((b) => b.custom_id), ['gate:member']);
    assert.ok(!/Khách/.test(off.text));
    assert.deepEqual(JSON.stringify(ui.buildGatePanel({ guildName: 'Bang Thử Nghiệm' })), JSON.stringify(panelOf({ ...config, guestRoleId: null })));
    assertV2Message(require('../src/bot/ui/common').v2Create(panelOf(config)), { forCreate: true });
  });
  it('postOrUpdateGatePanel draws the Khách button from guestRoleId', async () => {
    guildConfigService.updateConfig = async () => ({});
    delete require.cache[require.resolve('../src/bot/gatePanel')];
    const { postOrUpdateGatePanel: post } = require('../src/bot/gatePanel');
    const w = world();
    await post(w.client, { ...config, guildId: GUILD });
    assert.ok(JSON.stringify(w.rec.sent[0][1]).includes('gate:gst'));
    const w2 = world();
    await post(w2.client, { ...config, guildId: GUILD, guestRoleId: null });
    assert.ok(!JSON.stringify(w2.rec.sent[0][1]).includes('gate:gst'));
  });
  it('🤝 Khách only asks to confirm (ephemeral): no role, no request, no card yet; ↩ Quay lại ends it', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
    const { log } = await click(w, 'gst');
    assert.equal(log[0][0], 'deferReply');
    const v = assertMessage(last(log));
    assert.match(last(log).content, /Bạn sẽ vào server với vai trò \*\*khách\*\* \(không phải thành viên bang\)\. Thành viên bang thì bấm ⚔️ Thành viên bang\./);
    assert.deepEqual(v.rows[0].components.map((c) => [c.custom_id, c.label]), [['gate:gyes', '✅ Vào làm khách'], ['gate:gback', '↩ Quay lại']]);
    assert.deepEqual(w.rec.roleCalls, []);
    assert.deepEqual(reqs, []);
    const back = await click(w, 'gback');
    assert.deepEqual(w.rec.roleCalls, []);
    assert.match(last(back.log).content, /Đã quay lại/);
  });
  it('✅ Vào làm khách gives the guest role only, tells the person, posts an info card to the admin channel, saves no request and sets no cooldown', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
    const { log } = await click(w, 'gyes', { user: NEW_USER, name: 'Bạn Của An' });
    assert.equal(log[0][0], 'deferUpdate');
    assert.deepEqual(w.rec.roleCalls.map((c) => c.slice(0, 3)), [['add', NEW_USER, ['r-guest']]]);
    assert.equal(last(log).content, '🤝 Bạn đã vào server với vai trò khách.');
    assert.deepEqual(reqs, []);
    assert.deepEqual(w.rec.dms, []);
    assert.deepEqual(saved.mappings, []);
    assert.deepEqual(saved.classes, []);
    const sent = w.rec.sent.filter((s) => s[0] === 'c-admin');
    assert.equal(sent.length, 1);
    const v2 = assertV2Message(sent[0][1], { forCreate: true });
    assert.equal(v2.buttons.length, 0, 'nothing to decide');
    assert.match(v2.text, new RegExp(`🤝 <@${NEW_USER}> đã tự vào làm khách`));
    assert.match(v2.text, /Bạn Của An/);
    assert.deepEqual(ev('gate.guest_join').map((e) => e.member), [NEW_USER]);
    // no cooldown, no request: the picker for the member path is open at once
    const m = await click(w, 'member', { user: NEW_USER });
    assert.match(last(m.log).content, /Xin vào bang \(1\/3\)/);
  });
  it('the info card goes to gateAdminChannelId when set; a card that cannot be posted does not undo the guest role', async () => {
    config.gateAdminChannelId = 'c-war';
    const w = world();
    await click(w, 'gyes');
    assert.equal(w.rec.sent.filter((s) => s[0] === 'c-war').length, 1);
    const w2 = world();
    w2.guild.channels.cache.get('c-war').send = async () => {
      throw new Error('Missing Access');
    };
    const { log, member } = await click(w2, 'gyes', { user: sid(6001) });
    assert.ok(member.roles.cache.has('r-guest'));
    assert.equal(last(log).content, '🤝 Bạn đã vào server với vai trò khách.');
  });
  it('refused when the person already holds the member role or the guest role, when the gate is off, or when no guest role is set - at both steps', async () => {
    const w = world();
    for (const id of ['gst', 'gyes']) {
      const m = await click(w, id, { user: sid(6101), roleIds: ['r-member'] });
      assert.match(last(m.log).content, /đã là thành viên bang/);
      const g1 = await click(w, id, { user: sid(6102), roleIds: ['r-guest'] });
      assert.match(last(g1.log).content, /đã là khách/);
    }
    assert.deepEqual(w.rec.roleCalls, []);
    config.gateEnabled = false;
    config.features = { ...(config.features || {}), gate: false };
    assert.match(last((await click(w, 'gst', { user: sid(6103) })).log).content, /Cổng vào đang tắt/);
    config.gateEnabled = true;
    config.features = { ...(config.features || {}), gate: true };
    config.guestRoleId = null;
    assert.match(last((await click(w, 'gyes', { user: sid(6104) })).log).content, /Nút Khách đang tắt/);
    assert.deepEqual(w.rec.roleCalls, []);
  });
  it('a guest role the bot cannot hand out (above the bot, or a privileged role) is never given', async () => {
    const w = world({ botPosition: 1 });
    const { log } = await click(w, 'gyes');
    assert.deepEqual(w.rec.roleCalls, []);
    assert.match(last(log).content, /Bot chưa cấp được role khách/);
    assert.deepEqual(ev('gate.role_failed').map((e) => e.action), ['guest']);
    const w2 = world();
    w2.roles.get('r-guest').permissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
    await click(w2, 'gyes', { user: sid(6201) });
    assert.deepEqual(w2.rec.roleCalls, []);
  });
  it('Discord refusing the role call is reported, nothing else happens', async () => {
    const w = world({ roleFails: { add: ['r-guest'] } });
    const { log } = await click(w, 'gyes');
    assert.match(last(log).content, /Discord từ chối khi cấp role khách/);
    assert.equal(w.rec.sent.filter((s) => s[0] === 'c-admin').length, 0);
  });
  it('the Người lạ role is dropped when the person becomes a guest', async () => {
    config.strangerRoleId = 'r-stranger';
    const w = world();
    w.roles.set('r-stranger', { id: 'r-stranger', name: 'Người lạ', position: 1, managed: false });
    await click(w, 'gyes', { roleIds: ['r-stranger'] });
    assert.deepEqual(w.rec.roleCalls.map((c) => [c[0], c[2]]), [['add', ['r-guest']], ['remove', ['r-stranger']]]);
  });
  it('a guest can still apply as a member (no refusal for the guest role); the approval removes the guest role and keeps the rest of the flow', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
    w.mk(USER, 'Beta Boss', ['r-guest']);
    const { request, card } = await sendRequest({ w });
    assert.equal(request.status, 'pending');
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(reqs[0].status, 'approved');
    assert.deepEqual(w.rec.roleCalls.map((c) => [c[0], c[1], c[2]]), [['add', USER, ['r-member', 'r-ty']], ['remove', USER, ['r-guest']]]);
    assert.deepEqual(saved.mappings, [[{ discordId: USER, gameName: 'Beta Boss', displayName: 'Beta Boss' }]]);
    assert.ok(!assertV2Message(last(log)).text.includes('role khách'), 'no note when the guest role came off');
  });
  it('a guest role that cannot be removed on approval only adds a note: the member is still approved', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]], roleFails: { remove: ['r-guest'] } });
    w.mk(USER, 'Beta Boss', ['r-guest']);
    const { request, card } = await sendRequest({ w });
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(reqs[0].status, 'approved');
    assert.match(assertV2Message(last(log)).text, /Chưa gỡ được role khách/);
  });
  it('a double click on ✅ Vào làm khách gives the role once and posts ONE info card', async () => {
    const w = world();
    const run = () => gate.handle(interactionOf(w, { user: NEW_USER }).i, ['gate', 'gyes']);
    await Promise.all([run(), run()]);
    assert.equal(w.rec.roleCalls.filter((c) => c[0] === 'add').length, 1);
    assert.equal(w.rec.sent.filter((s) => s[0] === 'c-admin').length, 1);
    // the lock is released afterwards (a later refusal is the normal "already a guest")
    const again = interactionOf(w, { user: NEW_USER });
    await gate.handle(again.i, ['gate', 'gyes']);
    assert.match(last(again.log).content, /đã là khách/);
  });
  describe('a guest is not a stranger', () => {
    beforeEach(() => {
      config.strangerRoleId = 'r-stranger';
    });
    const withStranger = (opts) => {
      const w = world(opts);
      w.roles.set('r-stranger', { id: 'r-stranger', name: 'Người lạ', position: 1, managed: false });
      return w;
    };

    it('rejecting an applicant who holds the guest role does not give the stranger role back; without it the stranger role comes back', async () => {
      const w = withStranger({ members: [[ADMIN, 'Quản Lý', []]] });
      w.mk(USER, 'Beta Boss', ['r-guest']);
      const { request, card } = await sendRequest({ w });
      const no = interactionOf(w, { user: ADMIN, admin: true, fields: { reason: 'x' }, message: cardMessageOf(card) });
      await gate.handle(no.i, ['gate', 'noModal', String(request._id)]);
      assert.equal(reqs[0].status, 'rejected');
      assert.deepEqual(w.rec.roleCalls, []);
      const w2 = withStranger({ members: [[ADMIN, 'Quản Lý', []]] });
      reqs.length = 0;
      const second = await sendRequest({ w: w2 });
      const no2 = interactionOf(w2, { user: ADMIN, admin: true, fields: { reason: 'x' }, message: cardMessageOf(second.card) });
      await gate.handle(no2.i, ['gate', 'noModal', String(second.request._id)]);
      assert.deepEqual(w2.rec.roleCalls.map((c) => [c[0], c[2]]), [['add', ['r-stranger']]]);
    });
    const approvedThenRevoke = async (w) => {
      const { request, card } = await sendRequest({ w });
      await gate.handle(interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) }).i, ['gate', 'ok', String(request._id)]);
      w.rec.roleCalls.length = 0;
      const rv = interactionOf(w, { user: ADMIN, admin: true, fields: { reason: 'sai người' }, message: cardMessageOf(card) });
      await gate.handle(rv.i, ['gate', 'rvModal', String(request._id)]);
      return { request, log: rv.log };
    };

    it('revoking a member never hands out the guest role: member + class roles come off and the stranger role goes back, guest role set or not', async () => {
      const w = withStranger({ members: [[ADMIN, 'Quản Lý', []]] });
      await approvedThenRevoke(w);
      assert.deepEqual(w.rec.roleCalls.map((c) => [c[0], c[2]]), [['remove', ['r-member', 'r-ty']], ['add', ['r-stranger']]]);
      assert.equal(reqs[0].status, 'revoked');
      reqs.length = 0;
      config.guestRoleId = null;
      const w2 = withStranger({ members: [[ADMIN, 'Quản Lý', []]] });
      await approvedThenRevoke(w2);
      assert.deepEqual(w2.rec.roleCalls.map((c) => [c[0], c[2]]), [['remove', ['r-member', 'r-ty']], ['add', ['r-stranger']]]);
    });
    it('the guest role must differ from the stranger role: roleProblem, health, and both /setup saves', async () => {
      const { roleProblem, PROBLEM_TEXT } = require('../src/bot/gateRoles');
      const w = withStranger();
      assert.equal(roleProblem(w.guild, 'r-stranger', { ...config, guestRoleId: 'r-stranger' }, 'guest'), 'guest_same_as_stranger');
      assert.equal(roleProblem(w.guild, 'r-guest', { ...config, guestRoleId: 'r-guest' }, 'stranger'), 'guest_same_as_stranger');
      assert.match(PROBLEM_TEXT.guest_same_as_stranger, /Khách và role Người lạ phải khác nhau/);
      assert.ok(gateHealth({ ...config, guestRoleId: 'r-stranger' }, w.guild).some((h) => !h.ok && /Khách.*phải khác nhau/.test(h.text)));
      const writes = [];
      guildConfigService.updateConfig = async (_id, patch) => (writes.push(patch), (config = { ...config, ...patch }));
      guildConfigService.getOrCreateConfig = async () => config;
      delete require.cache[require.resolve('../src/bot/interactions/setup')];
      const fresh = require('../src/bot/interactions/setup');
      const select = async (id, value) => {
        const { i, log } = interactionOf(w, { user: ADMIN, admin: true, values: [value] });
        await fresh.handle(i, ['setup', id]);
        return last(log).content;
      };
      assert.match(await select('gateguestrole', 'r-stranger'), /Role khách .* chưa lưu: .*phải khác nhau/);
      config.guestRoleId = 'r-guest';
      assert.match(await select('gatestranger', 'r-guest'), /Role người lạ .* chưa lưu: .*phải khác nhau/);
      assert.deepEqual(writes, []);
      await select('gatestranger', 'r-stranger');
      assert.deepEqual(writes, [{ strangerRoleId: 'r-stranger' }]);
    });
  });
  it('the retired guest ids still answer "gone" even with a guest role set', async () => {
    const w = world();
    const a = await click(w, 'guest');
    assert.match(last(a.log).content, /Lối vào Khách đang tắt/);
    assert.deepEqual(w.rec.roleCalls, []);
  });
  it('the new guest ids are routed through the router and gated by the gate feature', async () => {
    const { featureOf } = require('../src/bot/featureGate');
    for (const id of ['gate:gst', 'gate:gyes', 'gate:gback']) assert.equal(featureOf(id), 'gate', id);
  });
});

describe('/setup 🤝 role khách select', () => {
  let writes;
  let fresh;
  beforeEach(() => {
    writes = [];
    guildConfigService.updateConfig = async (_id, patch) => {
      writes.push(patch);
      config = { ...config, ...patch };
      return config;
    };
    guildConfigService.getOrCreateConfig = async () => config;
    delete require.cache[require.resolve('../src/bot/interactions/setup')];
    fresh = require('../src/bot/interactions/setup');
  });
  const pick = async (w, values, opts = {}) => {
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, values, ...opts });
    await fresh.handle(i, ['setup', 'gateguestrole']);
    return last(log);
  };

  it('saves a safe role, shows it, and an empty selection clears it (the button goes away)', async () => {
    const w = world();
    const view = await pick(w, ['r-guest']);
    assert.deepEqual(writes.pop(), { guestRoleId: 'r-guest' });
    assert.match(view.content, /Đã lưu role khách/);
    assert.match(view.content, /🤝 Nút Khách: \*\*BẬT\*\*/);
    await pick(w, []);
    assert.deepEqual(writes.pop(), { guestRoleId: null });
    assert.equal(config.guestRoleId, null);
  });
  it('refuses (and saves nothing) @everyone, a managed role, the member role, a manager role, a privileged role and one above the bot', async () => {
    config.adminRoleIds = ['r-ty'];
    const w = world();
    w.roles.set('r-priv', { id: 'r-priv', name: 'Mod', position: 1, managed: false, permissions: new PermissionsBitField(PermissionFlagsBits.KickMembers) });
    const cases = [[GUILD, /@everyone/], ['r-bot', /role của bot/], ['r-member', /trùng role Thành viên/], ['r-ty', /role quản lý/], ['r-priv', /quyền quản trị/]];
    for (const [id, re] of cases) {
      const view = await pick(w, [id]);
      assert.match(view.content, new RegExp(`Role khách <@&${id}> chưa lưu`));
      assert.match(view.content, re, id);
    }
    const high = await pick(world({ botPosition: 1 }), ['r-guest']);
    assert.match(high.content, /chưa lưu.*DƯỚI/s);
    assert.deepEqual(writes, []);
    assert.equal(config.guestRoleId, null);
  });
  it('only managers can change it', async () => {
    const w = world();
    const { i, log } = interactionOf(w, { values: ['r-guest'] });
    await fresh.handle(i, ['setup', 'gateguestrole']);
    assert.deepEqual(writes, []);
    assert.equal(log.at(-1)[1].content, NO_PERMISSION);
  });
});

describe('routing', () => {
  it('the gate prefix is routed through the router', async () => {
    const w = world();
    const { i, log } = interactionOf(w, { customId: 'gate:member' });
    Object.assign(i, { inGuild: () => true, isChatInputCommand: () => false, isMessageComponent: () => true, isModalSubmit: () => false, isButton: () => true });
    await routeInteraction(i);
    assert.equal(log[0][0], 'deferReply');
    assert.ok(last(log).components.length > 0, 'the picker');
  });
});

// ---------- gateway events ----------

describe('GuildMemberAdd / GuildMemberRemove', () => {
  it('gate off: nothing happens (no log, no role call)', async () => {
    config.gateEnabled = false;
    const w = world();
    const m = w.mk(sid(60), 'Newcomer');
    await onGateMemberAdd(m);
    assert.deepEqual(w.rec.roleCalls, []);
    assert.deepEqual(ev('gate.join'), []);
  });
  it('gate on: only logs gate.join - assigns NOTHING (no role, no message, existing members untouched)', async () => {
    const w = world({ members: [[sid(61), 'Old Timer', ['r-member']]] });
    const m = w.mk(sid(60), 'Newcomer');
    await onGateMemberAdd(m);
    assert.deepEqual(w.rec.roleCalls, []);
    assert.deepEqual(w.rec.dms, []);
    assert.deepEqual(w.rec.sent, []);
    assert.deepEqual(ev('gate.join').map((e) => [e.guild, e.user]), [[GUILD, sid(60)]]);
    assert.ok(w.guild.members.cache.get(sid(61)).roles.cache.has('r-member'));
    await onGateMemberAdd({ ...m, user: { ...m.user, bot: true } });
    assert.equal(ev('gate.join').length, 1, 'bots are ignored');
  });
  it('leaving cancels a pending request and edits its card ("đã rời server")', async () => {
    const { w, request } = await sendRequest();
    const member = w.guild.members.cache.get(USER);
    member.client = w.client;
    await onGateMemberRemove(member);
    assert.equal(reqs[0].status, 'cancelled');
    assert.equal(reqs[0].reason, 'đã rời server');
    const edit = w.rec.edits.pop();
    assert.equal(edit[0], 'c-admin');
    const v2 = assertV2Message(edit[2]);
    assert.equal(v2.buttons.length, 0);
    assert.match(v2.text, /đã rời server/);
    assert.match(v2.text, /Yêu cầu vào bang/);
    assert.equal(ev('gate.cancel')[0].rid, String(request._id));
  });
  it('leaving without a request, or after a decision, changes nothing (works with the gate off too)', async () => {
    const { w } = await sendRequest();
    reqs[0].status = 'approved';
    config.gateEnabled = false;
    const member = w.guild.members.cache.get(USER);
    member.client = w.client;
    await onGateMemberRemove(member);
    assert.equal(reqs[0].status, 'approved');
    assert.deepEqual(w.rec.edits, []);
    await onGateMemberRemove(w.mk(sid(70), 'Nobody'));
  });
  it('the client registers both listeners', () => {
    const src = require('node:fs').readFileSync(require.resolve('../src/bot/client.js'), 'utf8');
    assert.match(src, /Events\.GuildMemberAdd, onGateMemberAdd/);
    assert.match(src, /Events\.GuildMemberRemove, onGateMemberRemove/);
  });
});

// ---------- war flows do not count pending / guests ----------

describe('the war "chưa đăng ký" numbers: the member role decides (no guest / pending roles are known)', () => {
  const infos = [
    { id: '1', name: 'Member', username: 'm', bot: false, roleIds: ['r-member'], roleNames: [] },
    { id: '2', name: 'Pending', username: 'p', bot: false, roleIds: ['r-pending'], roleNames: [] },
    { id: '3', name: 'Guest', username: 'g', bot: false, roleIds: ['r-guest'], roleNames: [] },
    { id: '4', name: 'Bot', username: 'b', bot: true, roleIds: ['r-member'], roleNames: [] },
  ];
  it('with a member role, only its holders (not bots) are tracked and listed', () => {
    assert.deepEqual(tracked(infos, config).map((m) => m.id), ['1']);
    assert.equal(groupUnregistered(infos, [], config).total, 1);
  });
  it('without a member role every non-bot counts; the legacy guest / pending fields are not read', () => {
    assert.deepEqual(tracked(infos, { classes: [], memberRoleId: null }).map((m) => m.id), ['1', '2', '3']);
    assert.deepEqual(tracked(infos, { ...config, memberRoleId: null, guestRoleId: 'r-guest', pendingRoleId: 'r-pending' }).map((m) => m.id), ['1', '2', '3']);
  });
});

// ---------- security review: role safety, flood control, approve races ----------

describe('H1: the class role the bot hands out must be safe', () => {
  const PERMS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageMessages', 'MentionEveryone', 'ManageWebhooks', 'ModerateMembers', 'MoveMembers', 'MuteMembers', 'DeafenMembers', 'ManageNicknames', 'ManageThreads', 'ManageEvents', 'ViewAuditLog'];
  const { roleProblem, unsafeRole, checkRoles, PRIVILEGED, PROBLEM_TEXT, KIND_LABEL } = require('../src/bot/gateRoles');
  const grant = (w, id, ...names) => {
    w.roles.get(id).permissions = new PermissionsBitField(names.map((n) => PermissionFlagsBits[n]));
  };

  it('the privileged list is exactly the seventeen permissions of the review', () => {
    assert.deepEqual(PRIVILEGED, PERMS.map((n) => PermissionFlagsBits[n]));
  });
  it('no Khách / Chờ duyệt kinds, texts or checks remain', () => {
    assert.deepEqual(Object.keys(KIND_LABEL), ['member', 'class', 'stranger', 'guest']);
    assert.ok(!('same_role' in PROBLEM_TEXT) && !('is_member' in PROBLEM_TEXT));
  });
  it('a plain class role is fine; the same role with ANY of the seventeen permissions is refused for class', () => {
    const w = world();
    assert.equal(roleProblem(w.guild, 'r-ty', config, 'class'), null);
    for (const name of PERMS) {
      const w2 = world();
      grant(w2, 'r-ty', name, 'ViewChannel');
      assert.equal(roleProblem(w2.guild, 'r-ty', config, 'class'), 'privileged', name);
    }
    const harmless = world();
    grant(harmless, 'r-ty', 'ViewChannel', 'SendMessages', 'ReadMessageHistory');
    assert.equal(roleProblem(harmless.guild, 'r-ty', config, 'class'), null);
  });
  it('a class role that is an admin role or @everyone is refused; the member role itself is not judged for power', () => {
    const w = world();
    assert.equal(roleProblem(w.guild, 'r-ty', { ...config, adminRoleIds: ['r-ty'] }, 'class'), 'is_admin');
    assert.equal(unsafeRole(w.guild, GUILD, config), 'everyone');
    assert.equal(roleProblem(w.guild, 'r-member', config, 'member'), null);
    grant(w, 'r-member', 'Administrator');
    assert.equal(roleProblem(w.guild, 'r-member', config, 'member'), null, 'the owner picked the member role by hand');
  });
  it('the bot-side checks stay: Manage Roles, the role exists, is not managed, and the bot top role is ABOVE it', () => {
    assert.equal(roleProblem(world({ manageRoles: false }).guild, 'r-member'), 'no_manage_roles');
    assert.equal(roleProblem(world().guild, 'r-gone'), 'missing');
    assert.equal(roleProblem(world({ botPosition: 2 }).guild, 'r-member'), 'hierarchy');
    assert.equal(roleProblem(world({ botPosition: 3 }).guild, 'r-member'), null);
    const w = world();
    w.roles.get('r-member').managed = true;
    assert.equal(roleProblem(w.guild, 'r-member'), 'managed');
  });
  it('without config / kind only the bot-side checks run; checkRoles passes config through', () => {
    const w = world();
    grant(w, 'r-ty', 'Administrator');
    assert.equal(roleProblem(w.guild, 'r-ty'), null);
    assert.deepEqual(checkRoles(w.guild, [{ kind: 'class', id: 'r-ty' }]), []);
    assert.deepEqual(checkRoles(w.guild, [{ kind: 'class', id: 'r-ty' }], config).map((f) => f.problem), ['privileged']);
  });
  it('the /setup health lines name the problem of a class role', () => {
    const w = world();
    grant(w, 'r-ty', 'KickMembers');
    const text = gateHealth(config, w.guild).map((l) => l.text).join('\n');
    assert.match(text, /Role phái \*\*Thiết Y\*\*.*quyền quản trị/);
  });

  describe('at click time', () => {
    it('gate:send never looks at roles: a legacy privileged pending role changes nothing', async () => {
      config.pendingRoleId = 'r-pending';
      const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
      grant(w, 'r-pending', 'BanMembers');
      const a = interactionOf(w);
      await gate.handle(a.i, ['gate', 'sendModal', `r1-${VER}`, '0']);
      assert.equal(reqs.length, 1);
      assert.deepEqual(w.rec.roleCalls, []);
      assert.equal(w.rec.sent.length, 1, 'the card is posted');
      assert.match(last(a.log).content, /Đã gửi yêu cầu/);
      assert.deepEqual(ev('gate.unsafe_role'), []);
    });
    it('✅ Duyệt skips a privileged / admin class role, still approves, and says so on the card', async () => {
      for (const make of [(w) => grant(w, 'r-ty', 'ManageGuild'), () => { config.adminRoleIds = ['r-ty']; }]) {
        reqs = [];
        const { w, request, card } = await sendRequest({ classIndex: 0 }); // Thiết Y -> r-ty
        make(w);
        const before = w.rec.roleCalls.length;
        const { i, log } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
        await gate.handle(i, ['gate', 'ok', String(request._id)]);
        assert.deepEqual(w.rec.roleCalls.slice(before).map((c) => c.slice(0, 3)), [['add', USER, ['r-member']]]);
        assert.equal(reqs[0].status, 'approved');
        assert.match(assertV2Message(last(log)).text, /Thiết Y.*KHÔNG gán/);
        assert.equal(ev('gate.unsafe_role').pop().kind, 'class');
        config.adminRoleIds = [];
      }
    });
  });
});

describe('M5: gate request flood control', () => {
  const HOUR = 3600 * 1000;
  const cooldownReq = (status, hoursAgo, extra = {}) => ({ _id: oid(900), guildId: GUILD, discordId: USER, status, decidedAt: new Date(Date.now() - hoursAgo * HOUR), reason: '', ...extra });

  it('a request rejected / cancelled (or an old guest-switched one) within 12 h blocks a new one and says when to retry', async () => {
    for (const status of ['rejected', 'cancelled', 'guest']) {
      reqs = [cooldownReq(status, 2)];
      const w = world();
      const { i, log } = interactionOf(w);
      await gate.handle(i, ['gate', 'member']);
      assert.match(last(log).content, /⏳ Yêu cầu trước của bạn vừa được xử lý/, status);
      assert.match(last(log).content, /<t:\d+:f> \(<t:\d+:R>\)/);
      assert.equal(last(log).components.length, 0, 'no picker');
      const send = interactionOf(w);
      await gate.handle(send.i, ['gate', 'sendModal', `r1-${VER}`, '0']);
      assert.equal(reqs.length, 1, `${status}: no new request`);
      assert.equal(w.rec.sent.length, 0);
    }
  });
  it('the retry time is decidedAt + 12 h', async () => {
    const decided = Date.now() - 2 * HOUR;
    reqs = [cooldownReq('rejected', 2, { decidedAt: new Date(decided) })];
    const { i, log } = interactionOf(world());
    await gate.handle(i, ['gate', 'member']);
    const stamps = [...last(log).content.matchAll(/<t:(\d+):f>/g)].map((m) => Number(m[1]));
    assert.equal(stamps[0], Math.floor((decided + 12 * HOUR) / 1000));
  });
  it('after 12 h, an approved request, or a card that could not be posted: no cooldown', async () => {
    for (const r of [cooldownReq('rejected', 13), cooldownReq('approved', 1), cooldownReq('cancelled', 1, { reason: gateService.CARD_FAILED_REASON }), cooldownReq('rejected', 1, { discordId: sid(7) })]) {
      reqs = [r];
      const { i, log } = interactionOf(world());
      await gate.handle(i, ['gate', 'member']);
      assert.equal(last(log).components.length > 0, true);
    }
  });
  it('3 new requests per hour per member, then "thử lại" with a time', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
    for (let n = 0; n < 3; n++) {
      const r = await sendRequest({ w });
      assert.ok(r.card, `request ${n + 1}`);
      reqs[reqs.length - 1].status = 'approved'; // not a bad ending: only the in-memory limit is in play
    }
    const { i, log } = interactionOf(w);
    await gate.handle(i, ['gate', 'member']);
    assert.match(last(log).content, /⏳ Bạn đã gửi 3 yêu cầu trong 1 giờ qua\. Thử lại <t:\d+:R>/);
    const other = interactionOf(w, { user: sid(8001), name: 'Zed' });
    await gate.handle(other.i, ['gate', 'member']);
    assert.ok(last(other.log).components.length > 0, 'another member is not affected');
    gateService.resetRequestLimits();
    const again = interactionOf(w);
    await gate.handle(again.i, ['gate', 'member']);
    assert.ok(last(again.log).components.length > 0);
  });
  it('service: requestBlockedUntil / noteRequest keep a rolling hour', () => {
    gateService.resetRequestLimits();
    const t0 = 1_000_000;
    for (let n = 0; n < 3; n++) gateService.noteRequest(GUILD, 'u', t0 + n * 60_000);
    assert.equal(gateService.requestBlockedUntil(GUILD, 'u', t0 + 3 * 60_000), t0 + HOUR);
    assert.equal(gateService.requestBlockedUntil(GUILD, 'u', t0 + HOUR + 1), null);
    assert.equal(gateService.requestBlockedUntil(GUILD, 'other', t0), null);
    gateService.resetRequestLimits();
  });
});

describe('L2: a card id from another guild finds nothing', () => {
  it('the handler passes interaction.guildId to getRequest', async () => {
    const { w, request, card } = await sendRequest();
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    i.guildId = '800000000000000099';
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.match(last(log, 'followUp').content, /Không tìm thấy yêu cầu này/);
    assert.equal(reqs[0].status, 'pending');
  });
  it('the real getRequest filters by guild', () => {
    const src = require('node:fs').readFileSync(require.resolve('../src/services/gateService.js'), 'utf8');
    assert.match(src, /where g\.id = \$1 and g\.guild_id = \$2`, \[String\(id\), String\(guildId\)\]/);
  });
});

describe('L3 / L4: approve re-checks the name and survives a failed step', () => {
  const approve = async (w, request, card) => {
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    return { log, text: assertV2Message(last(log)).text };
  };

  it('a name taken between the first check and the save is NOT taken over: roles approved, link skipped, card says so', async () => {
    const { w, request, card } = await sendRequest();
    const realLatest = gameRoster.latest;
    const realLoad = gameRoster.loadMappings;
    let latestCalls = 0;
    gameRoster.latest = async (...a) => (latestCalls++, realLatest(...a));
    gameRoster.loadMappings = async (...a) => (latestCalls >= 2 ? makeMappings([[sid(777), 'Beta Boss']]) : realLoad(...a));
    try {
      const { text } = await approve(w, request, card);
      assert.equal(reqs[0].status, 'approved');
      assert.deepEqual(saved.mappings, [], 'the link was not saved');
      assert.match(text, /Tên đã bị người khác liên kết, ghép tay/);
      assert.ok(w.rec.roleCalls.some((c) => c[0] === 'add' && c[2].includes('r-member')));
      assert.equal(ev('gate.link_skipped').length, 1);
      assert.equal(w.rec.dms.length, 1, 'the member is still told');
      assert.deepEqual(uidReleased, [[GUILD, 7]], 'the ID does not stay on a character the member is not linked to');
      assert.match(text, /ID game chưa lưu vì chưa liên kết nhân vật/);
    } finally {
      gameRoster.latest = realLatest;
      gameRoster.loadMappings = realLoad;
    }
  });
  it('a link that cannot be saved takes the ID back too and says so', async () => {
    const { w, request, card } = await sendRequest();
    saved.mapError = new Error('boom');
    const { text } = await approve(w, request, card);
    assert.equal(reqs[0].status, 'approved');
    assert.deepEqual(uidReleased, [[GUILD, 7]]);
    assert.match(text, /ID game chưa lưu vì chưa liên kết nhân vật/);
  });
  it('a link that is fine keeps the ID and shows no such note', async () => {
    const { w, request, card } = await sendRequest();
    const { text } = await approve(w, request, card);
    assert.deepEqual(uidReleased, []);
    assert.doesNotMatch(text, /chưa liên kết nhân vật/);
  });
  it('a free name still links when nobody took it', async () => {
    const { w, request, card } = await sendRequest();
    await approve(w, request, card);
    assert.equal(saved.mappings.length, 1);
  });
  it('saveMemberClass failing is noted on the card, the approval stands and the DM is still sent', async () => {
    const { w, request, card } = await sendRequest();
    saved.classError = new Error('db down');
    try {
      const { text } = await approve(w, request, card);
      assert.equal(reqs[0].status, 'approved');
      assert.match(text, /Chưa lưu được phái trong bot/);
      assert.equal(w.rec.dms.length, 1);
      assert.equal(ev('gate.class_failed').length, 1);
    } finally {
      saved.classError = null;
    }
  });
});

describe('🆔 game ID at the gate (required)', () => {
  const sendWith = async (uid, { w = world({ members: [[ADMIN, 'Quản Lý', []]] }), token = `r1-${VER}` } = {}) => {
    const s = interactionOf(w, { fields: { uid } });
    await gate.handle(s.i, ['gate', 'sendModal', token, '0']);
    return { w, s };
  };
  it('📨 Gửi yêu cầu opens a required ID form (customId within 100 chars even for the longest typed name)', async () => {
    const w = world();
    const { i, log } = interactionOf(w);
    await gate.handle(i, ['gate', 'send', `r1-${VER}`, '3']);
    const modal = assertModal(log.find((l) => l[0] === 'showModal')[1]);
    assert.equal(modal.custom_id, `gate:sendModal:r1-${VER}:3`);
    const input = modal.components[0].component;
    assert.deepEqual([input.custom_id, input.required, input.max_length], ['uid', true, 20]);
    assert.doesNotMatch(modal.components[0].label, /không bắt buộc/);
    const longest = ui.sendModal(ui.freeToken('Â'.repeat(32)), 24).toJSON();
    assert.ok(longest.custom_id.length <= 100, longest.custom_id.length);
    assert.equal(log.filter((l) => l[0] === 'deferUpdate').length, 0, 'a modal must be the first response');
  });
  it('the summary tells the member the ID is asked on send', () => {
    const view = ui.buildSummary({ token: `r1-${VER}`, classIndex: 0, name: 'Beta Boss', free: false, className: 'Thiết Y', styles: new Map() });
    assert.match(view.content, /nhập ID nhân vật trong game/);
  });
  it('no ID, a bad ID or a taken one: no request, no card, no role; the member sees why on the summary and can retry', async () => {
    uidHeld.set('99999', { name: 'Người Cũ', left: false });
    uidHeld.set('88888', { name: 'Người Đi', left: true });
    for (const [uid, pattern] of [['', /Cần nhập ID/], ['  ', /Cần nhập ID/], ['12ab', /chữ số/], ['1234', /chữ số/], ['99999', /thuộc nhân vật \*\*Người Cũ\*\*/], ['88888', /\*\*Người Đi\*\* \(đã rời bang\).*Đổi tên/]]) {
      const { w, s } = await sendWith(uid);
      assert.equal(reqs.length, 0, `[${uid}] no request`);
      assert.equal(w.rec.sent.length, 0, `[${uid}] no card`);
      assert.equal(w.rec.roleCalls.length, 0);
      const view = last(s.log);
      assert.match(view.content, pattern, uid);
      assert.equal(jsonRows(view)[0].components[0].custom_id, `gate:send:r1-${VER}:0`, 'the send button is still there');
    }
  });
  it('a valid ID is trimmed, stored on the request and shown on the managers card', async () => {
    const { w } = await sendWith(' 00123456789 ');
    assert.equal(reqs[0].gameUid, '00123456789');
    const card = w.rec.sent.filter((x) => x[0] === 'c-admin').pop()[1];
    assert.match(assertV2Message(card, { forCreate: true }).text, /🆔 ID game: 00123456789/);
  });
  const CLASH = { status: 'clash', text: 'ID này thuộc nhân vật **Người Đi** (đã rời bang) — có thể là cùng người đổi tên: dùng ✏️ Đổi tên.' };
  it('✅ Duyệt claims the ID for the linked character before anything is decided', async () => {
    const { w, request, card } = await sendRequest();
    const { i } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(request.status, 'approved');
    assert.deepEqual(uidClaims, [['Beta Boss', UID]]);
    assert.deepEqual(uidReleased, []);
  });
  it('✅ Duyệt on a clashing ID approves NOTHING: no role, no link, request cancelled without a cooldown, card says ID trùng, the member is told in DM', async () => {
    const { w, request, card } = await sendRequest();
    claimResult = CLASH; // somebody got the ID after the request was sent
    const before = w.rec.roleCalls.length;
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(request.status, 'cancelled');
    assert.equal(request.reason, gateService.UID_CLASH_REASON);
    assert.equal(w.rec.roleCalls.length, before, 'no role');
    assert.deepEqual(saved.mappings, []);
    assert.deepEqual(saved.classes, []);
    const text = textOf(last(log));
    assert.match(text, /ID game \*\*12345678\*\* bị trùng/);
    assert.match(text, /Người Đi\*\* \(đã rời bang\)/);
    assert.equal(assertV2Message(last(log)).buttons.length, 0, 'a decided card');
    assert.equal(w.rec.dms.length, 1);
    assert.match(w.rec.dms[0][1].content, /bị trùng/);
    assert.match(w.rec.dms[0][1].content, /gửi lại với ID đúng/);
    assert.equal(ev('gate.approve').length, 0);
    assert.equal(ev('gate.uid_clash').length, 1);
    const again = interactionOf(w);
    await gate.handle(again.i, ['gate', 'member']);
    assert.ok(last(again.log).components.length > 0, 'the picker opens again: no cooldown');
  });
  it('a manager-side clash does not use up the hourly limit either (the request was counted when sent)', async () => {
    const { w, request, card } = await sendRequest();
    assert.equal(gateService.requestBlockedUntil(GUILD, USER), null);
    for (let n = 0; n < 2; n++) gateService.noteRequest(GUILD, USER); // 3 counted now: at the limit
    assert.ok(gateService.requestBlockedUntil(GUILD, USER));
    claimResult = CLASH;
    const { i } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    assert.equal(gateService.requestBlockedUntil(GUILD, USER), null, 'one count was taken back');
  });
  it('a chosen character that already has a DIFFERENT ID is refused at send, with the summary to retry; its own ID is fine', async () => {
    uidOwn.set(gameRoster.nameKey('Beta Boss'), '55555555');
    const bad = await sendWith('12345678');
    assert.equal(reqs.length, 0);
    assert.equal(bad.w.rec.sent.length, 0);
    assert.match(last(bad.s.log).content, /đã có một ID game khác/);
    assert.match(last(bad.s.log).content, /nhập lại ID/);
    assert.equal(jsonRows(last(bad.s.log))[0].components[0].custom_id, `gate:send:r1-${VER}:0`);
    await sendWith('55555555', { w: world({ members: [[ADMIN, 'Quản Lý', []]] }) });
    assert.equal(reqs.length, 1);
  });
  it('✅ Duyệt on a clash with the DM closed: one public line in the gate channel instead', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]], dmFails: [USER] });
    const { request, card } = await sendRequest({ w });
    claimResult = CLASH;
    const { i } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'ok', String(request._id)]);
    const line = w.rec.sent.filter((x) => x[0] === 'c-gate').pop();
    assert.match(line[1].content, new RegExp(`<@${USER}> ID game`));
    assert.deepEqual(line[1].allowedMentions, { users: [USER] });
  });
  it('auto-approval on a clash: no role, no card to the managers, request cancelled, the member re-enters the ID on the summary and the retry works', async () => {
    config.gateAutoApprove = true;
    claimResult = CLASH;
    const first = await sendRequest();
    assert.equal(first.request.status, 'cancelled');
    assert.equal(first.request.reason, gateService.UID_CLASH_REASON);
    assert.equal(first.w.rec.roleCalls.length, 0);
    assert.equal(first.w.rec.sent.filter((x) => x[0] === 'c-admin').length, 0, 'managers are not bothered');
    assert.deepEqual(saved.mappings, []);
    const view = last(first.sendLog);
    assert.match(view.content, /Người Đi\*\* \(đã rời bang\)/);
    assert.match(view.content, /nhập lại ID/);
    assert.equal(jsonRows(view)[0].components[0].custom_id, `gate:send:r1-${VER}:0`);
    claimResult = { status: 'set', characterId: 7, created: false };
    const w = first.w;
    const retry = interactionOf(w, { fields: { uid: '99999999' } });
    await gate.handle(retry.i, ['gate', 'sendModal', `r1-${VER}`, '0']);
    assert.equal(reqs.at(-1).status, 'approved');
    assert.ok(w.rec.roleCalls.some((c) => c[0] === 'add' && c[2].includes('r-member')));
  });
  it('clashes do not burn the 3-requests-per-hour limit', async () => {
    config.gateAutoApprove = true;
    claimResult = CLASH;
    const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
    for (let n = 0; n < 5; n++) {
      const s = interactionOf(w);
      await gate.handle(s.i, ['gate', 'sendModal', `r1-${VER}`, '0']);
      assert.match(last(s.log).content, /nhập lại ID/, `attempt ${n}`);
    }
    assert.equal(gateService.requestBlockedUntil(GUILD, USER), null);
    claimResult = { status: 'set', characterId: 7, created: false };
    const ok = interactionOf(w);
    await gate.handle(ok.i, ['gate', 'sendModal', `r1-${VER}`, '0']);
    assert.equal(reqs.at(-1).status, 'approved');
  });
  it('a failed role call after the ID was claimed takes the ID back (only when this approval set it)', async () => {
    for (const [status, released] of [['set', [[GUILD, 7]]], ['same', []]]) {
      uidReleased = [];
      claimResult = { status, characterId: 7, created: false };
      reqs = [];
      const w = world({ members: [[ADMIN, 'Quản Lý', []]], roleFails: { add: ['r-member'] } });
      const { request, card } = await sendRequest({ w });
      const { i } = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
      await gate.handle(i, ['gate', 'ok', String(request._id)]);
      assert.equal(reqs[0].status, 'pending', 'a retry is possible');
      assert.deepEqual(uidReleased, released, status);
    }
  });
  it("the member's own ID, already typed on the roster row by a manager, is accepted for that very character", async () => {
    uidHeld.set('55555', { name: 'Beta Boss', left: false }); // pick r1 = Beta Boss
    const { s } = await sendWith('55555');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].gameUid, '55555');
    uidHeld.set('66666', { name: 'Gamma', left: false });
    reqs = [];
    const other = await sendWith('66666', { w: world({ members: [[ADMIN, 'Quản Lý', []]] }) });
    assert.equal(reqs.length, 0, "another character's ID is still refused");
    assert.match(last(other.s.log).content, /Gamma/);
  });
  it('a card without an ID (an old request) shows no ID line', () => {
    const texts = ui.approvalTexts({ request: { discordId: USER, gameName: 'X', gameUid: null }, member: { displayName: 'M', createdAt: new Date(), joinedAt: null }, classText: 'c' });
    assert.doesNotMatch(texts.join('\n'), /ID game/);
  });
});

describe('🤖 auto-approval (a roster name) and ↩️ Thu hồi', () => {
  beforeEach(() => {
    config.gateAutoApprove = true;
  });

  it('a roster name nobody holds: approved on send by the bot (roles, link, DM), the managers get a green card with only ↩️ Thu hồi', async () => {
    const { w, request, card, sendLog } = await sendRequest();
    assert.equal(request.status, 'approved');
    assert.equal(request.decidedBy, 'auto');
    assert.ok(w.rec.roleCalls.some((c) => c[0] === 'add' && c[1] === USER && c[2].includes('r-member')));
    assert.deepEqual(saved.mappings, [[{ discordId: USER, gameName: 'Beta Boss', displayName: 'Beta Boss' }]]);
    assert.equal(w.rec.dms.length, 1);
    const v2 = assertV2Message(card, { forCreate: true });
    assert.match(v2.text, /Bot tự duyệt/);
    assert.deepEqual(v2.buttons.map((b) => b.custom_id), [`gate:rv:${request._id}`]);
    assert.equal(card.components[0].toJSON().accent_color, 0x2ecc71);
    assert.match(last(sendLog).content, /Bạn đã vào bang/);
    assert.deepEqual(ev('gate.approve').map((e) => [e.by, e.auto, e.member]), [['auto', true, USER]]);
  });
  it('a typed name (not in the roster) still waits for a manager: pending card with ✅ / ❌, no role', async () => {
    const w = world({ members: [[ADMIN, 'Quản Lý', []]] });
    const s = interactionOf(w);
    await gate.handle(s.i, ['gate', 'sendModal', 'f-Tên Lạ', '0']);
    assert.equal(reqs[0].status, 'pending');
    assert.equal(w.rec.roleCalls.length, 0);
    const card = w.rec.sent.filter((x) => x[0] === 'c-admin').pop()[1];
    assert.deepEqual(assertV2Message(card, { forCreate: true }).buttons.map((b) => b.custom_id), [`gate:ok:${reqs[0]._id}`, `gate:no:${reqs[0]._id}`]);
    assert.match(last(s.log).content, /Đã gửi yêu cầu/);
  });
  it('an auto-approval that cannot finish (member role not chosen) falls back to the manual card with the reason; nothing changed', async () => {
    config.memberRoleId = null;
    const { w, request, card } = await sendRequest();
    assert.equal(request.status, 'pending');
    assert.equal(w.rec.roleCalls.length, 0);
    const v2 = assertV2Message(card, { forCreate: true });
    assert.match(v2.text, /Bot chưa tự duyệt được/);
    assert.deepEqual(v2.buttons.map((b) => b.custom_id), [`gate:ok:${request._id}`, `gate:no:${request._id}`]);
  });
  it('↩️ Thu hồi: admin only, asks a reason in a modal, then removes the member role, marks revoked, DMs the reason, card red', async () => {
    const { w, request, card } = await sendRequest();
    const outsider = interactionOf(w, { user: USER, message: cardMessageOf(card) });
    await gate.handle(outsider.i, ['gate', 'rv', String(request._id)]);
    assert.match(outsider.log[0][1].content, /quyền|quản lý/i);
    const ask = interactionOf(w, { user: ADMIN, admin: true, message: cardMessageOf(card) });
    await gate.handle(ask.i, ['gate', 'rv', String(request._id)]);
    assert.equal(assertModal(ask.log.find((l) => l[0] === 'showModal')[1]).custom_id, `gate:rvModal:${request._id}`);
    const before = w.rec.roleCalls.length;
    request.gameUid = request.gameUid || '12345678'; // the approval gave this ID
    const { i, log } = interactionOf(w, { user: ADMIN, admin: true, fields: { reason: 'Không phải người trong bang' }, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'rvModal', String(request._id)]);
    const removed = w.rec.roleCalls.slice(before).filter((c) => c[0] === 'remove');
    assert.equal(removed.length, 1);
    assert.ok(removed[0][2].includes('r-member'));
    assert.equal(reqs[0].status, 'revoked');
    assert.equal(reqs[0].decidedBy, ADMIN);
    assert.match(w.rec.dms.at(-1)[1].content, /Lý do: Không phải người trong bang/);
    assert.deepEqual(saved.unlinked, [[GUILD, [USER]]], 'the game name is freed for its real owner');
    assert.deepEqual(uidReleased.filter((r) => r[0] === 'revoke'), [['revoke', GUILD, request.gameUid, request.gameName, USER]], 'the ID it gave is taken back');
    assert.match(assertV2Message(last(log)).text, /🆔 Đã gỡ ID game `12345678`/);
    const done = last(log);
    assert.match(assertV2Message(done).text, new RegExp(`↩️ <@${ADMIN}> đã thu hồi`));
    assert.equal(done.components[0].toJSON().accent_color, 0xe74c3c);
    const again = interactionOf(w, { user: ADMIN, admin: true, fields: { reason: '' }, message: cardMessageOf(card) });
    await gate.handle(again.i, ['gate', 'rvModal', String(request._id)]);
    assert.match(last(again.log, 'followUp').content, /đã bị thu hồi rồi/);
  });
});

describe('👤 role Người lạ (strangerRoleId)', () => {
  beforeEach(() => {
    config.strangerRoleId = 'r-stranger';
  });
  const strangerWorld = (opts = {}) => world({ rolePositions: { 'r-stranger': 1 }, ...opts });

  it('joining with no role: the bot gives the stranger role (logged); someone who already has a role, a bot, or a role the bot cannot hand out is left alone', async () => {
    const w = strangerWorld();
    const m = w.mk(sid(70), 'Newcomer');
    await onGateMemberAdd(m);
    assert.deepEqual(w.rec.roleCalls.map((c) => c.slice(0, 3)), [['add', sid(70), ['r-stranger']]]);
    assert.ok(m.roles.cache.has('r-stranger'));
    assert.deepEqual(ev('gate.join').map((e) => e.stranger), ['added']);
    const back = w.mk(sid(71), 'Rejoiner', ['r-member']);
    await onGateMemberAdd(back);
    assert.equal(w.rec.roleCalls.length, 1, 'a member who already has roles is not touched');
    const high = strangerWorld({ rolePositions: { 'r-stranger': 50 } });
    await onGateMemberAdd(high.mk(sid(72), 'X'));
    assert.deepEqual(high.rec.roleCalls, []);
    assert.equal(ev('gate.join').at(-1).stranger, 'hierarchy');
    config.strangerRoleId = null;
    const off = strangerWorld();
    await onGateMemberAdd(off.mk(sid(73), 'Y'));
    assert.deepEqual(off.rec.roleCalls, [], 'no stranger role configured: nothing');
  });
  it('approval (auto or ✅) removes the stranger role together with the member role being given', async () => {
    config.gateAutoApprove = true;
    const w = strangerWorld({ members: [[ADMIN, 'Quản Lý', []], [USER, 'Beta Boss', ['r-stranger']]] });
    const { request } = await sendRequest({ w });
    assert.equal(request.status, 'approved');
    assert.ok(w.rec.roleCalls.some((c) => c[0] === 'remove' && c[2].includes('r-stranger')));
    assert.ok(!w.guild.members.cache.get(USER).roles.cache.has('r-stranger'));
    assert.ok(w.guild.members.cache.get(USER).roles.cache.has('r-member'));
  });
  it('↩️ Thu hồi gives the stranger role back; ❌ Từ chối makes sure the person still has it', async () => {
    config.gateAutoApprove = true;
    const w = strangerWorld({ members: [[ADMIN, 'Quản Lý', []], [USER, 'Beta Boss', ['r-stranger']]] });
    const { request, card } = await sendRequest({ w });
    const { i } = interactionOf(w, { user: ADMIN, admin: true, fields: { reason: '' }, message: cardMessageOf(card) });
    await gate.handle(i, ['gate', 'rvModal', String(request._id)]);
    const member = w.guild.members.cache.get(USER);
    assert.ok(member.roles.cache.has('r-stranger') && !member.roles.cache.has('r-member'));

    config.gateAutoApprove = false;
    const w2 = strangerWorld({ members: [[ADMIN, 'Quản Lý', []]] });
    const sent = await sendRequest({ w: w2 });
    const r = interactionOf(w2, { user: ADMIN, admin: true, fields: { reason: '' }, message: cardMessageOf(sent.card) });
    await gate.handle(r.i, ['gate', 'noModal', String(sent.request._id)]);
    assert.ok(w2.guild.members.cache.get(USER).roles.cache.has('r-stranger'), 'refused: still a stranger');
  });
  it('the /setup gate health names the stranger role; one with power or the member role itself is flagged', () => {
    const w = strangerWorld();
    assert.ok(gateHealth(config, w.guild).some((l) => l.ok && /Người lạ/.test(l.text)));
    assert.equal(require('../src/bot/gateRoles').roleProblem(w.guild, 'r-member', { ...config, strangerRoleId: 'r-member' }, 'stranger'), 'same_as_member');
  });
});
