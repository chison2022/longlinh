const { Client, Events, GatewayIntentBits } = require('discord.js');
const voiceHang = require('./voiceHang');
const { routeInteraction } = require('./interactions/router');
const scheduler = require('../jobs/scheduler');
const { invalidateClassStyles } = require('./classStyle');
const { syncMemberName } = require('../services/registrationService');
const { ensureMembers } = require('./memberCache');
const { redrawAll } = require('./refresher');
const { invalidateGameNames } = require('./gameNames');
const { scheduleSync } = require('./sheetSync');
const gateway = require('../services/sheets/gateway');
const { getConfig } = require('../services/guildConfigService');
const { onGateMemberAdd, onGateMemberRemove } = require('./gateEvents');
const { logEvent } = require('../eventLog');

// Fills the member cache of a guild so live names resolve (the GuildMembers intent keeps it current afterwards).
// A gateway rate limit is retried after its retry_after; success marks the guild as fully fetched (memberCache).
async function warmMembers(guild, options = {}) {
  const { complete, error } = await ensureMembers(guild, { retries: 3, ...options });
  if (!complete) console.warn(`[bot] cannot fetch members of ${guild.id}:`, error && error.message);
}

// Guilds one after another: parallel member requests are what trips the gateway rate limit.
async function warmAllGuilds(guilds, options) {
  for (const guild of guilds) await warmMembers(guild, options);
}

// Ready: warm the member caches (the "chưa đăng ký" numbers need them), then draw every unfinished war message and every
// dashboard again so messages posted by an older version become Components V2. Never throws.
async function warmAndRedraw(c, options = {}) {
  try {
    await warmAllGuilds([...c.guilds.cache.values()], options.warm);
  } catch (err) {
    console.warn('[bot] member warm-up:', err.message);
  }
  try {
    await redrawAll(c, options.redraw);
  } catch (err) {
    console.warn('[bot] startup redraw:', err.message);
  }
}

// A member changed their server name: refresh the stored copies so DB-only paths stay right.
async function onMemberUpdate(oldMember, newMember) {
  try {
    if (newMember.user && newMember.user.bot) return;
    if (!oldMember.partial && oldMember.displayName === newMember.displayName) return;
    invalidateGameNames(newMember.guild.id); // the automatic game-name match follows the Discord names
    await syncMemberName(newMember.guild.id, newMember.id, newMember.displayName);
  } catch (err) {
    console.error('[bot] guildMemberUpdate:', err.message);
  }
}

// A user changed their global name / username: members without a nickname show it, so refresh their stored copies.
async function onUserUpdate(oldUser, newUser) {
  try {
    if (newUser.bot) return;
    if (!oldUser.partial && oldUser.displayName === newUser.displayName) return;
    const guilds = (client && client.guilds && client.guilds.cache && [...client.guilds.cache.values()]) || [];
    for (const guild of guilds) {
      const member = guild.members && guild.members.cache.get(newUser.id);
      if (!member || member.nickname) continue; // a nickname wins over the global name: nothing visible changed
      invalidateGameNames(guild.id);
      await syncMemberName(guild.id, member.id, member.displayName);
    }
  } catch (err) {
    console.error('[bot] userUpdate:', err.message);
  }
}

let client = null;

// Authentication failed / invalid shard / invalid or disallowed intents: reconnecting can never succeed.
const UNRECOVERABLE_CLOSE_CODES = [4004, 4010, 4011, 4012, 4013, 4014];

// Login fails with close code 4014 when a privileged intent (Server Members) is not enabled in the Developer Portal.
function isDisallowedIntentsError(err) {
  return Boolean(err) && (err.code === 'DisallowedIntents' || err.code === 4014 || /disallowed intents|privileged intent/i.test(err.message || ''));
}

// Login failures that retrying can never fix (bad/missing token, disallowed intents); anything else (network, DNS,
// gateway timeout, Discord outage) is transient.
function isUnrecoverableLoginError(err) {
  if (!err) return false;
  if (isDisallowedIntentsError(err)) return true;
  return (
    err.code === 'TokenInvalid' || err.code === 'TokenMissing' || err.code === 4004 || err.status === 401 || /invalid token/i.test(err.message || '')
  );
}

function describeLoginError(err) {
  if (isDisallowedIntentsError(err)) {
    return [
      'Discord từ chối đăng nhập: chưa bật "Server Members Intent" (Used disallowed intents, mã 4014).',
      'Cách sửa: Discord Developer Portal -> Applications -> chọn bot -> Bot -> Privileged Gateway Intents -> bật SERVER MEMBERS INTENT -> Save, rồi chạy lại bot.',
      'Discord rejected the login: "Server Members Intent" is not enabled (Used disallowed intents, close code 4014).',
      'Fix: Discord Developer Portal -> Applications -> your bot -> Bot -> Privileged Gateway Intents -> enable SERVER MEMBERS INTENT -> Save, then restart the bot.',
    ].join('\n');
  }
  return `Discord bot đăng nhập thất bại / Discord bot login failed: ${(err && err.message) || err}`;
}

function getClient() {
  return client;
}

async function startBot(token) {
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildExpressions, GatewayIntentBits.GuildVoiceStates], // GuildExpressions: emoji updates; GuildVoiceStates: 🎧 Treo voice
    allowedMentions: { parse: ['users', 'roles'] }, // never @everyone/@here
  });
  client.on(Events.InteractionCreate, routeInteraction);
  // Class emoji / role colours are cached per guild for 60s; these events drop the cache early.
  for (const ev of [Events.GuildEmojiCreate, Events.GuildEmojiDelete, Events.GuildEmojiUpdate]) client.on(ev, (e) => invalidateClassStyles(e.guild && e.guild.id));
  for (const ev of [Events.GuildRoleCreate, Events.GuildRoleDelete]) client.on(ev, (r) => invalidateClassStyles(r.guild && r.guild.id));
  client.on(Events.GuildRoleUpdate, (_old, r) => invalidateClassStyles(r.guild && r.guild.id)); // (oldRole, newRole): the new one carries the guild
  client.on(Events.GuildMemberUpdate, onMemberUpdate);
  client.on(Events.UserUpdate, onUserUpdate);
  for (const ev of [Events.GuildMemberAdd, Events.GuildMemberRemove]) client.on(ev, (m) => {
    invalidateGameNames(m.guild && m.guild.id); // the game-name match covers whoever is in the server
    if (m.guild && gateway.isAvailable()) {
      // the Discord names / ids of the sheet roster tab: only for guilds that have a sheet (cached config, no fresh DB read)
      getConfig(m.guild.id).then((c) => c && c.sheetId && scheduleSync(client, m.guild.id), () => {});
    }
  });
  client.on(Events.GuildMemberAdd, onGateMemberAdd); // gate: logs only, assigns nothing
  client.on(Events.GuildMemberRemove, onGateMemberRemove); // gate: a pending request of someone who left is cancelled
  client.on(Events.GuildCreate, warmMembers);
  client.on(Events.VoiceStateUpdate, voiceHang.onVoiceStateUpdate); // 🎧 Treo voice: back to the chosen channel when moved / kicked
  client.on(Events.ShardReady, () => voiceHang.syncAll(client).catch(() => {})); // a new gateway session drops the voice state
  client.on(Events.Error, (err) => {
    console.error('[bot]', err);
    logEvent('boot', 'client_error', { err });
  });
  client.once(Events.ClientReady, (c) => {
    console.log(`Bot logged in as ${c.user.tag}`);
    logEvent('boot', 'bot_ready', { guilds: c.guilds.cache.size, guildIds: [...c.guilds.cache.keys()] });
    warmAndRedraw(c); // background, one guild / message at a time
    scheduler.start(c);
  });
  // discord.js may report an unrecoverable close (e.g. 4014) through this event instead of rejecting login().
  client.on(Events.ShardDisconnect, (event) => {
    if (event && UNRECOVERABLE_CLOSE_CODES.includes(event.code)) {
      console.error(describeLoginError({ code: event.code, message: `gateway closed with code ${event.code}` }));
      logEvent('boot', 'fatal', { stage: 'gateway_close', code: event.code });
      process.exit(1);
    }
  });
  try {
    await client.login(token);
  } catch (err) {
    await client.destroy().catch(() => {}); // a retry builds a fresh client; do not leave this one half-connected
    throw err;
  }
  return client;
}

const RETRY_DELAYS_MS = [5000, 15000, 60000]; // then every 60s

// Keeps trying to log in while failures look transient; rejects at once with an unrecoverable one.
// `start` and `sleep` are injectable for tests.
async function startBotWithRetry(token, { start = startBot, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await start(token);
    } catch (err) {
      if (isUnrecoverableLoginError(err)) throw err;
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      onRetry(err, delay);
      await sleep(delay);
    }
  }
}

module.exports = { onGateMemberAdd, onGateMemberRemove, onMemberUpdate, onUserUpdate, warmMembers, warmAllGuilds, warmAndRedraw, startBot, startBotWithRetry, getClient, isDisallowedIntentsError, isUnrecoverableLoginError, describeLoginError, RETRY_DELAYS_MS };
