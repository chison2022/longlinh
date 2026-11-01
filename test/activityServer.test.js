// The Activity web server: routes tested over real HTTP on localhost, Discord REST replaced by an injected fetch, PGlite for data.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const { createApp } = require('../activity/app');
const { schemaProblems } = require('../activity/server');
const { isManager } = require('../activity/adminRule');
const { clearConfigCache } = require('../src/services/guildConfigService');
const rules = require('../src/services/lineupRules');
const { seedWar, G } = require('./lineupFixture');

const ADMIN_ROLE = '700000000000000001';
const SHAPE = { groupCount: 2, partiesPerGroup: 5, partySize: 6 };
// token -> who: user id + the roles of the member in guild G (null = not in the guild)
const TOKENS = {
  'tok-admin-aaaaaaaa': { id: '555000000000000001', roles: [ADMIN_ROLE] },
  'tok-perm-bbbbbbbbb': { id: '555000000000000002', roles: ['700000000000000009'] }, // role with Manage Server
  'tok-owner-ccccccc': { id: '555000000000000003', roles: [] }, // guild owner
  'tok-plain-dddddddd': { id: '100000000000000001', roles: [] }, // member 1 of the war
  'tok-outsider-eeee': { id: '555000000000000009', roles: null },
};
const discordCalls = [];
const cdnCalls = [];
const EMOJI_TY = '900000000000000001'; // matches the class Thiết Y by slug
const EMOJI_TV = '900000000000000002'; // matches Tố Vấn by initials

function fakeDiscord(url, options = {}) {
  discordCalls.push(String(url));
  const json = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 404, json: async () => body });
  const auth = (options.headers && options.headers.Authorization) || '';
  const u = String(url);
  if (u.endsWith('/oauth2/token')) {
    const form = String(options.body);
    return form.includes('code=good') ? json({ access_token: 'tok-admin-aaaaaaaa' }) : json({}, false);
  }
  if (u.startsWith('https://cdn.discordapp.com/emojis/')) {
    cdnCalls.push(u);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    return Promise.resolve({ ok: !u.includes('999999999999999999'), status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  }
  if (auth.startsWith('Bot ')) {
    if (u.endsWith(`/guilds/${G}/emojis`)) return json([{ id: EMOJI_TY, name: 'thiety', animated: false, roles: [] }, { id: EMOJI_TV, name: 'TV', animated: false, roles: [] }, { id: '900000000000000003', name: 'locked', roles: ['1'] }]);
    if (u.endsWith(`/guilds/${G}`)) return json({ id: G, owner_id: TOKENS['tok-owner-ccccccc'].id });
    if (u.endsWith(`/guilds/${G}/roles`)) return json([{ id: G, permissions: '0' }, { id: '700000000000000009', permissions: String(0x20) }, { id: ADMIN_ROLE, permissions: '0' }]);
    return json({}, false);
  }
  const who = TOKENS[auth.replace('Bearer ', '')];
  if (!who) return json({}, false);
  if (u.endsWith('/users/@me')) return json({ id: who.id, username: `user${who.id.slice(-2)}`, global_name: null });
  if (u.endsWith(`/users/@me/guilds/${G}/member`)) return who.roles ? json({ roles: who.roles }) : json({}, false);
  return json({}, false);
}

let server;
let base;
let w;
before(async () => {
  await setupDb();
  const app = createApp({ fetchFn: fakeDiscord, env: { CLIENT_ID: '999', CLIENT_SECRET: 'secret', DISCORD_TOKEN: 'bot-token' }, staticDir: __dirname });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
beforeEach(async () => {
  await resetDb();
  clearConfigCache();
  discordCalls.length = 0;
  cdnCalls.length = 0;
  w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà'] });
  await db.q(`update guilds set settings = $2 where id = $1`, [G, JSON.stringify({ adminRoleIds: [ADMIN_ROLE], classes: ['Thiết Y', 'Tố Vấn', 'Huyết Hà'], groupCount: 2 })]);
  // member ids of the seed are sid(1..3) = 100000000000000001..3, the "plain" token is member 1
});

async function call(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('auth', () => {
  it('config is public, other routes need a token, a bad token is refused', async () => {
    assert.deepEqual((await call('GET', '/api/config')).body, { clientId: '999' });
    assert.equal((await call('GET', `/api/lineup/${w.warId}`)).status, 401);
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-nobody-xxxxxxx')).status, 401);
  });
  it('/api/token exchanges the code through Discord and returns only the access token', async () => {
    const ok = await call('POST', '/api/token', null, { code: 'good' });
    assert.deepEqual(ok.body, { access_token: 'tok-admin-aaaaaaaa' });
    assert.equal((await call('POST', '/api/token', null, { code: 'bad' })).status, 401);
    assert.equal((await call('POST', '/api/token', null, {})).status, 400);
  });
  it('a user who is not in the war guild gets 403, an unknown war 404', async () => {
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-outsider-eeee')).status, 403);
    assert.equal((await call('GET', '/api/lineup/ffffffffffffffffffffffff', 'tok-admin-aaaaaaaa')).status, 404);
    assert.equal((await call('GET', '/api/lineup/zzz', 'tok-admin-aaaaaaaa')).status, 404);
  });
});

describe('hardening', () => {
  it('answers carry nosniff and a CSP that only lets Discord frame the page', async () => {
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const csp = res.headers.get('content-security-policy');
    assert.equal(csp, "default-src 'self'; frame-ancestors https://discord.com https://*.discordsays.com");
    assert.doesNotMatch(csp, /unsafe-inline/);
  });
  it('bad JSON is a 400 and a huge body a 413, not a 500', async () => {
    const post = (body) => fetch(`${base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post(JSON.stringify({ code: 'x'.repeat(100000) }))).status, 413);
  });
  it('a refused token is remembered: the same bad token calls Discord once', async () => {
    discordCalls.length = 0;
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-garbage-1234567')).status, 401);
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-garbage-1234567')).status, 401);
    assert.equal(discordCalls.filter((u) => u.endsWith('/users/@me')).length, 1);
  });
  it('an IP limit runs before the token check', async () => {
    const app = createApp({ fetchFn: fakeDiscord, env: { CLIENT_ID: '999', CLIENT_SECRET: 's' }, staticDir: __dirname, limits: { ip: 3 } });
    const s2 = http.createServer(app);
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${s2.address().port}/api/lineup/${w.warId}`;
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await fetch(url, { headers: { Authorization: `Bearer random-token-${i}-xxxxx` } })).status);
      assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    } finally {
      await new Promise((r) => s2.close(r));
    }
  });
  it('a saved layout of an older shape is fitted on read, so the client can save it back', async () => {
    const wide = { groups: [rules.emptyLayout(SHAPE).groups[0], rules.emptyLayout(SHAPE).groups[0], rules.emptyLayout(SHAPE).groups[0]] };
    wide.groups[0][0] = [w.ids[0]];
    wide.groups[2][0] = [w.ids[1]];
    await db.q('insert into war_lineups (war_id, guild_id, layout, version) values ($1, $2, $3, 4)', [w.warId, G, JSON.stringify(wide)]);
    const r = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    assert.equal(r.body.lineup.groups.length, 2);
    assert.deepEqual(r.body.lineup.groups[0][0], [w.ids[0]]);
    const saved = await call('PUT', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa', { layout: r.body.lineup, version: r.body.version });
    assert.equal(saved.status, 200);
  });
  it('schemaProblems names what the bot has not migrated yet', async () => {
    assert.deepEqual(await schemaProblems(), []);
    await db.q('alter table war_lineups drop column claimed_at');
    assert.deepEqual(await schemaProblems(), ['war_lineups.claimed_at']);
    await db.q('alter table war_lineups add column claimed_at timestamptz');
    await db.q('drop table war_lineups');
    assert.deepEqual(await schemaProblems(), ['war_lineups']);
    await db.q('create table war_lineups (war_id char(24) primary key references war_events (id) on delete cascade, guild_id text not null, layout jsonb not null, version int not null default 0, updated_by text, updated_at timestamptz not null default now(), publish_requested_at timestamptz, publish_requested_by text, published_version int, published_at timestamptz, publish_error text, published_layout jsonb, claimed_at timestamptz)');
  });
});

describe('class emojis', () => {
  it('members and the legend carry the guild emoji the bot would pick; a class without one gets null', async () => {
    const r = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    const byName = Object.fromEntries(r.body.members.map((m) => [m.className, m.classEmoji]));
    assert.deepEqual(byName, { 'Tố Vấn': EMOJI_TV, 'Thiết Y': EMOJI_TY, 'Huyết Hà': null });
    const legend = Object.fromEntries(r.body.classes.map((c) => [c.name, c]));
    assert.equal(legend['Thiết Y'].emojiId, EMOJI_TY);
    assert.equal(legend['Thiết Y'].tag, 'TY');
    assert.equal(legend['Huyết Hà'].emojiId, null);
    assert.match(legend['Tố Vấn'].color, /^#[0-9a-f]{6}$/);
  });
  it('the settings override applies: :none: gives no emoji', async () => {
    await db.q('update guilds set settings = settings || $2::jsonb where id = $1', [G, JSON.stringify({ classEmojis: [{ className: 'Tố Vấn', emoji: 'none' }] })]);
    clearConfigCache();
    const r = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    assert.equal(r.body.classes.find((c) => c.name === 'Tố Vấn').emojiId, null);
  });
  it('without a bot token every class falls back to its colour (emojiId null)', async () => {
    const app = createApp({ fetchFn: fakeDiscord, env: { CLIENT_ID: '999', CLIENT_SECRET: 's' }, staticDir: __dirname });
    const s2 = http.createServer(app);
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${s2.address().port}/api/lineup/${w.warId}`, { headers: { Authorization: 'Bearer tok-admin-aaaaaaaa' } });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(body.members.every((m) => m.classEmoji === null));
    } finally {
      await new Promise((r) => s2.close(r));
    }
  });
  it('/api/emoji serves only class emojis already resolved, without a token, as cached PNG', async () => {
    const app = createApp({ fetchFn: fakeDiscord, env: { CLIENT_ID: '999', CLIENT_SECRET: 's', DISCORD_TOKEN: 'bot-token' }, staticDir: __dirname }); // fresh: nothing resolved yet
    const s3 = http.createServer(app);
    await new Promise((r) => s3.listen(0, '127.0.0.1', r));
    const root = `http://127.0.0.1:${s3.address().port}`;
    const img = (id) => fetch(`${root}/api/emoji/${id}`);
    assert.equal((await img('abc')).status, 400);
    assert.equal((await img(EMOJI_TY)).status, 404, 'not resolved yet: no open proxy');
    assert.equal((await img('900000000000000003')).status, 404, 'a role-locked emoji of the guild is never a class emoji');
    await fetch(`${root}/api/lineup/${w.warId}`, { headers: { Authorization: 'Bearer tok-admin-aaaaaaaa' } });
    const ok = await img(EMOJI_TY);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('cache-control'), 'public, max-age=86400');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()).subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await img(EMOJI_TY);
    assert.equal(cdnCalls.filter((u) => u.includes(EMOJI_TY)).length, 1, 'the second request comes from memory');
    assert.match(cdnCalls[0], /\.png\?size=48$/);
    await new Promise((r) => s3.close(r));
  });
});

describe('admin rule (pure)', () => {
  it('admin role, Manage Server / Administrator role, owner; @everyone applies to all', () => {
    const guild = { id: 'g', ownerId: 'o', roles: [{ id: 'g', permissions: '0' }, { id: 'r1', permissions: String(0x8) }] };
    assert.equal(isManager({ userId: 'u', member: { roles: ['a'] }, guild, adminRoleIds: ['a'] }), true);
    assert.equal(isManager({ userId: 'u', member: { roles: ['r1'] }, guild }), true);
    assert.equal(isManager({ userId: 'o', member: { roles: [] }, guild }), true);
    assert.equal(isManager({ userId: 'u', member: { roles: [] }, guild }), false);
    assert.equal(isManager({ userId: 'u', member: { roles: [] }, guild: { ...guild, roles: [{ id: 'g', permissions: String(0x20) }] } }), true);
    assert.equal(isManager({ userId: 'u', member: { roles: [] }, guild: null }), false);
  });
});

describe('GET', () => {
  it('wars of the guild, newest first, with canEdit', async () => {
    const r = await call('GET', `/api/wars?guild=${G}`, 'tok-admin-aaaaaaaa');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.wars.map((x) => x.id), [w.warId]);
    assert.equal(r.body.canEdit, true);
    assert.equal((await call('GET', `/api/wars?guild=${G}`, 'tok-plain-dddddddd')).body.canEdit, false);
    assert.equal((await call('GET', '/api/wars', 'tok-admin-aaaaaaaa')).status, 400);
  });
  it('lineup: members in sign-up order with class colour, layout shape, me, canEdit, version', async () => {
    const r = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.members.map((m) => m.id), w.ids);
    assert.equal(r.body.members[0].className, 'Tố Vấn');
    assert.match(r.body.members[0].classColor, /^#[0-9a-f]{6}$/);
    assert.deepEqual(r.body.layout, SHAPE);
    assert.deepEqual(r.body.lineup, rules.emptyLayout(SHAPE));
    assert.equal(r.body.version, 0);
    assert.equal(r.body.canEdit, true);
    assert.equal(r.body.me.id, TOKENS['tok-admin-aaaaaaaa'].id);
    assert.equal(r.body.publish.state, 'none');
    assert.equal((await call('GET', `/api/lineup/${w.warId}/version`, 'tok-admin-aaaaaaaa')).body.version, 0);
  });
  it('a Manage Server role and the guild owner are managers; a plain member is read-only', async () => {
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-perm-bbbbbbbbb')).body.canEdit, true);
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-owner-ccccccc')).body.canEdit, true);
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-plain-dddddddd')).body.canEdit, false);
  });
  it('the token and the member are cached (one Discord call per kind for repeated requests)', async () => {
    await call('GET', `/api/lineup/${w.warId}/version`, 'tok-admin-aaaaaaaa');
    discordCalls.length = 0;
    await call('GET', `/api/lineup/${w.warId}/version`, 'tok-admin-aaaaaaaa');
    assert.deepEqual(discordCalls, []);
  });
});

describe('PUT and publish', () => {
  const layoutOf = (...ids) => {
    const l = rules.emptyLayout(SHAPE);
    l.groups[0][0] = ids;
    return l;
  };
  it('a manager saves, a stale version gets 409 with the current lineup, a plain member gets 403', async () => {
    const ok = await call('PUT', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa', { layout: layoutOf(w.ids[0], w.ids[1]), version: 0 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.version, 1);
    const stale = await call('PUT', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa', { layout: layoutOf(w.ids[2]), version: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.version, 1);
    assert.deepEqual(stale.body.current.layout.groups[0][0], [w.ids[0], w.ids[1]]);
    assert.equal((await call('PUT', `/api/lineup/${w.warId}`, 'tok-plain-dddddddd', { layout: layoutOf(w.ids[2]), version: 1 })).status, 403);
    assert.equal((await call('PUT', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa', { layout: { groups: [] }, version: 1 })).status, 400);
    const read = await call('GET', `/api/lineup/${w.warId}`, 'tok-plain-dddddddd');
    assert.deepEqual(read.body.lineup.groups[0][0], [w.ids[0], w.ids[1]]);
    assert.equal(read.body.version, 1);
  });
  it('publish is for managers, marks the request pending and is shown in the lineup', async () => {
    assert.equal((await call('POST', `/api/lineup/${w.warId}/publish`, 'tok-plain-dddddddd', {})).status, 403);
    const r = await call('POST', `/api/lineup/${w.warId}/publish`, 'tok-admin-aaaaaaaa', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.publish.state, 'pending');
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-plain-dddddddd')).body.publish.state, 'pending');
  });
  it('another guild\'s war is not reachable even with a valid token', async () => {
    const other = await seedWar({ guildId: '800000000000000002', classes: ['Tố Vấn'] });
    assert.equal((await call('GET', `/api/lineup/${other.warId}`, 'tok-admin-aaaaaaaa')).status, 403);
  });
});
