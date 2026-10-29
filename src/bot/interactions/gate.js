// The new-member gate (customIds gate:*, views in ../ui/gate.js, rules in ../../services/gateService.js).
//  Public panel: gate:member (+ gate:gst "🤝 Khách" while config.guestRoleId is set: a confirm step, then the guest role at once - self-serve,
//  no request, no manager decision, no cooldown; managers only get an info line). The member path is three ephemeral steps (character, class, send) built on the SAME roster
//  ranking / holder rules as the self-link picker (gn, see ./gameName availability); the request is then posted as a card in the admin
//  channel where a manager presses ✅ Duyệt / ❌ Từ chối (admin-gated). Nothing here edits channel permissions. There is no Chờ duyệt
//  role: gate:guest / gate:swguest / gate:tg of old messages (the retired guest path) answer that they are gone.
//  A role that cannot be changed never half-applies: the roles are checked BEFORE anything is saved, the status moves with one atomic
//  update (a double click has one winner), and a failed role call puts the request back to pending so a retry works.
const { MessageFlags, SnowflakeUtil } = require('discord.js');
const gameRoster = require('../../services/gameRosterService');
const gateService = require('../../services/gateService');
const { getConfigOrDefault, isOn } = require('../../services/guildConfigService');
const { canonicalClass, saveMemberClass } = require('../../services/registrationService');
const { isAdmin, memberRoleIds } = require('../permissions');
const { availability, nameOf } = require('./gameName');
const { findClassRole, unsafeRole, checkRoles, failureLine, roleLabel, roleProblem, PROBLEM_TEXT } = require('../gateRoles');
const { discordTs } = require('../../utils/time');
const { stylesOf, styleOf, editReplyWithEmojiFallback } = require('../classStyle');
const { invalidateGameNames } = require('../gameNames');
const { scheduleSync } = require('../sheetSync');
const { schedulePanelRefresh } = require('../refresher');
const { messageTexts } = require('../ui/departNotice');
const { v2Create } = require('../ui/common');
const ui = require('../ui/gate');
const { plainClass } = require('../../services/lineupStyle');
const { NO_PERMISSION, eph } = require('./common');
const { logEvent, ixCtx } = require('../../eventLog');

const GATE_OFF = '🚪 Cổng vào đang tắt, hãy nhờ quản lý.';
const ALREADY_MEMBER = '✅ Bạn đã là thành viên bang.';
const ROSTER_CHANGED = 'Danh sách game vừa được cập nhật — chọn lại từ danh sách mới.';
const LOADING = '⏳ Bot đang tải danh sách thành viên Discord, thử lại sau ít giây.';
const GUEST_GONE_NOW = '🤝 Nút Khách đang tắt, hãy nhờ quản lý.';
const GUEST_GONE = '🚶 Lối vào Khách đang tắt — muốn vào bang hãy bấm ⚔️ Thành viên bang ở kênh cổng vào.';
const ALREADY_GUEST = '🤝 Bạn đã là khách của server.';
const GUEST_DONE = '🤝 Bạn đã vào server với vai trò khách.';
const TG_GONE = 'Nút “Chuyển thành Khách” không còn dùng nữa — duyệt hoặc từ chối yêu cầu này.';
const STATUS_TEXT = { approved: 'đã được duyệt', rejected: 'đã bị từ chối', guest: 'đã chuyển thành Khách (cũ)', cancelled: 'đã bị huỷ', revoked: 'đã bị thu hồi' };

const fromMessage = (interaction) => typeof interaction.isFromMessage === 'function' && interaction.isFromMessage();
const holds = (member, roleId) => Boolean(roleId) && memberRoleIds(member).includes(roleId);
const num = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

// The clicking member as a GuildMember (roles.add exists): the interaction's own when cached, else fetched.
async function memberOf(interaction) {
  const m = interaction.member;
  if (m && m.roles && typeof m.roles.add === 'function') return m;
  return interaction.guild.members.fetch(interaction.user.id);
}

// A guild member by id; null when they are not in the server any more.
async function fetchMember(guild, id) {
  try {
    return await guild.members.fetch(id);
  } catch (err) {
    if (err && (err.code === 10007 || err.code === 10013)) return null; // Unknown Member / Unknown User
    throw err;
  }
}

const roleFailed = (interaction, fields) => logEvent('gate', 'role_failed', { ...ixCtx(interaction), ...fields, lvl: 'warn' });

// ---------- member path ----------

async function pickerView(interaction, { page = 0, note = null, roster } = {}) {
  const doc = roster === undefined ? await gameRoster.latest(interaction.guildId) : roster;
  const avail = await availability(interaction, doc, { keepMine: true });
  const notes = [note, avail.complete ? null : LOADING].filter(Boolean).join('\n') || null;
  return ui.buildGatePicker({ ranked: avail.ranked, page, ver: doc ? gameRoster.rosterVersion(doc) : '0', hasRoster: Boolean(doc), note: notes });
}

// The common opening of the member path: gate on, not a member yet, no pending request. -> a reply payload, or null to go on.
async function entryBlock(interaction, config) {
  if (!isOn(config, 'gate')) return ui.ephemeral(GATE_OFF);
  const member = await memberOf(interaction);
  if (holds(member, config.memberRoleId)) return ui.ephemeral(ALREADY_MEMBER);
  const pending = await gateService.findPending(interaction.guildId, interaction.user.id);
  if (pending) return ui.buildPendingNotice(pending);
  const recent = await gateService.recentDecision(interaction.guildId, interaction.user.id);
  if (recent) {
    const again = new Date(new Date(recent.decidedAt).getTime() + gateService.COOLDOWN_MS);
    return ui.ephemeral(`⏳ Yêu cầu trước của bạn vừa được xử lý (${STATUS_TEXT[recent.status] || recent.status}). Bạn gửi yêu cầu mới được sau ${discordTs(again, 'f')} (${discordTs(again, 'R')}).`);
  }
  const until = gateService.requestBlockedUntil(interaction.guildId, interaction.user.id);
  if (until) return ui.ephemeral(`⏳ Bạn đã gửi ${gateService.REQUESTS_PER_HOUR} yêu cầu trong 1 giờ qua. Thử lại ${discordTs(new Date(until), 'R')}.`);
  return null;
}

// ---------- guest path (self-serve) ----------

// The checks of both guest steps. -> a reply payload, or null to go on.
async function guestBlock(interaction, config) {
  if (!isOn(config, 'gate')) return ui.ephemeral(GATE_OFF);
  if (!config.guestRoleId) return ui.ephemeral(GUEST_GONE_NOW);
  const member = await memberOf(interaction);
  if (holds(member, config.memberRoleId)) return ui.ephemeral(ALREADY_MEMBER);
  if (holds(member, config.guestRoleId)) return ui.ephemeral(ALREADY_GUEST);
  return null;
}

// 🤝 Khách -> the confirm step.
async function onGuest(interaction) {
  const config = await getConfigOrDefault(interaction.guildId);
  return interaction.editReply((await guestBlock(interaction, config)) || ui.buildGuestConfirm());
}

// A double click on ✅ Vào làm khách must not post two info cards: one run per person at a time (the stamp expires on its own).
const joining = new Map(); // "guild:user" -> started at
const JOIN_LOCK_MS = 10 * 1000;

// ✅ Vào làm khách -> the guest role at once; the managers get an info line (best effort).
async function onGuestJoin(interaction) {
  const key = `${interaction.guildId}:${interaction.user.id}`;
  const started = joining.get(key);
  if (started && Date.now() - started < JOIN_LOCK_MS) return undefined; // the first click answers
  joining.set(key, Date.now());
  try {
    return await guestJoin(interaction);
  } finally {
    joining.delete(key);
  }
}

async function guestJoin(interaction) {
  const config = await getConfigOrDefault(interaction.guildId, { fresh: true });
  const block = await guestBlock(interaction, config);
  if (block) return interaction.editReply(block);
  const member = await memberOf(interaction);
  const plan = [{ kind: 'guest', id: config.guestRoleId }];
  const bad = checkRoles(interaction.guild, plan, config);
  if (bad.length) {
    bad.forEach((f) => roleFailed(interaction, { kind: f.kind, role: f.id, action: 'guest', problem: f.problem }));
    return interaction.editReply(ui.ephemeral('⚠️ Bot chưa cấp được role khách, hãy báo quản lý.'));
  }
  const changed = await applyRoles(member, plan, 'Gate: tự vào làm khách');
  if (changed.addError) {
    roleFailed(interaction, { kind: 'add', role: config.guestRoleId, action: 'guest', err: changed.addError });
    return interaction.editReply(ui.ephemeral('⚠️ Discord từ chối khi cấp role khách, hãy báo quản lý.'));
  }
  const notes = [];
  const strangerNote = await dropStranger(member, config);
  if (strangerNote) notes.push(strangerNote);
  logEvent('gate', 'guest_join', { ...ixCtx(interaction), member: interaction.user.id });
  const adminChannelId = gateService.gateAdminChannelOf(config);
  if (adminChannelId) {
    try {
      const createdAt = createdAtOf(interaction.user.id);
      const channel = await interaction.client.channels.fetch(adminChannelId);
      await channel.send(v2Create(ui.buildGuestJoinedCard({ member: { id: interaction.user.id, displayName: nameOf(interaction), createdAt, joinedAt: member.joinedAt || null }, warnings: [...cardWarnings({ createdAt, holder: null }), ...notes] })));
    } catch (err) {
      console.error('[gate] cannot post the guest info line:', err.message);
      logEvent('gate', 'guest_info_failed', { ...ixCtx(interaction), err, lvl: 'warn' });
    }
  }
  return interaction.editReply(ui.ephemeral(GUEST_DONE));
}

async function onMember(interaction) {
  const config = await getConfigOrDefault(interaction.guildId);
  const block = await entryBlock(interaction, config);
  if (block) return interaction.editReply(block);
  return interaction.editReply(await pickerView(interaction));
}

// token -> { name, free, entry, token } | { stale: true } (the roster changed / the token is damaged)
function resolveChoice(token, roster) {
  const t = ui.parseToken(token);
  if (!t) return { stale: true };
  if (t.free) {
    const cleaned = gameRoster.cleanFreeName(t.name);
    if (cleaned.error) return { stale: true };
    const entry = roster && roster.members.find((g) => gameRoster.nameKey(g.name) === gameRoster.nameKey(cleaned.name));
    return entry ? { name: entry.name, free: false, entry, token: ui.rosterToken(roster.members.indexOf(entry), gameRoster.rosterVersion(roster)) } : { name: cleaned.name, free: true, entry: null, token };
  }
  if (!roster || gameRoster.rosterVersion(roster) !== t.ver) return { stale: true };
  const entry = roster.members[t.index];
  return entry ? { name: entry.name, free: false, entry, token } : { stale: true };
}

// The member's own availability view of a name (never the clicking manager's). -> { avail, holder }
async function holderCheck(interaction, roster, choice, who) {
  const avail = await availability(interaction, roster, who);
  return { avail, holder: avail.complete ? avail.holderOf(choice.entry || { name: choice.name }) : null };
}

const refuseNote = (holder) => `⚠️ ${gameRoster.takenMessage(holder.source)}`;
const refused = (interaction, holder, name) => logEvent('gate', 'name_refused', { ...ixCtx(interaction), reason: holder.source, free: name.free });

async function classStep(interaction, config, choice, note) {
  const styles = stylesOf(interaction.guild, config);
  return editReplyWithEmojiFallback(interaction, (noEmoji) =>
    ui.buildClassStep({ token: choice.token, name: choice.name, free: choice.free, classes: config.classes, styles, noEmoji, note })
  );
}

// The roster entry's class as an index into config.classes (-1 = unknown / not configured).
function rosterClassIndex(config, choice) {
  const own = choice.entry && choice.entry.className;
  if (!own) return -1;
  const key = (c) => String(plainClass(c) || c).trim().toLowerCase();
  return config.classes.findIndex((c) => key(c) === key(own));
}

// After a name is chosen: the class is already known from the roster -> straight to the summary (with "change class"); else step 2.
async function afterName(interaction, config, choice) {
  const index = rosterClassIndex(config, choice);
  if (index < 0) return classStep(interaction, config, choice);
  const styles = stylesOf(interaction.guild, config);
  return interaction.editReply(ui.buildSummary({ token: choice.token, classIndex: index, name: choice.name, free: choice.free, className: config.classes[index], styles, fromRoster: true, instant: config.gateAutoApprove !== false }));
}

async function onChangeClass(interaction, parts) {
  const roster = await gameRoster.latest(interaction.guildId);
  const choice = resolveChoice(parts.slice(2).join(':'), roster);
  if (choice.stale) return interaction.editReply(await pickerView(interaction, { note: ROSTER_CHANGED, roster }));
  const config = await getConfigOrDefault(interaction.guildId);
  return classStep(interaction, config, choice);
}

async function onPick(interaction, parts) {
  const roster = await gameRoster.latest(interaction.guildId);
  const index = Number(String((interaction.values || [])[0]));
  if (!roster || gameRoster.rosterVersion(roster) !== parts[3] || !roster.members[index]) return interaction.editReply(await pickerView(interaction, { note: ROSTER_CHANGED, roster }));
  const choice = resolveChoice(ui.rosterToken(index, parts[3]), roster);
  const { avail, holder } = await holderCheck(interaction, roster, choice, { keepMine: true });
  if (!avail.complete) return interaction.editReply(await pickerView(interaction, { page: num(parts[2]), note: LOADING, roster }));
  if (holder) {
    refused(interaction, holder, choice);
    return interaction.editReply(await pickerView(interaction, { page: num(parts[2]), note: refuseNote(holder), roster }));
  }
  const config = await getConfigOrDefault(interaction.guildId);
  return afterName(interaction, config, choice);
}

async function onFreeSubmit(interaction) {
  const roster = await gameRoster.latest(interaction.guildId);
  const cleaned = gameRoster.cleanFreeName(interaction.fields.getTextInputValue('name'));
  if (cleaned.error) return interaction.editReply(await pickerView(interaction, { note: `⚠️ ${cleaned.error}`, roster }));
  const choice = resolveChoice(ui.freeToken(cleaned.name), roster); // a typed name that IS in the roster is that character
  const { avail, holder } = await holderCheck(interaction, roster, choice, { keepMine: true });
  if (!avail.complete) return interaction.editReply(await pickerView(interaction, { note: LOADING, roster }));
  if (holder) {
    refused(interaction, holder, choice);
    return interaction.editReply(await pickerView(interaction, { note: refuseNote(holder), roster }));
  }
  const config = await getConfigOrDefault(interaction.guildId);
  return afterName(interaction, config, choice);
}

async function onClass(interaction, parts) {
  const token = parts.slice(2).join(':');
  const roster = await gameRoster.latest(interaction.guildId);
  const choice = resolveChoice(token, roster);
  if (choice.stale) return interaction.editReply(await pickerView(interaction, { note: ROSTER_CHANGED, roster }));
  const config = await getConfigOrDefault(interaction.guildId);
  const index = Number(String((interaction.values || [])[0]));
  const className = config.classes[index];
  if (!className) return classStep(interaction, config, choice, '⚠️ Danh sách phái vừa đổi, chọn lại.');
  const styles = stylesOf(interaction.guild, config);
  return interaction.editReply(ui.buildSummary({ token: choice.token, classIndex: index, name: choice.name, free: choice.free, className, styles, instant: config.gateAutoApprove !== false && Boolean(choice.entry) && !choice.free }));
}

// The warnings shown on the card.
function cardWarnings({ createdAt, holder, now = Date.now() }) {
  const out = [];
  if (holder) out.push(`⚠️ Tên game này đang do <@${holder.id}> giữ (không nên xảy ra): kiểm tra trước khi duyệt.`);
  if (now - createdAt.getTime() < gateService.YOUNG_ACCOUNT_DAYS * 24 * 3600 * 1000) out.push(`⚠️ Tài khoản Discord mới tạo (dưới ${gateService.YOUNG_ACCOUNT_DAYS} ngày).`);
  return out;
}

const createdAtOf = (id) => new Date(SnowflakeUtil.timestampFrom(id));

async function onSend(interaction, parts) {
  const token = parts.slice(2, -1).join(':');
  const classIndex = Number(parts[parts.length - 1]);
  const config = await getConfigOrDefault(interaction.guildId, { fresh: true });
  const block = await entryBlock(interaction, config);
  if (block) return interaction.editReply(block);
  const roster = await gameRoster.latest(interaction.guildId);
  const choice = resolveChoice(token, roster);
  if (choice.stale) return interaction.editReply(await pickerView(interaction, { note: ROSTER_CHANGED, roster }));
  const className = config.classes[classIndex];
  if (!className) return classStep(interaction, config, choice, '⚠️ Danh sách phái vừa đổi, chọn lại.');
  const adminChannelId = gateService.gateAdminChannelOf(config);
  if (!adminChannelId) return interaction.editReply(ui.ephemeral('⚠️ Quản lý chưa chọn kênh nhận yêu cầu vào bang, hãy báo quản lý.'));

  // The in-game ID is required: a missing, bad or taken one sends the member back to the summary to retry (nothing is saved yet).
  // The chosen character's own ID (a manager may have typed it already) is not a clash.
  const retryUid = (text) => {
    const instant = config.gateAutoApprove !== false && Boolean(choice.entry) && !choice.free;
    return interaction.editReply(ui.buildSummary({ token: choice.token, classIndex, name: choice.name, free: choice.free, className, styles: stylesOf(interaction.guild, config), fromRoster: rosterClassIndex(config, choice) >= 0, instant, note: `⚠️ ${text}\nBấm Gửi yêu cầu để nhập lại ID.` }));
  };
  const uidCheck = await gameRoster.checkGameUid(interaction.guildId, interaction.fields.getTextInputValue('uid'), { exceptName: choice.name });
  if (!uidCheck.error && !uidCheck.uid) uidCheck.error = 'Cần nhập ID nhân vật trong game để gửi yêu cầu.';
  if (uidCheck.error) return retryUid(uidCheck.error);

  const { avail, holder } = await holderCheck(interaction, roster, choice, { keepMine: true });
  if (!avail.complete) return interaction.editReply(await pickerView(interaction, { note: LOADING, roster }));
  if (holder) {
    refused(interaction, holder, choice);
    return interaction.editReply(await pickerView(interaction, { note: refuseNote(holder), roster }));
  }

  const member = await memberOf(interaction);
  const canonical = canonicalClass(className, config.classes);
  const { request, created, uidClash } = await gateService.createPending({
    guildId: interaction.guildId,
    discordId: interaction.user.id,
    displayName: nameOf(interaction),
    gameName: choice.name,
    gameNameFree: choice.free,
    className: canonical,
    gameUid: uidCheck.uid,
    adminChannelId,
  });
  if (uidClash) return retryUid(uidClash); // another applicant reserved the same ID a moment ago
  if (!created) return interaction.editReply(ui.buildPendingNotice(request)); // parallel click: one pending request only
  gateService.noteRequest(interaction.guildId, interaction.user.id);

  const styles = stylesOf(interaction.guild, config);
  const classText = `${styleOf(styles, canonical).emojiText} ${plainClass(canonical) || canonical}`;
  const cardInfo = {
    request,
    member: { id: interaction.user.id, displayName: nameOf(interaction), createdAt: createdAtOf(interaction.user.id), joinedAt: member.joinedAt || null },
    entry: choice.entry,
    classText,
    warnings: cardWarnings({ createdAt: createdAtOf(interaction.user.id), holder }),
  };
  let card = ui.buildApprovalCard(cardInfo);

  // A name from the game roster that nobody holds: the bot approves it right away; managers get a card with ↩️ Thu hồi.
  // A typed name (not in the roster) - or an auto-approval that could not finish - waits for a manager as before.
  if (config.gateAutoApprove !== false && choice.entry && !choice.free) {
    const r = await grantMembership(interaction, request, config, 'auto');
    if (r.notes) return autoApproved(interaction, { request, adminChannelId, texts: ui.approvalTexts(cardInfo), notes: r.notes, name: choice.name, className: canonical });
    if (r.lost) return interaction.editReply(ui.buildPendingNotice(request));
    if (r.uidClash) {
      // nothing was approved: the request is cancelled without a cooldown and without using up the hourly limit, the member re-enters the ID
      await gateService.decide(request._id, 'cancelled', { by: interaction.user.id, reason: gateService.UID_CLASH_REASON });
      gateService.unnoteRequest(interaction.guildId, interaction.user.id);
      logEvent('gate', 'uid_clash', { ...ixCtx(interaction), rid: String(request._id), auto: true, lvl: 'warn' });
      return retryUid(r.uidClash);
    }
    if (r.alert) card = ui.buildAlertCard({ texts: ui.approvalTexts(cardInfo), requestId: String(request._id), alert: `Bot chưa tự duyệt được:\n${r.alert}` });
  }
  try {
    const channel = await interaction.client.channels.fetch(adminChannelId);
    const msg = await channel.send(v2Create(card));
    await gateService.setCard(request._id, adminChannelId, msg.id);
  } catch (err) {
    console.error('[gate] cannot post the request card:', err.message);
    logEvent('gate', 'request', { ...ixCtx(interaction), result: 'card_failed', err });
    await gateService.decide(request._id, 'cancelled', { by: interaction.user.id, reason: 'không gửi được thẻ tới quản lý' });
    return interaction.editReply(ui.ephemeral('❌ Không gửi được yêu cầu tới quản lý (bot thiếu quyền ở kênh duyệt). Hãy báo quản lý rồi thử lại.'));
  }
  logEvent('gate', 'request', { ...ixCtx(interaction), rid: String(request._id), gameInRoster: Boolean(choice.entry), free: choice.free, class: canonical, young: cardWarnings({ createdAt: createdAtOf(interaction.user.id), holder: null }).length > 0 });
  return interaction.editReply(ui.ephemeral(`✅ Đã gửi yêu cầu cho quản lý (nhân vật **${ui.safe(choice.name, 40)}**, phái ${ui.safe(plainClass(canonical) || canonical, 40)}). Bạn sẽ nhận tin nhắn riêng khi được duyệt.`));
}

// The member is in: the managers' card (best effort: the member is approved either way) + the member's confirmation.
async function autoApproved(interaction, { request, adminChannelId, texts, notes, name, className }) {
  try {
    const channel = await interaction.client.channels.fetch(adminChannelId);
    const msg = await channel.send(v2Create(ui.buildAutoApprovedCard({ texts, requestId: String(request._id), notes })));
    await gateService.setCard(request._id, adminChannelId, msg.id);
  } catch (err) {
    console.error('[gate] cannot post the auto-approved card:', err.message);
    logEvent('gate', 'auto_card_failed', { ...ixCtx(interaction), rid: String(request._id), err, lvl: 'warn' });
  }
  return interaction.editReply(ui.ephemeral(`🎉 Bạn đã vào bang (nhân vật **${ui.safe(name, 40)}**, phái ${ui.safe(plainClass(className) || className, 40)}). Các kênh của bang đã mở, xem thêm trong tin nhắn riêng của bot.`));
}

// ---------- roles ----------

// [{kind,id}] -> the roles the member does not hold yet.
const rolePlan = (member, add) => add.filter((e) => e.id && !holds(member, e.id));

// ONE API call (all or nothing). -> { addError? }
async function applyRoles(member, add, reason = 'Gate') {
  if (!add.length) return {};
  try {
    await member.roles.add(add.map((e) => e.id), reason);
    return {};
  } catch (err) {
    return { addError: err };
  }
}

// The "Người lạ" role (strangerRoleId): removed when the member gets in, given back when the membership is taken away / refused.
// Best effort: -> a note for the card, or null. Never throws.
async function dropStranger(member, config) {
  const id = config.strangerRoleId;
  if (!id || !holds(member, id)) return null;
  try {
    await member.roles.remove(id, 'Gate: đã vào bang, gỡ role người lạ');
    return null;
  } catch (err) {
    return `⚠️ Chưa gỡ được role người lạ <@&${id}> (${err.message}): gỡ tay.`;
  }
}

// A guest who became a member no longer needs the guest role. Best effort: -> a note for the card, or null. Never throws.
async function dropGuest(member, config) {
  const id = config.guestRoleId;
  if (!id || !holds(member, id)) return null;
  try {
    await member.roles.remove(id, 'Gate: đã thành thành viên, gỡ role khách');
    return null;
  } catch (err) {
    return `⚠️ Chưa gỡ được role khách <@&${id}> (${err.message}): gỡ tay.`;
  }
}

async function giveStranger(member, config, guild) {
  const id = config.strangerRoleId;
  if (!id || holds(member, id)) return null;
  if (holds(member, config.guestRoleId)) return null; // a guest is in the server on purpose: not a stranger
  const problem = roleProblem(guild, id, config, 'stranger');
  if (problem) return `⚠️ Không gán lại được role người lạ <@&${id}>: ${PROBLEM_TEXT[problem]}.`;
  try {
    await member.roles.add(id, 'Gate: chưa được vào bang, gán role người lạ');
    return null;
  } catch (err) {
    return `⚠️ Chưa gán lại được role người lạ <@&${id}> (${err.message}): gán tay.`;
  }
}

// ---------- manager buttons ----------

// The card says what failed and stays pending (buttons kept); the manager also gets the same text, ephemeral.
async function alertCard(interaction, request, alert) {
  await interaction.editReply(ui.buildAlertCard({ texts: messageTexts(interaction.message), requestId: String(request._id), alert }));
  return interaction.followUp(eph(`⚠️ Chưa xử lý được, yêu cầu vẫn đang chờ:\n${alert}`, { allowedMentions: { parse: [] } }));
}

const rolesText = (entries) => entries.map(roleLabel).join(', ');

// Loads the request for a button; answers (and returns null) when it is gone or already decided.
async function loadPending(interaction, id) {
  const request = await gateService.getRequest(id, interaction.guildId);
  if (!request) {
    await interaction.followUp(eph('Không tìm thấy yêu cầu này.'));
    return null;
  }
  if (request.status !== 'pending') {
    await interaction.followUp(eph(`Yêu cầu này ${STATUS_TEXT[request.status] || request.status} rồi.`));
    return null;
  }
  return request;
}

// The member left before the manager decided: the request is cancelled.
async function memberGone(interaction, request) {
  const decided = await gateService.decide(request._id, 'cancelled', { by: interaction.user.id, reason: 'đã rời server' });
  if (!decided) return interaction.followUp(eph('Yêu cầu này vừa được xử lý.'));
  logEvent('gate', 'cancel', { ...ixCtx(interaction), rid: String(request._id), reason: 'left' });
  await interaction.editReply(ui.buildDecidedCard({ texts: messageTexts(interaction.message), kind: 'cancelled', text: `<@${request.discordId}> đã rời server, yêu cầu tự huỷ.` }));
  return undefined;
}

async function dmMember(member, text) {
  try {
    for (const part of gateService.chunkText(text)) await member.send({ content: part, allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    return err;
  }
}

// Grants the membership of a pending request: name still free, roles manageable, ONE winner, roles, link, class, DM.
// Shared by the manager's ✅ and the bot's auto-approval on send (by = 'auto'). Nothing is changed when it returns { alert }.
// The applicant's game ID is given to the character BEFORE anything is decided or any role is given, in one transaction with the status
// change: a clash (held by another character, even a departed one, or a different ID already on this one) approves nothing.
// -> { alert } (still pending) | { uidClash: text } (still pending, the caller cancels it) | { gone: true } (member left) | { lost: true } (somebody else decided) | { notes, classRole }
async function grantMembership(interaction, request, config, by) {
  const guild = interaction.guild;
  if (!config.memberRoleId) return { alert: '• Chưa chọn role thành viên trong /setup.' };
  const member = await fetchMember(guild, request.discordId);
  if (!member) return { gone: true };

  // 1. the name must still be free (judged for the applicant, not for the manager)
  const roster = await gameRoster.latest(interaction.guildId);
  const entry = roster && roster.members.find((g) => gameRoster.nameKey(g.name) === gameRoster.nameKey(request.gameName));
  const { avail, holder } = await holderCheck(interaction, roster, { name: request.gameName, entry }, { id: request.discordId, name: member.displayName, username: member.user && member.user.username, keepMine: true });
  if (!avail.complete) return { alert: '• Bot chưa tải đủ danh sách thành viên Discord để kiểm tra tên game, thử lại sau ít giây.' };
  if (holder) return { alert: `• Tên game **${ui.safe(request.gameName, 40)}** đang do <@${holder.id}> giữ. Từ chối, hoặc gỡ ghép của người kia rồi duyệt lại.` };

  // 2. every role must be manageable BEFORE anything is saved
  let classRole = findClassRole(guild, request.className);
  let classSkipped = null; // a role named like the class that must NOT be handed out
  const classUnsafe = classRole ? unsafeRole(guild, classRole.id, config, 'class') : null;
  if (classUnsafe) {
    logEvent('gate', 'unsafe_role', { ...ixCtx(interaction), kind: 'class', role: classRole.id, problem: classUnsafe, lvl: 'warn' });
    classSkipped = classRole;
    classRole = null;
  }
  const plan = rolePlan(member, [{ kind: 'member', id: config.memberRoleId }, ...(classRole ? [{ kind: 'class', id: classRole.id, name: request.className }] : [])]);
  const bad = checkRoles(guild, plan, config);
  if (bad.length) {
    bad.forEach((f) => roleFailed(interaction, { kind: f.kind, role: f.id, action: 'approve', problem: f.problem }));
    return { alert: bad.map(failureLine).join('\n') };
  }

  // 3. one winner
  const claimArgs = request.gameUid ? { guildId: interaction.guildId, name: request.gameName, uid: request.gameUid } : null; // old requests have no ID
  const won = await gateService.decideWithUid(request._id, 'approved', { by }, claimArgs);
  if (won.clash) return { uidClash: won.clash };
  if (!won.decided) return { lost: true };
  const undoUid = async () => {
    if (!won.claim || won.claim.status !== 'set') return; // only an ID this grant set is taken back
    try {
      await gameRoster.releaseGameUid(interaction.guildId, won.claim.characterId);
    } catch (err) {
      console.error('[gate] cannot release the game ID:', err.message);
    }
  };
  const changed = await applyRoles(member, plan, by === 'auto' ? 'Gate: bot tự duyệt (tên có trong danh sách game)' : `Gate: duyệt bởi ${by}`);
  if (changed.addError) {
    roleFailed(interaction, { kind: 'add', role: plan.map((e) => e.id).join(','), action: 'approve', err: changed.addError });
    await gateService.reopen(request._id, 'approved');
    await undoUid();
    return { alert: `• Discord từ chối khi gán role (${rolesText(plan)}): ${changed.addError.message}` };
  }
  const notes = [];
  // the link is skipped below: the ID must not stay on a character the member is not linked to
  const unlinkedUid = async () => {
    if (!won.claim || won.claim.status !== 'set') return;
    await undoUid();
    notes.push('⚠️ ID game chưa lưu vì chưa liên kết nhân vật: sau khi ghép tên thì nhập ở 🎮 Thành viên game → 🆔 ID game.');
  };
  if (classSkipped) notes.push(`⚠️ Role phái **${ui.safe(plainClass(request.className) || request.className, 40)}** <@&${classSkipped.id}> có quyền quản lý hoặc là role quản lý nên bot KHÔNG gán: gán tay nếu đúng ý.`);
  else if (!classRole) notes.push(`ℹ️ Không có role nào tên phái **${ui.safe(plainClass(request.className) || request.className, 40)}** nên chưa gán role phái.`);
  const strangerNote = await dropStranger(member, config);
  if (strangerNote) notes.push(strangerNote);
  const guestNote = await dropGuest(member, config);
  if (guestNote) notes.push(guestNote);

  // 4. link + class. The name is checked again right before saving: if somebody took it since step 1 the link is NOT taken over (the roles
  // stay approved, the card says so). Nothing here may stop the member from being told.
  try {
    const roster2 = await gameRoster.latest(interaction.guildId);
    const entry2 = roster2 && roster2.members.find((g) => gameRoster.nameKey(g.name) === gameRoster.nameKey(request.gameName));
    const again = await holderCheck(interaction, roster2, { name: request.gameName, entry: entry2 }, { id: request.discordId, name: member.displayName, username: member.user && member.user.username, keepMine: true });
    if (!again.avail.complete) {
      notes.push('⚠️ Chưa kiểm tra lại được tên game (bot đang tải danh sách thành viên): chưa liên kết, ghép tay trong 🔗 Ghép tên.');
      await unlinkedUid();
    } else if (again.holder) {
      logEvent('gate', 'link_skipped', { ...ixCtx(interaction), rid: String(request._id), reason: again.holder.source });
      notes.push('⚠️ Tên đã bị người khác liên kết, ghép tay trong 🔗 Ghép tên.');
      await unlinkedUid();
    } else {
      await gameRoster.setMappings(interaction.guildId, [{ discordId: request.discordId, gameName: entry2 ? entry2.name : request.gameName, displayName: member.displayName }]);
    }
  } catch (err) {
    console.error('[gate] cannot save the link:', err.message);
    notes.push('⚠️ Chưa lưu được liên kết tên game (có người vừa nhận tên này): ghép tay trong 🔗 Ghép tên.');
    await unlinkedUid();
  }
  try {
    await saveMemberClass(interaction.guildId, request.discordId, member.displayName, canonicalClass(request.className, config.classes));
  } catch (err) {
    console.error('[gate] cannot save the class:', err.message);
    logEvent('gate', 'class_failed', { ...ixCtx(interaction), rid: String(request._id), err });
    notes.push('⚠️ Chưa lưu được phái trong bot: đặt tay ở bảng đăng ký.');
  }
  try {
    invalidateGameNames(interaction.guildId);
    scheduleSync(interaction.client, interaction.guildId);
    schedulePanelRefresh(interaction.client, interaction.guildId);
  } catch (err) {
    console.error('[gate] post-approve refresh:', err.message);
  }

  // 5. tell the member
  const dm = await dmMember(member, gateService.welcomeMemberText(config, guild));
  if (dm !== true) {
    logEvent('gate', 'dm_failed', { ...ixCtx(interaction), rid: String(request._id), kind: 'approve', err: dm });
    notes.push('ℹ️ Không nhắn riêng được, bot đã báo trong kênh cổng vào.');
    await publicLine(interaction, config, request.discordId);
  }
  logEvent('gate', 'approve', { ...ixCtx(interaction), member: request.discordId, by, auto: by === 'auto', rid: String(request._id), dm: dm === true, classRole: Boolean(classRole) });
  return { notes, classRole };
}

// ✅ on a request whose ID clashes: nothing is approved, the request is cancelled (no cooldown) and the member is told to apply again.
async function uidClashed(interaction, request, config, clash) {
  const decided = await gateService.decide(request._id, 'cancelled', { by: interaction.user.id, reason: gateService.UID_CLASH_REASON });
  if (!decided) return interaction.followUp(eph('Yêu cầu này vừa được quản lý khác xử lý.'));
  gateService.unnoteRequest(interaction.guildId, request.discordId); // like the auto path: a clash does not use up the member's hourly limit
  logEvent('gate', 'uid_clash', { ...ixCtx(interaction), rid: String(request._id), auto: false, lvl: 'warn' });
  const notes = [];
  const member = await fetchMember(interaction.guild, request.discordId);
  if (member) {
    const told = `Yêu cầu vào bang của bạn chưa được duyệt: ID game **${request.gameUid}** bị trùng. ${clash}\nHãy bấm ⚔️ Thành viên bang ở kênh cổng vào và gửi lại với ID đúng.`;
    const dm = await dmMember(member, told);
    if (dm !== true) {
      logEvent('gate', 'dm_failed', { ...ixCtx(interaction), rid: String(request._id), kind: 'uid_clash', err: dm });
      notes.push('ℹ️ Không nhắn riêng được, bot đã báo trong kênh cổng vào.');
      await publicLine(interaction, config, request.discordId, `⚠️ <@${request.discordId}> ID game không đúng/bị trùng nên yêu cầu chưa được duyệt. Hãy gửi lại yêu cầu ở đây với ID đúng.`);
    }
  } else {
    notes.push('ℹ️ Người này đã rời server.');
  }
  return interaction.editReply(ui.buildDecidedCard({ texts: messageTexts(interaction.message), kind: 'cancelled', text: `ID game **${request.gameUid}** bị trùng, không duyệt: ${clash} Người xin vào cần gửi lại với ID đúng.`, notes }));
}

async function onApprove(interaction, id) {
  const request = await loadPending(interaction, id);
  if (!request) return undefined;
  const config = await getConfigOrDefault(interaction.guildId, { fresh: true });
  const r = await grantMembership(interaction, request, config, interaction.user.id);
  if (r.alert) return alertCard(interaction, request, r.alert);
  if (r.gone) return memberGone(interaction, request);
  if (r.lost) return interaction.followUp(eph('Yêu cầu này vừa được quản lý khác xử lý.'));
  if (r.uidClash) return uidClashed(interaction, request, config, r.uidClash);
  return interaction.editReply(ui.buildDecidedCard({ texts: messageTexts(interaction.message), kind: 'approved', by: interaction.user.id, notes: r.notes }));
}

// ↩️ Thu hồi (after the reason modal): approved -> revoked, the member and class roles the gate gives are removed, the member is told (with a reason).
async function onRevoke(interaction, id) {
  const request = await gateService.getRequest(id, interaction.guildId);
  if (!request) return interaction.followUp(eph('Không tìm thấy yêu cầu này.'));
  if (request.status !== 'approved') return interaction.followUp(eph(`Yêu cầu này ${STATUS_TEXT[request.status] || request.status} rồi.`));
  const reason = String(interaction.fields.getTextInputValue('reason') || '').trim().slice(0, gateService.MAX_REASON);
  const config = await getConfigOrDefault(interaction.guildId, { fresh: true });
  const done = await gateService.revoke(request._id, { by: interaction.user.id, reason });
  if (!done) return interaction.followUp(eph('Yêu cầu này vừa được quản lý khác xử lý.'));
  const notes = [];
  const member = await fetchMember(interaction.guild, request.discordId);
  if (member) {
    const classRole = findClassRole(interaction.guild, request.className);
    const remove = [config.memberRoleId, classRole && !unsafeRole(interaction.guild, classRole.id, config, 'class') ? classRole.id : null].filter((rid) => rid && holds(member, rid));
    try {
      if (remove.length) await member.roles.remove(remove, `Gate: thu hồi bởi ${interaction.user.id}`);
    } catch (err) {
      roleFailed(interaction, { kind: 'remove', role: remove.join(','), action: 'revoke', err });
      notes.push(`⚠️ Discord từ chối khi gỡ role (${err.message}): gỡ tay.`);
    }
    const back = await giveStranger(member, config, interaction.guild);
    if (back) notes.push(back);
    if (reason) {
      const dm = await dmMember(member, `Bạn đã bị thu hồi quyền thành viên bang.\nLý do: ${reason}`);
      if (dm !== true) notes.push('ℹ️ Không nhắn riêng được lý do.');
    }
  } else {
    notes.push('ℹ️ Người này đã rời server.');
  }
  // the game name the approval linked is freed, or its real owner could never pick it
  try {
    if (await gameRoster.removeMappings(interaction.guildId, [request.discordId])) notes.push(`🔓 Đã gỡ liên kết tên game **${ui.safe(request.gameName, 40)}**.`);
  } catch (err) {
    console.error('[gate] cannot remove the link:', err.message);
    notes.push('⚠️ Chưa gỡ được liên kết tên game: gỡ tay trong 🔗 Ghép tên.');
  }
  try {
    invalidateGameNames(interaction.guildId);
    scheduleSync(interaction.client, interaction.guildId);
    schedulePanelRefresh(interaction.client, interaction.guildId);
  } catch (err) {
    console.error('[gate] post-revoke refresh:', err.message);
  }
  logEvent('gate', 'revoke', { ...ixCtx(interaction), member: request.discordId, by: interaction.user.id, rid: String(request._id), reason: Boolean(reason) });
  return interaction.editReply(ui.buildDecidedCard({ texts: messageTexts(interaction.message), kind: 'revoked', by: interaction.user.id, reason, notes }));
}

// DM closed: one short line in the gate channel that pings that user and nobody else.
async function publicLine(interaction, config, userId, text = null) {
  if (!config.gateChannelId) return;
  try {
    const channel = await interaction.client.channels.fetch(config.gateChannelId);
    await channel.send({ content: text || `✅ <@${userId}> đã được duyệt vào bang. Kiểm tra các kênh mới nhé!`, allowedMentions: { users: [userId] } });
  } catch (err) {
    console.warn('[gate] cannot post the public line:', err.message);
  }
}

async function onReject(interaction, id) {
  const request = await loadPending(interaction, id);
  if (!request) return undefined;
  const reason = String(interaction.fields.getTextInputValue('reason') || '').trim().slice(0, gateService.MAX_REASON);
  const member = await fetchMember(interaction.guild, request.discordId);
  const decided = await gateService.decide(request._id, 'rejected', { by: interaction.user.id, reason });
  if (!decided) return interaction.followUp(eph('Yêu cầu này vừa được quản lý khác xử lý.'));
  const notes = [];
  if (member) {
    const back = await giveStranger(member, await getConfigOrDefault(interaction.guildId), interaction.guild);
    if (back) notes.push(back);
    if (reason) {
      const dm = await dmMember(member, `Yêu cầu vào bang của bạn chưa được duyệt.\nLý do: ${reason}`);
      if (dm !== true) {
        logEvent('gate', 'dm_failed', { ...ixCtx(interaction), rid: String(request._id), kind: 'reject', err: dm });
        notes.push('ℹ️ Không nhắn riêng được lý do cho người xin vào.');
      }
    }
  } else {
    notes.push('ℹ️ Người này đã rời server.');
  }
  logEvent('gate', 'reject', { ...ixCtx(interaction), by: interaction.user.id, rid: String(request._id), reason: Boolean(reason) });
  return interaction.editReply(ui.buildDecidedCard({ texts: messageTexts(interaction.message), kind: 'rejected', by: interaction.user.id, reason, notes }));
}

// gate:ok:<id> | gate:no:<id> | gate:noModal:<id> (| gate:tg:<id>: gone) - admin only (checked before anything is touched or shown).
async function onAdmin(interaction, parts) {
  const config = await getConfigOrDefault(interaction.guildId);
  if (!isAdmin(interaction.member, config, interaction.memberPermissions)) return interaction.reply(eph(NO_PERMISSION));
  const id = parts[2];
  if (parts[1] === 'tg') return interaction.reply(eph(TG_GONE));
  if (parts[1] === 'no') return interaction.showModal(ui.rejectModal(id));
  if (parts[1] === 'rv') return interaction.showModal(ui.revokeModal(id));
  await interaction.deferUpdate();
  if (parts[1] === 'ok') return onApprove(interaction, id);
  if (parts[1] === 'rvModal') return onRevoke(interaction, id);
  return onReject(interaction, id);
}

// ---------- entry ----------

async function handle(interaction, parts) {
  const eph1 = { flags: MessageFlags.Ephemeral };
  switch (parts[1]) {
    case 'member':
      await interaction.deferReply(eph1);
      return onMember(interaction);
    case 'guest':
      await interaction.deferReply(eph1);
      return interaction.editReply(ui.ephemeral(GUEST_GONE));
    case 'swguest':
      await interaction.deferUpdate();
      return interaction.editReply(ui.ephemeral(GUEST_GONE));
    case 'gst':
      await interaction.deferReply(eph1);
      return onGuest(interaction);
    case 'gyes':
      await interaction.deferUpdate();
      return onGuestJoin(interaction);
    case 'gback':
      await interaction.deferUpdate();
      return interaction.editReply(ui.ephemeral('Đã quay lại. Bấm một nút ở bảng cổng vào để chọn lại.'));
    case 'back':
      await interaction.deferUpdate();
      return interaction.editReply(await pickerView(interaction));
    case 'p': {
      await interaction.deferUpdate();
      const roster = await gameRoster.latest(interaction.guildId);
      if (!roster || gameRoster.rosterVersion(roster) !== parts[3]) return interaction.editReply(await pickerView(interaction, { note: ROSTER_CHANGED, roster }));
      return interaction.editReply(await pickerView(interaction, { page: num(parts[2]), roster }));
    }
    case 'pick':
      await interaction.deferUpdate();
      return onPick(interaction, parts);
    case 'free':
      return interaction.showModal(ui.freeNameModal());
    case 'freeModal':
      if (fromMessage(interaction)) await interaction.deferUpdate();
      else await interaction.deferReply(eph1);
      return onFreeSubmit(interaction);
    case 'cls':
      await interaction.deferUpdate();
      return onClass(interaction, parts);
    case 'chc':
      await interaction.deferUpdate();
      return onChangeClass(interaction, parts);
    case 'send': // the button opens the optional-ID form; its submit (sendModal) is the real send
      return interaction.showModal(ui.sendModal(parts.slice(2, -1).join(':'), parts[parts.length - 1]));
    case 'sendModal':
      if (fromMessage(interaction)) await interaction.deferUpdate();
      else await interaction.deferReply(eph1);
      return onSend(interaction, parts);
    case 'ok':
    case 'no':
    case 'noModal':
    case 'rv':
    case 'rvModal':
    case 'tg':
      return onAdmin(interaction, parts);
    default:
      return undefined;
  }
}

module.exports = { handle };
