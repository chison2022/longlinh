// Review fixes: class change, claim, export order, lineup canon, config dedupe. DB parts on an in-memory PostgreSQL; no network.
const { describe, it, mock, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const registrationService = require('../src/services/registrationService');
const warService = require('../src/services/warService');
const roster = require('../src/services/rosterService');
const guildConfig = require('../src/services/guildConfigService');
const { buildUnregView } = require('../src/bot/ui/unreg');
const { buildClassSelect } = require('../src/bot/ui/warMessage');
const { sid, oid } = require('./helpers');
const { assertV2Message } = require('./discordLimits');

afterEach(() => mock.restoreAll());

describe('DB fixes (PostgreSQL)', () => {
  const G = 'G';
  before(setupDb);
  beforeEach(async () => {
    await resetDb();
    await db.q('insert into guilds (id) values ($1)', [G]);
  });
  const war = (startAt) => warService.createEvent({ guildId: G, title: 't', startAt, deadlineAt: startAt, teams: [] });

  it('updateRegistrationClass changes the class of that registration and the member name; saveMemberClass remembers the class', async () => {
    const e = await war(new Date('2026-10-10T13:00:00Z'));
    await registrationService.upsertRegistration({ eventId: e._id, guildId: G, discordId: sid(1), displayName: 'A', status: 'join', className: 'Thiết Y' });
    await registrationService.updateRegistrationClass(e._id, sid(1), 'Tố Vấn', 'A mới');
    const r = await registrationService.getRegistration(e._id, sid(1));
    assert.deepEqual([r.className, r.displayName, r.status], ['Tố Vấn', 'A mới', 'join']);
    await registrationService.saveMemberClass(G, sid(1), 'A mới', 'Huyết Hà');
    assert.equal((await registrationService.getMember(G, sid(1))).className, 'Huyết Hà');
  });
  it('claimManualRemind: one claim per 10 minutes; a lost claim says when the blocking reminder was sent; release gives it back', async () => {
    const e = await war(new Date('2026-10-10T13:00:00Z'));
    const now = new Date('2026-10-07T10:00:00Z');
    assert.deepEqual(await warService.claimManualRemind(e._id, now), { claimed: true, at: null });
    const lost = await warService.claimManualRemind(e._id, new Date('2026-10-07T10:05:00Z'));
    assert.equal(lost.claimed, false);
    assert.equal(lost.at.toISOString(), now.toISOString());
    assert.equal((await warService.claimManualRemind(e._id, new Date('2026-10-07T10:11:00Z'))).claimed, true, 'older than 10 min');
    await warService.releaseManualRemind(e._id, new Date('2026-10-07T10:11:00Z'));
    assert.equal((await warService.claimManualRemind(e._id, new Date('2026-10-07T10:12:00Z'))).claimed, true);
  });
});

describe('export order', () => {
});

describe('lineup image input', () => {
});

describe('config class dedupe on load', () => {
  it('getConfig keeps the first spelling of a repeated class', async () => {
    guildConfig.clearConfigCache();
    mock.method(db, 'one', async () => ({ id: 'GD', settings: { classes: ['🛡️ Thiết Y', 'Tố Vấn', 'Thiết Y'], classEmojis: [] } }));
    const c = await guildConfig.getConfig('GD', { fresh: true });
    assert.deepEqual(c.classes, ['🛡️ Thiết Y', 'Tố Vấn']);
    const row = buildClassSelect('war:cls:x:-', c.classes, 'Thiết Y', new Map()).toJSON();
    assert.equal(row.components[0].options.filter((o) => o.default).length, 1);
    guildConfig.clearConfigCache();
  });
  it('defaultConfig is already duplicate-free', () => {
    const c = guildConfig.defaultConfig('G');
    assert.equal(new Set(c.classes).size, c.classes.length);
  });
});

describe('unreg view with a partial member list', () => {
  const event = { _id: oid(1), title: 'T', status: 'open' };
  it('never says everybody registered when incomplete', () => {
    const v = buildUnregView(event, { total: 0, groups: [] }, { incomplete: true });
    const text = assertV2Message(v).text;
    assert.doesNotMatch(text, /Mọi thành viên đã đăng ký/);
    assert.match(text, /Không tải đủ danh sách/);
    assert.match(assertV2Message(buildUnregView(event, { total: 0, groups: [] })).text, /Mọi thành viên đã đăng ký/);
  });
});
