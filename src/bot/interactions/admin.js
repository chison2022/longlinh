const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const warService = require('../../services/warService');
const { listRegistrations, summarize } = require('../../services/registrationService');
const { getConfigOrDefault, updateConfig, parseSettings } = require('../../services/guildConfigService');
const feed = require('../../services/sheets/feed');
const { parseTarget } = require('../../services/headcountService');
const { layoutOf } = require('../../services/teamService');
const { parseLocalDateTime, formatLocalDateTime, formatDayTime, discordTs } = require('../../utils/time');
const { isAdmin } = require('../permissions');
const { buildCreateModal, buildSettingsModal, buildSheetModal, buildOffWarnModal } = require('../ui/settingsModal');
const gateway = require('../../services/sheets/gateway');
const sheetSync = require('../sheetSync');
const actBridge = require('../actBridge');
const { postWarMessage, moveWarMessage, scheduleRefresh, schedulePanelRefresh, refreshNow, refreshPanelNow } = require('../refresher');
const { buildSheetView } = require('../ui/sheetView');
const { NO_PERMISSION, eph } = require('./common');
const { stylesOf, autoEmojiNames } = require('../classStyle');
const { noteState } = require('../gameNames');
const { ensureMembers, MEMBERS_WARNING } = require('../memberCache');
const { memberInfo, groupUnregistered, tracked } = require('../../services/rosterService');
const { buildUnregView, buildUnregNotice, splitByGame, NO_ROLE } = require('../ui/unreg');
const gameRoster = require('./gameRoster');
const gameMap = require('./gameMap');
const depart = require('./depart');
const gameRename = require('./gameRename');
const db = require('../../db');
const gameRosterService = require('../../services/gameRosterService');
const { buildDepartDone, messageTexts } = require('../ui/departNotice');
const { setupView } = require('./setup');
const { logEvent, ixCtx } = require('../../eventLog');

const NO_EVENT = 'Chưa có bang chiến nào đang diễn ra.';

function countsLine(regs) {
  const s = summarize(regs);
  return `✅ ${s.join + s.reserve} · ❌ ${s.absent}`; // a legacy 'reserve' counts as join
}

// The war time is fixed by the guild schedule (earliest start in the future); the admin only picks the deadline.
async function showCreateModal(interaction, config) {
  const schedule = config.schedule;
  const { warStart, deadline } = warService.computeCycle(schedule, new Date());
  return interaction.showModal(
    buildCreateModal({ deadline: formatLocalDateTime(deadline), war: warService.formatWarWindow(warStart, schedule) })
  );
}

// Reply for a week that already has its war: never create a second one. When the war message sits in another channel than
// the current announce channel (open/locked event) a button offers to move it.
function existingWeekReply(event, config) {
  const link = warService.messageLink(event);
  const reply = {
    content:
      event.status === 'done'
        ? `⚠️ Bang chiến tuần này (**${event.title}**) đã kết thúc rồi, không tạo thêm bang chiến mới${link ? ` — ${link}` : ''}`
        : `⚠️ Tuần này đã có **${event.title}** (${warService.STATUS_LABELS[event.status] || event.status})${link ? ` — ${link}` : ''}`,
  };
  if (canMove(event, config)) {
    reply.content += `
Bài đang ở <#${event.channelId}>, kênh thông báo hiện tại là <#${config.announceChannelId}>.`;
    reply.components = [
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`adm:move:${event._id}`).setLabel('📌 Chuyển bài sang kênh mới').setStyle(ButtonStyle.Primary)),
    ];
  }
  return reply;
}

const canMove = warService.canMoveMessage;

async function onCreateSubmit(interaction, config) {
  if (!config.announceChannelId) return interaction.editReply('⚠️ Chưa chọn kênh thông báo. Dùng lệnh /setup trước.');
  const now = new Date();
  const { warStart: startAt } = warService.computeCycle(config.schedule, now);
  const title = warService.buildTitle(startAt, config.schedule);
  const existing = await warService.findEventByStart(interaction.guildId, startAt);
  if (existing) {
    logEvent('admin', 'create', { ...ixCtx(interaction), result: 'existing', eid: String(existing._id), status: existing.status });
    return interaction.editReply(existingWeekReply(existing, config));
  }
  const deadlineAt = parseLocalDateTime(interaction.fields.getTextInputValue('deadline'), now);
  const error = warService.validateEventTimes(startAt, deadlineAt, now);
  if (error) return interaction.editReply(`❌ ${error}`);

  let event;
  try {
    event = await warService.createEvent({
      guildId: interaction.guildId,
      title,
      startAt,
      deadlineAt,
      remindAt: warService.remindAtFor(deadlineAt, config.schedule.remindBeforeHours, now),
      auto: false,
    });
  } catch (err) {
    if (!db.isUniqueViolation(err)) throw err;
    const raced = await warService.findEventByStart(interaction.guildId, startAt); // created by a parallel click / the scheduler
    if (!raced) throw err;
    logEvent('admin', 'create', { ...ixCtx(interaction), result: 'existing', eid: String(raced._id), status: raced.status, raced: true });
    return interaction.editReply(existingWeekReply(raced, config));
  }
  try {
    const posted = await postWarMessage(interaction.client, config, event);
    if (!posted) throw new Error('the war message is already being posted');
    schedulePanelRefresh(interaction.client, interaction.guildId); // the dashboard shows the new event
    sheetSync.scheduleSync(interaction.client, interaction.guildId, 0, 'created'); // the sheet switches to the new war
    logEvent('admin', 'create', { ...ixCtx(interaction), result: 'created', eid: String(event._id), deadline: deadlineAt.toISOString() });
    return interaction.editReply(`✅ Đã tạo **${title}** và đăng ở ${warService.messageLink(posted)}`);
  } catch (err) {
    console.error('[admin] post war message:', err.message);
    logEvent('admin', 'create', { ...ixCtx(interaction), result: 'error', stage: 'post', eid: String(event._id), err });
    return interaction.editReply(
      `❌ Không đăng được thông báo vào <#${config.announceChannelId}>. Kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn, Nhúng liên kết).`
    );
  }
}

// True when the clicked message is the /setup view (it carries the setup:postall button; setup:post on a view posted before 📌 Đăng tất cả).
const isSetupMessage = (interaction) =>
  ((interaction.message && interaction.message.components) || []).some((row) =>
    (row.components || []).some((c) => ['setup:postall', 'setup:post'].includes(c.customId || c.custom_id))
  );

// adm:move:<eid> - re-post the war message in the current announce channel (button of the "already exists" reply, or of the
// /setup view: there the view is drawn again with the result as its note instead of being replaced by plain text)
async function onMove(interaction, config, eventId) {
  const fromSetup = isSetupMessage(interaction);
  const done = async (content) => interaction.editReply(fromSetup ? await setupView(interaction, config, content) : { content, components: [] });
  const event = await warService.getEvent(eventId);
  if (!event || event.guildId !== interaction.guildId) return done('Bang chiến không tồn tại hoặc đã bị xoá.');
  if (!config.announceChannelId) return done('⚠️ Chưa chọn kênh thông báo. Dùng lệnh /setup trước.');
  if (event.status !== 'open' && event.status !== 'locked') return done(`Bang chiến **${event.title}** đang ở trạng thái "${warService.STATUS_LABELS[event.status]}", không chuyển bài được.`);
  if (!event.messageId || event.channelId === config.announceChannelId) return done(`Bài **${event.title}** đã ở <#${config.announceChannelId}>: ${warService.messageLink(event)}`);
  let result;
  try {
    result = await moveWarMessage(interaction.client, config, event);
  } catch (err) {
    console.error('[admin] move war message:', err.message);
    logEvent('admin', 'move', { ...ixCtx(interaction), eid: String(eventId), result: 'error', err });
    return done(`❌ Không đăng được bài vào <#${config.announceChannelId}>. Kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn, Nhúng liên kết). Bài cũ giữ nguyên.`);
  }
  logEvent('admin', 'move', { ...ixCtx(interaction), eid: String(eventId), result: result.moved ? 'moved' : 'noop', oldDelete: result.oldDelete, fromSetup });
  if (!result.moved) return done('Bài vừa được chuyển hoặc bang chiến vừa đổi trạng thái, không làm gì thêm.');
  scheduleRefresh(interaction.client, event._id, 0); // the new message was built before the move: show fresh counts / lock state
  const oldLink = `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.messageId}`;
  const note = result.oldDelete === 'failed' ? `
⚠️ Chưa xoá được bài cũ ở <#${event.channelId}> (thiếu quyền?). Xoá tay: ${oldLink}` : '';
  return done(`✅ Đã chuyển **${event.title}** sang <#${config.announceChannelId}>: ${warService.messageLink(result.event)}. Đăng ký giữ nguyên.${note}`);
}

async function onLock(interaction, config) {
  const event = await warService.getCurrentEvent(interaction.guildId);
  if (!event) return interaction.editReply(NO_EVENT);
  let updated;
  let message;
  let lockResult;
  if (event.status === 'open') {
    updated = await warService.lockEvent(event._id);
    message = `🔒 Đã chốt danh sách **${event.title}**.`;
    lockResult = { result: 'locked' };
  } else if (event.status === 'locked') {
    if (new Date(event.startAt) <= new Date()) return interaction.editReply('Đã quá giờ đánh, không thể mở lại đăng ký.');
    // the regular lock time (start - lockBeforeHours) while it is still ahead, else the war start
    const deadline = warService.reopenDeadline(event, config.schedule, new Date());
    updated = await warService.reopenEvent(event._id, deadline);
    message = `🟢 Đã mở lại đăng ký **${event.title}** (hạn mới: ${discordTs(deadline, 'f')}).`;
    lockResult = { result: 'reopened', deadline: new Date(deadline).toISOString() };
  } else {
    return interaction.editReply(`Bang chiến **${event.title}** đang ở trạng thái "${warService.STATUS_LABELS[event.status]}", không thể chốt/mở lại.`);
  }
  if (!updated) return interaction.editReply('Trạng thái vừa thay đổi, hãy thử lại.');
  scheduleRefresh(interaction.client, event._id, 0);
  sheetSync.scheduleSync(interaction.client, interaction.guildId);
  if (lockResult.result === 'locked') actBridge.onLocked(interaction.client, event._id); // the Activity's copy of the war
  else actBridge.onReopened(event._id); // the board cannot publish while registration is open
  logEvent('admin', 'lock', { ...ixCtx(interaction), eid: String(event._id), ...lockResult });
  const regs = await listRegistrations(event._id);
  return interaction.editReply(`${message}\n${countsLine(regs)}`);
}

// adm:export (an old dashboard's button): the data lives in the Google Sheet now.
// Plain infos of the guild's members; the cache is fetched when it is not known to be complete (see memberCache).
// -> { infos, complete }: complete=false means the fetch failed and the infos may be missing people.
async function memberInfos(guild) {
  const { complete } = await ensureMembers(guild);
  return { infos: [...guild.members.cache.values()].map(memberInfo), complete };
}

const STALE_LIST = 'Danh sách đã được làm mới — bấm 👥 Chưa đăng ký để mở lại.';

// Answers an unreg button. A message that has text content (an old confirm step / notice) cannot become Components V2 in place
// (discord.js cannot clear content): it is edited to a plain componentless line and the V2 answer goes as a new ephemeral follow-up.
// A failing edit also falls back to a follow-up, so the answer (above all "đã nhắc N người") is never lost.
async function answer(interaction, payload, inPlace = true) {
  const followUp = () => interaction.followUp({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });
  if (inPlace && interaction.message?.content) {
    await interaction.editReply({ content: STALE_LIST, embeds: [], components: [] }).catch((err) => console.error('[admin] unreg stale edit:', err.message));
    return followUp();
  }
  try {
    return await interaction.editReply(payload);
  } catch (err) {
    console.error('[admin] unreg edit failed, using a follow-up:', err.message);
    return followUp();
  }
}
const REMIND_COOLDOWN_MIN = Math.round(warService.MANUAL_REMIND_COOLDOWN_MS / 60000);
const reminding = new Set(); // event ids with a manual reminder being sent by this process

// -> { ids: Set of the Discord ids that match somebody of the in-game roster (by name or by hand), names: Map(id -> game name) };
// null without a roster (no split then).
async function inGameIds(guildId, infos) {
  try {
    const state = (db.isConnected() ? 1 : 0);
    noteState('admin', state);
    if (state !== 1) return null; // no DB connection: no split
    const found = await gameRosterService.matchGuild(guildId, infos.map((i) => ({ id: i.id, name: i.name, bot: i.bot })));
    return found ? { ids: new Set(found.match.matched.filter((m) => m.how !== 'prefix').map((m) => m.discordId)), names: gameRosterService.gameNameMap(found.match) } : null;
  } catch (err) {
    console.error('[admin] game roster match:', err.message);
    return null;
  }
}

async function unregisteredOf(interaction, config, event) {
  const [{ infos, complete }, regs] = await Promise.all([memberInfos(interaction.guild), listRegistrations(event._id)]);
  const grouped = groupUnregistered(infos, regs.map((r) => r.discordId), config);
  const game = await inGameIds(interaction.guildId, infos);
  return { ...grouped, complete, trackedCount: tracked(infos, config).length, inGame: game && game.ids, gameNames: game && game.names };
}

const viewOpts = (interaction, config, grouped, extra = {}) => ({
  styles: stylesOf(interaction.guild, config),
  incomplete: !grouped.complete,
  inGame: grouped.inGame,
  gameNames: grouped.gameNames,
  trackedCount: grouped.trackedCount,
  memberRoleId: config.memberRoleId,
  ...extra,
});

// adm:unreg | adm:unreg:r (refresh/cancel, edits the list in place)
async function onUnreg(interaction, config, inPlace = false) {
  if (!config.memberRoleId) return answer(interaction, buildUnregNotice(NO_ROLE, { back: false }), inPlace);
  const event = await warService.getCurrentEvent(interaction.guildId);
  if (!event) return answer(interaction, buildUnregNotice(NO_EVENT, { back: false }), inPlace);
  const grouped = await unregisteredOf(interaction, config, event);
  const split = grouped.inGame ? splitByGame(grouped, grouped.inGame) : null; // only for the log line
  logEvent('unreg', 'view', {
    ...ixCtx(interaction),
    eid: String(event._id),
    total: grouped.total,
    inGame: split ? split.inGame.total : null,
    unknown: split ? split.notInGame.total : grouped.total,
    trackedCount: grouped.trackedCount,
    incomplete: !grouped.complete,
    refresh: inPlace,
  });
  return answer(interaction, buildUnregView(event, grouped, viewOpts(interaction, config, grouped)), inPlace);
}

// adm:unregping:<eid>[:g] (confirm step) | adm:unregok:<eid>[:g] (send ONE reminder, split by length, users only).
// ":g" = only the people the bot found in the game roster; without it everybody who has not registered.
async function onUnregPing(interaction, config, eventId, send, only = false) {
  if (!config.memberRoleId) return answer(interaction, buildUnregNotice(NO_ROLE, { back: false }));
  const event = await warService.getEvent(eventId);
  if (!event || event.guildId !== interaction.guildId) return answer(interaction, buildUnregNotice('Bang chiến không tồn tại hoặc đã bị xoá.', { back: false }));
  if (!warService.canRegister(event, new Date())) return answer(interaction, buildUnregNotice('Đăng ký đã đóng, không cần nhắc.', { back: false }));
  const grouped = await unregisteredOf(interaction, config, event);
  const target = only ? { ...(grouped.inGame ? splitByGame(grouped, grouped.inGame).inGame : { total: 0, groups: [] }), complete: grouped.complete } : grouped;
  if (!target.total) {
    if (only && grouped.trackedCount !== 0) return answer(interaction, buildUnregNotice('Chưa có ai xác định được là đang ở bang để nhắc.'));
    return answer(interaction, buildUnregView(event, grouped, viewOpts(interaction, config, grouped)));
  }
  if (!send) {
    logEvent('unreg', 'confirm', { ...ixCtx(interaction), eid: String(event._id), target: only ? 'in' : 'all', total: target.total });
    return answer(interaction, buildUnregView(event, grouped, viewOpts(interaction, config, grouped, { confirm: only ? 'in' : 'all' })));
  }
  return sendReminder(interaction, config, event, target, only);
}

// One manual reminder per event per MANUAL_REMIND_COOLDOWN: an in-process lock (double click while sending) plus an atomic
// claim in the DB (another process / a second admin).
async function sendReminder(interaction, config, event, grouped, only = false) {
  const key = String(event._id);
  const target = only ? 'in' : 'all';
  if (reminding.has(key)) {
    logEvent('unreg', 'cooldown', { ...ixCtx(interaction), eid: key, reason: 'busy' });
    return answer(interaction, buildUnregNotice('⏳ Đang gửi nhắc cho bang chiến này, đợi chút.'));
  }
  reminding.add(key);
  try {
    const now = new Date();
    const claim = await warService.claimManualRemind(event._id, now);
    if (!claim.claimed) {
      logEvent('unreg', 'cooldown', { ...ixCtx(interaction), eid: key, reason: 'recent', at: claim.at ? new Date(claim.at).toISOString() : undefined });
      const at = claim.at ? ` lúc ${discordTs(new Date(claim.at), 'R')}` : '';
      return answer(interaction, buildUnregNotice(`⏳ Vừa nhắc${at}, đợi ${REMIND_COOLDOWN_MIN} phút.`));
    }
    const channelId = config.announceChannelId || event.channelId;
    const link = warService.messageLink(event);
    const header = `📣 **${event.title}** — nhắc đăng ký (hạn ${discordTs(new Date(event.deadlineAt), 'R')}).${link ? ` Đăng ký tại: ${link}` : ''}
Chưa đăng ký:`;
    const messages = warService.buildReminderMessages(header, grouped.groups.flatMap((g) => g.ids));
    let sent = 0;
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      for (const content of messages) {
        await channel.send({ content, allowedMentions: { parse: ['users'] } });
        sent++;
      }
    } catch (err) {
      console.error('[admin] unreg ping:', err.message);
      logEvent('unreg', 'failed', { ...ixCtx(interaction), eid: key, target, total: grouped.total, sent, messages: messages.length, channel: channelId, err });
      if (sent === 0) await warService.releaseManualRemind(event._id, now).catch(() => {}); // nothing went out: do not burn the cooldown
      const detail = sent ? `Chỉ ${sent}/${messages.length} tin đã gửi, các tin còn lại bị lỗi.` : 'Chưa có tin nào được gửi.';
      return answer(interaction, buildUnregNotice(`❌ Không gửi được vào <#${channelId}>. Kiểm tra quyền của bot. ${detail}`));
    }
    logEvent('unreg', 'sent', { ...ixCtx(interaction), eid: key, target, total: grouped.total, sent, messages: messages.length, incomplete: !grouped.complete });
    const warning = grouped.complete ? '' : `\n${MEMBERS_WARNING}`;
    return answer(interaction, buildUnregNotice(`✅ Đã nhắc ${grouped.total} người ở <#${channelId}> (${sent}/${messages.length} tin).${warning}`));
  } finally {
    reminding.delete(key);
  }
}

async function onSettingsSubmit(interaction, config) {
  const get = (id) => interaction.fields.getTextInputValue(id) || '';
  const { value, error } = parseSettings({
    classes: get('classes'),
    groupCount: get('groupCount'),
    war: get('war'),
    open: get('open'),
    timing: get('timing'),
  }, { autoEmoji: (list) => autoEmojiNames(interaction.guild, list), prevEmojis: config.classEmojis });
  if (error) {
    logEvent('admin', 'settings', { ...ixCtx(interaction), result: 'invalid' });
    return interaction.editReply(`❌ ${error}`);
  }
  const saved = await updateConfig(interaction.guildId, {
    classes: value.classes,
    classEmojis: value.classEmojis,
    groupCount: value.groupCount,
    schedule: { ...config.schedule, ...value.schedule },
  });
  // capacity / classes / schedule appear on the war message and the dashboard: draw them again
  const current = await warService.getCurrentEvent(interaction.guildId).catch(() => null);
  if (current) scheduleRefresh(interaction.client, current._id, 0);
  sheetSync.scheduleSync(interaction.client, interaction.guildId); // class names / labels of the sheet
  const s = saved.schedule;
  const layout = layoutOf(saved);
  logEvent('admin', 'settings', { ...ixCtx(interaction), result: 'saved', classes: saved.classes.length, groupCount: saved.groupCount, autoOpen: Boolean(s.enabled) });
  return interaction.editReply(
    [
      '✅ Đã lưu cài đặt.',
      `Môn phái (${saved.classes.length}): ${saved.classes.join(', ')}`,
      `Số nhóm: ${saved.groupCount} (mỗi nhóm ${layout.partiesPerGroup} PT × ${layout.partySize})`,
      `Lịch đánh: ${formatDayTime(s.warDay, s.warTime)} · chốt trước ${s.lockBeforeHours} giờ · nhắc trước hạn ${s.remindBeforeHours} giờ`,
      `Tự mở đăng ký: ${s.enabled ? formatDayTime(s.openDay, s.openTime) : 'tắt'}${s.enabled && s.openPing ? ' · tag role thành viên: bật' : ''}`,
    ].join('\n')
  );
}

// adm:offcfgModal - the "⚙️ Ngưỡng" form: days offline before the managers are told (0 = off), and the wanted number
// of official members (an empty / missing field leaves it as it is: a form opened before that field existed).
async function onOffWarnSubmit(interaction, config) {
  const raw = String(interaction.fields.getTextInputValue('days') || '').trim();
  const days = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(days) || days > 60) {
    logEvent('admin', 'off_warn', { ...ixCtx(interaction), result: 'invalid' });
    return interaction.editReply('❌ Số ngày phải là số nguyên từ 0 đến 60 (0 = tắt cảnh báo).');
  }
  const targetRaw = String(interaction.fields.getTextInputValue('target') || '').trim();
  const patch = { offWarnDays: days };
  if (targetRaw) {
    const parsed = parseTarget(targetRaw);
    if (parsed.error) {
      logEvent('admin', 'off_warn', { ...ixCtx(interaction), result: 'invalid', field: 'target' });
      return interaction.editReply(`❌ ${parsed.error}`);
    }
    patch.rosterTarget = parsed.value;
  }
  await updateConfig(interaction.guildId, patch);
  if (patch.rosterTarget !== undefined) schedulePanelRefresh(interaction.client, interaction.guildId); // the dashboard shows the target
  logEvent('admin', 'off_warn', { ...ixCtx(interaction), result: 'saved', days, target: patch.rosterTarget });
  const targetNote = patch.rosterTarget !== undefined ? ` Mục tiêu quân số chính thức: **${patch.rosterTarget}**.` : '';
  const main = days ? `✅ Đã lưu: sau mỗi lần cập nhật danh sách game, bot báo quản lý người off từ **${days} ngày** trở lên mà không có đơn xin nghỉ.` : '✅ Đã tắt cảnh báo off quá số ngày.';
  return interaction.editReply(main + targetNote);
}

// adm:sheet (the 📊 view) | adm:sheetedit (modal) | adm:sheetModal (modal submit) | adm:sheetnow (sync now) | adm:sheetsync (an old dashboard's button)
async function onSheetSubmit(interaction, config) {
  const raw = String(interaction.fields.getTextInputValue('sheetId') || '').trim();
  if (!raw) {
    await updateConfig(interaction.guildId, { sheetId: null });
    schedulePanelRefresh(interaction.client, interaction.guildId);
    logEvent('sheet', 'connect', { ...ixCtx(interaction), ok: true, action: 'off' });
    return interaction.editReply('✅ Đã tắt đồng bộ Google Sheet.');
  }
  const id = gateway.parseSpreadsheetId(raw);
  if (!id) {
    logEvent('sheet', 'connect', { ...ixCtx(interaction), ok: false, reason: 'bad_id', lvl: 'warn' });
    return interaction.editReply('❌ Link / ID Google Sheet không hợp lệ. Dán link dạng https://docs.google.com/spreadsheets/d/…');
  }
  if (!gateway.isAvailable()) {
    logEvent('sheet', 'connect', { ...ixCtx(interaction), ok: false, reason: 'no_key', lvl: 'warn' });
    return interaction.editReply(`⚠️ ${gateway.NO_KEY_HINT()}`);
  }
  const checked = await gateway.checkSpreadsheet(id);
  if (!checked.ok) {
    logEvent('sheet', 'connect', { ...ixCtx(interaction), ok: false, reason: 'check_failed', detail: String(checked.message || '').slice(0, 200), lvl: 'warn' });
    return interaction.editReply(`⚠️ Chưa lưu: ${checked.message}`);
  }
  await updateConfig(interaction.guildId, { sheetId: id });
  schedulePanelRefresh(interaction.client, interaction.guildId);
  sheetSync.scheduleSync(interaction.client, interaction.guildId, 0, 'connect');
  logEvent('sheet', 'connect', { ...ixCtx(interaction), ok: true, action: 'on' });
  return interaction.editReply(`✅ Đã nối Google Sheet **${checked.title}**. Bot sẽ ghi các tab ${feed.tabsText()} (tự đồng bộ sau mỗi thay đổi, hoặc bấm 📊 Google Sheet → 🔄 Đồng bộ ngay).`);
}

// The ephemeral 📊 view: sheet title + link, last sync / error, sync-now and change buttons (or the setup hint without a sheet).
async function sheetViewFor(config, note) {
  const hasKey = gateway.isAvailable();
  const view = { configured: Boolean(config.sheetId), hasKey, keyHint: gateway.NO_KEY_HINT(), email: hasKey ? gateway.accountEmail() : null, status: sheetSync.getStatus(config.guildId), note };
  if (!config.sheetId) return buildSheetView(view);
  view.url = gateway.sheetUrl(config.sheetId);
  if (hasKey) {
    try {
      view.title = (await gateway.getClient().getSpreadsheet(config.sheetId)).title;
    } catch (err) {
      view.titleError = gateway.describeError(err);
    }
  }
  return buildSheetView(view);
}

// Syncs at once, then redraws the war message and the dashboard (data written straight to the DB shows up too).
// -> the sentence that reports the counts / the error.
async function syncAndRedraw(interaction) {
  const res = await sheetSync.syncNow(interaction.client, interaction.guildId, 'now');
  let redraw = '';
  try {
    const current = await warService.getCurrentEvent(interaction.guildId);
    if (current) await refreshNow(interaction.client, current._id, { panel: false });
    await refreshPanelNow(interaction.client, interaction.guildId);
    redraw = '\nĐã vẽ lại bài bang chiến và bảng điều khiển.';
  } catch (err) {
    console.error('[admin] redraw after sync:', err.message);
  }
  if (!res.ok) return `⚠️ Chưa đồng bộ được: ${res.message}${redraw}`;
  const parts = [`${res.members} thành viên`, `${res.week} dòng bang chiến tuần này`, `${res.history} dòng lịch sử`];
  if (res.events !== undefined) parts.push(`${res.events} dòng sự kiện`);
  if (res.kept) parts.push(`giữ ${res.kept} ô người khác sửa`);
  return `✅ Đã đồng bộ: ${parts.join(', ')}.${redraw}`;
}

const NO_SHEET = 'Chưa cài Google Sheet. Bấm **📊 Google Sheet** để dán link.';

// adm:sheet - opens the view
async function onSheetView(interaction, config) {
  return interaction.editReply(await sheetViewFor(config));
}

// adm:sheetnow - sync now, the view is drawn again with the result
async function onSheetNow(interaction, config) {
  if (!config.sheetId) return interaction.editReply(await sheetViewFor(config, NO_SHEET));
  const note = await syncAndRedraw(interaction);
  return interaction.editReply(await sheetViewFor(config, note));
}

// adm:create | adm:createModal | adm:lock | adm:settings | adm:settingsModal
// | adm:unreg[:r] | adm:unregping:<eid>[:g] | adm:unregok:<eid>[:g] | adm:move:<eid>
// | adm:sheet | adm:sheetedit | adm:sheetnow | adm:game | adm:gamexlsx | adm:gameup | adm:gameupModal | adm:gameadd | adm:gameaddModal | adm:gameuid | adm:gameuidModal | adm:gmap[:r|:g] | adm:gmapp:<page> | adm:gmapm:<index>:<page>:<ver> | adm:gmaps:<index>:<ver> | adm:gmapsug:<ver> | adm:gmapg:<page>:<ver> | adm:gmapu:<index>:<ver> | adm:gmapdel (see ./gameMap)
// | adm:depok:<rosterId> | adm:depunlink:<rosterId> (the "left the game, still on Discord" notice, see ./depart)
// adm:offok:<rosterId> - ✅ Đã xử lý on the "off quá N ngày" card (admin-gated in handle): the card turns green with who handled it.
async function onOffDone(interaction, rosterId) {
  const texts = messageTexts(interaction.message);
  if (!texts.length) return interaction.followUp(eph('Không đọc được thông báo để cập nhật.'));
  await interaction.editReply(buildDepartDone({ texts, adminId: interaction.user.id }));
  logEvent('roster', 'off_done', { ...ixCtx(interaction), rosterId });
}

async function handle(interaction, parts) {
  const action = parts[1];
  const opensModal = action === 'create' || action === 'settings' || action === 'offcfg' || action === 'gameup' || action === 'gameadd' || action === 'gameuid' || action === 'sheetedit';
  // Buttons inside the ephemeral unreg list edit it in place; everything else opens a new ephemeral reply.
  const inPlace = action === 'grenpair' || action === 'grenold' || action === 'grennew' || action === 'grenok' || (action === 'gren' && parts[2] === 'r') || action === 'sheetnow' || action === 'gmapsug' || action === 'gmapg' || action === 'gmapu' || action === 'gmapdel' || action === 'gmapp' || action === 'gmapm' || action === 'gmaps' || (action === 'gmap' && (parts[2] === 'r' || parts[2] === 'g')) || action === 'unregping' || action === 'unregok' || action === 'move' || action === 'depok' || action === 'offok' || (action === 'unreg' && parts[2] === 'r');
  if (inPlace) await interaction.deferUpdate();
  else if (!opensModal) await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Modals must open within Discord's 3s window: Manage Server needs no DB at all, the config is cached otherwise.
  let config = null;
  let allowed = isAdmin(interaction.member, null, interaction.memberPermissions);
  if (!allowed) {
    config = await getConfigOrDefault(interaction.guildId);
    allowed = isAdmin(interaction.member, config, interaction.memberPermissions);
  }
  if (!allowed) {
    if (opensModal) return interaction.reply(eph(NO_PERMISSION));
    if (action === 'depok' || action === 'offok') return interaction.followUp(eph(NO_PERMISSION)); // the public notice stays as it is; only the clicker is told
    const unregView = action === 'unregping' || action === 'unregok' || (action === 'unreg' && parts[2] === 'r');
    return unregView ? answer(interaction, buildUnregNotice(NO_PERMISSION, { back: false })) : interaction.editReply(NO_PERMISSION);
  }
  if (!config) config = await getConfigOrDefault(interaction.guildId);

  switch (action) {
    case 'create':
      return showCreateModal(interaction, config);
    case 'settings':
      return interaction.showModal(buildSettingsModal(config, stylesOf(interaction.guild, config)));
    case 'createModal':
      return onCreateSubmit(interaction, config);
    case 'settingsModal':
      return onSettingsSubmit(interaction, config);
    case 'lock':
      return onLock(interaction, config);
    case 'sheet':
      return onSheetView(interaction, config);
    case 'sheetedit':
      return interaction.showModal(buildSheetModal(config));
    case 'sheetnow':
      return onSheetNow(interaction, config);
    case 'sheetModal':
      return onSheetSubmit(interaction, config);
    case 'unreg':
      return onUnreg(interaction, config, parts[2] === 'r');
    case 'unregping':
    case 'unregok':
      return onUnregPing(interaction, config, parts[2], action === 'unregok', parts[3] === 'g');
    case 'game':
      return gameRoster.onView(interaction, config);
    case 'gamexlsx':
      return gameRoster.onXlsx(interaction, config);
    case 'gameup':
      return gameRoster.onUpload(interaction);
    case 'gameupModal':
      return gameRoster.onUploadSubmit(interaction, config);
    case 'gameadd':
      return gameRoster.onAdd(interaction, config);
    case 'gameaddModal':
      return gameRoster.onAddSubmit(interaction, config);
    case 'gameuid':
      return gameRoster.onUid(interaction);
    case 'gameuidModal':
      return gameRoster.onUidSubmit(interaction, config);
    case 'gmap':
      return parts[2] === 'g' ? gameRoster.onBack(interaction, config) : gameMap.handle(interaction, parts);
    case 'gmapp':
    case 'gmapm':
    case 'gmaps':
    case 'gmapg':
    case 'gmapu':
    case 'gmapsug':
    case 'gmapdel':
      return gameMap.handle(interaction, parts);
    case 'depok':
      return depart.onDone(interaction, config, parts[2]);
    case 'offok':
      return onOffDone(interaction, parts[2]);
    case 'offcfg':
      return interaction.showModal(buildOffWarnModal(config));
    case 'offcfgModal':
      return onOffWarnSubmit(interaction, config);
    case 'depunlink':
      return depart.onUnlink(interaction, config, parts[2]);
    case 'depreg':
      return depart.onUnreg(interaction, config, parts[2]);
    case 'gren':
    case 'grenpair':
    case 'grenold':
    case 'grennew':
    case 'grenok':
      return gameRename.handle(interaction, parts);
    case 'move':
      return onMove(interaction, config, parts[2]);
    default:
      return interaction.editReply('Chức năng không tồn tại.');
  }
}

module.exports = { handle };
