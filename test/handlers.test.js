// Interaction handlers with all DB / Discord access stubbed. Destructured imports are captured at require
// time, so stubs on guildConfigService / registrationService / refresher are installed BEFORE requiring handlers.
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, Collection, MessageFlags } = require('discord.js');
const warService = require('../src/services/warService');
const registrationService = require('../src/services/registrationService');
const guildConfigService = require('../src/services/guildConfigService');
const refresher = require('../src/bot/refresher');
const defaults = require('../config/defaults');
const { vn, oid, sid, makeRegs } = require('./helpers');
const ExcelJS = require('exceljs');
const { assertV2Message } = require('./discordLimits');

let configCalls = 0;
let config;
let regs;
const refreshed = [];
const configOptions = []; // 2nd argument of every getConfigOrDefault call
guildConfigService.getConfigOrDefault = async (_guildId, options) => {
  configCalls += 1;
  configOptions.push(options);
  return config;
};
guildConfigService.updateConfig = async (guildId, patch) => ({ ...config, ...patch });
registrationService.listRegistrations = async () => regs;
registrationService.getRegistration = async (eventId, discordId) => regs.find((r) => r.discordId === discordId) || null;
let tkMembers = []; // fake Member rows with links / tuyenKhien
const linkService = require('../src/services/linkService');
linkService.loadMembers = async () => tkMembers;
refresher.scheduleRefresh = (...a) => refreshed.push(a);
const panelRefreshed = []; // schedulePanelRefresh calls
refresher.schedulePanelRefresh = (...a) => panelRefreshed.push(a);
const teamsHandler = require('../src/bot/interactions/teams');
const adminHandler = require('../src/bot/interactions/admin');
const warHandler = require('../src/bot/interactions/war');

const GUILD = '800000000000000001';
const EID = oid(5);
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
const ADMIN = sid(900);

let stored; // event in the fake DB
let writes;
let sent; // channel.send payloads

beforeEach(() => {
  configCalls = 0;
  configOptions.length = 0;
  refreshed.length = 0;
  panelRefreshed.length = 0;
  writes = [];
  sent = [];
  tkMembers = [];
  config = { ...guildConfigService.defaultConfig(GUILD), announceChannelId: 'chan', memberRoleId: 'role-1', groupCount: 1 };
  regs = makeRegs(6);
  stored = {
    _id: EID,
    guildId: GUILD,
    title: 'Bang chiến CN 20:00',
    status: 'locked',
    startAt: vn(2026, 10, 11, 20),
    deadlineAt: vn(2026, 10, 11, 18),
    channelId: 'chan',
  };
  warService.getEvent = async () => stored;
  warService.findEventByStart = async () => null;
  warService.publishEvent = async (id) => {
    writes.push(['publish', id]);
    return stored.status === 'done' ? null : { ...stored, status: 'published' };
  };
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});

function interaction(extra = {}) {
  const log = [];
  const channel = { id: 'chan', send: async (p) => sent.push(p) };
  const i = {
    guildId: GUILD,
    user: { id: ADMIN, username: 'u' },
    member: { roles: [], permissions: MANAGE },
    memberPermissions: MANAGE,
    client: { channels: { fetch: async () => channel } },
    deferReply: async () => log.push(['deferReply']),
    deferUpdate: async () => log.push(['deferUpdate']),
    editReply: async (o) => log.push(['editReply', o]),
    reply: async (o) => log.push(['reply', o]),
    followUp: async (o) => log.push(['followUp', o]),
    showModal: async (m) => log.push(['showModal', m]),
    ...extra,
  };
  return { i, log };
}
const lastReply = (log) => log.filter((l) => l[0] === 'editReply').pop()[1];

describe('tm:pub (publish = post the lineup link)', () => {
  const URL_OK = 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=5';
  const submit = async (values, extra = {}) => {
    const { i, log } = interaction({ fields: { getTextInputValue: (id) => values[id] ?? '' }, ...extra });
    await teamsHandler.handle(i, ['tm', 'pubModal', EID]);
    return log;
  };
  beforeEach(() => {
    warService.setLineupLink = async (id, url, note) => {
      writes.push(['link', id, url, note]);
      stored.lineupUrl = url;
      stored.lineupNote = note;
    };
  });
  const assertLinkMessage = (p, { note } = {}) => {
    const v2 = assertV2Message(p, { forCreate: true });
    assert.equal(p.files, undefined);
    assert.match(v2.text, /^### 📢 Đội hình — Bang chiến CN 20:00/);
    assert.match(v2.text, /<t:\d+:f> – <t:\d+:t> \(<t:\d+:R>\)/);
    if (note) assert.ok(v2.text.includes(note));
    assert.deepEqual(v2.buttons.map((c) => [c.label, c.style, c.url]), [['📊 Xem đội hình', 5, URL_OK]]);
    assert.ok(!JSON.stringify(v2.json).includes('<@'));
  };

  it('tm:pub opens the link modal (prefilled with the stored link); nothing is sent or written', async () => {
    stored.lineupUrl = URL_OK;
    const { i, log } = interaction();
    await teamsHandler.handle(i, ['tm', 'pub', EID]);
    assert.equal(log[0][0], 'showModal');
    const json = log[0][1].toJSON();
    assert.equal(json.custom_id, `tm:pubModal:${EID}`);
    assert.equal(JSON.stringify(json).includes(URL_OK), true);
    assert.equal(sent.length, 0);
    assert.deepEqual(writes, []);
  });
  it('tm:pub refuses non-admins, another guild and a finished event (no modal)', async () => {
    let r = interaction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
    await teamsHandler.handle(r.i, ['tm', 'pub', EID]);
    assert.match(r.log[0][1].content, /không có quyền/);
    stored.guildId = 'other';
    r = interaction();
    await teamsHandler.handle(r.i, ['tm', 'pub', EID]);
    assert.match(r.log[0][1].content, /không tồn tại/);
    stored.guildId = GUILD;
    stored.status = 'done';
    r = interaction();
    await teamsHandler.handle(r.i, ['tm', 'pub', EID]);
    assert.match(r.log[0][1].content, /đã kết thúc/);
    assert.ok(!r.log.some((l) => l[0] === 'showModal'));
  });
  it('a locked event publishes straight away: ONE V2 link message with the note, the link saved, status published, war message + dashboard redrawn', async () => {
    const log = await submit({ url: URL_OK, note: 'Tập trung 19:45 kênh Voice 1' });
    assert.equal(sent.length, 1);
    assertLinkMessage(sent[0], { note: 'Tập trung 19:45 kênh Voice 1' });
    assert.deepEqual(writes.map((w) => w[0]), ['link', 'publish']);
    assert.deepEqual(writes[0].slice(2), [URL_OK, 'Tập trung 19:45 kênh Voice 1']);
    assert.match(lastReply(log), /Đã công bố đội hình ở <#chan>/);
    assert.equal(refreshed.length, 1); // the war message gets its "📊 Đội hình" button
    assert.equal(panelRefreshed.length, 1);
  });
  it('a bad link (not http/https, empty) is refused and nothing is saved or sent', async () => {
    for (const url of ['', 'ftp://x/y', 'not a url', 'javascript:alert(1)']) {
      const log = await submit({ url });
      assert.match(lastReply(log), /Link đội hình không hợp lệ/);
    }
    assert.deepEqual(writes, []);
    assert.equal(sent.length, 0);
  });
  it('an OPEN event: the modal saves the link and asks for confirmation, publishing nothing', async () => {
    stored.status = 'open';
    const log = await submit({ url: URL_OK });
    const reply = lastReply(log);
    assert.match(reply.content, /đóng đăng ký/);
    assert.deepEqual(reply.components[0].toJSON().components.map((c) => c.custom_id), [`tm:pubok:${EID}`, `tm:pubno:${EID}`]);
    assert.equal(sent.length, 0);
    assert.deepEqual(writes, [], 'nothing is stored before the announcement is posted');
  });
  it('only the confirm (tm:pubok) publishes an open event, edits the confirm message and says registration is closed', async () => {
    stored.status = 'open';
    await submit({ url: URL_OK });
    const { i, log } = interaction();
    await teamsHandler.handle(i, ['tm', 'pubok', EID]);
    assert.equal(log[0][0], 'deferUpdate');
    assert.equal(sent.length, 1);
    assertLinkMessage(sent[0]);
    assert.deepEqual(writes.map((w) => w[0]), ['link', 'publish']);
    assert.deepEqual(lastReply(log), { content: '📢 Đã công bố — đăng ký đã đóng. Đội hình ở <#chan>.', components: [] });
  });
  it('the pending link is per admin: another admin\'s confirm / cancel cannot publish or drop it; the confirm text shows the (truncated) link', async () => {
    stored.status = 'open';
    const long = `https://docs.google.com/spreadsheets/d/abc/edit?${'x'.repeat(200)}`;
    const log = await submit({ url: long });
    const text = lastReply(log).content;
    assert.ok(text.includes('🔗 https://docs.google.com/spreadsheets/d/abc/edit?') && text.includes('…') && !text.includes('x'.repeat(150)));
    const other = interaction({ user: { id: sid(901), username: 'b' } });
    await teamsHandler.handle(other.i, ['tm', 'pubok', EID]);
    assert.match(lastReply(other.log).content, /hết hạn/);
    const cancel = interaction({ user: { id: sid(901), username: 'b' } });
    await teamsHandler.handle(cancel.i, ['tm', 'pubno', EID]);
    assert.equal(sent.length, 0);
    const mine = interaction();
    await teamsHandler.handle(mine.i, ['tm', 'pubok', EID]);
    assert.equal(sent.length, 1, 'the first admin\'s link was still waiting');
  });
  it('the announcement is out but the link could not be stored -> the reply carries a warning', async () => {
    warService.setLineupLink = async () => Promise.reject(new Error('db down'));
    const log = await submit({ url: URL_OK });
    assert.equal(sent.length, 1);
    assert.match(lastReply(log), /Đã công bố[^]*⚠️ Đã đăng nhưng chưa lưu được link/);
  });
  it('a confirm with no link waiting (expired / bot restarted) asks to start again and posts nothing', async () => {
    stored.status = 'open';
    const { i, log } = interaction();
    await teamsHandler.handle(i, ['tm', 'pubok', 'unknown-event-without-modal']);
    assert.match(lastReply(log).content, /hết hạn/);
    assert.equal(sent.length, 0);
    assert.deepEqual(writes, []);
  });
  it('a long Vietnamese-character link: refused when its NORMALIZED (percent-encoded) form exceeds 512, accepted when it fits', async () => {
    const long = `https://docs.google.com/spreadsheets/d/abc/edit?q=${'đội hình '.repeat(30)}`; // ~300 typed characters, far more once encoded
    assert.ok(long.length < 512 && new URL(long).href.length > 512);
    assert.match(lastReply(await submit({ url: long })), /Link đội hình không hợp lệ/);
    const fits = `https://docs.google.com/spreadsheets/d/abc/edit?q=${'đ'.repeat(40)}`;
    assert.ok(new URL(fits).href.length <= 512);
    await submit({ url: fits });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].components.length, 1);
    assert.deepEqual(writes.map((w) => w[0]), ['link', 'publish']);
    assert.equal(writes[0][2], new URL(fits).href, 'the normalized href is what is stored and linked');
  });
  it('double click on the confirm: posted once, the second answer says it is already published', async () => {
    stored.status = 'open';
    await submit({ url: URL_OK });
    warService.publishEvent = async (id) => {
      writes.push(['publish', id]);
      stored.status = 'published';
      return { ...stored };
    };
    const a = interaction();
    await teamsHandler.handle(a.i, ['tm', 'pubok', EID]);
    const b = interaction();
    await teamsHandler.handle(b.i, ['tm', 'pubok', EID]);
    assert.equal(sent.length, 1);
    assert.match(lastReply(b.log).content, /đã được công bố rồi/);
  });
  it('concurrent second click while the first is posting gets "Đang công bố"; the lineup is posted once', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = { id: 'chan', send: async (p) => { await gate; sent.push(p); } };
    stored.status = 'open';
    await submit({ url: URL_OK }); // the link waits for the confirm
    const first = interaction({ client: { channels: { fetch: async () => slow } } });
    const p1 = teamsHandler.handle(first.i, ['tm', 'pubok', EID]);
    await new Promise((r) => setTimeout(r, 5));
    const second = interaction();
    await teamsHandler.handle(second.i, ['tm', 'pubok', EID]);
    assert.match(lastReply(second.log).content, /Đang công bố/);
    release();
    await p1;
    assert.equal(sent.length, 1);
  });
  it('re-publishing a PUBLISHED event posts again ("đăng lại") with the new link', async () => {
    stored.status = 'published';
    const log = await submit({ url: URL_OK });
    assert.equal(sent.length, 1);
    assert.match(lastReply(log), /\(đăng lại\)/);
  });
  it('"Huỷ" (tm:pubno) cancels without publishing', async () => {
    stored.status = 'open';
    const { i, log } = interaction();
    await teamsHandler.handle(i, ['tm', 'pubno', EID]);
    assert.match(lastReply(log).content, /Đã huỷ/);
    assert.equal(sent.length, 0);
    assert.deepEqual(writes, []);
  });
  it('the publish confirm keeps the admin check, and the modal submit too', async () => {
    stored.status = 'open';
    const nobody = { member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY };
    const { i, log } = interaction(nobody);
    await teamsHandler.handle(i, ['tm', 'pubok', EID]);
    assert.match(lastReply(log).content, /không có quyền/);
    const log2 = await submit({ url: URL_OK }, nobody);
    assert.match(lastReply(log2), /không có quyền/);
    assert.equal(sent.length, 0);
    assert.deepEqual(writes, []);
  });
  it('a finished event cannot be published and an event of another guild is not found', async () => {
    stored.status = 'done';
    assert.match(lastReply(await submit({ url: URL_OK })), /đã kết thúc/);
    stored.status = 'locked';
    stored.guildId = 'other';
    assert.match(lastReply(await submit({ url: URL_OK })), /không tồn tại/);
    assert.equal(sent.length, 0);
    assert.deepEqual(writes, []);
  });
  it('send failure -> error reply and the event stays unpublished', async () => {
    const log = await submit({ url: URL_OK }, { client: { channels: { fetch: async () => ({ send: async () => Promise.reject(new Error('no perms')) }) } } });
    assert.deepEqual(writes, [], 'a failed post stores nothing');
    assert.match(lastReply(log), /Không gửi được/);
  });
});

describe('admin modals', () => {
  it('Manage Server members get the create modal without reading config for the permission check', async () => {
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'create']);
    assert.equal(log[0][0], 'showModal');
    assert.equal(configCalls, 1, 'one (cached) read for the prefill only');
  });
  describe('create modal (deadline only)', () => {
    const SAT_WAR = () => ({ ...defaults.schedule, warDay: 6, warTime: '20:00', lockBeforeHours: 2, remindBeforeHours: 3 });
    const fieldsOf = (modal) => Object.fromEntries(modal.components.map((l) => [l.component.custom_id, l]));
    const withNow = (date, fn) => async () => {
      mock.timers.enable({ apis: ['Date'], now: date });
      try {
        await fn();
      } finally {
        mock.timers.reset();
      }
    };
    const fields = (values) => ({ fields: { getTextInputValue: (id) => values[id] } });

    it('Wednesday: prefill = next Saturday 18:00, description shows the 20:00-21:00 window', withNow(vn(2026, 10, 7, 12, 0), async () => {
      config.schedule = SAT_WAR();
      const { i, log } = interaction();
      await adminHandler.handle(i, ['adm', 'create']);
      const f = fieldsOf(log[0][1].toJSON());
      assert.deepEqual(Object.keys(f), ['deadline']);
      assert.equal(f.deadline.component.value, '10/10 18:00');
      assert.equal(f.deadline.description, 'Giờ Việt Nam. Bang chiến: T7 10/10 20:00–21:00');
    }));
    it('Saturday 21:30 (war over): next Saturday', withNow(vn(2026, 10, 10, 21, 30), async () => {
      config.schedule = SAT_WAR();
      const { i, log } = interaction();
      await adminHandler.handle(i, ['adm', 'create']);
      const f = fieldsOf(log[0][1].toJSON());
      assert.equal(f.deadline.component.value, '17/10 18:00');
      assert.match(f.deadline.description, /T7 17\/10 20:00–21:00/);
    }));
    it('submit creates the event for the next war with an automatic title', withNow(vn(2026, 10, 7, 12, 0), async () => {
      config.schedule = SAT_WAR();
      let created;
      warService.createEvent = async (data) => (created = { _id: EID, ...data });
      warService.claimPost = async () => true;
      warService.setMessage = async () => {};
      const { i, log } = interaction(fields({ deadline: '10/10 18:00' }));
      await adminHandler.handle(i, ['adm', 'createModal']);
      assert.equal(created.title, 'Bang chiến T7 20:00 (10/10)');
      assert.deepEqual(created.startAt, vn(2026, 10, 10, 20, 0));
      assert.deepEqual(created.deadlineAt, vn(2026, 10, 10, 18, 0));
      assert.equal(created.auto, false);
      assert.match(lastReply(log), /✅ Đã tạo/);
    }));
    it('Saturday 19:00 with lock 2h: war still today but the 18:00 deadline is past -> error, nothing created', withNow(vn(2026, 10, 10, 19, 0), async () => {
      config.schedule = SAT_WAR();
      let created = false;
      warService.createEvent = async () => (created = true);
      const { i, log } = interaction();
      await adminHandler.handle(i, ['adm', 'create']);
      assert.equal(fieldsOf(log[0][1].toJSON()).deadline.component.value, '10/10 18:00');
      const sub = interaction(fields({ deadline: '10/10 18:00' }));
      await adminHandler.handle(sub.i, ['adm', 'createModal']);
      assert.match(lastReply(sub.log), /❌ Hạn chốt đã qua/);
      assert.equal(created, false);
    }));
    it('deadline after the war start is rejected', withNow(vn(2026, 10, 7, 12, 0), async () => {
      config.schedule = SAT_WAR();
      const { i, log } = interaction(fields({ deadline: '10/10 20:30' }));
      await adminHandler.handle(i, ['adm', 'createModal']);
      assert.match(lastReply(log), /trước hoặc bằng giờ đánh/);
    }));
    it('unparsable deadline is rejected', withNow(vn(2026, 10, 7, 12, 0), async () => {
      const { i, log } = interaction(fields({ deadline: 'mai' }));
      await adminHandler.handle(i, ['adm', 'createModal']);
      assert.match(lastReply(log), /Hạn chốt không hợp lệ/);
    }));
  });
  it('settings modal opens prefilled from the cached config', async () => {
    config.groupCount = 3;
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'settings']);
    const modal = log[0][1].toJSON();
    assert.equal(modal.custom_id, 'adm:settingsModal');
    assert.equal(modal.components.find((l) => l.component.custom_id === 'groupCount').component.value, '3');
  });
  it('an admin role (no Manage Server) is accepted via the cached config', async () => {
    config.adminRoleIds = ['r-admin'];
    const { i, log } = interaction({ member: { roles: ['r-admin'], permissions: NOBODY }, memberPermissions: NOBODY });
    await adminHandler.handle(i, ['adm', 'settings']);
    assert.equal(log[0][0], 'showModal');
  });
  it('everyone else gets a "no permission" reply instead of a modal', async () => {
    const { i, log } = interaction({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
    await adminHandler.handle(i, ['adm', 'create']);
    assert.equal(log[0][0], 'reply');
    assert.match(log[0][1].content, /không có quyền/);
  });
  it('un-configured guild: modal prefill falls back to defaults', async () => {
    config = guildConfigService.defaultConfig(GUILD);
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'settings']);
    const modal = log[0][1].toJSON();
    assert.equal(modal.components.find((l) => l.component.custom_id === 'classes').component.value, defaults.classes.join('\n'));
  });
});

describe('member registration', () => {
  const memberDoc = { className: 'Tố Vấn', gameName: 'Alpha' }; // linked: no nudge (the nudge has its own tests)
  const baseEvent = () => ({ ...stored, status: 'open', deadlineAt: new Date(Date.now() + 3600 * 1000) });

  beforeEach(() => {
    config.classes = ['Tố Vấn'];
    regService_stub();
  });
  function regService_stub() {
    registrationService.getMember = async () => memberDoc;
    registrationService.upsertRegistration = async (r) => writes.push(['upsert', r.status]);
  }

  it('does not create/update GuildConfig on a click (read-only config path)', async () => {
    stored = baseEvent();
    const { i, log } = interaction();
    i.guildId = GUILD;
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.deepEqual(writes, [['upsert', 'join']]);
    assert.match(lastReply(log), /Đã ghi nhận/);
    assert.equal(refreshed.length, 1);
  });
  it('click path: ONE event read, member read in parallel with it, then the write (no duplicate getEvent)', async () => {
    stored = baseEvent();
    const order = [];
    warService.getEvent = async () => {
      order.push('getEvent');
      return stored;
    };
    registrationService.getMember = async () => {
      order.push('getMember');
      return memberDoc;
    };
    registrationService.upsertRegistration = async () => order.push('upsert');
    const { i } = interaction();
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.deepEqual(order, ['getEvent', 'getMember', 'upsert']); // both reads are issued before the write
  });
  it('deadline re-check: passing while the reads are in flight -> nothing saved', async () => {
    stored = { ...baseEvent(), deadlineAt: new Date(Date.now() + 20) };
    registrationService.getMember = async () => {
      await new Promise((r) => setTimeout(r, 60)); // slow read: the deadline passes meanwhile
      return memberDoc;
    };
    const { i, log } = interaction();
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.deepEqual(writes, []);
    assert.match(lastReply(log), /hết hạn đăng ký/);
    assert.equal(refreshed.length, 0);
  });
  it('event locked (as read) -> nothing saved', async () => {
    stored = { ...baseEvent(), status: 'locked' };
    const { i, log } = interaction();
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.deepEqual(writes, []);
    assert.match(lastReply(log), /hết hạn đăng ký/);
  });
  it('class pick that completes a registration: deadline re-checked after the class save', async () => {
    stored = { ...baseEvent(), deadlineAt: new Date(Date.now() + 20) };
    registrationService.saveMemberClass = async () => {
      await new Promise((r) => setTimeout(r, 60));
    };
    const { i, log } = interaction({ values: ['Tố Vấn'] });
    await warHandler.handle(i, ['war', 'cls', EID, 'join']);
    assert.deepEqual(writes, []);
    assert.match(lastReply(log).content, /hết hạn đăng ký/);
  });
  it('absent: only the registration is written', async () => {
    stored = baseEvent();
    const { i } = interaction();
    await warHandler.handle(i, ['war', 'st', EID, 'absent']);
    assert.deepEqual(writes.map((w) => w[0]), ['upsert']);
  });
});

describe('class from Discord role', () => {
  const CLASSES = ['🛡️ Thiết Y', '💊 Tố Vấn', '🩸 Huyết Hà'];
  const openEvent = () => ({ ...stored, status: 'open', deadlineAt: new Date(Date.now() + 3600 * 1000) });
  let upserts;
  let saves;
  let saved; // Member doc in the fake DB

  beforeEach(() => {
    config.classes = CLASSES;
    stored = openEvent();
    upserts = [];
    saves = [];
    saved = { className: '💊 Tố Vấn', gameName: 'Alpha' };
    registrationService.getMember = async () => saved;
    registrationService.upsertRegistration = async (r) => upserts.push(r);
    registrationService.saveMemberClass = async (...a) => saves.push(a);
    registrationService.updateRegistrationClass = async () => {};
  });
  // Cached member: roles is a GuildMemberRoleManager-like object with a Collection cache.
  const withRoles = (...names) => ({
    member: { roles: { cache: new Collection(names.map((n, k) => [String(k), { name: n }])) }, permissions: NOBODY },
  });

  it('one class role -> used, no menu, snapshot carries it, saved class synced in the same step', async () => {
    const { i, log } = interaction(withRoles('Thành viên', 'Thiết Y'));
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].className, '🛡️ Thiết Y');
    assert.deepEqual(saves.map((s) => s[3]), ['🛡️ Thiết Y']);
    assert.match(lastReply(log), /Đã ghi nhận.*Thiết Y/);
  });
  it('role class equal to the saved one -> no extra write', async () => {
    const { i } = interaction(withRoles('Tố Vấn'));
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(upserts[0].className, '💊 Tố Vấn');
    assert.deepEqual(saves, []);
  });
  it('no member doc + role -> class saved too', async () => {
    saved = null;
    const { i } = interaction(withRoles('Huyết Hà'));
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(upserts[0].className, '🩸 Huyết Hà');
    assert.equal(saves.length, 1);
  });
  it('no class role -> saved class, nothing synced', async () => {
    const { i } = interaction(withRoles('Thành viên'));
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(upserts[0].className, '💊 Tố Vấn');
    assert.deepEqual(saves, []);
  });
  it('no class role and no saved class -> class menu, nothing written', async () => {
    saved = null;
    const { i, log } = interaction(withRoles('Thành viên'));
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(lastReply(log).components.length, 1);
    assert.deepEqual(upserts, []);
    assert.deepEqual(saves, []);
  });
  it('saved class no longer in config + no role -> class menu', async () => {
    saved = { className: '🗑️ Cũ' };
    const { i, log } = interaction(withRoles());
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(lastReply(log).components.length, 1);
  });
  it('two class roles -> ambiguous: falls back to the saved class', async () => {
    const { i } = interaction(withRoles('Thiết Y', 'Huyết Hà'));
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(upserts[0].className, '💊 Tố Vấn');
    assert.deepEqual(saves, []);
  });
  it('two class roles and no saved class -> menu', async () => {
    saved = null;
    const { i, log } = interaction(withRoles('Thiết Y', 'Huyết Hà'));
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(lastReply(log).components.length, 1);
    assert.deepEqual(upserts, []);
  });
  it('raw role-id array (API member) and no guild on the interaction -> no roles known, falls back to the saved class', async () => {
    const { i } = interaction({ guild: null, member: { roles: ['r1', 'r2'], permissions: NOBODY } });
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(upserts[0].className, '💊 Tố Vấn');
    assert.deepEqual(saves, [], 'nothing synced from roles');
  });
  it('role ids but no guild cache available -> behaves as no role', async () => {
    const { i } = interaction({ member: { roles: ['r1'], permissions: NOBODY } });
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(upserts[0].className, '💊 Tố Vấn');
  });
  it('a failing class sync does not fail the registration', async () => {
    registrationService.saveMemberClass = async () => {
      throw new Error('db down');
    };
    const { i, log } = interaction(withRoles('Thiết Y'));
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    assert.equal(upserts.length, 1);
    assert.match(lastReply(log), /Đã ghi nhận/);
  });
  it('confirmation replies use the class style (server emoji when matched, else unicode) + plain name', async () => {
    const guild = {
      roles: { cache: new Collection() },
      emojis: { cache: new Collection([['7', { id: '7', name: 'tovan', animated: false }]]) },
    };
    const { i, log } = interaction({ ...withRoles('Tố Vấn'), guild });
    await warHandler.handle(i, ['war', 'st', EID, 'join']);
    const deadline = Math.floor(new Date(stored.deadlineAt).getTime() / 1000);
    assert.equal(lastReply(log), `✅ Đã ghi nhận: **Tham gia** – <:tovan:7> Tố Vấn. Đổi được tới <t:${deadline}:f>.`);
    const chg = interaction({ ...withRoles('Tố Vấn'), guild });
    await warHandler.handle(chg.i, ['war', 'chg', EID]);
    assert.equal(lastReply(chg.log), '🎭 Phái của bạn: **<:tovan:7> Tố Vấn** (lấy theo role). Muốn đổi, nhờ quản lý đổi role.');
    const cls = interaction({ ...withRoles('Thành viên'), guild, values: ['🛡️ Thiết Y'] });
    await warHandler.handle(cls.i, ['war', 'cls', EID, '-']);
    assert.equal(lastReply(cls.log).content, 'Đã đổi môn phái thành 🛡️ Thiết Y.'); // no server emoji matches: unicode fallback
  });
  it('war:chg with a class role -> explanation, no menu', async () => {
    const { i, log } = interaction(withRoles('Tố Vấn'));
    await warHandler.handle(i, ['war', 'chg', EID]);
    assert.equal(lastReply(log), '🎭 Phái của bạn: **💊 Tố Vấn** (lấy theo role). Muốn đổi, nhờ quản lý đổi role.');
  });
  it('war:chg without a class role -> menu', async () => {
    const { i, log } = interaction(withRoles('Thành viên'));
    await warHandler.handle(i, ['war', 'chg', EID]);
    assert.equal(lastReply(log).components.length, 1);
    assert.equal(lastReply(log).content, 'Bạn chưa có role phái. Chọn môn phái của bạn:');
  });
  it('Vắng also tells until when it can be changed', async () => {
    const { i, log } = interaction(withRoles('Tố Vấn'));
    await warHandler.handle(i, ['war', 'st', EID, 'absent']);
    assert.equal(upserts[0].status, 'absent');
    assert.match(lastReply(log), /^✅ Đã ghi nhận: \*\*Vắng\*\* – .*Đổi được tới <t:\d+:f>\.$/);
  });
  it('legacy "Dự bị" button: ephemeral explanation, nothing saved, the old message is redrawn', async () => {
    const { i, log } = interaction(withRoles('Tố Vấn'));
    await warHandler.handle(i, ['war', 'st', EID, 'reserve']);
    assert.equal(lastReply(log), 'Nút Dự bị đã bỏ — bấm ✅ Tham gia hoặc ❌ Vắng.');
    assert.deepEqual(log[0], ['deferReply']);
    assert.deepEqual(upserts, []);
    assert.deepEqual(refreshed.map((r) => r[1]), [EID]);
  });
  it('war:cls with the removed reserve status saves the class, registers nothing and explains', async () => {
    const { i, log } = interaction({ ...withRoles('Thành viên'), values: ['🩸 Huyết Hà'] });
    await warHandler.handle(i, ['war', 'cls', EID, 'reserve']);
    assert.deepEqual(upserts, []);
    assert.match(lastReply(log).content, /Nút Dự bị đã bỏ/);
  });
  it('war:cls: the role wins over the picked value and the member is told', async () => {
    const { i, log } = interaction({ ...withRoles('Thiết Y'), values: ['🩸 Huyết Hà'] });
    await warHandler.handle(i, ['war', 'cls', EID, 'join']);
    assert.deepEqual(saves.map((s) => s[3]), ['🛡️ Thiết Y']);
    assert.equal(upserts[0].className, '🛡️ Thiết Y');
    assert.match(lastReply(log).content, /lấy theo role \*\*🛡️ Thiết Y\*\*/);
  });
  it('🎭 Phái của tôi after the deadline: the preference is saved, the registration keeps its class and the reply says so', async () => {
    stored = { ...stored, status: 'locked' };
    regs = [{ discordId: ADMIN, status: 'join', className: '🛡️ Thiết Y', displayName: 'A' }];
    const updates = [];
    registrationService.updateRegistrationClass = async (...a) => updates.push(a);
    const { i, log } = interaction({ ...withRoles('Thành viên'), values: ['🩸 Huyết Hà'] });
    await warHandler.handle(i, ['war', 'cls', EID, '-']);
    assert.deepEqual(saves.map((s) => s[3]), ['🩸 Huyết Hà']);
    assert.deepEqual(updates, [], 'the registration is not touched');
    assert.deepEqual(refreshed, [], 'nothing to redraw');
    assert.equal(lastReply(log).content, 'Đã lưu phái 🩸 Huyết Hà cho các lần sau — đăng ký trận này giữ nguyên 🛡️ Thiết Y.');
    // not registered for this war at all
    regs = [];
    const none = interaction({ ...withRoles('Thành viên'), values: ['🩸 Huyết Hà'] });
    await warHandler.handle(none.i, ['war', 'cls', EID, '-']);
    assert.equal(lastReply(none.log).content, 'Đã lưu phái 🩸 Huyết Hà cho các lần sau. Đăng ký trận này đã đóng.');
    // registered as absent
    regs = [{ discordId: ADMIN, status: 'absent', className: null, displayName: 'A' }];
    const gone = interaction({ ...withRoles('Thành viên'), values: ['🩸 Huyết Hà'] });
    await warHandler.handle(gone.i, ['war', 'cls', EID, '-']);
    assert.equal(lastReply(gone.log).content, 'Đã lưu phái 🩸 Huyết Hà cho các lần sau. Trận này bạn đã báo vắng.');
  });
  it('war:cls: picked value equal to the role class -> no note; no role -> picked value', async () => {
    let t = interaction({ ...withRoles('Thiết Y'), values: ['🛡️ Thiết Y'] });
    await warHandler.handle(t.i, ['war', 'cls', EID, '-']);
    assert.doesNotMatch(lastReply(t.log).content, /role/);
    t = interaction({ ...withRoles('Thành viên'), values: ['🩸 Huyết Hà'] });
    await warHandler.handle(t.i, ['war', 'cls', EID, '-']);
    assert.deepEqual(saves.map((s) => s[3]), ['🛡️ Thiết Y', '🩸 Huyết Hà']);
  });
});

