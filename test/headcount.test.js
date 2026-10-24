// "Quân số": official / apprentice count from the roster ranks (accent-insensitive "Học Việc"), the dashboard lines, the config field and the
// "⚙️ Ngưỡng" form (adm:offcfgModal keeps working), and the "sheet connected" reply listing every bot-owned tab. DB / Discord stubbed.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { sid } = require('./helpers');
const { assertV2Message, assertModal } = require('./discordLimits');

const guildConfigService = require('../src/services/guildConfigService');
const refresher = require('../src/bot/refresher');
const sheetSync = require('../src/bot/sheetSync');
let config;
let savedPatch;
let panelRefreshes = 0;
guildConfigService.getConfigOrDefault = async () => config;
guildConfigService.updateConfig = async (guildId, patch) => ((savedPatch = [guildId, patch]), { ...config, ...patch });
refresher.schedulePanelRefresh = () => {
  panelRefreshes += 1;
};
sheetSync.scheduleSync = () => {};

const gateway = require('../src/services/sheets/gateway');
const hc = require('../src/services/headcountService');
const defaults = require('../config/defaults');
const adminHandler = require('../src/bot/interactions/admin');
const { buildPanel } = require('../src/bot/ui/panel');
const { buildSheetView } = require('../src/bot/ui/sheetView');
const { buildOffWarnModal } = require('../src/bot/ui/settingsModal');
const feed = require('../src/services/sheets/feed');
const { createFakeSheets } = require('./fakeSheets');

const GUILD = '800000000000000013';
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);

afterEach(() => mock.restoreAll());

describe('countHeadcount', () => {
  const ranks = (...list) => list.map((rank) => ({ rank }));
  it('rank "Học Việc" is an apprentice, everything else (and an empty rank) is official', () => {
    assert.deepEqual(hc.countHeadcount(ranks('Bang chủ', 'Phó bang', 'Trưởng lão', 'Tinh anh', 'Thành viên', '', 'Học Việc', 'Học Việc')), { official: 6, apprentice: 2 });
  });
  it('accent-insensitive, case-insensitive, spacing-insensitive, NFC or NFD', () => {
    const variants = ['Học Việc', 'học việc', 'HỌC VIỆC', 'Hoc Viec', 'hoc  viec', ' Học Việc ', 'Họ̣c Việc', 'học-việc'];
    assert.deepEqual(hc.countHeadcount(ranks(...variants)), { official: 0, apprentice: variants.length });
    assert.equal(hc.isApprentice('Học Việc Cao Cấp'), false, 'only the exact rank');
    assert.equal(hc.isApprentice(null), false);
  });
  it('no members -> 0 / 0; a missing list is fine', () => {
    assert.deepEqual(hc.countHeadcount([]), { official: 0, apprentice: 0 });
    assert.deepEqual(hc.countHeadcount(undefined), { official: 0, apprentice: 0 });
  });
});

describe('the dashboard line', () => {
  it('below the target: counts, caps, target and the recruiting warning', () => {
    assert.deepEqual(hc.headcountLines({ official: 48, apprentice: 3 }, 50), ['👥 Chính thức 48/60 · Học Việc 3/20 · mục tiêu 50', '⚠️ Dưới mục tiêu: nên mở tuyển']);
  });
  it('at or above the target: "Đủ quân số"', () => {
    assert.equal(hc.headcountLines({ official: 50, apprentice: 0 }, 50)[1], '✅ Đủ quân số');
    assert.equal(hc.headcountLines({ official: 57, apprentice: 20 }, 50)[1], '✅ Đủ quân số');
    assert.equal(hc.headcountLines({ official: 49, apprentice: 0 }, 50)[1], '⚠️ Dưới mục tiêu: nên mở tuyển');
  });
  it('no roster -> no line', () => {
    assert.deepEqual(hc.headcountLines(null, 50), []);
    assert.ok(!assertV2Message(buildPanel({ headcount: null })).text.includes('Chính thức'));
  });
  it('shown in the 👥 member section of the dashboard, before the sheet line, with the configured target', () => {
    const text = assertV2Message(buildPanel({ headcount: { official: 44, apprentice: 7 }, rosterTarget: 55, game: { count: 51, at: new Date() } })).text;
    assert.match(text, /👥 Chính thức 44\/60 · Học Việc 7\/20 · mục tiêu 55\n⚠️ Dưới mục tiêu: nên mở tuyển\n📊 Sheet/);
    assert.match(assertV2Message(buildPanel({ headcount: { official: 44, apprentice: 7 } })).text, /mục tiêu 50/, 'default target');
  });
  it('constants: caps 60 / 20, default target 50', () => {
    assert.deepEqual([defaults.officialCap, defaults.apprenticeCap, defaults.rosterTarget], [60, 20, 50]);
  });
});

describe('the config field rosterTarget', () => {
  it('defaults to 50, range 1..60 on every config write; a config without it reads as 50', () => {
    assert.equal(guildConfigService.invalidPatch({ rosterTarget: 0 }), 'rosterTarget');
    assert.equal(guildConfigService.invalidPatch({ rosterTarget: 61 }), 'rosterTarget');
    assert.equal(guildConfigService.invalidPatch({ rosterTarget: 60 }), null);
    assert.equal(guildConfigService.defaultConfig(GUILD).rosterTarget, 50);
    assert.equal(hc.targetOf({}), 50);
    assert.equal(hc.targetOf({ rosterTarget: 45 }), 45);
    assert.equal(hc.targetOf({ rosterTarget: 99 }), 50);
  });
  it('parseTarget: 1..60 integers only', () => {
    assert.equal(hc.parseTarget(' 55 ').value, 55);
    assert.equal(hc.parseTarget('1').value, 1);
    assert.equal(hc.parseTarget('60').value, 60);
    for (const bad of ['', '0', '61', '-1', '5.5', 'abc', '100']) assert.match(hc.parseTarget(bad).error, /từ 1 đến 60/, bad);
  });
});

describe('the ⚙️ Ngưỡng form (adm:offcfg / adm:offcfgModal)', () => {
  function interaction({ admin = true, fields = {} } = {}) {
    const log = [];
    const perms = admin ? MANAGE : NOBODY;
    return {
      log,
      i: {
        guildId: GUILD,
        guild: { id: GUILD },
        client: {},
        user: { id: sid(900) },
        member: { roles: [], permissions: perms },
        memberPermissions: perms,
        fields: { getTextInputValue: (k) => fields[k] ?? '' },
        deferReply: async (o) => log.push(['deferReply', o]),
        deferUpdate: async () => log.push(['deferUpdate']),
        editReply: async (o) => log.push(['editReply', o]),
        followUp: async (o) => log.push(['followUp', o]),
        reply: async (o) => log.push(['reply', o]),
        showModal: async (m) => log.push(['showModal', m]),
      },
    };
  }
  const last = (log, kind) => log.filter((l) => l[0] === kind).pop()[1];
  const beforeEachConfig = () => {
    config = { ...guildConfigService.defaultConfig(GUILD), offWarnDays: 7, rosterTarget: 48 };
    savedPatch = null;
    panelRefreshes = 0;
  };

  it('the form has two fields: days (offWarnDays) and "Mục tiêu quân số chính thức" (rosterTarget), prefilled; the customId is still adm:offcfgModal', async () => {
    beforeEachConfig();
    const t = interaction();
    await adminHandler.handle(t.i, ['adm', 'offcfg']);
    const m = assertModal(last(t.log, 'showModal'));
    assert.equal(m.custom_id, 'adm:offcfgModal');
    assert.deepEqual(m.components.map((c) => [c.component.custom_id, c.component.value]), [['days', '7'], ['target', '48']]);
    assert.equal(m.components[1].label, 'Mục tiêu quân số chính thức');
    assert.equal(buildOffWarnModal({}).toJSON().components[1].component.value, '50');
  });
  it('saves both values and redraws the dashboard', async () => {
    beforeEachConfig();
    const t = interaction({ fields: { days: '3', target: ' 52 ' } });
    await adminHandler.handle(t.i, ['adm', 'offcfgModal']);
    assert.deepEqual(savedPatch, [GUILD, { offWarnDays: 3, rosterTarget: 52 }]);
    assert.match(last(t.log, 'editReply'), /3 ngày[^]*Mục tiêu quân số chính thức: \*\*52\*\*/);
    assert.equal(panelRefreshes, 1);
  });
  it('an empty target (a form opened before the field existed) leaves the target alone', async () => {
    beforeEachConfig();
    await adminHandler.handle(interaction({ fields: { days: '4' } }).i, ['adm', 'offcfgModal']);
    assert.deepEqual(savedPatch, [GUILD, { offWarnDays: 4 }]);
    assert.equal(panelRefreshes, 0);
  });
  it('a bad target saves NOTHING (not even the days)', async () => {
    for (const bad of ['0', '61', 'abc', '5.5']) {
      beforeEachConfig();
      const t = interaction({ fields: { days: '3', target: bad } });
      await adminHandler.handle(t.i, ['adm', 'offcfgModal']);
      assert.equal(savedPatch, null, bad);
      assert.match(last(t.log, 'editReply'), /từ 1 đến 60/);
    }
  });
  it('a non-manager changes nothing, on the form and on the submit', async () => {
    beforeEachConfig();
    const open = interaction({ admin: false });
    await adminHandler.handle(open.i, ['adm', 'offcfg']);
    assert.deepEqual(open.log.map((l) => l[0]), ['reply']);
    const submit = interaction({ admin: false, fields: { days: '3', target: '30' } });
    await adminHandler.handle(submit.i, ['adm', 'offcfgModal']);
    assert.equal(savedPatch, null);
  });
});

describe('sheet connected message and the 📊 view list every bot-owned tab', () => {
  it('adm:sheetModal reply names all tabs of feed.ALL_TABS', async () => {
    gateway.setClient(createFakeSheets({ title: 'Bang hội' }));
    config = { ...guildConfigService.defaultConfig(GUILD), sheetId: null };
    const fields = { sheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde' };
    const log = [];
    const i = {
      guildId: GUILD,
      guild: { id: GUILD },
      client: {},
      user: { id: sid(900) },
      member: { roles: [], permissions: MANAGE },
      memberPermissions: MANAGE,
      fields: { getTextInputValue: (k) => fields[k] ?? '' },
      deferReply: async () => {},
      editReply: async (o) => log.push(o),
    };
    await adminHandler.handle(i, ['adm', 'sheetModal']);
    const reply = log.pop();
    assert.ok(feed.ALL_TABS.every((tab) => String(reply).includes(tab)));
  });
  it('the 📊 view lists them too', () => {
    const text = buildSheetView({ configured: false, hasKey: true, email: 'bot@x.iam' }).content;
    for (const tab of feed.ALL_TABS) assert.ok(text.includes(tab), tab);
  });
});
