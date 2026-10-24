// 🎧 Treo voice: the bot joins / moves / leaves with gateway op 4, refuses a channel it cannot use, and goes back when moved.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const voice = require('../src/bot/voiceHang');
const { buildSetupView } = require('../src/bot/ui/panel');
const { FEATURE_KEYS, NEW_GUILD_DEFAULTS } = require('../src/services/features');

const G = '800000000000000001';
const VC = '900000000000000001';
const VC2 = '900000000000000002';
const on = (extra = {}) => ({ guildId: G, features: { voiceHang: true }, hangChannelId: VC, ...extra });

// A guild with the bot in `current` (null = not in voice); `perms` = the bot's permissions in every channel.
function fakeGuild({ current = null, perms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect], channels = [VC, VC2], userLimit = 0, members = 0 } = {}) {
  const sent = [];
  const chan = (id) => ({ id, type: ChannelType.GuildVoice, userLimit, members: { size: members }, permissionsFor: () => ({ has: (p) => perms.includes(p) }) });
  const guild = {
    id: G,
    sent,
    shard: { send: (payload) => sent.push(payload) },
    members: { me: { voice: { channelId: current } } },
    channels: { cache: new Map(channels.map((id) => [id, chan(id)])), fetch: async () => null },
  };
  return { guild, client: { guilds: { cache: new Map([[G, guild]]) }, user: { id: 'bot' } } };
}

describe('voiceHang.syncGuild', () => {
  it('feature on + channel chosen: joins it muted and deafened (op 4)', async () => {
    const { guild, client } = fakeGuild();
    assert.deepEqual(await voice.syncGuild(client, G, on()), { action: 'joined', channelId: VC });
    assert.deepEqual(guild.sent, [{ op: 4, d: { guild_id: G, channel_id: VC, self_mute: true, self_deaf: true } }]);
  });
  it('already there: nothing is sent; somewhere else: moved to the chosen channel', async () => {
    let f = fakeGuild({ current: VC });
    assert.equal((await voice.syncGuild(f.client, G, on())).action, 'stayed');
    assert.deepEqual(f.guild.sent, []);
    f = fakeGuild({ current: VC2 });
    assert.equal((await voice.syncGuild(f.client, G, on())).action, 'joined');
    assert.equal(f.guild.sent[0].d.channel_id, VC);
  });
  it('feature off or no channel: leaves (channel_id null), or does nothing when not in voice', async () => {
    let f = fakeGuild({ current: VC });
    assert.equal((await voice.syncGuild(f.client, G, on({ features: { voiceHang: false } }))).action, 'left');
    assert.deepEqual(f.guild.sent[0].d, { guild_id: G, channel_id: null, self_mute: true, self_deaf: true });
    f = fakeGuild({ current: VC });
    assert.equal((await voice.syncGuild(f.client, G, on({ hangChannelId: null }))).action, 'left');
    f = fakeGuild();
    assert.equal((await voice.syncGuild(f.client, G, null)).action, 'none');
    assert.deepEqual(f.guild.sent, []);
  });
  it('a channel the bot cannot use is refused with the reason, nothing is sent', async () => {
    let f = fakeGuild({ perms: [PermissionFlagsBits.ViewChannel] });
    assert.deepEqual(await voice.syncGuild(f.client, G, on()), { action: 'blocked', channelId: VC, problem: 'bot thiếu quyền Xem kênh / Kết nối' });
    f = fakeGuild({ channels: [] });
    assert.equal((await voice.syncGuild(f.client, G, on())).problem, 'kênh không còn tồn tại');
    f = fakeGuild({ userLimit: 2, members: 2 });
    assert.equal((await voice.syncGuild(f.client, G, on())).problem, 'kênh đã đủ người');
    assert.deepEqual(f.guild.sent, []);
  });
  it('an unknown guild does nothing', async () => {
    assert.equal((await voice.syncGuild({ guilds: { cache: new Map() } }, G, on())).action, 'none');
  });
});

describe('voiceHang.onVoiceStateUpdate', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => {
    voice.resetTimers();
    mock.timers.reset();
  });
  it('the bot moved / kicked: one re-sync after the delay; someone else or a mute change: nothing', async () => {
    const { guild, client } = fakeGuild();
    const state = (id, channelId) => ({ id, channelId, client, guild });
    const cfg = require('../src/services/guildConfigService');
    mock.method(cfg, 'getConfig', async () => on());
    voice.onVoiceStateUpdate(state('someone', VC), state('someone', null));
    voice.onVoiceStateUpdate(state('bot', VC), state('bot', VC)); // mute / deafen only
    voice.onVoiceStateUpdate(state('bot', VC), state('bot', null)); // kicked
    voice.onVoiceStateUpdate(state('bot', null), state('bot', VC2)); // dragged elsewhere: one timer, not two
    mock.timers.tick(voice.REJOIN_DELAY_MS);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(guild.sent.length, 1);
    assert.equal(guild.sent[0].d.channel_id, VC);
    mock.restoreAll();
  });
});

describe('🎧 in /setup', () => {
  it('is a feature toggle, off for a new guild', () => {
    assert.ok(FEATURE_KEYS.includes('voiceHang'));
    assert.equal(NEW_GUILD_DEFAULTS.voiceHang, false);
  });
  it('⚙️ Nâng cao shows 🎧 only while it is on; its screen has a voice-only channel select, ⏏ Rời kênh and the status', () => {
    const adv = (config) => JSON.stringify(buildSetupView(config, null, { view: 'adv' }).components.map((r) => r.toJSON()));
    assert.ok(!adv({ features: { voiceHang: false } }).includes('setup:voiceview'));
    assert.ok(adv({ features: { voiceHang: true } }).includes('setup:voiceview'));
    const v = buildSetupView(on(), null, { view: 'voice', voiceStatus: '🔊 Bot đang ở <#1>' });
    const rows = v.components.map((r) => r.toJSON());
    assert.equal(rows[0].components[0].custom_id, 'setup:voicechan');
    assert.deepEqual(rows[0].components[0].channel_types, [ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
    assert.deepEqual(rows[0].components[0].default_values, [{ id: VC, type: 'channel' }]);
    assert.deepEqual(rows[1].components.map((b) => b.custom_id), ['setup:voiceclear', 'setup:main']);
    assert.match(v.content, /🔊 Bot đang ở/);
  });
  it('noteOf explains each result, and a saved channel with the feature off', () => {
    assert.match(voice.noteOf({ action: 'joined', channelId: VC }), /Bot đang vào/);
    assert.match(voice.noteOf({ action: 'blocked', channelId: VC, problem: 'x' }), /Chưa vào được .*: x/);
    assert.match(voice.noteOf({ action: 'left' }), /đã rời/);
    assert.match(voice.noteOf({ action: 'none' }, { hangChannelId: VC, features: { voiceHang: false } }), /bật \*\*🎧 Treo voice\*\*/);
  });
});
