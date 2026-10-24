// One war per week: the create guard, the "move the war message to the new announce channel" flow and the index migration.
// DB / Discord stubbed. Stubs on registrationService / guildConfigService are installed BEFORE the handlers are required.
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const warService = require('../src/services/warService');
const registrationService = require('../src/services/registrationService');
const guildConfigService = require('../src/services/guildConfigService');
const { vn, oid, sid, makeRegs } = require('./helpers');

let config;
let regs = [];
guildConfigService.getConfigOrDefault = async () => config;
guildConfigService.getConfig = async () => config; // used by refresher.refreshNow
registrationService.listRegistrations = async () => regs;
const adminHandler = require('../src/bot/interactions/admin');
const refresher = require('../src/bot/refresher');

const GUILD = '800000000000000001';
const EID = oid(7);
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
const SAT = { warDay: 6, warTime: '20:00', lockBeforeHours: 2, remindBeforeHours: 3, enabled: true, openDay: 1, openTime: '00:00' };

let existing;
let created;
let events;
let moves; // warService.moveMessage calls
let deleted; // [channelId, messageId]
let sent; // [channelId, payload]
let sendFails;
let moveResults;
let deleteErrors; // channelId -> error thrown by messages.delete
let edited; // [channelId, messageId] of messages.edit calls

beforeEach(() => {
  config = { ...guildConfigService.defaultConfig(GUILD), announceChannelId: 'new-chan', classes: ['Thiết Y'], schedule: { ...guildConfigService.defaultConfig(GUILD).schedule, ...SAT } };
  regs = makeRegs(3);
  existing = { _id: EID, guildId: GUILD, title: 'Bang chiến T7 20:00 (10/10)', status: 'open', startAt: vn(2026, 10, 10, 20), deadlineAt: vn(2026, 10, 10, 18), channelId: 'old-chan', messageId: 'old-msg', teams: [] };
  created = [];
  events = [];
  moves = [];
  deleted = [];
  sent = [];
  sendFails = false;
  moveResults = [true];
  deleteErrors = {};
  edited = [];
  warService.findEventByStart = async () => existing;
  warService.createEvent = async (data) => {
    created.push(data);
    return { _id: EID, ...data };
  };
  warService.getEvent = async () => existing;
  warService.moveMessage = async (...a) => {
    moves.push(a);
    return moveResults.length > 1 ? moveResults.shift() : moveResults[0];
  };
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});

const channelOf = (id) => ({
  id,
  guild: { id: GUILD },
  send: async (payload) => {
    if (sendFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    sent.push([id, payload]);
    return { id: `msg-in-${id}` };
  },
  messages: {
    edit: async (messageId) => {
      edited.push([id, messageId]);
    },
    delete: async (messageId) => {
      if (deleteErrors[id]) throw deleteErrors[id];
      deleted.push([id, messageId]);
    },
  },
});

function interaction(extra = {}) {
  const log = [];
  const i = {
    guildId: GUILD,
    user: { id: sid(900) },
    member: { roles: [], permissions: MANAGE },
    memberPermissions: MANAGE,
    client: { channels: { fetch: async (id) => channelOf(id) } },
    fields: { getTextInputValue: () => '10/10 18:00' },
    deferReply: async () => log.push(['deferReply']),
    deferUpdate: async () => log.push(['deferUpdate']),
    editReply: async (o) => log.push(['editReply', o]),
    reply: async (o) => log.push(['reply', o]),
    ...extra,
  };
  return { i, log };
}
const lastReply = (log) => log.filter((l) => l[0] === 'editReply').pop()[1];
const withNow = (fn) => async () => {
  mock.timers.enable({ apis: ['Date'], now: vn(2026, 10, 7, 12, 0) });
  try {
    await fn();
  } finally {
    mock.timers.reset();
  }
};
const buttonIds = (reply) => (reply.components || []).flatMap((r) => r.toJSON().components.map((c) => c.custom_id));

describe('adm:createModal: one war per week', () => {
  it('an event for this war start exists: nothing is created, the reply names it with its status and link', withNow(async () => {
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'createModal']);
    assert.deepEqual(created, []);
    const r = lastReply(log);
    assert.match(r.content, /⚠️ Tuần này đã có \*\*Bang chiến T7 20:00 \(10\/10\)\*\* \(🟢 Đang mở đăng ký\) — https:\/\/discord\.com\/channels\/800000000000000001\/old-chan\/old-msg/);
  }));
  it('looks the event up by guild and the start of the next war', withNow(async () => {
    const seen = [];
    warService.findEventByStart = async (guildId, startAt) => {
      seen.push([guildId, startAt]);
      return existing;
    };
    await adminHandler.handle(interaction().i, ['adm', 'createModal']);
    assert.deepEqual(seen, [[GUILD, vn(2026, 10, 10, 20)]]);
  }));
  for (const status of ['open', 'locked', 'published', 'done']) {
    it(`blocks an existing ${status} event too`, withNow(async () => {
      existing.status = status;
      const { i, log } = interaction();
      await adminHandler.handle(i, ['adm', 'createModal']);
      assert.deepEqual(created, []);
      assert.ok(lastReply(log).content.includes(status === 'done' ? 'đã kết thúc rồi' : warService.STATUS_LABELS[status]));
    }));
  }
  it('no event yet: created as before', withNow(async () => {
    warService.findEventByStart = async () => null;
    warService.claimPost = async () => true;
    warService.setMessage = async () => {};
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'createModal']);
    assert.equal(created.length, 1);
    assert.match(lastReply(log), /✅ Đã tạo/);
  }));
  it('a duplicate-key error (parallel create / scheduler) is answered like an existing event', withNow(async () => {
    let lookups = 0;
    warService.findEventByStart = async () => (++lookups === 1 ? null : existing);
    warService.createEvent = async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "war_events_guild_id_start_at_key"'), { code: '23505' });
    };
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'createModal']);
    assert.match(lastReply(log).content, /Tuần này đã có/);
  }));
  it('a finished war in the same week blocks creation and the reply says it is finished', withNow(async () => {
    existing = { ...existing, status: 'done' };
    const { i, log } = interaction();
    await adminHandler.handle(i, ['adm', 'createModal']);
    assert.deepEqual(created, []);
    assert.match(lastReply(log).content, /đã kết thúc rồi, không tạo thêm/);
  }));
  it('other create errors are not swallowed', withNow(async () => {
    warService.findEventByStart = async () => null;
    warService.createEvent = async () => {
      throw new Error('db down');
    };
    await assert.rejects(() => adminHandler.handle(interaction().i, ['adm', 'createModal']), /db down/);
  }));
  it('a duplicate-key error without a findable event is rethrown', withNow(async () => {
    warService.findEventByStart = async () => null;
    warService.createEvent = async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    };
    await assert.rejects(() => adminHandler.handle(interaction().i, ['adm', 'createModal']), /duplicate key value/);
  }));

  describe('move button', () => {
    const idsFor = async () => {
      const { i, log } = interaction();
      await adminHandler.handle(i, ['adm', 'createModal']);
      return buttonIds(lastReply(log));
    };
    it('open event in another channel than the announce channel: adm:move:<eid>', withNow(async () => {
      assert.deepEqual(await idsFor(), [`adm:move:${EID}`]);
    }));
    it('locked too; the reply names both channels', withNow(async () => {
      existing.status = 'locked';
      const { i, log } = interaction();
      await adminHandler.handle(i, ['adm', 'createModal']);
      assert.deepEqual(buttonIds(lastReply(log)), [`adm:move:${EID}`]);
      assert.match(lastReply(log).content, /<#old-chan>.*<#new-chan>/);
    }));
    it('no button when the message is already in the announce channel, was never posted, or the war is published / done', withNow(async () => {
      existing.channelId = 'new-chan';
      assert.deepEqual(await idsFor(), []);
      existing.channelId = 'old-chan';
      existing.messageId = null;
      assert.deepEqual(await idsFor(), []);
      existing.messageId = 'old-msg';
      for (const status of ['published', 'done']) {
        existing.status = status;
        assert.deepEqual(await idsFor(), []);
      }
    }));
  });
});

describe('adm:move:<eid>', () => {
  const move = async (extra) => {
    const { i, log } = interaction(extra);
    await adminHandler.handle(i, ['adm', 'move', EID]);
    const r = lastReply(log);
    return { log, reply: typeof r === 'string' ? r : r.content, comps: r.components };
  };

  it('posts the war message (live counts) in the announce channel, saves ids compare-and-set on the old message, deletes the old one', async () => {
    const { log, reply, comps } = await move();
    assert.deepEqual(log[0], ['deferUpdate']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'new-chan');
    assert.match(JSON.stringify(sent[0][1]), /3/, 'the message is built from the current registrations');
    assert.deepEqual(moves, [[EID, 'old-msg', 'new-chan', 'msg-in-new-chan']]);
    assert.deepEqual(deleted, [['old-chan', 'old-msg']]);
    assert.match(reply, /✅ Đã chuyển.*<#new-chan>.*discord\.com\/channels\/800000000000000001\/new-chan\/msg-in-new-chan/);
    assert.doesNotMatch(reply, /⚠️/);
    assert.deepEqual(comps, [], 'the button goes away');
  });
  it('M1: after a successful move the NEW message is refreshed from fresh DB state; a lost compare-and-set refreshes nothing', async () => {
    warService.moveMessage = async () => {
      existing = { ...existing, channelId: 'new-chan', messageId: 'msg-in-new-chan' };
      return true;
    };
    await move();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(edited, [['new-chan', 'msg-in-new-chan']]);
    edited = [];
    moveResults = [false];
    warService.moveMessage = async () => false;
    existing = { ...existing, channelId: 'old-chan', messageId: 'old-msg' };
    await move();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(edited, []);
  });
  it('the old message already gone (Unknown Message / Unknown Channel): silent', async () => {
    for (const code of [10008, 10003]) {
      deleteErrors = { 'old-chan': Object.assign(new Error('Unknown'), { code }) };
      const { reply } = await move();
      assert.match(reply, /✅ Đã chuyển/);
      assert.doesNotMatch(reply, /⚠️/);
    }
  });
  it('the old message cannot be deleted (missing access): moved, but the admin is told and gets the link', async () => {
    deleteErrors = { 'old-chan': Object.assign(new Error('Missing Access'), { code: 50001 }) };
    const { reply } = await move();
    assert.match(reply, /✅ Đã chuyển/);
    assert.match(reply, /⚠️ Chưa xoá được bài cũ ở <#old-chan>.*old-chan\/old-msg/s);
    assert.equal(moves.length, 1, 'registrations and the new location are kept');
  });
  it('lost the compare-and-set (somebody moved it first): the message just sent is removed, the old one is kept', async () => {
    moveResults = [false];
    const { reply } = await move();
    assert.deepEqual(deleted, [['new-chan', 'msg-in-new-chan']]);
    assert.match(reply, /vừa được chuyển/);
  });
  it('double click: the second click finds the event already in the announce channel and posts nothing', async () => {
    await move();
    existing = { ...existing, channelId: 'new-chan', messageId: 'msg-in-new-chan' };
    sent = [];
    deleted = [];
    const { reply } = await move();
    assert.deepEqual(sent, []);
    assert.deepEqual(deleted, []);
    assert.match(reply, /đã ở <#new-chan>/);
  });
  it('two clicks racing on a stale read: exactly one keeps its message', async () => {
    moveResults = [true, false];
    await Promise.all([move(), move()]);
    assert.equal(sent.length, 2);
    assert.deepEqual(deleted.sort(), [['new-chan', 'msg-in-new-chan'], ['old-chan', 'old-msg']].sort());
  });
  it('the send fails: nothing is saved, the old message stays, the reply points at the bot permissions', async () => {
    sendFails = true;
    const { reply } = await move();
    assert.deepEqual(moves, []);
    assert.deepEqual(deleted, []);
    assert.match(reply, /❌ Không đăng được bài vào <#new-chan>.*Bài cũ giữ nguyên/);
  });
  it('refuses a finished event, an unknown / foreign event and a missing announce channel', async () => {
    existing.status = 'published';
    assert.match((await move()).reply, /không chuyển bài được/);
    existing = null;
    assert.match((await move()).reply, /không tồn tại/);
    existing = { _id: EID, guildId: 'other', status: 'open' };
    assert.match((await move()).reply, /không tồn tại/);
    existing = { _id: EID, guildId: GUILD, title: 'x', status: 'open', channelId: 'old-chan', messageId: 'm' };
    config.announceChannelId = null;
    assert.match((await move()).reply, /Chưa chọn kênh thông báo/);
    assert.deepEqual(sent, []);
  });
  it('is admin-only', async () => {
    const { reply } = await move({ member: { roles: [], permissions: NOBODY }, memberPermissions: NOBODY });
    assert.match(reply, /không có quyền/);
    assert.deepEqual(sent, []);
  });
});

describe('moveWarMessage', () => {
  const client = { channels: { fetch: async (id) => channelOf(id) } };
  it('a failing moveMessage (db error) removes the message it just sent and rethrows', async () => {
    warService.moveMessage = async () => {
      throw new Error('db timeout');
    };
    await assert.rejects(() => refresher.moveWarMessage(client, config, existing), /db timeout/);
    assert.deepEqual(deleted, [['new-chan', 'msg-in-new-chan']]);
  });
  it('reports how the old message went', async () => {
    assert.equal((await refresher.moveWarMessage(client, config, existing)).oldDelete, 'ok');
    deleteErrors = { 'old-chan': Object.assign(new Error('Unknown Message'), { code: 10008 }) };
    assert.equal((await refresher.moveWarMessage(client, config, existing)).oldDelete, 'gone');
    deleteErrors = { 'old-chan': new Error('boom') };
    const r = await refresher.moveWarMessage(client, config, existing);
    assert.equal(r.oldDelete, 'failed');
    assert.equal(r.event.channelId, 'new-chan');
    assert.equal(r.event.messageId, 'msg-in-new-chan');
  });
});

describe('scheduler auto-create and the unique start', () => {
  it('shouldAutoCreate skips a week that already has a manual or an auto event', () => {
    const cycle = { warStart: vn(2026, 10, 10, 20), openAt: vn(2026, 10, 5), deadline: vn(2026, 10, 10, 18) };
    const now = vn(2026, 10, 7, 12);
    assert.equal(warService.shouldAutoCreate(cycle, now, [{ status: 'open', auto: false, startAt: vn(2026, 10, 10, 20) }]), false);
    assert.equal(warService.shouldAutoCreate(cycle, now, [{ status: 'locked', auto: true, startAt: vn(2026, 10, 10, 20) }]), false);
    assert.equal(warService.shouldAutoCreate(cycle, now, []), true);
  });
});
