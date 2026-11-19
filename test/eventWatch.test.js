// The watched event channel: a manager's post there becomes an event whose card answers the post (src/bot/eventWatch.js).
// Discord is stubbed; the events live in the in-memory PostgreSQL (test/pgdb.js). The stubs are installed before eventWatch is loaded
// (it destructures what it imports).
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const guildConfigService = require('../src/services/guildConfigService');
const refresher = require('../src/bot/refresher');
const sheetSync = require('../src/bot/sheetSync');
const eventDocSync = require('../src/bot/eventDocSync');

const GUILD = '100000000000000001';
const WATCH = '200000000000000001';
let config;
guildConfigService.getConfig = async () => config;
const posted = [];
let postImpl = async (client, channelId, event, opts) => ({ ...event, channelId, messageId: `card-${posted.length}` });
refresher.postEventCard = async (...a) => (posted.push({ channelId: a[1], event: a[2], opts: a[3] }), postImpl(...a));
sheetSync.scheduleSync = () => {};
eventDocSync.scheduleDocSync = () => {};

const eventService = require('../src/services/eventService');
const { onMessageCreate } = require('../src/bot/eventWatch');

const MANAGER = { roles: { cache: new Map() }, permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) };
const MEMBER = { roles: { cache: new Map() }, permissions: new PermissionsBitField(0n) };
let seq = 0;
// A message as discord.js gives it; `replies` collects what the bot answered with message.reply.
function post(content, over = {}) {
  seq += 1;
  const replies = [];
  const msg = {
    id: `30000000000000${String(seq).padStart(4, '0')}`,
    guild: { id: GUILD },
    channelId: WATCH,
    author: { id: '400000000000000001', bot: false },
    member: MANAGER,
    content,
    client: {},
    reference: null,
    system: false,
    webhookId: null,
    reply: async (p) => (replies.push(p), { id: 'prompt-1' }),
    ...over,
  };
  return { msg, replies };
}
const eventsOfGuild = async () => db.q('select title, start_at, deadline_at, source_message_id, created_by from guild_events where guild_id = $1', [GUILD]);

describe('eventWatch: a post in the watched channel opens an event', () => {
  before(setupDb);
  beforeEach(async () => {
    await resetDb();
    await db.q('insert into guilds (id) values ($1)', [GUILD]);
    config = { guildId: GUILD, eventWatchChannelId: WATCH, adminRoleIds: [], features: { events: true } };
    posted.length = 0;
    postImpl = async (client, channelId, event) => ({ ...event, channelId, messageId: `card-${posted.length}` });
  });

  it('a manager post with a time: the event is made (title = first line, deadline = start) and its card answers the post', async () => {
    const { msg, replies } = post('**Giải Solo bang**\nCN 20h tại Lạc Dương, ai tham gia báo danh nhé');
    await onMessageCreate(msg);
    const rows = await eventsOfGuild();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Giải Solo bang');
    assert.equal(rows[0].source_message_id, msg.id);
    assert.equal(rows[0].created_by, msg.author.id);
    assert.equal(new Date(rows[0].deadline_at).getTime(), new Date(rows[0].start_at).getTime());
    assert.ok(new Date(rows[0].start_at) > new Date());
    assert.equal(posted.length, 1);
    assert.equal(posted[0].channelId, WATCH);
    assert.equal(posted[0].opts.replyTo, msg.id);
    assert.equal(replies.length, 0, 'the card is the answer, nothing else');
  });

  it('one event per post: the same post again makes nothing new', async () => {
    const { msg } = post('Họp bang 21:00 thứ 7');
    await onMessageCreate(msg);
    await onMessageCreate(msg);
    assert.equal((await eventsOfGuild()).length, 1);
    assert.equal(posted.length, 1);
    assert.ok(await eventService.eventBySource(GUILD, msg.id));
  });

  it('ignored: a member, a bot, a reply, a system / webhook message, another channel, events off, no watched channel', async () => {
    const text = 'Đi phó bản CN 20h';
    const cases = [
      post(text, { member: MEMBER }),
      post(text, { author: { id: '1', bot: true } }),
      post(text, { reference: { messageId: '9' } }),
      post(text, { system: true }),
      post(text, { webhookId: '7' }),
      post(text, { channelId: '200000000000000099' }),
    ];
    for (const { msg } of cases) await onMessageCreate(msg);
    config = { ...config, features: { events: false } };
    await onMessageCreate(post(text).msg);
    config = { ...config, features: { events: true }, eventWatchChannelId: null };
    await onMessageCreate(post(text).msg);
    assert.equal((await eventsOfGuild()).length, 0);
    assert.equal(posted.length, 0);
  });

  it('a manager role (not Manage Server) counts as a manager', async () => {
    config = { ...config, adminRoleIds: ['r-lead'] };
    const lead = { roles: { cache: new Map([['r-lead', {}]]) }, permissions: new PermissionsBitField(0n) };
    await onMessageCreate(post('Boss thế giới tối nay 23h30', { member: lead }).msg);
    assert.equal((await eventsOfGuild()).length, 1);
  });

  it('no time in the post: opened at once without a time (no deadline, members can answer, nothing else posted)', async () => {
    const { msg, replies } = post('Giải đấu bang sắp tới, mọi người chuẩn bị nhé');
    await onMessageCreate(msg);
    const rows = await eventsOfGuild();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].start_at, null);
    assert.equal(rows[0].deadline_at, null);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].opts.replyTo, msg.id);
    assert.equal(replies.length, 0);
    const event = await eventService.eventBySource(GUILD, msg.id);
    assert.equal(event.allowMaybe, false, 'only ✅ / ❌ under a post');
    assert.equal(eventService.canReply(event), true);
    assert.equal(eventService.remindAtOf(event), null);
  });

  it('an event without a time is never locked or reminded by the clock, and is over 7 days after it was made', async () => {
    await onMessageCreate(post('Điểm danh đi săn boss').msg);
    const far = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    assert.equal((await eventService.findDueLocks(far)).length, 0);
    assert.equal((await eventService.findDueReminders(far)).length, 0);
    assert.equal((await eventService.findFinished(new Date(Date.now() + 6 * 24 * 3600 * 1000))).length, 0);
    assert.equal((await eventService.findFinished(new Date(Date.now() + 8 * 24 * 3600 * 1000))).length, 1);
  });

  it('the card under a post: "Điểm danh sự kiện", the ticks, the time line only with a time, ✅ / ❌ / 📋', async () => {
    const { buildEventCard } = require('../src/bot/ui/eventCard');
    await onMessageCreate(post('Điểm danh đi săn boss').msg);
    await onMessageCreate(post('Họp bang 21:00 thứ 7').msg);
    const [untimed, timed] = posted.map((p) => p.event);
    const texts = (payload) => JSON.stringify(payload.components.map((c) => c.toJSON ? c.toJSON() : c));
    const a = texts(buildEventCard(untimed, { yes: 12, maybe: 0, no: 3 }));
    assert.match(a, /Điểm danh sự kiện/);
    assert.match(a, /Vui lòng báo danh sự kiện vào đây/);
    assert.match(a, /✅ Tham gia: \*\*12\*\*/);
    assert.match(a, /❌ Không: \*\*3\*\*/);
    assert.doesNotMatch(a, /❓/);
    assert.doesNotMatch(a, /🕗|Đổi được tới/);
    const b = texts(buildEventCard(timed, { yes: 0, maybe: 0, no: 0 }));
    assert.match(b, /🕗/);
    assert.match(b, /Đổi được tới/);
  });

  it('the card cannot be posted: the event is removed again (nothing half made)', async () => {
    postImpl = async () => {
      throw new Error('Missing Access');
    };
    await onMessageCreate(post('Họp bang 21:00 thứ 7').msg);
    assert.equal((await eventsOfGuild()).length, 0);
  });
});
