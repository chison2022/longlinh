// The Activity web server: routes tested over real HTTP on localhost, Discord REST replaced by an injected fetch, PGlite for both databases
// (the main one only seeds the war the bot snapshots; the server itself reads the side database alone).
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../src/db');
const side = require('../src/sideDb');
const { setupDb, resetDb } = require('./pgdb');
const { setupSide, resetSide } = require('./sidedb');
const { createApp } = require('../activity/app');
const { schemaProblems } = require('../activity/server');
const { isManager } = require('../activity/adminRule');
const rules = require('../src/services/lineupRules');
const { seedWar, snapshot, G, ADMIN_ROLE } = require('./lineupFixture');

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
const EMOJI_TY = '900000000000000001'; // the icon of the class Thiết Y in the guild snapshot
const EMOJI_TV = '900000000000000002'; // the icon of Tố Vấn
const GUILD_CLASSES = [{ name: 'Thiết Y', tag: 'TY', emojiId: EMOJI_TY }, { name: 'Tố Vấn', tag: 'TV', emojiId: EMOJI_TV }, { name: 'Huyết Hà', tag: 'HH', emojiId: null }];

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
  await setupSide();
  const app = createApp({ fetchFn: fakeDiscord, env: { CLIENT_ID: '999', CLIENT_SECRET: 'secret' }, staticDir: __dirname });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
beforeEach(async () => {
  await resetDb();
  await resetSide();
  discordCalls.length = 0;
  cdnCalls.length = 0;
  w = await seedWar({ classes: ['Tố Vấn', 'Thiết Y', 'Huyết Hà'] });
  await snapshot(w, { classes: GUILD_CLASSES });
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
  it('failed token lookups are counted apart: past the limit this IP gets 429 and Discord is not asked any more', async () => {
    const app = createApp({ fetchFn: fakeDiscord, env: { CLIENT_ID: '999', CLIENT_SECRET: 's' }, staticDir: __dirname, limits: { miss: 3 } });
    const s4 = http.createServer(app);
    await new Promise((r) => s4.listen(0, '127.0.0.1', r));
    try {
      discordCalls.length = 0;
      const url = `http://127.0.0.1:${s4.address().port}/api/lineup/${w.warId}`;
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await fetch(url, { headers: { Authorization: `Bearer garbage-token-${i}-xxxxxx` } })).status);
      assert.deepEqual(codes, [401, 401, 401, 429, 429]);
      assert.equal(discordCalls.filter((u) => u.endsWith('/users/@me')).length, 3, 'the 4th and 5th never reached Discord');
      // a good token from the same IP is held back too while the window lasts (the IP, not the token, is what Discord would ban)
      assert.equal((await fetch(url, { headers: { Authorization: 'Bearer tok-admin-aaaaaaaa' } })).status, 429);
    } finally {
      await new Promise((r) => s4.close(r));
    }
  });
  it('publishing is refused while registration is open again; fine once the war is locked', async () => {
    await side.q("update act_wars set status = 'open' where war_id = $1", [w.warId]);
    const open = await call('POST', `/api/lineup/${w.warId}/publish`, 'tok-admin-aaaaaaaa', {});
    assert.equal(open.status, 409);
    assert.match(open.body.error, /mở lại/);
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa')).body.war.status, 'open', 'the board knows');
    await side.q("update act_wars set status = 'locked' where war_id = $1", [w.warId]);
    assert.equal((await call('POST', `/api/lineup/${w.warId}/publish`, 'tok-admin-aaaaaaaa', {})).status, 200);
  });
  it('a saved layout of an older shape is fitted on read, so the client can save it back', async () => {
    const wide = { groups: [rules.emptyLayout(SHAPE).groups[0], rules.emptyLayout(SHAPE).groups[0], rules.emptyLayout(SHAPE).groups[0]] };
    wide.groups[0][0] = [w.ids[0]];
    wide.groups[2][0] = [w.ids[1]];
    await side.q('insert into act_lineups (war_id, guild_id, layout, version) values ($1, $2, $3, 4)', [w.warId, G, JSON.stringify(wide)]);
    const r = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    assert.equal(r.body.lineup.groups.length, 2);
    assert.deepEqual(r.body.lineup.groups[0][0], [w.ids[0]]);
    const saved = await call('PUT', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa', { layout: r.body.lineup, version: r.body.version });
    assert.equal(saved.status, 200);
  });
  it('schemaProblems names what the bot has not created yet', async () => {
    assert.deepEqual(await schemaProblems(), []);
    await side.q('alter table act_lineups drop column claimed_at');
    assert.deepEqual(await schemaProblems(), ['act_lineups.claimed_at']);
    await side.q('alter table act_lineups add column claimed_at timestamptz');
    await side.q('drop table act_tasks');
    assert.deepEqual(await schemaProblems(), ['act_tasks']);
    await side.ensureSideSchema(); // the bot's start brings it back
    assert.deepEqual(await schemaProblems(), []);
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
  it('/api/emoji serves only the class emojis of the guild snapshot, without a token, as cached PNG', async () => {
    const img = (id) => fetch(`${base}/api/emoji/${id}`);
    assert.equal((await img('abc')).status, 400);
    assert.equal((await img('900000000000000003')).status, 404, 'not a class emoji of any guild: no open proxy');
    const ok = await img(EMOJI_TY);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('cache-control'), 'public, max-age=86400');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()).subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await img(EMOJI_TY);
    assert.equal(cdnCalls.filter((u) => u.includes(EMOJI_TY)).length, 1, 'the second request comes from memory');
    assert.match(cdnCalls[0], /\.png\?size=48$/);
  });
});

describe('tasks API', () => {
  it('GET carries tasks, partyNotes, the task list and the default task of each member', async () => {
    await side.q("update act_members set role_pref = 'vattu' where member_key = $1", [w.ids[0]]);
    const r = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    assert.deepEqual(r.body.taskList.map((t) => t.key), ['def', 'cong', 'daytru', 'vattu']);
    assert.equal(r.body.members[0].taskDefault, 'vattu');
    assert.equal(r.body.members[1].taskDefault, null);
    assert.deepEqual([r.body.tasks, r.body.partyNotes], [{}, {}]);
  });
  it('PUT saves tasks and notes (mentions stripped) and a viewer reads them; an unknown task is 400', async () => {
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[0][0] = [w.ids[0]];
    const ok = await call('PUT', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa', { layout, version: 0, tasks: { [w.ids[0]]: 'def' }, partyNotes: { '0-0': 'giữ trụ @everyone' } });
    assert.equal(ok.status, 200);
    const read = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    assert.deepEqual(read.body.tasks, { [w.ids[0]]: 'def' });
    assert.deepEqual(read.body.partyNotes, { '0-0': 'giữ trụ everyone' });
    const bad = await call('PUT', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa', { layout, version: 1, tasks: { [w.ids[0]]: 'c:nope' } });
    assert.equal(bad.status, 400);
  });
  it('custom task CRUD is for managers of the guild only', async () => {
    const add = (token, body) => call('POST', '/api/tasks', token, { guild: G, ...body });
    assert.equal((await add('tok-plain-dddddddd', { label: 'Cướp cờ' })).status, 403);
    assert.equal((await add('tok-outsider-eeee', { label: 'Cướp cờ' })).status, 403);
    assert.equal((await call('POST', '/api/tasks', 'tok-admin-aaaaaaaa', { label: 'x' })).status, 400, 'no guild');
    const created = await add('tok-admin-aaaaaaaa', { label: 'Cướp cờ', emoji: '🚩' });
    assert.equal(created.status, 200);
    const key = created.body.taskList.find((t) => !t.builtin).key;
    assert.equal((await call('PUT', `/api/tasks/${encodeURIComponent(key)}`, 'tok-plain-dddddddd', { guild: G, label: 'x' })).status, 403);
    const renamed = await call('PUT', `/api/tasks/${encodeURIComponent(key)}`, 'tok-admin-aaaaaaaa', { guild: G, label: 'Cờ', emoji: '' });
    assert.equal(renamed.body.taskList.find((t) => !t.builtin).label, 'Cờ');
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa')).body.taskList.length, 5, 'the list');
    assert.equal((await call('DELETE', `/api/tasks/${encodeURIComponent(key)}?guild=${G}`, 'tok-plain-dddddddd')).status, 403);
    const del = await call('DELETE', `/api/tasks/${encodeURIComponent(key)}?guild=${G}`, 'tok-admin-aaaaaaaa');
    assert.equal(del.body.taskList.length, 4);
    assert.equal((await call('DELETE', '/api/tasks/def?guild=' + G, 'tok-admin-aaaaaaaa')).status, 404, 'built-ins are not deletable');
  });
});

describe('in-game names and Tuyến Khiên groups in the payload', () => {
  it('members carry the in-game name (Discord name beside it), linked flag and the link groups', async () => {
    await db.q("insert into game_characters (guild_id, name, name_key, class_name) values ($1, 'Kiếm Tâm', 'kiemtam', 'Tố Vấn')", [G]);
    await db.q("insert into character_links (character_id, member_id, guild_id, source) select g.id, m.id, $1, 'admin' from game_characters g, discord_members m where g.name = 'Kiếm Tâm' and m.discord_id = $2", [G, w.ids[0]]);
    await db.q('update discord_members set tk_partners = $2 where discord_id = $1', [w.ids[1], [w.ids[2]]]);
    await snapshot(w, { classes: GUILD_CLASSES }); // a re-lock: the board sees the links from now on
    const r = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    const [a, b] = r.body.members;
    assert.deepEqual([a.name, a.discordName, a.linked], ['Kiếm Tâm', 'Người 1', true]);
    assert.ok(!('power' in a));
    assert.deepEqual([b.name, b.discordName, b.linked], ['Người 2', 'Người 2', false]);
    assert.deepEqual(r.body.linkGroups, [[w.ids[1], w.ids[2]].sort()]);
  });
});

describe('admin rule (pure)', () => {
  it('the owner, a configured admin role, or a Manage Server / Administrator role of the snapshot; nobody else', () => {
    const guild = { ownerId: 'o', adminRoleIds: ['a'], managerRoleIds: ['m'] };
    assert.equal(isManager({ userId: 'u', member: { roles: ['a'] }, guild }), true);
    assert.equal(isManager({ userId: 'u', member: { roles: ['x', 'm'] }, guild }), true);
    assert.equal(isManager({ userId: 'o', member: { roles: [] }, guild }), true);
    assert.equal(isManager({ userId: 'u', member: { roles: ['x'] }, guild }), false);
    assert.equal(isManager({ userId: 'u', member: null, guild }), false);
    assert.equal(isManager({ userId: 'u', member: { roles: ['a'] }, guild: null }), false);
    assert.equal(isManager({ userId: 'u', member: { roles: ['a'] }, guild: { ownerId: 'o' } }), false);
  });
});

describe('people: add by hand, remove, restore', () => {
  const adm = 'tok-admin-aaaaaaaa';
  const lineup = (token = adm) => call('GET', `/api/lineup/${w.warId}`, token);
  it('a manager adds a person by hand: class from the guild list, optional role and task; he shows up with a manual key', async () => {
    const r = await call('POST', `/api/lineup/${w.warId}/members`, adm, { name: '  Lão Ngũ  @all ', className: 'Tố Vấn', rolePref: 'def', task: 'cong' });
    assert.equal(r.status, 200);
    assert.match(r.body.member.id, /^m:[a-f0-9]{10}$/);
    const got = await lineup();
    const m = got.body.members.find((x) => x.id === r.body.member.id);
    assert.deepEqual([m.name, m.className, m.manual, m.linked, m.taskDefault], ['Lão Ngũ all', 'Tố Vấn', true, false, 'def']);
    assert.equal(got.body.tasks[m.id], 'cong');
    assert.ok(got.body.version >= 1, 'the version moved: open boards reload');
    // he can be placed like anybody
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[0][0] = [m.id, w.ids[0]];
    assert.equal((await call('PUT', `/api/lineup/${w.warId}`, adm, { layout, version: got.body.version })).status, 200);
  });
  it('a bad class, an empty name, an unknown task are refused; a plain member cannot add', async () => {
    const add = (token, body) => call('POST', `/api/lineup/${w.warId}/members`, token, body);
    assert.equal((await add(adm, { name: 'A', className: 'Không có' })).status, 400);
    assert.equal((await add(adm, { name: '   ', className: 'Tố Vấn' })).status, 400);
    assert.equal((await add(adm, { name: 'A', className: 'Tố Vấn', task: 'c:khong' })).status, 400);
    assert.equal((await add('tok-plain-dddddddd', { name: 'A', className: 'Tố Vấn' })).status, 403);
    assert.equal((await add('tok-outsider-eeee', { name: 'A', className: 'Tố Vấn' })).status, 403);
  });
  it('removing a registered person: gone from the list, the layout and the tasks, listed under removed (managers only), restorable', async () => {
    const layout = rules.emptyLayout(SHAPE);
    layout.groups[0][0] = [w.ids[0], w.ids[1]];
    await call('PUT', `/api/lineup/${w.warId}`, adm, { layout, version: 0, tasks: { [w.ids[0]]: 'def' } });
    const del = await call('DELETE', `/api/lineup/${w.warId}/members/${w.ids[0]}`, adm);
    assert.equal(del.status, 200);
    const got = await lineup();
    assert.ok(!got.body.members.some((m) => m.id === w.ids[0]));
    assert.deepEqual(got.body.lineup.groups[0][0], [w.ids[1]]);
    assert.equal(got.body.tasks[w.ids[0]], undefined);
    assert.deepEqual(got.body.removedMembers.map((m) => m.id), [w.ids[0]]);
    assert.equal((await lineup('tok-plain-dddddddd')).status, 403, 'a member does not get the board at all');
    assert.equal((await call('DELETE', `/api/lineup/${w.warId}/members/${w.ids[1]}`, 'tok-plain-dddddddd')).status, 403);
    assert.equal((await call('DELETE', `/api/lineup/${w.warId}/members/${w.ids[0]}`, adm)).status, 400, 'already removed');
    assert.equal((await call('POST', `/api/lineup/${w.warId}/members/${w.ids[0]}/restore`, 'tok-plain-dddddddd')).status, 403);
    assert.equal((await call('POST', `/api/lineup/${w.warId}/members/${w.ids[0]}/restore`, adm)).status, 200);
    const back = await lineup();
    assert.ok(back.body.members.some((m) => m.id === w.ids[0]));
    assert.deepEqual(back.body.removedMembers, []);
  });
  it('removing a hand-added person deletes him; he cannot be restored', async () => {
    const add = await call('POST', `/api/lineup/${w.warId}/members`, adm, { name: 'Khách', className: 'Huyết Hà' });
    const key = add.body.member.id;
    assert.equal((await call('DELETE', `/api/lineup/${w.warId}/members/${key}`, adm)).status, 200);
    const got = await lineup();
    assert.ok(!got.body.members.some((m) => m.id === key));
    assert.deepEqual(got.body.removedMembers, []);
    assert.equal((await call('POST', `/api/lineup/${w.warId}/members/${key}/restore`, adm)).status, 400);
  });
});

describe('GET', () => {
  it('wars of the guild, newest first, for Leaders; a member gets 403 not_manager', async () => {
    const r = await call('GET', `/api/wars?guild=${G}`, 'tok-admin-aaaaaaaa');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.wars.map((x) => x.id), [w.warId]);
    assert.deepEqual(Object.keys(r.body), ['wars']);
    const plain = await call('GET', `/api/wars?guild=${G}`, 'tok-plain-dddddddd');
    assert.deepEqual([plain.status, plain.body.code], [403, 'not_manager']);
    assert.equal((await call('GET', '/api/wars', 'tok-admin-aaaaaaaa')).status, 400);
  });
  it('lineup: members in sign-up order with class colour, layout shape, version', async () => {
    const r = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.members.map((m) => m.id), w.ids);
    assert.equal(r.body.members[0].className, 'Tố Vấn');
    assert.match(r.body.members[0].classColor, /^#[0-9a-f]{6}$/);
    assert.deepEqual(r.body.layout, SHAPE);
    assert.deepEqual(r.body.lineup, rules.emptyLayout(SHAPE));
    assert.equal(r.body.version, 0);
    assert.equal(r.body.publish.state, 'none');
    assert.equal((await call('GET', `/api/lineup/${w.warId}/version`, 'tok-admin-aaaaaaaa')).body.version, 0);
  });
  it('a Manage Server role and the guild owner are managers; a plain member is read-only', async () => {
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-perm-bbbbbbbbb')).status, 200);
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-owner-ccccccc')).status, 200);
    const plain = await call('GET', `/api/lineup/${w.warId}`, 'tok-plain-dddddddd');
    assert.deepEqual([plain.status, plain.body.code], [403, 'not_manager']);
    for (const [m, path] of [['GET', `/api/lineup/${w.warId}/version`], ['GET', '/api/emoji/x'], ['POST', `/api/lineup/${w.warId}/publish`], ['POST', '/api/tasks']]) {
      const r = await call(m, path, 'tok-plain-dddddddd', m === 'POST' ? { guild: G } : undefined);
      if (!path.startsWith('/api/emoji')) assert.deepEqual([r.status, r.body.code], [403, 'not_manager'], `${m} ${path}`);
    }
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
    const read = await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa');
    assert.deepEqual(read.body.lineup.groups[0][0], [w.ids[0], w.ids[1]]);
    assert.equal(read.body.version, 1);
  });
  it('publish is for managers, marks the request pending and is shown in the lineup', async () => {
    assert.equal((await call('POST', `/api/lineup/${w.warId}/publish`, 'tok-plain-dddddddd', {})).status, 403);
    const r = await call('POST', `/api/lineup/${w.warId}/publish`, 'tok-admin-aaaaaaaa', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.publish.state, 'pending');
    assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa')).body.publish.state, 'pending');
  });
  it("another guild's war is not reachable even with a valid token", async () => {
    const other = await seedWar({ guildId: '800000000000000002', classes: ['Tố Vấn'] });
    assert.equal((await call('GET', `/api/lineup/${other.warId}`, 'tok-admin-aaaaaaaa')).status, 404, 'no snapshot yet: nothing to show');
    await snapshot(other);
    assert.equal((await call('GET', `/api/lineup/${other.warId}`, 'tok-admin-aaaaaaaa')).status, 403, 'a snapshot, but the user is not a member of that guild');
  });
  it('the server needs no bot token and never reads the main database', async () => {
    const calls = [];
    const real = db.q;
    db.q = (...a) => {
      calls.push(a[0]);
      return real(...a);
    };
    try {
      assert.equal((await call('GET', `/api/lineup/${w.warId}`, 'tok-admin-aaaaaaaa')).status, 200);
      assert.equal((await call('GET', `/api/wars?guild=${G}`, 'tok-admin-aaaaaaaa')).status, 200);
    } finally {
      db.q = real;
    }
    assert.deepEqual(calls, []);
    assert.ok(!discordCalls.some((u) => /\/guilds\/\d+(\/roles|\/emojis)?$/.test(u)), 'no guild REST call');
  });


});
