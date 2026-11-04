// Scheduler tick tests with all DB / Discord access stubbed (no MongoDB needed).
// Destructured imports in scheduler.js are captured at require time, so the stubs are
// installed on the module exports BEFORE scheduler.js is required.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { vn, sid } = require('./helpers');

const warService = require('../src/services/warService');
const registrationService = require('../src/services/registrationService');
const guildConfigService = require('../src/services/guildConfigService');
const refresher = require('../src/bot/refresher');
const gameRosterService = require('../src/services/gameRosterService');
const departureService = require('../src/services/departureService');
const departNotice = require('../src/bot/departNotice');
const offNotice = require('../src/bot/offNotice');
const eventLog = require('../src/eventLog');
const eventService = require('../src/services/eventService');

const real = { computeCycle: warService.computeCycle, shouldAutoCreate: warService.shouldAutoCreate, remindAtFor: warService.remindAtFor, buildTitle: warService.buildTitle, buildReminderMessages: warService.buildReminderMessages, messageLink: warService.messageLink };

let stubs;
const calls = [];
const record = (name) => (...args) => {
  calls.push([name, ...args]);
  return stubs[name](...args);
};

// Indirect stubs for destructured imports.
registrationService.listRegistrations = record('listRegistrations');
guildConfigService.getConfig = record('getConfig');
guildConfigService.listScheduledConfigs = record('listScheduledConfigs');
refresher.scheduleRefresh = record('scheduleRefresh');
refresher.postWarMessage = record('postWarMessage');
refresher.hasPendingSave = record('hasPendingSave');
refresher.retryPendingSaves = record('retryPendingSaves');
refresher.scheduleEventRefresh = record('scheduleEventRefresh');
// the guild-events step reads eventService at call time
for (const name of ['findDueLocks', 'lockEvent', 'findDueReminders', 'claimRemind', 'findFinished', 'markDone', 'listReplies', 'findDueMinNotices', 'claimMinNotice', 'countsOf']) {
  eventService[name] = record(`ev_${name}`);
}
// departNotice reads these at call time (module objects).
gameRosterService.latest = record('latest');
for (const name of ['listNoticeConfigs', 'loadLinked', 'claimNotice', 'saveNoticeIds']) departureService[name] = record(name);
// the off-notice step is a module object read at call time (the leave service is gone: its calls are never recorded); the off notice has its own tests (offNotice.test.js)
offNotice.noticeDue = record('offNoticeDue');
// warService is used as a namespace object, so these are looked up at call time.
for (const name of ['findFinished', 'markDone', 'findDueLocks', 'lockEvent', 'findDueReminders', 'claimReminder', 'listActiveEvents', 'findEventByStart', 'createEvent']) {
  warService[name] = record(name);
}

const actBridge = require('../src/bot/actBridge');
const openPing = require('../src/bot/openPing');
const { tick, stop } = require('../src/jobs/scheduler');

const NOW = vn(2026, 10, 6, 10, 0); // Tuesday
const GUILD = '900000000000000001';

function defaultStubs() {
  return {
    findFinished: async () => [],
    markDone: async () => null,
    findDueLocks: async () => [],
    lockEvent: async () => null,
    findDueReminders: async () => [],
    claimReminder: async () => false,
    listActiveEvents: async () => [],
    findEventByStart: async () => null,
    createEvent: async (data) => ({ ...data, _id: 'new-event' }),
    listRegistrations: async () => [],
    getConfig: async () => null,
    listScheduledConfigs: async () => [],
    scheduleRefresh: () => {},
    hasPendingSave: () => false,
    retryPendingSaves: async () => {},
    postWarMessage: async (client, config, event) => ({ ...event, channelId: 'c', messageId: 'm' }),
    listNoticeConfigs: async () => [],
    offNoticeDue: async () => {},
    coveringIds: async () => new Set(),
    autoAbsent: async () => ({ applied: 0, ids: [] }),
    latest: async () => null,
    loadLinked: async () => [],
    claimNotice: async () => true,
    saveNoticeIds: async () => {},
    scheduleEventRefresh: () => {},
    ev_findDueLocks: async () => [],
    ev_lockEvent: async () => null,
    ev_findDueReminders: async () => [],
    ev_claimRemind: async () => false,
    ev_findFinished: async () => [],
    ev_markDone: async () => null,
    ev_listReplies: async () => [],
    ev_findDueMinNotices: async () => [],
    ev_claimMinNotice: async () => true,
    ev_countsOf: async () => ({ yes: 0, maybe: 0, no: 0 }),
  };
}

const callsOf = (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

// Fake client: one channel that records sends, one guild with members.
function makeClient({ members = [], fetchMembersError = null } = {}) {
  const sent = [];
  const channel = { id: 'chan', send: async (payload) => sent.push(payload) };
  const coll = new Collection(members.map((m) => [m.id, m]));
  const client = {
    sent,
    channels: { fetch: async () => channel },
    guilds: {
      fetch: async () => ({
        members: {
          fetch: async () => {
            if (fetchMembersError) throw fetchMembersError;
            return coll;
          },
        },
      }),
    },
  };
  return client;
}

const member = (n, roles = ['role-member'], bot = false) => ({ id: sid(n), user: { bot }, roles: { cache: new Map(roles.map((r) => [r, {}])) } });

beforeEach(() => {
  departNotice.resetWarned();
  stubs = defaultStubs();
  calls.length = 0;
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'log', () => {});
});

describe('scheduler.tick – finish/lock', () => {
  it('marks finished events done and refreshes only those actually transitioned', async () => {
    stubs.findFinished = async () => [{ _id: 'e1' }, { _id: 'e2' }];
    stubs.markDone = async (id) => (id === 'e1' ? { _id: 'e1', status: 'done' } : null);
    const client = makeClient();
    await tick(client, NOW);
    assert.deepEqual(callsOf('findFinished'), [[NOW, 12]]);
    assert.deepEqual(callsOf('scheduleRefresh'), [[client, 'e1', 0]]);
  });
  it('locks due events and refreshes them immediately', async () => {
    stubs.findDueLocks = async () => [{ _id: 'a' }, { _id: 'b' }];
    stubs.lockEvent = async (id) => ({ _id: id, status: 'locked' });
    const client = makeClient();
    await tick(client, NOW);
    assert.deepEqual(callsOf('findDueLocks'), [[NOW]]);
    assert.deepEqual(callsOf('scheduleRefresh').map((c) => c[1]), ['a', 'b']);
  });
  it('copies each war it locks into the Activity database (once, at the lock)', async () => {
    const seen = [];
    const real = actBridge.onLocked;
    actBridge.onLocked = (c, id) => seen.push(id);
    try {
      stubs.findDueLocks = async () => [{ _id: 'a' }, { _id: 'b' }];
      stubs.lockEvent = async (id) => (id === 'a' ? { _id: id, status: 'locked' } : null); // b was locked by somebody else meanwhile
      await tick(makeClient(), NOW);
    } finally {
      actBridge.onLocked = real;
    }
    assert.deepEqual(seen, ['a']);
  });
  it('an error in one event does not stop the others', async () => {
    stubs.findDueLocks = async () => [{ _id: 'bad' }, { _id: 'good' }];
    stubs.lockEvent = async (id) => {
      if (id === 'bad') throw new Error('boom');
      return { _id: id };
    };
    await tick(makeClient(), NOW);
    assert.deepEqual(callsOf('scheduleRefresh').map((c) => c[1]), ['good']);
  });
  it('a failing step does not stop later steps', async () => {
    stubs.findFinished = async () => {
      throw new Error('db down');
    };
    stubs.findDueLocks = async () => [{ _id: 'x' }];
    stubs.lockEvent = async () => ({ _id: 'x' });
    await tick(makeClient(), NOW);
    assert.equal(callsOf('lockEvent').length, 1);
    assert.equal(callsOf('listScheduledConfigs').length, 1);
  });
  it('concurrent ticks do not overlap', async () => {
    let release;
    stubs.findFinished = () => new Promise((r) => (release = () => r([])));
    const client = makeClient();
    const first = tick(client, NOW);
    await tick(client, NOW); // returns immediately while the first is running
    assert.equal(callsOf('findFinished').length, 1);
    release();
    await first;
    stubs.findFinished = async () => [];
    await tick(client, NOW); // flag released afterwards
    assert.equal(callsOf('findFinished').length, 2);
  });
});

describe('scheduler.tick – reminders', () => {
  const event = {
    _id: 'ev1',
    guildId: GUILD,
    title: 'Bang chiến CN 20:00 (11/10)',
    deadlineAt: vn(2026, 10, 11, 18, 0),
    channelId: 'chan',
    messageId: 'msg',
  };
  it('does nothing when the reminder was already claimed', async () => {
    stubs.findDueReminders = async () => [event];
    stubs.claimReminder = async () => false;
    const client = makeClient();
    await tick(client, NOW);
    assert.equal(client.sent.length, 0);
  });
  it('pings only unregistered, non-bot members with the member role', async () => {
    stubs.findDueReminders = async () => [event];
    stubs.claimReminder = async () => true;
    stubs.getConfig = async () => ({ announceChannelId: 'chan', memberRoleId: 'role-member' });
    stubs.listRegistrations = async () => [{ discordId: sid(2) }];
    const client = makeClient({ members: [member(1), member(2), member(3, ['other']), member(4, ['role-member'], true), member(5)] });
    await tick(client, NOW);
    assert.equal(client.sent.length, 1);
    const msg = client.sent[0];
    assert.ok(msg.content.includes(`<@${sid(1)}>`));
    assert.ok(msg.content.includes(`<@${sid(5)}>`));
    for (const n of [2, 3, 4]) assert.ok(!msg.content.includes(`<@${sid(n)}>`), `should not ping ${n}`);
    assert.deepEqual(msg.allowedMentions, { parse: ['users'] });
    assert.ok(msg.content.includes('https://discord.com/channels/'));
  });
  it('splits large reminder lists into messages under 2000 chars', async () => {
    stubs.findDueReminders = async () => [event];
    stubs.claimReminder = async () => true;
    stubs.getConfig = async () => ({ announceChannelId: 'chan', memberRoleId: 'role-member' });
    const client = makeClient({ members: Array.from({ length: 150 }, (_, i) => member(i)) });
    await tick(client, NOW);
    assert.ok(client.sent.length >= 2);
    assert.ok(client.sent.every((m) => m.content.length <= 2000));
    const pinged = client.sent.flatMap((m) => m.content.match(/<@\d+>/g) || []);
    assert.equal(pinged.length, 150);
  });
  it('leave is retired: members with an active leave request ARE reminded (no exclusion), even with leave: true stored; the leave service is never read', async () => {
    stubs.findDueReminders = async () => [{ ...event, startAt: vn(2026, 10, 11, 20, 0) }];
    stubs.claimReminder = async () => true;
    stubs.getConfig = async () => ({ announceChannelId: 'chan', memberRoleId: 'role-member', features: { leave: true } });
    stubs.coveringIds = async () => new Set([sid(1)]);
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.equal(client.sent.length, 1);
    assert.ok(client.sent[0].content.includes(`<@${sid(1)}>`), 'on leave: pinged like everybody not registered');
    assert.ok(client.sent[0].content.includes(`<@${sid(2)}>`));
    assert.equal(callsOf('coveringIds').length, 0);
    assert.equal(callsOf('autoAbsent').length, 0);
  });
  it('everyone registered -> no message', async () => {
    stubs.findDueReminders = async () => [event];
    stubs.claimReminder = async () => true;
    stubs.getConfig = async () => ({ announceChannelId: 'chan', memberRoleId: 'role-member' });
    stubs.listRegistrations = async () => [{ discordId: sid(1) }];
    const client = makeClient({ members: [member(1)] });
    await tick(client, NOW);
    assert.equal(client.sent.length, 0);
  });
  it('no member role configured -> header only, no pings', async () => {
    stubs.findDueReminders = async () => [event];
    stubs.claimReminder = async () => true;
    stubs.getConfig = async () => ({ announceChannelId: 'chan', memberRoleId: null });
    const client = makeClient({ members: [member(1)] });
    await tick(client, NOW);
    assert.equal(client.sent.length, 1);
    assert.deepEqual(client.sent[0].allowedMentions, { parse: [] });
    assert.ok(!client.sent[0].content.includes('<@'));
  });
  it('member fetch failure (no intent) -> header only', async () => {
    stubs.findDueReminders = async () => [event];
    stubs.claimReminder = async () => true;
    stubs.getConfig = async () => ({ announceChannelId: 'chan', memberRoleId: 'role-member' });
    const client = makeClient({ fetchMembersError: new Error('Missing intent') });
    await tick(client, NOW);
    assert.equal(client.sent.length, 1);
    assert.deepEqual(client.sent[0].allowedMentions, { parse: [] });
  });
  it('no channel known -> nothing sent', async () => {
    stubs.findDueReminders = async () => [{ ...event, channelId: null }];
    stubs.claimReminder = async () => true;
    stubs.getConfig = async () => null;
    const client = makeClient();
    await tick(client, NOW);
    assert.equal(client.sent.length, 0);
  });
});

describe('scheduler.tick – auto create', () => {
  const config = {
    guildId: GUILD,
    announceChannelId: 'chan',
    groupCount: 1,
    classes: ['A'],
    schedule: { enabled: true, warDay: 0, warTime: '20:00', openDay: 1, openTime: '09:00', lockBeforeHours: 2, remindBeforeHours: 3 },
  };
  it('creates and posts the event for the current cycle', async () => {
    stubs.listScheduledConfigs = async () => [config];
    await tick(makeClient(), NOW);
    const created = callsOf('createEvent');
    assert.equal(created.length, 1);
    const data = created[0][0];
    assert.deepEqual(data, {
      guildId: GUILD,
      title: 'Bang chiến CN 20:00 (11/10)',
      startAt: vn(2026, 10, 11, 20, 0),
      deadlineAt: vn(2026, 10, 11, 18, 0),
      remindAt: vn(2026, 10, 11, 15, 0),
      auto: true,
    });
    assert.equal(callsOf('postWarMessage').length, 1);
    assert.equal(callsOf('postWarMessage')[0][1], config);
  });
  describe('the registration-open role ping', () => {
    const pinged = [];
    const real = openPing.sendOpenPing;
    beforeEach(() => {
      pinged.length = 0;
      openPing.sendOpenPing = async (client, cfg, event) => {
        pinged.push([cfg.guildId, event.messageId]);
      };
    });
    afterEach(() => {
      openPing.sendOpenPing = real;
      stop(); // forgets the post back-off of the failing-post case
    });
    it('is attempted once after the auto-created war message is posted', async () => {
      stubs.listScheduledConfigs = async () => [{ ...config, memberRoleId: 'role', schedule: { ...config.schedule, openPing: true } }];
      await tick(makeClient(), NOW);
      assert.deepEqual(pinged, [[GUILD, 'm']]);
    });
    it('is attempted after the missing war message of an existing event is posted too', async () => {
      const orphan = { _id: 'orphan-1', guildId: GUILD, status: 'open', startAt: vn(2026, 10, 11, 20, 0), deadlineAt: vn(2026, 10, 11, 18, 0), messageId: null, auto: true, createdAt: new Date(NOW.getTime() - 10 * 60 * 1000) };
      stubs.listScheduledConfigs = async () => [{ ...config, memberRoleId: 'role', schedule: { ...config.schedule, openPing: true } }];
      stubs.listActiveEvents = async () => [orphan];
      await tick(makeClient(), NOW);
      assert.deepEqual(pinged, [[GUILD, 'm']]);
    });
    it('is not attempted when the war message could not be posted', async () => {
      stubs.listScheduledConfigs = async () => [{ ...config, memberRoleId: 'role', schedule: { ...config.schedule, openPing: true } }];
      stubs.postWarMessage = async () => {
        throw new Error('Missing Permissions');
      };
      await tick(makeClient(), NOW);
      assert.deepEqual(pinged, []);
    });
    it('a failing ping does not touch the war post: the dashboard still refreshes', async () => {
      stubs.listScheduledConfigs = async () => [{ ...config, memberRoleId: 'role', schedule: { ...config.schedule, openPing: true } }];
      openPing.sendOpenPing = async () => {
        throw new Error('boom');
      };
      await tick(makeClient(), NOW);
      assert.equal(callsOf('postWarMessage').length, 1);
    });
  });
  it('nobody is registered absent for a leave when the event is created: the war message is posted straight away', async () => {
    stubs.listScheduledConfigs = async () => [{ ...config, features: { leave: true } }];
    const order = [];
    stubs.autoAbsent = async () => {
      order.push('autoAbsent');
      return { applied: 2, ids: ['a', 'b'] };
    };
    stubs.postWarMessage = async (client, cfg, event) => {
      order.push('post');
      return { ...event, channelId: 'c', messageId: 'm' };
    };
    await tick(makeClient(), NOW);
    assert.deepEqual(order, ['post']);
    assert.equal(callsOf('autoAbsent').length, 0);
  });
  it('skips when an active event already exists for this war', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.listActiveEvents = async () => [{ startAt: vn(2026, 10, 11, 20, 0), status: 'open' }];
    await tick(makeClient(), NOW);
    assert.equal(callsOf('createEvent').length, 0);
  });
  it('skips when a finished (done) event already exists for this war week', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.findEventByStart = async () => ({ startAt: vn(2026, 10, 11, 20, 0), status: 'done' });
    await tick(makeClient(), NOW);
    assert.equal(callsOf('createEvent').length, 0);
    assert.equal(callsOf('findEventByStart')[0][0], GUILD);
  });
  it('skips before the open time and after the deadline', async () => {
    stubs.listScheduledConfigs = async () => [config];
    await tick(makeClient(), vn(2026, 10, 5, 8, 59)); // Monday before 09:00
    await tick(makeClient(), vn(2026, 10, 11, 18, 0)); // at deadline
    assert.equal(callsOf('createEvent').length, 0);
  });
  it('remindAt is null when the reminder time has already passed', async () => {
    stubs.listScheduledConfigs = async () => [config];
    await tick(makeClient(), vn(2026, 10, 11, 16, 0));
    assert.equal(callsOf('createEvent')[0][0].remindAt, null);
  });
  it('one failing guild does not block the next', async () => {
    stubs.listScheduledConfigs = async () => [{ ...config, guildId: 'g-bad' }, config];
    stubs.listActiveEvents = async (guildId) => {
      if (guildId === 'g-bad') throw new Error('boom');
      return [];
    };
    await tick(makeClient(), NOW);
    assert.deepEqual(callsOf('createEvent').map((c) => c[0].guildId), [GUILD]);
  });
});

describe('scheduler.tick – auto create races and failures', () => {
  const config = {
    guildId: '900000000000000077', // unique: post-failure backoff is remembered per guild across tests
    announceChannelId: 'chan',
    groupCount: 1,
    classes: ['A'],
    schedule: { enabled: true, warDay: 0, warTime: '20:00', openDay: 1, openTime: '09:00', lockBeforeHours: 2, remindBeforeHours: 3 },
  };
  const errorLines = () => console.error.mock.calls.map((c) => c.arguments.join(' '));

  it('a duplicate-key error on create (another tick already made it) is skipped silently', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.createEvent = async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    };
    await tick(makeClient(), NOW);
    assert.equal(callsOf('postWarMessage').length, 0);
    assert.deepEqual(errorLines(), []);
  });
  it('a non-duplicate create error is still logged', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.createEvent = async () => {
      throw new Error('db down');
    };
    await tick(makeClient(), NOW);
    assert.equal(callsOf('postWarMessage').length, 0);
    assert.ok(errorLines().some((l) => l.includes('db down')));
  });
  it('after a failed post the guild is skipped for 30 minutes, with the reason logged', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.postWarMessage = async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    };
    await tick(makeClient(), NOW);
    assert.equal(callsOf('createEvent').length, 1);
    assert.ok(errorLines().some((l) => l.includes(config.guildId) && /thiếu quyền/.test(l)), errorLines().join('\n'));

    await tick(makeClient(), new Date(NOW.getTime() + 29 * 60 * 1000));
    assert.equal(callsOf('createEvent').length, 1, 'still backing off');

    await tick(makeClient(), new Date(NOW.getTime() + 31 * 60 * 1000));
    assert.equal(callsOf('createEvent').length, 2, 'retried after the back-off');
  });
});

describe('scheduler.tick – open auto event without a war message', () => {
  const config = {
    guildId: '900000000000000088',
    announceChannelId: 'chan',
    groupCount: 1,
    classes: ['A'],
    schedule: { enabled: true, warDay: 0, warTime: '20:00', openDay: 1, openTime: '09:00', lockBeforeHours: 2, remindBeforeHours: 3 },
  };
  const orphan = (extra = {}) => ({
    _id: 'orphan-1',
    guildId: config.guildId,
    title: 'Bang chiến CN 20:00 (11/10)',
    startAt: vn(2026, 10, 11, 20, 0),
    deadlineAt: vn(2026, 10, 11, 18, 0),
    status: 'open',
    auto: true,
    messageId: null,
    createdAt: new Date(Date.now() - 40 * 60 * 1000),
    ...extra,
  });

  it('posts the existing event instead of creating another or leaving the guild without a message', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.listActiveEvents = async () => [orphan()];
    await tick(makeClient(), NOW);
    assert.equal(callsOf('createEvent').length, 0);
    assert.equal(callsOf('postWarMessage').length, 1);
    assert.equal(callsOf('postWarMessage')[0][2]._id, 'orphan-1');
  });
  it('leaves events that have a message, are not auto, are not open, or were created moments ago', async () => {
    stubs.listScheduledConfigs = async () => [config];
    for (const extra of [{ messageId: 'm1' }, { auto: false }, { status: 'locked' }, { createdAt: new Date(Date.now() - 10 * 1000) }]) {
      stubs.listActiveEvents = async () => [orphan(extra)];
      await tick(makeClient(), NOW);
    }
    assert.equal(callsOf('postWarMessage').length, 0);
  });
  it('a failing post backs off 30 minutes, then the next tick tries again', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.listActiveEvents = async () => [orphan()];
    stubs.postWarMessage = async () => {
      throw new Error('send failed (and the event could not be deleted afterwards: db down)');
    };
    await tick(makeClient(), NOW);
    assert.equal(callsOf('postWarMessage').length, 1);
    await tick(makeClient(), new Date(NOW.getTime() + 29 * 60 * 1000));
    assert.equal(callsOf('postWarMessage').length, 1, 'still backing off');
    await tick(makeClient(), new Date(NOW.getTime() + 31 * 60 * 1000));
    assert.equal(callsOf('postWarMessage').length, 2);
  });
});

describe('scheduler.tick – no double post after a failed id save or a recent attempt', () => {
  const config = {
    guildId: '900000000000000099',
    announceChannelId: 'chan',
    groupCount: 1,
    classes: ['A'],
    schedule: { enabled: true, warDay: 0, warTime: '20:00', openDay: 1, openTime: '09:00', lockBeforeHours: 2, remindBeforeHours: 3 },
  };
  const min = (n) => new Date(Date.now() - n * 60 * 1000);
  const orphan = (extra = {}) => ({
    _id: 'orphan-2',
    guildId: config.guildId,
    title: 'Bang chiến CN 20:00 (11/10)',
    startAt: vn(2026, 10, 11, 20, 0),
    deadlineAt: vn(2026, 10, 11, 18, 0),
    status: 'open',
    auto: true,
    messageId: null,
    createdAt: min(40),
    ...extra,
  });
  const warnLines = () => console.warn.mock.calls.map((c) => c.arguments.join(' '));

  it('every tick first retries saving ids of messages already sent', async () => {
    stubs.listScheduledConfigs = async () => [config];
    await tick(makeClient(), NOW);
    assert.equal(callsOf('retryPendingSaves').length, 1);
  });
  it('an event whose message was sent but whose id is unsaved is not posted again (tick after tick)', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.listActiveEvents = async () => [orphan({ postAttemptAt: min(30) })];
    stubs.hasPendingSave = (id) => id === 'orphan-2';
    for (let i = 0; i < 3; i++) await tick(makeClient(), new Date(NOW.getTime() + i * 60 * 1000));
    assert.equal(callsOf('postWarMessage').length, 0);
    assert.equal(callsOf('createEvent').length, 0, 'does not create a second event either');
  });
  it('a post attempt younger than 10 minutes blocks a repost; crash case (no pending save) reposts after 10 minutes with a warning', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.listActiveEvents = async () => [orphan({ postAttemptAt: min(9) })];
    await tick(makeClient(), NOW);
    assert.equal(callsOf('postWarMessage').length, 0);

    stubs.listActiveEvents = async () => [orphan({ postAttemptAt: min(11) })];
    await tick(makeClient(), NOW);
    assert.equal(callsOf('postWarMessage').length, 1);
    assert.ok(warnLines().some((l) => /untracked message may exist/.test(l)), warnLines().join(' | '));
  });
  it('losing the claim (postWarMessage -> null) is silent: no backoff, no error', async () => {
    stubs.listScheduledConfigs = async () => [config];
    stubs.listActiveEvents = async () => [orphan()];
    stubs.postWarMessage = async () => null;
    await tick(makeClient(), NOW);
    await tick(makeClient(), new Date(NOW.getTime() + 60 * 1000));
    assert.equal(callsOf('postWarMessage').length, 2, 'no 30-minute backoff');
    assert.deepEqual(console.error.mock.calls, []);
  });
});

// Sanity: the pure functions used by the scheduler were not replaced.
describe('scheduler stubs', () => {
  it('pure warService helpers are the real implementations', () => {
    for (const [k, fn] of Object.entries(real)) assert.equal(warService[k], fn);
  });
});

describe('scheduler.tick – depart notice (left the game, still on Discord)', () => {
  const ROSTER = { _id: 'r2', importedAt: vn(2026, 10, 8, 12), members: [{ name: 'Kelo' }] };
  const config = (extra = {}) => ({ guildId: GUILD, adminChannelId: 'admin-chan', departNoticeRosterId: 'r1', ...extra });
  const linked = [
    { discordId: sid(1), gameName: 'Kelo', source: 'admin', displayName: 'Kelo' },
    { discordId: sid(2), gameName: 'Đã Rời', source: 'self', displayName: 'Rời' },
  ];
  beforeEach(() => {
    stubs.listNoticeConfigs = async () => [config()];
    stubs.latest = async () => ROSTER;
    stubs.loadLinked = async () => linked;
  });

  it('a new import: ONE V2 notice in the admin channel, nobody mentioned, claimed by import id', async () => {
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.deepEqual(callsOf('claimNotice'), [[GUILD, 'r2', ROSTER.importedAt]]);
    assert.deepEqual(callsOf('saveNoticeIds').map((c) => [c[0], c[1], c[2], c[3].more]), [[GUILD, 'r2', [sid(2)], 0]]);
    assert.equal(client.sent.length, 1);
    assert.deepEqual(client.sent[0].allowedMentions, { parse: [] });
    const text = JSON.stringify(client.sent[0].components[0].toJSON());
    assert.ok(text.includes('<@' + sid(2) + '>') && !text.includes('<@' + sid(1) + '>'));
  });
  it('the member list is incomplete -> skipped WITHOUT claiming, retried on the next tick', async () => {
    const client = makeClient({ members: [member(1), member(2)], fetchMembersError: new Error('timeout') });
    await tick(client, NOW);
    await tick(client, NOW);
    assert.equal(callsOf('claimNotice').length, 0);
    assert.equal(client.sent.length, 0);
  });
  it('the claim is lost (another tick / process / the upload got it) -> nothing is posted', async () => {
    stubs.claimNotice = async () => false;
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.equal(callsOf('claimNotice').length, 1);
    assert.equal(client.sent.length, 0);
  });
  it('a newer import landed while the members were fetched -> this one gives up without claiming', async () => {
    let n = 0;
    stubs.latest = async () => (++n <= 2 ? ROSTER : { ...ROSTER, _id: 'r3' }); // head, the full read, then the re-read
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.equal(callsOf('claimNotice').length, 0);
    assert.equal(client.sent.length, 0);
  });
  it('a guild the bot has left (not in client.guilds.cache) is skipped, logged once per process', async () => {
    const client = makeClient({ members: [member(1), member(2)] });
    client.guilds.cache = new Collection(); // the bot is in no guild
    const lines = [];
    eventLog.setSink((l) => lines.push(JSON.parse(l)));
    try {
      await tick(client, NOW);
      await tick(client, NOW);
    } finally {
      eventLog.setSink(null);
    }
    assert.equal(lines.filter((l) => l.ev === 'depart_notice' && l.reason === 'not_in_guild').length, 1);
    assert.equal(callsOf('latest').length, 0);
    assert.equal(callsOf('claimNotice').length, 0);
    assert.equal(client.sent.length, 0);
  });
  it('the import was already handled (departNoticeRosterId = latest) -> no member fetch, no claim, no post', async () => {
    stubs.listNoticeConfigs = async () => [config({ departNoticeRosterId: 'r2' })];
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.equal(callsOf('claimNotice').length, 0);
    assert.equal(callsOf('loadLinked').length, 0);
    assert.equal(client.sent.length, 0);
  });
  it('the first run after deploy (departNoticeRosterId null) handles the current latest import', async () => {
    stubs.listNoticeConfigs = async () => [config({ departNoticeRosterId: null })];
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.equal(client.sent.length, 1);
  });
  it('nobody departed -> the import is claimed (never asked again) but nothing is posted', async () => {
    stubs.loadLinked = async () => [linked[0]];
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.equal(callsOf('claimNotice').length, 1);
    assert.equal(client.sent.length, 0);
  });
  it('no admin channel -> skipped (not claimed, nothing sent)', async () => {
    stubs.listNoticeConfigs = async () => [config({ adminChannelId: null })];
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.equal(callsOf('latest').length, 0);
    assert.equal(callsOf('claimNotice').length, 0);
    assert.equal(client.sent.length, 0);
  });
  it('no import yet -> nothing', async () => {
    stubs.latest = async () => null;
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.equal(callsOf('claimNotice').length, 0);
    assert.equal(client.sent.length, 0);
  });
  it('a failing guild does not stop the next one', async () => {
    stubs.listNoticeConfigs = async () => [config({ guildId: 'g-bad' }), config()];
    stubs.latest = async (guildId) => {
      if (guildId === 'g-bad') throw new Error('db down');
      return ROSTER;
    };
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.equal(client.sent.length, 1);
  });
});

describe('scheduler.tick – guild events step', () => {
  it('runs after the war steps: a due event is locked, a due reminder pings only ✅ / ❓, a finished one is closed', async () => {
    const ev = { _id: 'ev1', guildId: GUILD, title: 'Tiệc', startAt: NOW, channelId: 'chan', messageId: 'm' };
    stubs.getConfig = async () => ({ features: { events: true } });
    stubs.ev_findDueLocks = async () => [ev];
    stubs.ev_lockEvent = async () => ({ ...ev, status: 'locked' });
    stubs.ev_findDueReminders = async () => [{ ...ev, _id: 'ev2' }];
    stubs.ev_claimRemind = async () => true;
    stubs.ev_listReplies = async () => [
      { discordId: sid(1), status: 'yes' },
      { discordId: sid(2), status: 'no' },
    ];
    stubs.ev_findFinished = async () => [{ ...ev, _id: 'ev3' }];
    stubs.ev_markDone = async (id) => ({ _id: id, status: 'done' });
    const client = makeClient();
    await tick(client, NOW);
    assert.deepEqual(callsOf('scheduleEventRefresh').map((c) => [c[1], c[2]]), [['ev1', 0], ['ev3', 0]]);
    assert.equal(client.sent.length, 1);
    assert.ok(client.sent[0].content.includes(`<@${sid(1)}>`) && !client.sent[0].content.includes(`<@${sid(2)}>`));
    assert.deepEqual(client.sent[0].allowedMentions, { users: [sid(1)] });
  });
  it('an error inside the events step is isolated: the departure step still runs', async () => {
    stubs.ev_findDueLocks = async () => {
      throw new Error('db down');
    };
    stubs.listNoticeConfigs = async () => [];
    await tick(makeClient(), NOW);
    assert.equal(callsOf('listNoticeConfigs').length, 1);
  });
});

describe('scheduler.tick – off notice step', () => {
  it('every tick offers the latest import to the off-too-long notice (it has its own claim); a failing step does not stop the others', async () => {
    await tick(makeClient(), NOW);
    assert.equal(callsOf('offNoticeDue').length, 1);
    stubs.offNoticeDue = async () => {
      throw new Error('boom');
    };
    const lines = [];
    eventLog.setSink((l) => lines.push(JSON.parse(l)));
    try {
      await tick(makeClient(), NOW);
    } finally {
      eventLog.setSink(null);
    }
    assert.ok(lines.some((l) => l.area === 'sched' && l.ev === 'step_error' && l.step === 'offwarn'));
  });
});

describe('scheduler.tick – feature toggles (🧩 Tính năng)', () => {
  const ev = { _id: 'ev1', guildId: GUILD, title: 'Tiệc', startAt: NOW, channelId: 'chan', messageId: 'm' };
  const withEvents = () => {
    stubs.ev_findDueLocks = async () => [ev];
    stubs.ev_lockEvent = async () => ({ ...ev, status: 'locked' });
    stubs.ev_findDueReminders = async () => [{ ...ev, _id: 'ev2' }];
    stubs.ev_claimRemind = async () => true;
    stubs.ev_findFinished = async () => [{ ...ev, _id: 'ev3' }];
    stubs.ev_markDone = async (id) => ({ _id: id, status: 'done' });
    stubs.ev_findDueMinNotices = async () => [{ ...ev, _id: 'ev4', minParticipants: 5 }];
  };
  const eventCalls = () => calls.filter((c) => /^ev_(lockEvent|claimRemind|markDone|claimMinNotice)$/.test(c[0])).map((c) => c[0]);

  it('events on: reminders, locks, min notices and done run', async () => {
    withEvents();
    stubs.getConfig = async () => ({ features: { events: true }, adminChannelId: 'admin-chan' });
    await tick(makeClient(), NOW);
    assert.deepEqual([...new Set(eventCalls())].sort(), ['ev_claimMinNotice', 'ev_claimRemind', 'ev_lockEvent', 'ev_markDone']);
  });
  it('events off (stored toggle, or a guild with no event panel): the whole events step is skipped, nothing is claimed', async () => {
    withEvents();
    const client = makeClient();
    stubs.getConfig = async () => ({ features: { events: false }, adminChannelId: 'admin-chan' });
    await tick(client, NOW);
    stubs.getConfig = async () => ({ adminChannelId: 'admin-chan' }); // no field, no panel posted: the new-guild default (off)
    await tick(client, NOW);
    assert.deepEqual(eventCalls(), []);
    assert.equal(client.sent.length, 0);
  });
  it('events: a guild that never had the field but posted its event panel keeps running (migration)', async () => {
    withEvents();
    stubs.getConfig = async () => ({ eventPanelMessageId: 'panel-1', adminChannelId: 'admin-chan' });
    await tick(makeClient(), NOW);
    assert.ok(eventCalls().includes('ev_lockEvent'));
  });
  it('events are judged per guild: one guild off does not stop another', async () => {
    const other = { ...ev, _id: 'ev9', guildId: 'g-other' };
    stubs.ev_findDueLocks = async () => [ev, other];
    stubs.ev_lockEvent = async (id) => ({ _id: id });
    stubs.getConfig = async (guildId) => ({ features: { events: guildId === 'g-other' } });
    await tick(makeClient(), NOW);
    assert.deepEqual(callsOf('ev_lockEvent').map((c) => c[0]), ['ev9']);
  });

  it('leave (retired, also with leave: false stored): the reminder does not exclude people on leave, and nobody is registered absent (reminder and create)', async () => {
    const event = { _id: 'ev1', guildId: GUILD, title: 'Bang chiến', deadlineAt: vn(2026, 10, 11, 18, 0), startAt: vn(2026, 10, 11, 20, 0), channelId: 'chan', messageId: 'msg' };
    stubs.findDueReminders = async () => [event];
    stubs.claimReminder = async () => true;
    stubs.getConfig = async () => ({ announceChannelId: 'chan', memberRoleId: 'role-member', features: { leave: false } });
    stubs.coveringIds = async () => new Set([sid(1)]);
    const client = makeClient({ members: [member(1), member(2)] });
    await tick(client, NOW);
    assert.ok(client.sent[0].content.includes(`<@${sid(1)}>`) && client.sent[0].content.includes(`<@${sid(2)}>`), 'the person on leave is reminded again');
    assert.equal(callsOf('coveringIds').length, 0);
    assert.equal(callsOf('autoAbsent').length, 0);
    stubs.findDueReminders = async () => [];
    stubs.listScheduledConfigs = async () => [{ guildId: GUILD, announceChannelId: 'chan', groupCount: 1, classes: ['A'], schedule: { enabled: true, warDay: 0, warTime: '20:00', openDay: 1, openTime: '09:00', lockBeforeHours: 2, remindBeforeHours: 3 } }];
    await tick(makeClient(), NOW);
    assert.equal(callsOf('createEvent').length, 1, 'the war is still created');
    assert.equal(callsOf('autoAbsent').length, 0, 'but nobody is auto-absent');
  });

  it('departNotice off: the depart step claims and posts nothing; on: it posts', async () => {
    const roster = { _id: 'r2', importedAt: vn(2026, 10, 8, 12), members: [{ name: 'Kelo' }] };
    const cfg = (features) => ({ guildId: GUILD, adminChannelId: 'admin-chan', departNoticeRosterId: 'r1', features });
    stubs.latest = async () => roster;
    stubs.loadLinked = async () => [{ discordId: sid(2), gameName: 'Đã Rời', source: 'self', displayName: 'Rời' }];
    stubs.listNoticeConfigs = async () => [cfg({ departNotice: false })];
    const off = makeClient({ members: [member(2)] });
    await tick(off, NOW);
    assert.equal(callsOf('claimNotice').length, 0);
    assert.equal(off.sent.length, 0);
    stubs.listNoticeConfigs = async () => [cfg({ departNotice: true })];
    const on = makeClient({ members: [member(2)] });
    await tick(on, NOW);
    assert.equal(callsOf('claimNotice').length, 1);
    assert.equal(on.sent.length, 1);
  });
  it('offNotice off: noticeGuild (the step, and the import button) answers "feature_off" before it reads anything; on: it goes on', async () => {
    const client = makeClient();
    assert.deepEqual(await offNotice.noticeGuild(client, GUILD, { config: { adminChannelId: 'admin-chan', features: { offNotice: false } } }), { posted: false, reason: 'feature_off' });
    assert.deepEqual(await departNotice.noticeGuild(client, GUILD, { config: { adminChannelId: 'admin-chan', features: { departNotice: false } } }), { posted: false, reason: 'feature_off' });
    assert.equal(callsOf('latest').length, 0, 'no roster read at all');
    const on = await offNotice.noticeGuild(client, GUILD, { config: { adminChannelId: 'admin-chan', features: { offNotice: true } } });
    assert.equal(on.reason, 'no_roster');
  });
});
