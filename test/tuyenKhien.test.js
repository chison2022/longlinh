// Nhất Tuyến Khiên: pure link helpers, the member panel (war:tk*), board markers / warnings, tm:mv split + tm:mvgrp,
// image / xlsx / list markers. Handlers run with the DB stubbed (in-memory Member rows).
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, Collection } = require('discord.js');
const warService = require('../src/services/warService');
const registrationService = require('../src/services/registrationService');
const guildConfigService = require('../src/services/guildConfigService');
const refresher = require('../src/bot/refresher');
const linkService = require('../src/services/linkService');
const { assertMessage, assertV2Message } = require('./discordLimits');
const { oid, sid, makeRegs, vn } = require('./helpers');

const { buildGroups, neighborsOf, declaredBy, planLinks, contextFor, groupOf } = linkService;

// ---------- stubs (installed before the handlers are required) ----------
let config;
let regs;
let members = []; // [{ discordId, displayName?, links?, tuyenKhien? }]
guildConfigService.getConfigOrDefault = async () => config;
registrationService.listRegistrations = async () => regs;
refresher.scheduleRefresh = () => {};
linkService.loadMembers = async () => members.map((m) => ({ ...m, links: [...(m.links || [])] }));
linkService.setLinks = async (guildId, me, picks, shown) => {
  const plan = planLinks(members, me, picks, shown);
  for (const id of plan.unlink) {
    const m = members.find((x) => x.discordId === id);
    if (m) m.links = (m.links || []).filter((l) => l !== me);
  }
  upsert(me).links = plan.links;
  return { links: plan.links, rejected: plan.rejected };
};
linkService.toggleCarries = async (guildId, me) => {
  const m = upsert(me);
  m.tuyenKhien = !m.tuyenKhien;
  return m.tuyenKhien;
};
linkService.clearLinks = async (guildId, me) => {
  for (const m of members) m.links = (m.links || []).filter((l) => l !== me);
  upsert(me).links = [];
};
const upsert = (id) => {
  let m = members.find((x) => x.discordId === id);
  if (!m) members.push((m = { discordId: id, links: [] }));
  return m;
};

const teamsHandler = require('../src/bot/interactions/teams');
const warHandler = require('../src/bot/interactions/war');

const GUILD = '800000000000000001';
const EID = oid(7);
const ME = sid(1);
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);

// ---------- pure ----------

describe('linkService (pure)', () => {
  const M = (id, ...links) => ({ discordId: id, links });

  it('one-sided declaration is already a link (pair, triangle, chain)', () => {
    assert.deepEqual(buildGroups([M('a', 'b')]), [['a', 'b']]);
    assert.deepEqual(buildGroups([M('a', 'b'), M('b', 'a')]), [['a', 'b']]);
    assert.deepEqual(buildGroups([M('a', 'b'), M('b', 'c'), M('c', 'a')]), [['a', 'b', 'c']]);
    assert.deepEqual(buildGroups([M('a', 'b'), M('c', 'b'), M('d', 'c')]), [['a', 'b', 'c', 'd']]); // chain, any direction
    assert.deepEqual(buildGroups([M('a', 'b'), M('x', 'y')]), [['a', 'b'], ['x', 'y']]);
  });
  it('ignores self links, empty links and people without a link; groups are never singletons', () => {
    assert.deepEqual(buildGroups([M('a', 'a'), M('b'), { discordId: 'c' }]), []);
    assert.deepEqual(buildGroups([]), []);
    assert.deepEqual(buildGroups(null), []);
  });
  it('a component of more than 6 is one group (the admins split it into PTs)', () => {
    const ids = 'abcdefgh'.split('');
    const g = buildGroups(ids.slice(1).map((id) => M(id, 'a')));
    assert.equal(g.length, 1);
    assert.deepEqual(g[0], ids);
  });
  it('`only` restricts people: a chain without its middle is no group', () => {
    const ms = [M('a', 'b'), M('b', 'c')];
    assert.deepEqual(buildGroups(ms, ['a', 'c']), []);
    assert.deepEqual(buildGroups(ms, ['a', 'b']), [['a', 'b']]);
  });
  it('is deterministic: independent of input order, sorted inside and between groups', () => {
    const ms = [M('z', 'y'), M('c', 'b'), M('b', 'a'), M('m', 'n')];
    const out = buildGroups(ms);
    assert.deepEqual(out, [['a', 'b', 'c'], ['m', 'n'], ['y', 'z']]);
    assert.deepEqual(buildGroups([...ms].reverse()), out);
    assert.deepEqual(buildGroups(ms), out);
  });
  it('neighborsOf: both directions; declaredBy: only people I did not declare', () => {
    const ms = [M('me', 'x'), M('y', 'me'), M('x', 'me'), M('q', 'other')];
    assert.deepEqual(neighborsOf(ms, 'me'), ['x', 'y']);
    assert.deepEqual(declaredBy(ms, 'me'), ['y']);
    assert.deepEqual(declaredBy(ms, 'nobody'), []);
  });
  it('groupOf finds the group of an id', () => {
    assert.deepEqual(groupOf([['a', 'b'], ['c', 'd']], 'd'), ['c', 'd']);
    assert.equal(groupOf([['a', 'b']], 'z'), null);
  });
  it('planLinks: picks replace, self / duplicates dropped, max 5; deselecting a shown neighbor unlinks it BOTH ways', () => {
    const ms = [M('me', 'a', 'b'), M('c', 'me')];
    assert.deepEqual(planLinks(ms, 'me', ['a', 'b', 'c']), { links: ['a', 'b', 'c'], accepted: [], unlink: [], rejected: [] }); // c declared me already: kept, but not a new pick
    assert.deepEqual(planLinks(ms, 'me', ['a', 'b', 'c', 'd']).accepted, ['d'], 'only genuinely new picks are written to my list');
    const drop = planLinks(ms, 'me', ['a'], ['a', 'b', 'c']); // b (mine) and c (declared me, shown) deselected
    assert.deepEqual(planLinks(ms, 'me', ['a']).unlink, ['b'], 'shown unknown: only my own links, never an unseen declarer');
    assert.deepEqual(drop.unlink.sort(), ['b', 'c']);
    assert.deepEqual(drop.links, ['a']);
    assert.deepEqual(planLinks([], 'me', ['me', 'a', 'a', 'b', 'c', 'd', 'e', 'f']).links, ['a', 'b', 'c', 'd', 'e']);
  });
  it('contextFor: groups among participants only; carriers among participants', () => {
    const rs = [
      { discordId: 'a', status: 'join' },
      { discordId: 'b', status: 'join' },
      { discordId: 'c', status: 'absent' },
    ];
    const ms = [{ discordId: 'a', links: ['b', 'c'], tuyenKhien: true }, { discordId: 'c', tuyenKhien: true, links: [] }];
    const ctx = contextFor(ms, rs);
    assert.deepEqual(ctx.groups, [['a', 'b']]);
    assert.deepEqual([...ctx.carriers], ['a']);
  });
});

// ---------- handlers ----------

function interaction(extra = {}) {
  const log = [];
  return {
    log,
    i: {
      guildId: GUILD,
      customId: 'war:tk:' + EID,
      user: { id: ME },
      member: { roles: [], permissions: MANAGE },
      memberPermissions: MANAGE,
      guild: { members: { cache: new Map() } },
      client: {},
      deferReply: async () => log.push(['deferReply']),
      deferUpdate: async () => log.push(['deferUpdate']),
      editReply: async (o) => log.push(['editReply', o]),
      followUp: async (o) => log.push(['followUp', o]),
      ...extra,
    },
  };
}
const last = (log) => log.filter((l) => l[0] === 'editReply').pop()[1];
const compIds = (msg) => msg.components.map((r) => r.toJSON().components.map((c) => c.custom_id));

describe('war:tk member panel', () => {
  let stored;
  beforeEach(() => {
    config = { ...guildConfigService.defaultConfig(GUILD), memberRoleId: 'role-1', groupCount: 1 };
    regs = makeRegs(6);
    members = [];
    stored = { _id: EID, guildId: GUILD, title: 'War', status: 'locked', startAt: vn(2026, 10, 11, 20), deadlineAt: vn(2026, 10, 11, 18), teams: [] };
    warService.getEvent = async () => stored;
    mock.method(console, 'error', () => {});
  });
  const press = async (action, extra = {}) => {
    const { i, log } = interaction({ customId: `war:${action}:${EID}`, ...extra });
    await warHandler.handle(i, ['war', action, EID]);
    return log;
  };

  it('opens an ephemeral panel (also after the deadline): select + carry / clear buttons, limits ok', async () => {
    const log = await press('tk');
    assert.equal(log[0][0], 'deferReply');
    const msg = last(log);
    assertMessage(msg);
    assert.deepEqual(compIds(msg), [[`war:tkpick:${EID}`], [`war:tkcarry:${EID}`, `war:tkclear:${EID}`]]);
    assert.match(msg.content, /hảo cảm ≥3000/);
    assert.equal(
      msg.content,
      [
        '🔗 Nhóm Tuyến Khiên · nhóm của bạn: chỉ mình bạn',
        '① Chọn tối đa 5 người đã có Nhất Tuyến Khiên với bạn (hảo cảm ≥3000)',
        '② Nếu bạn đang trang bị nội tại Nhất Tuyến Khiên → bấm 🛡️',
        '-# Bỏ chọn ai thì liên kết với người đó bị gỡ cả hai phía.',
      ].join('\n')
    );
    assert.ok(!compIds(msg).flat().some((id) => id.includes('tkaccept')), 'no accept flow');
    const select = msg.components[0].toJSON().components[0];
    assert.equal(select.type, 5);
    assert.equal(select.min_values, 0);
    assert.equal(select.max_values, 5);
  });
  it('shows "đã khai bạn" for a one-sided declaration and the group once linked; default users = neighbors', async () => {
    members = [{ discordId: sid(2), displayName: 'Bạn A', links: [ME] }];
    let msg = last(await press('tk'));
    assert.match(msg.content, /Đã khai bạn: Bạn A/);
    assert.match(msg.content, /nhóm của bạn: Bạn A/); // one declaration is enough
    assert.deepEqual(msg.components[0].toJSON().components[0].default_values, [{ id: sid(2), type: 'user' }]);
    assert.equal(msg.components[1].toJSON().components[1].disabled, false);
    members = [];
    msg = last(await press('tk'));
    assert.match(msg.content, /nhóm của bạn: chỉ mình bạn/);
    assert.equal(msg.components[1].toJSON().components[1].disabled, true);
  });
  it('tkpick sets my links (max 5, self and bots dropped) and re-renders the panel in place', async () => {
    const users = new Collection([[sid(3), { id: sid(3), bot: true }]]);
    const log = await press('tkpick', { values: [ME, sid(2), sid(3), sid(4)], users, members: new Collection() });
    assert.equal(log[0][0], 'deferUpdate');
    assert.deepEqual(members.find((m) => m.discordId === ME).links, [sid(2), sid(4)]);
    const msg = last(log);
    assertMessage(msg);
    assert.match(msg.content, /Bỏ qua chính bạn \/ bot/);
    const many = [2, 3, 4, 5, 6, 7, 8].map(sid);
    await press('tkpick', { values: many, users: new Collection(), members: new Collection() });
    assert.equal(members.find((m) => m.discordId === ME).links.length, 5);
  });
  it('tkpick skips (and does not save) picked users without the member role, like bots / yourself', async () => {
    const roleless = { id: sid(2), displayName: 'Khách', roles: [] };
    const log = await press('tkpick', { values: [sid(2)], users: new Collection(), members: new Collection([[sid(2), roleless]]) });
    assert.match(last(log).content, /⚠️ Bỏ qua Khách: không có role thành viên bang/);
    assert.deepEqual((members.find((m) => m.discordId === ME) || { links: [] }).links, []);
    const withRole = { id: sid(3), roles: ['role-1'] };
    const mixed = await press('tkpick', { values: [sid(2), sid(3)], users: new Collection(), members: new Collection([[sid(2), roleless], [sid(3), withRole]]) });
    assert.match(last(mixed).content, /Bỏ qua Khách/);
    assert.deepEqual(members.find((m) => m.discordId === ME).links, [sid(3)], 'only the member with the role is linked');
    const ok = await press('tkpick', { values: [sid(3)], users: new Collection(), members: new Collection([[sid(3), withRole]]) });
    assert.doesNotMatch(last(ok).content, /Bỏ qua/);
  });
  it('tkpick: a picked user who is not in the guild at all (user without a member) is skipped too', async () => {
    const stranger = { id: sid(9), username: 'ngoai', bot: false };
    const log = await press('tkpick', { values: [sid(9)], users: new Collection([[sid(9), stranger]]), members: new Collection() });
    assert.match(last(log).content, /Bỏ qua ngoai: không có role thành viên bang/);
  });
  it('after rejected picks (self / bot / no role / over the cap) the menu is redrawn with only the saved links as defaults, under a fresh customId', async () => {
    const users = new Collection([[sid(3), { id: sid(3), bot: true }]]);
    const msg = last(await press('tkpick', { values: [ME, sid(2), sid(3)], users, members: new Collection() }));
    const menu = msg.components[0].toJSON().components[0];
    assert.deepEqual(menu.default_values.map((d) => d.id), [sid(2)], 'self and the bot are not shown as selected');
    assert.match(menu.custom_id, new RegExp(`^war:tkpick:${EID}:[0-9a-z]+$`));
    assert.ok(menu.custom_id.length <= 100);
    // over the group cap
    members = [2, 3, 4, 5, 6].map((n) => ({ discordId: sid(n), links: [sid(n === 6 ? 2 : n + 1)] }));
    members.push({ discordId: sid(20), links: [sid(21), sid(22)] });
    const over = last(await press('tkpick', { values: [sid(2), sid(20)], users: new Collection(), members: new Collection() })).components[0].toJSON().components[0];
    assert.deepEqual(over.default_values.map((d) => d.id), [sid(2)]);
    assert.match(over.custom_id, /^war:tkpick:\d+:[0-9a-z]+$/);
    // a clean pick keeps the plain id
    const clean = last(await press('tkpick', { values: [sid(2)], users: new Collection(), members: new Collection() })).components[0].toJSON().components[0];
    assert.equal(clean.custom_id, `war:tkpick:${EID}`);
  });
  it('deselecting a person who declared me removes the link on BOTH sides', async () => {
    members = [{ discordId: sid(2), links: [ME] }, { discordId: ME, links: [sid(4)] }];
    await press('tkpick', { component: { data: { default_values: [{ id: sid(2), type: 'user' }, { id: sid(4), type: 'user' }] } }, values: [sid(4)], users: new Collection(), members: new Collection() }); // sid(2) deselected
    assert.deepEqual(members.find((m) => m.discordId === sid(2)).links, []);
    assert.deepEqual(members.find((m) => m.discordId === ME).links, [sid(4)]);
  });
  it('H4: a stale panel only unlinks people the menu really showed (default_values), not an unseen declarer', async () => {
    members = [{ discordId: ME, links: [sid(4)] }, { discordId: sid(2), links: [ME] }]; // sid(2) declared me AFTER the panel was rendered
    const shown = { data: { default_values: [{ id: sid(4), type: 'user' }] } };
    await press('tkpick', { component: shown, values: [], users: new Collection(), members: new Collection() }); // sid(4) deselected
    assert.deepEqual(members.find((m) => m.discordId === ME).links, []);
    assert.deepEqual(members.find((m) => m.discordId === sid(2)).links, [ME], 'the unseen declarer keeps the link');
    // a panel that showed the declarer and deselected him does unlink him
    await press('tkpick', { component: { data: { default_values: [{ id: sid(2), type: 'user' }] } }, values: [], users: new Collection(), members: new Collection() });
    assert.deepEqual(members.find((m) => m.discordId === sid(2)).links, []);
  });
  it('H3: a pick that would make my group bigger than 6 is refused with a note naming the person', async () => {
    members = [2, 3, 4, 5, 6].map((n) => ({ discordId: sid(n), links: [sid(n === 6 ? 2 : n + 1)] })); // chain of 5
    members.push({ discordId: sid(20), links: [sid(21), sid(22)] }); // group of 3
    const log = await press('tkpick', { values: [sid(2), sid(20)], users: new Collection(), members: new Collection() });
    assert.deepEqual(members.find((m) => m.discordId === ME).links, [sid(2)]);
    assert.match(last(log).content, /⚠️ Không thêm được .+: nhóm sẽ vượt 6 người/);
    assert.match(last(log).content, new RegExp(sid(20)));
  });
  it('L3: my own declared links come first in the menu defaults and the panel explains that deselecting unlinks both ways', async () => {
    members = [{ discordId: sid(2), links: [ME] }, { discordId: ME, links: [sid(9)] }];
    const msg = last(await press('tk'));
    assert.deepEqual(msg.components[0].toJSON().components[0].default_values.map((d) => d.id), [sid(9), sid(2)]);
    assert.match(msg.content, /liên kết với người đó bị gỡ cả hai phía/);
  });
  it('tkclear removes my links in both directions', async () => {
    members = [{ discordId: ME, links: [sid(2)] }, { discordId: sid(3), links: [ME, sid(9)] }, { discordId: sid(2), links: [] }];
    const log = await press('tkclear');
    assert.deepEqual(members.find((m) => m.discordId === ME).links, []);
    assert.deepEqual(members.find((m) => m.discordId === sid(3)).links, [sid(9)]);
    assert.equal(log[0][0], 'deferUpdate');
    assert.match(last(log).content, /chỉ mình bạn/);
  });
  it('tkcarry toggles the passive and the button label follows', async () => {
    let msg = last(await press('tkcarry'));
    assert.equal(members.find((m) => m.discordId === ME).tuyenKhien, true);
    assert.equal(msg.components[1].toJSON().components[0].label, '🛡️ Tôi mang Nhất Tuyến Khiên: Có');
    msg = last(await press('tkcarry'));
    assert.equal(members.find((m) => m.discordId === ME).tuyenKhien, false);
    assert.equal(msg.components[1].toJSON().components[0].label, '🛡️ Tôi mang Nhất Tuyến Khiên: Không');
  });
  it('warns when my group is bigger than a PT', async () => {
    members = [2, 3, 4, 5, 6, 7].map((n) => ({ discordId: sid(n), links: [ME] }));
    assert.match(last(await press('tk')).content, /7 người, nhiều hơn 1 PT/);
  });
  it('an event of another guild (or a missing one) is refused for every action, nothing is written', async () => {
    for (const action of ['tk', 'tkpick', 'tkcarry', 'tkclear']) {
      stored = { ...stored, guildId: 'other-guild' };
      const log = await press(action, { values: [sid(2)], users: new Collection(), members: new Collection() });
      assert.match(last(log).content, /không tồn tại/);
      assert.deepEqual(members, [], `${action} wrote nothing`);
      warService.getEvent = async () => null;
      assert.match(last(await press(action, { values: [] })).content, /không tồn tại/);
      warService.getEvent = async () => stored;
    }
  });
});

