// 🎧 Treo voice: while the feature is on, the bot sits in the chosen voice channel of the guild (mic and sound off).
// Only the gateway voice state is sent (op 4): there is no audio connection, so no voice library / native module is needed.
// The bot goes back when it is moved or disconnected, and after a gateway reconnect (a new session drops the voice state).
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const guildConfig = require('../services/guildConfigService'); // read at call time (tests replace getConfig)
const { isOn } = guildConfig;
const { logEvent } = require('../eventLog');

const REJOIN_DELAY_MS = 5000;
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
const timers = new Map(); // guildId -> pending re-sync

// The channel the bot should sit in for this config, or null.
const targetOf = (config) => (config && isOn(config, 'voiceHang') && config.hangChannelId) || null;

const currentOf = (guild) => (guild.members.me && guild.members.me.voice && guild.members.me.voice.channelId) || null;

// Why the bot cannot sit in `channel` (Vietnamese), or null.
function problemOf(guild, channel) {
  if (!channel) return 'kênh không còn tồn tại';
  if (!VOICE_TYPES.includes(channel.type)) return 'không phải kênh voice';
  const me = guild.members.me;
  const perms = me && channel.permissionsFor(me);
  if (!perms || !perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect)) return 'bot thiếu quyền Xem kênh / Kết nối';
  const full = channel.userLimit && channel.members && channel.members.size >= channel.userLimit;
  if (full && !perms.has(PermissionFlagsBits.MoveMembers)) return 'kênh đã đủ người';
  return null;
}

function sendVoiceState(guild, channelId) {
  guild.shard.send({ op: 4, d: { guild_id: guild.id, channel_id: channelId, self_mute: true, self_deaf: true } });
}

// Puts the bot where the config says: joins, moves or leaves. `config` undefined = read it (cached).
// -> { action: 'joined' | 'stayed' | 'left' | 'none' | 'blocked', channelId?, problem? }
async function syncGuild(client, guildId, config) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild || !guild.members.me) return { action: 'none' };
  const target = targetOf(config === undefined ? await guildConfig.getConfig(guildId) : config);
  const current = currentOf(guild);
  if (!target) {
    if (!current) return { action: 'none' };
    sendVoiceState(guild, null); // the bot only ever sits in voice for this feature
    logEvent('voice', 'left', { guild: guildId, channel: current });
    return { action: 'left', channelId: current };
  }
  if (current === target) return { action: 'stayed', channelId: target };
  const channel = guild.channels.cache.get(target) || (await guild.channels.fetch(target).catch(() => null));
  const problem = problemOf(guild, channel);
  if (problem) {
    logEvent('voice', 'blocked', { guild: guildId, channel: target, problem, lvl: 'warn' });
    return { action: 'blocked', channelId: target, problem };
  }
  sendVoiceState(guild, target);
  logEvent('voice', 'joined', { guild: guildId, channel: target, from: current });
  return { action: 'joined', channelId: target };
}

async function syncAll(client) {
  for (const guildId of client.guilds.cache.keys()) {
    await syncGuild(client, guildId).catch((err) => console.error(`[voice] guild ${guildId}:`, err.message));
  }
}

// One re-sync per guild after a short delay (a move / kick / reconnect often comes in bursts).
function scheduleSync(client, guildId, delay = REJOIN_DELAY_MS) {
  clearTimeout(timers.get(guildId));
  const t = setTimeout(() => {
    timers.delete(guildId);
    syncGuild(client, guildId).catch((err) => console.error(`[voice] guild ${guildId}:`, err.message));
  }, delay);
  if (t.unref) t.unref();
  timers.set(guildId, t);
}

// voiceStateUpdate: the bot's own channel changed (moved, disconnected by someone, kicked): back to the chosen one.
function onVoiceStateUpdate(oldState, newState) {
  const client = newState.client;
  if (!client || !client.user || newState.id !== client.user.id) return;
  if (oldState.channelId === newState.channelId) return; // mute / deafen changes only
  scheduleSync(client, newState.guild.id);
}

// The "Đang ở" line of the /setup view.
function statusLine(guild, config) {
  const current = guild ? currentOf(guild) : null;
  if (current) return `🔊 Bot đang ở <#${current}>`;
  return targetOf(config) ? '⏳ Bot chưa vào kênh (đang thử lại; xem quyền Kết nối của bot)' : '🔇 Bot không ở kênh voice nào';
}

// A /setup note for a sync result.
function noteOf(res, config) {
  if (res.action === 'joined') return `🎧 Bot đang vào <#${res.channelId}>.`;
  if (res.action === 'stayed') return `🎧 Bot đã ở <#${res.channelId}>.`;
  if (res.action === 'blocked') return `⚠️ Chưa vào được <#${res.channelId}>: ${res.problem}.`;
  if (res.action === 'left') return '⏏ Bot đã rời kênh voice.';
  return config && config.hangChannelId && !isOn(config, 'voiceHang') ? '🎧 Đã lưu kênh: bật **🎧 Treo voice** ở 🧩 Tính năng để bot vào.' : '';
}

const resetTimers = () => {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
};

module.exports = { REJOIN_DELAY_MS, VOICE_TYPES, targetOf, problemOf, syncGuild, syncAll, scheduleSync, onVoiceStateUpdate, statusLine, noteOf, resetTimers };
