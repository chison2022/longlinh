// Members link their own Discord account to their in-game character (customIds gn:*, see ui/gameName.js). Not admin-gated: everything
// here only touches the clicking member's own link. Admin pairs (adm:gmap*) always win: a member can neither take a name an admin
// gave to someone else nor change a pair an admin made for them.
const { MessageFlags, ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } = require('discord.js');
const gameRoster = require('../../services/gameRosterService');
const guildConfigService = require('../../services/guildConfigService');
const { memberInfo } = require('../../services/rosterService');
const { buildPicker, linkLine, meLine, LABELS } = require('../ui/gameName');
const { invalidateGameNames } = require('../gameNames');
const { ensureMembers } = require('../memberCache');
const { scheduleSync } = require('../sheetSync');
const { logEvent, ixCtx } = require('../../eventLog');

const ROSTER_CHANGED = 'Danh sách game vừa được cập nhật — chọn lại từ danh sách mới.';
const LOADING = '⏳ Bot đang tải danh sách thành viên Discord, thử lại sau ít giây.';
const COOLDOWN_MS = 10 * 1000; // between two changes of the same member's link
const NOTIFY_MS = 60 * 60 * 1000; // one admin notice per name per hour

const num = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const infosOf = (interaction) => {
  const members = interaction.guild && interaction.guild.members && interaction.guild.members.cache;
  return members ? [...members.values()].map(memberInfo).map((m) => ({ id: m.id, name: m.name, username: m.username, bot: m.bot })) : [];
};
const nameOf = (interaction) => (interaction.member && interaction.member.displayName) || (interaction.user && (interaction.user.globalName || interaction.user.username)) || '';

// ---------- cooldown (per member, in memory) ----------

const lastChange = new Map();
let clock = () => Date.now();
function cooling(userId) {
  const now = clock();
  for (const [id, at] of lastChange) if (now - at >= COOLDOWN_MS) lastChange.delete(id);
  if (lastChange.has(userId)) return true;
  lastChange.set(userId, now);
  return false;
}
const TOO_FAST = '⏳ Bạn vừa đổi liên kết xong, đợi vài giây rồi thử lại.';
const coolRefused = (interaction, source) => logEvent('gn', 'link', { ...ixCtx(interaction), source, result: 'refused', reason: 'cooldown' });

// Tests only.
function resetState({ now } = {}) {
  lastChange.clear();
  notified.clear();
  uidSaves.clear();
  clock = now || (() => Date.now());
}

// ---------- availability ----------

// Which roster names the member may take. A name is blocked when somebody else holds it (admin pair or self link, compared with
// nameKey), when it is automatically matched to somebody else, or when it is the exact Discord name (norm) of another member.
// roster = the roster already loaded by the caller (saves a round trip). -> { roster, complete, ranked, holderOf(game) }
// holderOf -> { id, source: 'admin' | 'self' | 'selfFree' | 'auto' } | null
// `who` = { id, name, username, keepMine } for the new-member gate, where a manager (or the bot) asks on behalf of somebody else:
// the holders, the ranking and "mine" are judged for that person; keepMine = the person's own current name stays selectable.
async function availability(interaction, roster, who = {}) {
  const me = who.id || interaction.user.id;
  const doc = roster === undefined ? await gameRoster.latest(interaction.guildId) : roster;
  if (!doc) return { roster: null, complete: true, ranked: [], holderOf: () => null };
  const { complete } = interaction.guild && interaction.guild.members ? await ensureMembers(interaction.guild) : { complete: false };
  const infos = infosOf(interaction);
  const found = await gameRoster.matchGuild(interaction.guildId, infos, doc);
  const holders = new Map(); // nameKey -> holder
  for (const [id, name] of found.mappings) if (id !== me) holders.set(gameRoster.nameKey(name), { id, source: (found.mappings.sources && found.mappings.sources.get(id)) || 'admin' });
  const autoHolder = new Map(found.match.matched.filter((m) => m.discordId !== me).map((m) => [m.game, m.discordId]));
  const discordNames = new Map(); // norm(Discord name / username of somebody else) -> id
  for (const p of infos) {
    if (p.id === me || p.bot) continue;
    for (const n of [p.name, p.username]) if (n) discordNames.set(gameRoster.norm(n), p.id);
  }
  const holderOf = (game) => {
    const keyed = holders.get(gameRoster.nameKey(game.name));
    if (keyed) return keyed;
    if (autoHolder.has(game)) return { id: autoHolder.get(game), source: 'auto' };
    const same = discordNames.get(gameRoster.norm(game.name));
    return same ? { id: same, source: 'auto' } : null;
  };
  const mine = found.mappings.get(me) ? gameRoster.nameKey(found.mappings.get(me)) : null;
  const index = new Map(doc.members.map((g, i) => [g, i]));
  const open = doc.members.filter((g) => !holderOf(g) && (who.keepMine || gameRoster.nameKey(g.name) !== mine));
  const ranked = gameRoster
    .rankGames(open, who.name !== undefined ? who.name : nameOf(interaction), who.username !== undefined ? who.username : interaction.user && interaction.user.username)
    .map((r) => ({ ...r, index: index.get(r.game) }));
  return { roster: doc, complete, ranked, holderOf };
}

// `src` is set when the member opened the picker themselves (gn:open / gn:change): that is the one worth a gn.view line.
async function view(interaction, { page = 0, note = null, roster, compact = false, src } = {}) {
  const doc = roster === undefined ? await gameRoster.latest(interaction.guildId) : roster;
  const [link, avail] = await Promise.all([gameRoster.getLink(interaction.guildId, interaction.user.id), availability(interaction, doc)]);
  if (src) logEvent('gn', 'view', { ...ixCtx(interaction), src, mode: compact && link ? 'compact' : 'full', hasRoster: Boolean(doc), linked: Boolean(link) });
  if (compact && link) return buildPicker({ link, compact: true });
  const notes = [note, avail.complete ? null : LOADING].filter(Boolean).join('\n') || null;
  return buildPicker({ link, ranked: avail.ranked, page, ver: doc ? gameRoster.rosterVersion(doc) : '0', hasRoster: Boolean(doc), note: notes });
}

// ---------- admin notice ----------

const notified = new Map(); // `${guild}:${nameKey}` -> last notice time
async function notifyAdmins(interaction, gameName, holderId) {
  try {
    const key = `${interaction.guildId}:${gameRoster.nameKey(gameName)}`;
    const now = clock();
    if (notified.has(key) && now - notified.get(key) < NOTIFY_MS) return;
    const config = await guildConfigService.getConfigOrDefault(interaction.guildId);
    if (!config || !config.adminChannelId) {
      logEvent('gn', 'admin_notice', { guild: interaction.guildId, result: 'skipped', reason: 'no_admin_channel' });
      return;
    }
    const channel = await interaction.client.channels.fetch(config.adminChannelId);
    await channel.send({
      content: `🎮 <@${interaction.user.id}> muốn nhận **${escapeMarkdown(gameName)}** nhưng <@${holderId}> đã tự liên kết — kiểm tra trong 🔗 Ghép tên.`,
      allowedMentions: { parse: [] },
    });
    notified.set(key, now); // only a notice that really went out suppresses the next one
    logEvent('gn', 'admin_notice', { guild: interaction.guildId, result: 'sent', channel: config.adminChannelId });
    for (const [k, at] of notified) if (now - at >= NOTIFY_MS) notified.delete(k);
  } catch (err) {
    console.warn('[gn] cannot notify the admin channel:', err.message);
    logEvent('gn', 'admin_notice', { guild: interaction.guildId, result: 'failed', err });
  }
}

// A refusal because somebody holds the name -> the sentence for the member (and a notice to the admins when it is a member's own link).
async function refuse(interaction, gameName, holder, source = 'self') {
  logEvent('gn', 'link', { ...ixCtx(interaction), source, result: 'refused', reason: holder ? holder.source : 'self' }); // admin / self / selfFree / auto
  if (holder && (holder.source === 'self' || holder.source === 'selfFree')) await notifyAdmins(interaction, gameName, holder.id);
  return `⚠️ ${gameRoster.takenMessage(holder ? holder.source : 'self')}`;
}

// After any change of a link: the in-game name caches and the Google Sheet follow.
function changed(interaction) {
  invalidateGameNames(interaction.guildId);
  scheduleSync(interaction.client, interaction.guildId);
}

// -> { ok: true, saved } | a refusal note (string) for the picker; throws what is not a known refusal
async function link(interaction, game, { free = false } = {}) {
  try {
    const saved = await gameRoster.selfLink(interaction.guildId, interaction.user.id, game, { free, displayName: nameOf(interaction) });
    changed(interaction);
    logEvent('gn', 'link', { ...ixCtx(interaction), source: free ? 'selfFree' : 'self', result: 'ok' });
    return { ok: true, saved };
  } catch (err) {
    const source = free ? 'selfFree' : 'self';
    if (err.code === 'GAME_NAME_TAKEN') return refuse(interaction, game, err.holder, source);
    if (err.code === 'ADMIN_LOCKED') {
      logEvent('gn', 'link', { ...ixCtx(interaction), source, result: 'refused', reason: 'admin' });
      return `⚠️ ${err.message}`;
    }
    if (err.code === 'GAME_NAME_INVALID') {
      logEvent('gn', 'link', { ...ixCtx(interaction), source, result: 'refused', reason: 'invalid' });
      return '⚠️ Tên không hợp lệ.';
    }
    throw err;
  }
}

// A link() result -> view options: success = compact view (no note), refusal = the full picker with the note.
const resultOf = (res, opts) => (typeof res === 'string' ? { ...opts, note: res } : { ...opts, compact: true });

// ---------- handlers ----------

async function onPick(interaction, parts) {
  const roster = await gameRoster.latest(interaction.guildId);
  if (!roster || gameRoster.rosterVersion(roster) !== parts[3]) return interaction.editReply(await view(interaction, { note: ROSTER_CHANGED, roster }));
  const game = roster.members[Number(String((interaction.values || [])[0]))];
  if (!game) return interaction.editReply(await view(interaction, { note: ROSTER_CHANGED, roster }));
  if (cooling(interaction.user.id)) {
    coolRefused(interaction, 'self');
    return interaction.editReply(await view(interaction, { page: num(parts[2]), note: TOO_FAST, roster }));
  }
  const avail = await availability(interaction, roster);
  let note;
  if (!avail.complete) {
    note = LOADING;
    logEvent('gn', 'link', { ...ixCtx(interaction), source: 'self', result: 'refused', reason: 'members_loading' });
  } else if (avail.holderOf(game)) note = await refuse(interaction, game.name, avail.holderOf(game));
  else note = await link(interaction, game.name);
  return interaction.editReply(await view(interaction, resultOf(note, { page: num(parts[2]), roster })));
}

function freeModal(customId = 'gn:freeModal') {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Nhập tên nhân vật')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Tên nhân vật trong game')
        .setDescription('Gõ đúng như trong game (chữ Latin / tiếng Việt, số). Quản lý sẽ kiểm tra lại.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(gameRoster.FREE_NAME_MAX))
    );
}

async function onFreeSubmit(interaction) {
  const roster = await gameRoster.latest(interaction.guildId);
  const cleaned = gameRoster.cleanFreeName(interaction.fields.getTextInputValue('name'));
  if (cleaned.error) return interaction.editReply(await view(interaction, { note: `⚠️ ${cleaned.error}`, roster }));
  if (cooling(interaction.user.id)) {
    coolRefused(interaction, 'selfFree');
    return interaction.editReply(await view(interaction, { note: TOO_FAST, roster }));
  }
  const avail = await availability(interaction, roster);
  if (!avail.complete) {
    logEvent('gn', 'link', { ...ixCtx(interaction), source: 'selfFree', result: 'refused', reason: 'members_loading' });
    return interaction.editReply(await view(interaction, { note: LOADING, roster }));
  }
  // a typed name that IS in the roster (other case / accents / spacing / lookalike letters) is that character, saved with the roster's spelling
  const inRoster = roster && roster.members.find((g) => gameRoster.nameKey(g.name) === gameRoster.nameKey(cleaned.name));
  let res;
  if (inRoster) res = avail.holderOf(inRoster) ? await refuse(interaction, inRoster.name, avail.holderOf(inRoster), 'selfFree') : await link(interaction, inRoster.name);
  else res = await link(interaction, cleaned.name, { free: true });
  return interaction.editReply(await view(interaction, resultOf(res, { roster })));
}

// 🆔 Nhập ID game: the member's own in-game ID for the character they are linked to (a manager fixes a wrong one with 🆔 ID game).
function uidModal() {
  return new ModalBuilder()
    .setCustomId('gn:uidModal')
    .setTitle('Nhập ID game')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('ID nhân vật trong game')
        .setDescription('Chỉ chữ số, 5 đến 20 số (xem trong game, mục thông tin nhân vật).')
        .setTextInputComponent(new TextInputBuilder().setCustomId('uid').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(gameRoster.GAME_UID_MAX))
    );
}

// At most UID_SAVES_PER_HOUR saved IDs per member per rolling hour (in memory; a restart forgets it).
const UID_SAVES_PER_HOUR = 3;
const uidSaves = new Map(); // "guild:user" -> [timestamps]
function uidBlockedUntil(key, now = clock()) {
  const list = (uidSaves.get(key) || []).filter((t) => t > now - 3600 * 1000);
  if (list.length) uidSaves.set(key, list);
  else uidSaves.delete(key);
  return list.length >= UID_SAVES_PER_HOUR ? list[0] + 3600 * 1000 : null;
}

// Best effort: the managers see every ID a member typed themself.
async function notifyUid(interaction, uid, name) {
  try {
    const config = await guildConfigService.getConfigOrDefault(interaction.guildId);
    if (!config || !config.adminChannelId) return;
    const channel = await interaction.client.channels.fetch(config.adminChannelId);
    await channel.send({ content: `🆔 <@${interaction.user.id}> tự nhập ID game ${uid} cho nhân vật ${escapeMarkdown(name)}.`, allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn('[gn] cannot notify the admin channel of an ID:', err.message);
  }
}

async function onUidSubmit(interaction) {
  const reply = (text) => interaction.editReply({ content: text, allowedMentions: { parse: [] } });
  const key = `${interaction.guildId}:${interaction.user.id}`;
  const until = uidBlockedUntil(key);
  if (until) {
    logEvent('gn', 'game_uid', { ...ixCtx(interaction), ok: false, reason: 'rate' });
    return reply(`⏳ Bạn đã nhập ID nhiều lần, thử lại sau <t:${Math.ceil(until / 1000)}:R>.`);
  }
  const link = await gameRoster.getLink(interaction.guildId, interaction.user.id);
  if (!link) {
    logEvent('gn', 'game_uid', { ...ixCtx(interaction), ok: false, reason: 'not_linked' });
    return reply(`Bạn chưa liên kết nhân vật — bấm ${LABELS.open} trước.`);
  }
  const checked = await gameRoster.checkGameUid(interaction.guildId, interaction.fields.getTextInputValue('uid'), { exceptName: link.gameName, exceptId: link.characterId });
  if (!checked.error && !checked.uid) checked.error = 'Cần nhập ID nhân vật trong game.';
  if (checked.error) {
    logEvent('gn', 'game_uid', { ...ixCtx(interaction), ok: false, reason: 'refused' });
    return reply(`⚠️ ${checked.error}`);
  }
  // the same transactional claim as the gate: a clash (even one that appeared a moment ago) saves nothing
  const got = await gameRoster.claimGameUid(interaction.guildId, link.gameName, checked.uid, { characterId: link.characterId, by: interaction.user.id });
  if (got.status === 'clash') {
    logEvent('gn', 'game_uid', { ...ixCtx(interaction), ok: false, reason: 'clash' });
    return reply(`⚠️ ${got.text}`);
  }
  if (got.status === 'set') {
    uidSaves.set(key, [...(uidSaves.get(key) || []), clock()]);
    changed(interaction);
    await notifyUid(interaction, checked.uid, link.gameName);
  }
  logEvent('gn', 'game_uid', { ...ixCtx(interaction), ok: true, result: got.status });
  return reply(`✅ Đã lưu ID game **${checked.uid}** cho nhân vật **${escapeMarkdown(link.gameName)}**.`);
}

async function onUnlink(interaction) {
  const roster = await gameRoster.latest(interaction.guildId);
  if (cooling(interaction.user.id)) {
    logEvent('gn', 'unlink', { ...ixCtx(interaction), result: 'cooldown' });
    return interaction.editReply(await view(interaction, { note: TOO_FAST, roster }));
  }
  let note;
  let compact = false;
  let result = 'none';
  try {
    const removed = await gameRoster.selfUnlink(interaction.guildId, interaction.user.id);
    if (removed) changed(interaction);
    note = removed ? 'Đã gỡ liên kết.' : 'Bạn chưa liên kết nhân vật nào.';
    result = removed ? 'ok' : 'none';
  } catch (err) {
    if (err.code !== 'ADMIN_LOCKED') throw err;
    note = `⚠️ ${err.message}`;
    compact = true; // still linked (admin-owned): back to the compact view
    result = 'admin_locked';
  }
  logEvent('gn', 'unlink', { ...ixCtx(interaction), result });
  return interaction.editReply(await view(interaction, { note, roster, compact }));
}

// gn:open | gn:change | gn:me | gn:p:<page>:<ver> | gn:pick:<page>:<ver> | gn:free | gn:freeModal | gn:unlink | gn:uid | gn:uidModal
async function handle(interaction, parts) {
  switch (parts[1]) {
    case 'open':
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return interaction.editReply(await view(interaction, { compact: true, src: 'open' }));
    case 'change':
      await interaction.deferUpdate();
      return interaction.editReply(await view(interaction, { src: 'change' }));
    case 'me': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return interaction.editReply({ content: meLine(await gameRoster.getLink(interaction.guildId, interaction.user.id)), allowedMentions: { parse: [] } });
    }
    case 'p': {
      await interaction.deferUpdate();
      const roster = await gameRoster.latest(interaction.guildId);
      if (!roster || gameRoster.rosterVersion(roster) !== parts[3]) return interaction.editReply(await view(interaction, { note: ROSTER_CHANGED, roster }));
      return interaction.editReply(await view(interaction, { page: num(parts[2]), roster }));
    }
    case 'pick':
      await interaction.deferUpdate();
      return onPick(interaction, parts);
    case 'free':
      return interaction.showModal(freeModal());
    case 'freeModal':
      // opened from the picker (an ephemeral message): update it in place; opened from elsewhere: a new ephemeral reply
      if (typeof interaction.isFromMessage === 'function' && interaction.isFromMessage()) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return onFreeSubmit(interaction);
    case 'uid':
      return interaction.showModal(uidModal());
    case 'uidModal': // opened from the public panel: always a new ephemeral reply
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return onUidSubmit(interaction);
    case 'unlink':
      await interaction.deferUpdate();
      return onUnlink(interaction);
    default:
      return undefined;
  }
}

module.exports = { handle, LABELS, resetState, availability, freeModal, nameOf };
