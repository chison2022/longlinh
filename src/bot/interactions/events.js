// Guild events (customIds ev:*). Members: ev:rp:<eid>:<yes|maybe|no> (answer), ev:ls:<eid> (who joins), ev:rules:<eid> (the full rules). Managers
// (the dashboard's admin gate): the manager view opens from adm:events (see ./admin), then ev:pick (select) · ev:sel|edit|lock|cancel|cancelok|
// remind|remindok|maybe:<eid> · ev:new · modals ev:newModal | ev:editModal:<eid>. The persistent panel (see ../eventPanel) has ev:pnew (the create form,
// modal ev:pnewModal) and ev:pmanage (opens the manager view as a new ephemeral reply): the panel message itself is never edited by these. A new event is first previewed (ev:drtag|drmaybe|drpost|drcancel:<draft>,
// the draft lives in memory for 15 min). The form has no time field: its submit shows the date / time picker first (ev:pk:<picker>:<day|hour|min|dur|dl>
// selects, ev:pkok|pkcancel:<picker>; the picker lives in memory for 30 min like the draft), then the preview (create) or the save (edit).
// A modal with a typed `time` field (opened before the picker existed) still goes the old way. The shortfall notice in the admin channel has
// ev:mincancel|minext|minkeep:<eid> + modal ev:minextModal:<eid>.
// The manager view is one ephemeral V2 message edited in place.
const crypto = require('node:crypto');
const { MessageFlags, AttachmentBuilder } = require('discord.js');
const gameRoster = require('../../services/gameRosterService');
const { buildEventDocx } = require('../../services/eventDocx');
const { plainClass } = require('../../services/lineupStyle');
const { loadGameNames } = require('../gameNames');
const eventService = require('../../services/eventService');
const { getConfigOrDefault } = require('../../services/guildConfigService');
const { isAdmin } = require('../permissions');
const { buildEventModal, buildExtendModal } = require('../ui/settingsModal');
const { buildEventPicker } = require('../ui/eventPicker');
const { buildEventsView, buildListMessages, buildRulesMessages, buildEventPreview, buildMinNotice } = require('../ui/eventCard');
const { defang } = require('../../services/mailService');
const { discordTs } = require('../../utils/time');
const { scheduleEventRefresh, refreshEventCardNow, postEventCard } = require('../refresher');
const sheetSync = require('../sheetSync');
const { scheduleDocSync } = require('../eventDocSync');
// an event change refreshes the Sheet tab and the events Google Doc (each debounced on its own)
const scheduleSync = (client, guildId) => {
  sheetSync.scheduleSync(client, guildId);
  scheduleDocSync(client, guildId);
};
const { liveRegs } = require('../liveNames');
const { NO_PERMISSION, eph, displayNameOf } = require('./common');
const { logEvent, ixCtx } = require('../../eventLog');

const NOT_FOUND = 'Sự kiện không tồn tại hoặc đã bị xoá.';
const CLOSED = '🔒 Đã hết hạn đăng ký sự kiện này.';
const CANCELLED = '❌ Sự kiện này đã huỷ.';
const DRAFT_EXPIRED = 'Bản nháp đã hết hạn, bấm ➕ Tạo sự kiện lại.';
const DRAFT_TTL_MS = 15 * 60 * 1000;
const PICKER_EXPIRED = 'Phiên tạo sự kiện đã hết hạn, bấm ➕ Tạo sự kiện lại.';
const PICKER_TTL_MS = 30 * 60 * 1000;
const ADMIN_ACTIONS = new Set(['pk', 'pkok', 'pkcancel', 'pick', 'sel', 'new', 'newModal', 'edit', 'editModal', 'lock', 'cancel', 'cancelok', 'remind', 'remindok', 'maybe', 'drtag', 'drmaybe', 'drpost', 'drcancel', 'mincancel', 'minext', 'minextModal', 'minkeep', 'pnew', 'pnewModal', 'pmanage', 'doc']);
const OPENS_MODAL = new Set(['new', 'pnew', 'edit', 'minext']);
const SUBMITS = new Set(['newModal', 'pnewModal', 'editModal', 'minextModal']);
const NEW_EPHEMERAL = new Set(['pnewModal', 'pmanage', 'doc']); // answered from the persistent panel: always a new ephemeral reply, never an edit of the panel
const MODAL_FETCH_MS = 1500; // what we may spend on the DB before showModal (Discord wants the modal within 3 s)
const REMIND_COOLDOWN_MIN = Math.round(eventService.MANUAL_REMIND_COOLDOWN_MS / 60000);
const reminding = new Set(); // event ids with a manual reminder being sent by this process
// The previews of new events: draftId -> { userId, guildId, value, tag, allowMaybe, at }. Memory only (like the publish draft of ./teams): gone after
// a restart, and after DRAFT_TTL_MS. Only the admin who made it can use it.
const drafts = new Map();
// The pickers of a form being filled: pickerId -> { userId, guildId, eventId (null: a new event), texts, pick, base, note, done, at }. Memory only, like the
// drafts: the text fields of the modal cannot ride in a customId. A restart / the TTL ends it with PICKER_EXPIRED; `done` = ✅ was taken (a double click
// does nothing).
const pickers = new Map();

function pruneDrafts(now = Date.now()) {
  for (const [id, d] of drafts) if (now - d.at > DRAFT_TTL_MS) drafts.delete(id);
}

// The draft of this admin (not expired, same guild) or null; `take` removes it (the one who takes it posts it: a double click posts once).
function getDraft(draftId, interaction, { take = false } = {}) {
  pruneDrafts();
  const d = drafts.get(String(draftId));
  if (!d || d.userId !== interaction.user.id || d.guildId !== interaction.guildId) return null;
  d.at = Date.now(); // every preview interaction keeps the draft alive
  if (take) drafts.delete(String(draftId));
  return d;
}

function getPicker(pickerId, interaction) {
  const now = Date.now();
  for (const [id, p] of pickers) if (now - p.at > PICKER_TTL_MS) pickers.delete(id);
  const p = pickers.get(String(pickerId));
  if (!p || p.userId !== interaction.user.id || p.guildId !== interaction.guildId) return null;
  p.at = now;
  return p;
}

async function loadEvent(interaction, eventId) {
  const event = await eventService.getEvent(eventId);
  return event && event.guildId === interaction.guildId ? event : null;
}

const isLive = (event) => event && (event.status === 'open' || event.status === 'locked');

// ---------- members ----------

// ev:rp:<eid>:<status>
async function onReply(interaction, eventId, status) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!eventService.REPLIES.includes(status)) return interaction.editReply(NOT_FOUND);
  const event = await loadEvent(interaction, eventId);
  if (!event) return interaction.editReply(NOT_FOUND);
  const ctx = { ...ixCtx(interaction), eid: eventId, status };
  if (event.status === 'cancelled') {
    logEvent('event', 'reply', { ...ctx, result: 'closed', why: 'cancelled' });
    return interaction.editReply(CANCELLED);
  }
  if (status === 'maybe' && event.allowMaybe === false) {
    logEvent('event', 'reply', { ...ctx, result: 'no_maybe' });
    return interaction.editReply('❓ Sự kiện này không có lựa chọn "Có thể". Bấm ✅ Tham gia hoặc ❌ Không.');
  }
  const res = await eventService.setReply({ event, discordId: interaction.user.id, displayName: displayNameOf(interaction), status, now: new Date() });
  if (!res.ok) {
    logEvent('event', 'reply', { ...ctx, result: res.reason });
    if (res.reason === 'full') {
      scheduleEventRefresh(interaction.client, event._id); // the card may still show a free seat
      return interaction.editReply(`⚠️ Đã đủ ${event.capacity} người tham gia.${event.allowMaybe === false ? '' : ' Bạn vẫn có thể chọn ❓ Có thể.'}`);
    }
    return interaction.editReply(CLOSED);
  }
  logEvent('event', 'reply', { ...ctx, result: 'ok', ...(res.seatFreed === false ? { seat: 'not_freed', lvl: 'warn' } : {}) });
  scheduleEventRefresh(interaction.client, event._id);
  scheduleSync(interaction.client, event.guildId);
  return interaction.editReply(`✅ Đã ghi nhận: **${eventService.REPLY_LABELS[status]}** — ${defang(event.title)}. Đổi được tới ${discordTs(new Date(event.deadlineAt), 'f')}.`);
}

// ev:ls:<eid> - who joins, in order of answer (names only, no mentions)
async function onList(interaction, eventId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const event = await loadEvent(interaction, eventId);
  if (!event) return interaction.editReply(NOT_FOUND);
  const replies = liveRegs(interaction.guild, await eventService.listReplies(event._id));
  const [first, ...rest] = buildListMessages(event, replies);
  await interaction.editReply({ content: first, allowedMentions: { parse: [] } });
  for (const content of rest) await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

// ev:rules:<eid> - the full description (the card shows it cut when it is long), split over messages, without mentions
async function onRules(interaction, eventId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const event = await loadEvent(interaction, eventId);
  if (!event) return interaction.editReply(NOT_FOUND);
  const [first, ...rest] = buildRulesMessages(event);
  await interaction.editReply({ content: first, allowedMentions: { parse: [] } });
  for (const content of rest) await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

// ---------- managers ----------

// ev:doc:<eid> (manager view): the event as a Word file, for the clicker only. Game names / classes as the 🎮 match knows them.
async function onDocx(interaction, eventId) {
  const event = await loadEvent(interaction, eventId);
  if (!event) return interaction.editReply(NOT_FOUND);
  const replies = liveRegs(interaction.guild, await eventService.listReplies(event._id));
  const gameNames = await loadGameNames(interaction.guild);
  const roster = await gameRoster.latest(interaction.guildId, 'members.name members.className').catch(() => null);
  const classes = new Map(((roster && roster.members) || []).map((m) => [m.name, m.className]));
  const { buffer, fileName } = await buildEventDocx({
    event,
    replies,
    gameNames,
    classOf: (name) => plainClass(classes.get(name) || '') || classes.get(name) || '',
    category: eventService.categoryOf(event),
    statusLabel: (eventService.STATUS_LABELS[event.status] || event.status).replace(/^\S+\s/, ''),
    guildName: interaction.guild ? interaction.guild.name : '',
  });
  logEvent('event', 'docx', { ...ixCtx(interaction), eid: String(event._id), replies: replies.length, bytes: buffer.length });
  return interaction.editReply({ content: `📄 **${defang(event.title)}**: ${replies.length} người trả lời.`, files: [new AttachmentBuilder(buffer, { name: fileName })], allowedMentions: { parse: [] } });
}

// The manager view of a guild (open / locked events with their numbers).
async function viewOf(guildId, opts = {}) {
  const events = await eventService.listManage(guildId);
  const counts = await eventService.countsFor(events.map((e) => e._id));
  return buildEventsView({ events, counts, ...opts });
}

// adm:events (the dashboard button; admin.js has gated and deferred it) -> the ephemeral "📅 Quản lý sự kiện".
async function openManage(interaction, src = null) {
  logEvent('event', 'manage_open', { ...ixCtx(interaction), ...(src ? { src } : {}) });
  return interaction.editReply(await viewOf(interaction.guildId));
}

const fieldsOf = (interaction) => {
  const get = (id) => interaction.fields.getTextInputValue(id) || '';
  const has = (id) => {
    try {
      interaction.fields.getTextInputValue(id);
      return true;
    } catch {
      return false; // getTextInputValue throws for a field the modal does not have
    }
  };
  const [category] = interaction.fields.getStringSelectValues('category'); // the select inside the modal
  // `time` only when the submitted modal has it (an old one): the new form picks the time afterwards
  return { title: get('title'), category: category || '', description: get('description'), ...(has('time') ? { time: get('time') } : {}), people: get('people') };
};

// The preview of a draft: the card as it will be posted + the toggles.
function previewOf(draftId, draft, config, note = null) {
  return buildEventPreview({ event: { _id: 'preview', guildId: draft.guildId, ...draft.value }, draftId, tag: draft.tag, allowMaybe: draft.allowMaybe, hasRole: Boolean(config.memberRoleId), note });
}

// The complete event value is known: show the preview (nothing is created yet).
async function showPreview(interaction, config, value) {
  pruneDrafts();
  const draftId = crypto.randomBytes(4).toString('hex');
  const draft = { userId: interaction.user.id, guildId: interaction.guildId, value, tag: false, allowMaybe: true, at: Date.now() };
  drafts.set(draftId, draft);
  return interaction.editReply(previewOf(draftId, draft, config));
}

const NO_CHANNEL = '⚠️ Chưa chọn kênh thông báo sự kiện. Dùng lệnh /setup trước.';

// The form was filled. No time field (the normal case): the date / time picker follows. A typed `time` (an old modal): the preview at once.
async function onNewSubmit(interaction, config) {
  const show = async (note, selectedId = null) => interaction.editReply(await viewOf(interaction.guildId, { selectedId, note }));
  const raw = fieldsOf(interaction);
  const { value, error } = raw.time === undefined ? eventService.parseEventFormTexts(raw) : eventService.parseEventForm(raw, new Date());
  if (error) {
    logEvent('event', 'create', { ...ixCtx(interaction), result: 'invalid' });
    return show(`❌ ${error}`);
  }
  if (!eventService.eventChannelOf(config)) return show(NO_CHANNEL);
  if (raw.time === undefined) return showPicker(interaction, value);
  return showPreview(interaction, config, value);
}

// ---------- the date / time picker: ev:pk:<picker>:<field> (select), ev:pkok | pkcancel:<picker> ----------

const PICKER_FIELDS = new Set(['day', 'hour', 'min', 'dur', 'dl']);

// The times of the picker, and why ✅ is off (null: it is on).
function pickerState(rec, now) {
  const times = eventService.pickTimes(rec.pick, rec.base);
  const existing = rec.base ? { startAt: rec.base.startAt, deadlineAt: rec.base.deadlineAt } : null; // an edit may keep a time that is already past
  return { times, error: eventService.checkPickTimes(times, now, existing) };
}

function pickerView(pickerId, rec, now = new Date()) {
  const { times, error } = pickerState(rec, now);
  return buildEventPicker({ draftId: pickerId, title: rec.texts.title, editing: Boolean(rec.eventId), pick: rec.pick, times, error, note: rec.note, now });
}

// The form's texts are valid: open the picker (`event` = the stored event of an edit: its times pre-select the nearest list values).
async function showPicker(interaction, texts, event = null) {
  const now = new Date();
  let pick;
  let base = null;
  let note = null;
  if (event) {
    const found = eventService.pickFromEvent(event);
    ({ pick, base } = found);
    if (!found.exact) note = 'ℹ️ Giờ hiện tại của sự kiện không có đúng trong các danh sách nên đã chọn giá trị gần nhất. Không đổi mục nào thì bot giữ nguyên giờ cũ.';
  } else {
    pick = eventService.defaultPick(now);
  }
  const pickerId = crypto.randomBytes(4).toString('hex');
  const rec = { userId: interaction.user.id, guildId: interaction.guildId, eventId: event ? String(event._id) : null, texts, pick, base, note, done: false, at: Date.now() };
  getPicker('', interaction); // (drops the expired ones)
  pickers.set(pickerId, rec);
  return interaction.editReply(pickerView(pickerId, rec, now));
}

const pickerExpired = async (interaction) => interaction.editReply(await viewOf(interaction.guildId, { note: PICKER_EXPIRED }));

// A select changed: store the value, redraw the same message with the new summary.
async function onPick(interaction, pickerId, field) {
  const rec = getPicker(pickerId, interaction);
  if (!rec) return pickerExpired(interaction);
  if (rec.done) return undefined;
  const now = new Date();
  const value = String((interaction.values || [])[0] ?? '');
  const valid = {
    day: () => eventService.pickDayOptions(now, rec.pick.day).some((o) => o.value === value),
    hour: () => /^\d{1,2}$/.test(value) && Number(value) <= 23,
    min: () => /^\d+$/.test(value) && eventService.PICK_MINUTES.includes(Number(value)),
    dur: () => eventService.PICK_KEYS.dur.includes(value),
    dl: () => eventService.PICK_KEYS.dl.includes(value),
  };
  if (PICKER_FIELDS.has(field) && valid[field]()) {
    rec.pick[field] = field === 'hour' || field === 'min' ? Number(value) : value;
    rec.note = null;
  }
  return interaction.editReply(pickerView(pickerId, rec, now));
}

// ✅ Tạo sự kiện (-> the preview of the new event) | ✅ Lưu (-> the event is updated).
async function onPickOk(interaction, config, pickerId) {
  const rec = getPicker(pickerId, interaction);
  if (!rec) return pickerExpired(interaction);
  if (rec.done) return undefined;
  const now = new Date();
  const { times, error } = pickerState(rec, now);
  if (error) return interaction.editReply(pickerView(pickerId, rec, now)); // (✅ is off then; this is a forced click or the time passed meanwhile)
  const value = { ...rec.texts, ...times };
  if (!rec.eventId) {
    if (!eventService.eventChannelOf(config)) {
      rec.note = NO_CHANNEL;
      return interaction.editReply(pickerView(pickerId, rec, now));
    }
    rec.done = true;
    return showPreview(interaction, config, value);
  }
  rec.done = true;
  const event = await loadEvent(interaction, rec.eventId);
  const show = async (note) => interaction.editReply(await viewOf(interaction.guildId, { selectedId: rec.eventId, note }));
  if (!event) return show(`❌ ${NOT_FOUND}`);
  if (!isLive(event)) return show(`❌ Sự kiện đã ${event.status === 'cancelled' ? 'huỷ' : 'kết thúc'}, không sửa được.`);
  return applyEdit(interaction, event, value);
}

// ↩ Huỷ
async function onPickCancel(interaction, pickerId) {
  const rec = getPicker(pickerId, interaction);
  if (rec) pickers.delete(String(pickerId));
  return interaction.editReply(await viewOf(interaction.guildId, { selectedId: rec && rec.eventId, note: `Đã huỷ, chưa ${rec && rec.eventId ? 'sửa' : 'tạo'} sự kiện nào.` }));
}

// ev:drtag | drmaybe (toggles) | drpost (📢 Đăng) | drcancel (Huỷ) : <draft>
async function onDraft(interaction, config, action, draftId) {
  const show = async (note) => interaction.editReply(await viewOf(interaction.guildId, { note }));
  const draft = getDraft(draftId, interaction, { take: action === 'drpost' || action === 'drcancel' });
  if (!draft) return show(DRAFT_EXPIRED);
  if (action === 'drcancel') return show('Đã huỷ bản nháp, chưa đăng gì.');
  if (action === 'drtag') {
    if (config.memberRoleId) draft.tag = !draft.tag;
    return interaction.editReply(previewOf(draftId, draft, config));
  }
  if (action === 'drmaybe') {
    draft.allowMaybe = !draft.allowMaybe;
    return interaction.editReply(previewOf(draftId, draft, config));
  }
  // drpost: the draft is ours alone now; a failure puts it back
  const back = async (note) => {
    drafts.set(String(draftId), draft);
    return interaction.editReply(previewOf(draftId, draft, config, note));
  };
  const cardChannelId = eventService.eventChannelOf(config);
  if (!cardChannelId) return back('⚠️ Chưa chọn kênh thông báo sự kiện. Dùng lệnh /setup trước.');
  const { value } = draft;
  const now = new Date();
  if (value.deadlineAt <= now || value.startAt <= now) {
    logEvent('event', 'create', { ...ixCtx(interaction), result: 'invalid', why: 'stale_draft' });
    return back(`❌ ${value.startAt <= now ? 'Giờ bắt đầu' : 'Hạn đăng ký'} đã qua trong lúc xem trước. Bấm ➕ Tạo sự kiện để nhập lại giờ mới.`);
  }
  const tagRoleId = draft.tag && config.memberRoleId ? config.memberRoleId : null;
  const event = await eventService.createEvent({ guildId: interaction.guildId, ...value, allowMaybe: draft.allowMaybe, createdBy: interaction.user.id });
  const info = { category: value.category, min: value.minParticipants, max: value.capacity, tag: Boolean(tagRoleId), allowMaybe: draft.allowMaybe };
  let posted;
  try {
    posted = await postEventCard(interaction.client, cardChannelId, event, { tagRoleId });
  } catch (err) {
    console.error('[events] post card:', err.message);
    logEvent('event', 'create', { ...ixCtx(interaction), result: 'error', stage: 'post', eid: String(event._id), ...info, err });
    await eventService.deleteEvent(event._id).catch((delErr) => console.error('[events] could not remove the unposted event:', delErr.message));
    return back(`❌ Không đăng được thẻ vào <#${cardChannelId}>. Kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn).`);
  }
  scheduleSync(interaction.client, interaction.guildId);
  logEvent('event', 'create', { ...ixCtx(interaction), result: 'created', eid: String(event._id), start: value.startAt.toISOString(), deadline: value.deadlineAt.toISOString(), ...info });
  return interaction.editReply(await viewOf(interaction.guildId, { selectedId: String(event._id), note: `✅ Đã tạo **${defang(value.title)}** và đăng ở ${eventService.messageLink(posted)}` }));
}

async function onEditSubmit(interaction, eventId) {
  const show = async (note) => interaction.editReply(await viewOf(interaction.guildId, { selectedId: eventId, note }));
  const event = await loadEvent(interaction, eventId);
  if (!event) return show(`❌ ${NOT_FOUND}`);
  if (!isLive(event)) return show(`❌ Sự kiện đã ${event.status === 'cancelled' ? 'huỷ' : 'kết thúc'}, không sửa được.`);
  const raw = fieldsOf(interaction);
  const { value, error } = raw.time === undefined ? eventService.parseEventFormTexts(raw) : eventService.parseEventForm(raw, new Date(), event);
  if (error) {
    logEvent('event', 'edit', { ...ixCtx(interaction), eid: eventId, result: 'invalid' });
    return show(`❌ ${error}`);
  }
  if (raw.time === undefined) return showPicker(interaction, value, event); // the times come from the picker
  return applyEdit(interaction, event, value);
}

// Save the edit of a live event (`value` = parseEventForm's value, or the picker's).
async function applyEdit(interaction, event, value) {
  const eventId = String(event._id);
  const show = async (note) => interaction.editReply(await viewOf(interaction.guildId, { selectedId: eventId, note }));
  const startChanged = new Date(event.startAt).getTime() !== value.startAt.getTime();
  const deadlineChanged = new Date(event.deadlineAt).getTime() !== value.deadlineAt.getTime();
  // a locked event given a deadline (and a start) still ahead is open again, like "⏳ Gia hạn": the shortfall notice may fire again at the new deadline
  const now = new Date();
  const reopen = event.status === 'locked' && deadlineChanged && value.deadlineAt > now && value.startAt > now;
  const same = (a, b) => (a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : (a ?? null) === (b ?? null));
  const changed = Object.keys(value).filter((k) => !same(value[k], event[k]));
  const minChanged = (event.minParticipants ?? null) !== value.minParticipants;
  const patch = { ...value, ...(minChanged || reopen ? { minNoticeAt: null } : {}), ...(reopen ? { status: 'open' } : {}) }; // a new minimum is judged again at the deadline
  const updated = await eventService.updateEvent(event._id, patch, { startChanged });
  if (!updated) return show('❌ Trạng thái sự kiện vừa thay đổi, hãy thử lại.');
  scheduleEventRefresh(interaction.client, event._id, 0);
  scheduleSync(interaction.client, event.guildId);
  logEvent('event', 'edit', { ...ixCtx(interaction), eid: eventId, result: 'saved', changed, ...(reopen ? { reopened: true } : {}) });
  const yes = (await eventService.countsOf(event._id)).yes;
  const over = value.capacity && yes > value.capacity ? `\n⚠️ Đang có ${yes} người ✅, nhiều hơn số tối đa mới: giữ nguyên, chỉ chặn người đăng ký thêm.` : '';
  return show(`✅ Đã sửa **${defang(value.title)}**.${reopen ? ' 🟢 Đã mở lại vì hạn mới còn ở tương lai.' : ''}${over}`);
}

async function onLock(interaction, eventId) {
  const show = async (note) => interaction.editReply(await viewOf(interaction.guildId, { selectedId: eventId, note }));
  const event = await loadEvent(interaction, eventId);
  if (!event) return show(`❌ ${NOT_FOUND}`);
  const now = new Date();
  let updated;
  let result;
  let note;
  if (event.status === 'open') {
    updated = await eventService.lockEvent(event._id);
    result = 'locked';
    note = `🔒 Đã chốt **${defang(event.title)}**: không nhận thêm trả lời.`;
  } else if (event.status === 'locked') {
    if (new Date(event.startAt) <= now) return show('❌ Sự kiện đã bắt đầu, không mở lại được.');
    const deadline = new Date(event.deadlineAt) > now ? new Date(event.deadlineAt) : new Date(event.startAt); // a passed deadline would lock it again at once
    updated = await eventService.reopenEvent(event._id, deadline);
    result = 'reopened';
    note = `🟢 Đã mở lại **${defang(event.title)}** (hạn: ${discordTs(deadline, 'f')}).`;
  } else {
    return show(`❌ Sự kiện đã ${event.status === 'cancelled' ? 'huỷ' : 'kết thúc'}, không chốt / mở lại được.`);
  }
  if (!updated) return show('❌ Trạng thái sự kiện vừa thay đổi, hãy thử lại.');
  scheduleEventRefresh(interaction.client, event._id, 0);
  scheduleSync(interaction.client, event.guildId);
  logEvent('event', 'lock', { ...ixCtx(interaction), eid: eventId, result, by: 'manual' });
  return show(note);
}

// The cancel shared by the confirm step and the shortfall notice: ONE atomic transition, the card turns grey at once, then the public notice
// (no mention). -> null when the status changed meanwhile, else { notice: 'sent' | 'failed' }.
async function cancelNow(interaction, event, via = null) {
  const updated = await eventService.cancelEvent(event._id);
  if (!updated) return null;
  await refreshEventCardNow(interaction.client, event._id);
  let notice = 'sent';
  try {
    const channel = await interaction.client.channels.fetch(event.channelId);
    await channel.send({ content: `❌ Sự kiện **${defang(event.title)}** đã huỷ.`, allowedMentions: { parse: [] } });
  } catch (err) {
    notice = 'failed';
    console.error('[events] cancel notice:', err.message);
  }
  scheduleSync(interaction.client, event.guildId);
  const counts = await eventService.countsOf(event._id);
  logEvent('event', 'cancel', { ...ixCtx(interaction), eid: String(event._id), ...counts, notice, ...(via ? { via } : {}), ...(notice === 'failed' ? { lvl: 'warn' } : {}) });
  return { notice };
}

// ev:cancel:<eid> (confirm step) | ev:cancelok:<eid>
async function onCancel(interaction, eventId, send) {
  const show = async (opts) => interaction.editReply(await viewOf(interaction.guildId, { selectedId: eventId, ...opts }));
  const event = await loadEvent(interaction, eventId);
  if (!event) return show({ note: `❌ ${NOT_FOUND}` });
  if (!isLive(event)) return show({ note: `❌ Sự kiện đã ${event.status === 'cancelled' ? 'huỷ' : 'kết thúc'} rồi.` });
  if (!send) return show({ confirm: 'cancel' });
  const res = await cancelNow(interaction, event);
  if (!res) return show({ note: '❌ Trạng thái sự kiện vừa thay đổi, hãy thử lại.' });
  return show({ note: `✅ Đã huỷ **${defang(event.title)}**.${res.notice === 'failed' ? ' ⚠️ Chưa báo được trong kênh (thiếu quyền?).' : ''}` });
}

// ev:maybe:<eid> - the manager view's "❓ Có thể: bật / tắt": the card gets / loses its ❓ button (answers already given stay)
async function onToggleMaybe(interaction, eventId) {
  const show = async (note) => interaction.editReply(await viewOf(interaction.guildId, { selectedId: eventId, note }));
  const event = await loadEvent(interaction, eventId);
  if (!event) return show(`❌ ${NOT_FOUND}`);
  if (!isLive(event)) return show(`❌ Sự kiện đã ${event.status === 'cancelled' ? 'huỷ' : 'kết thúc'}, không sửa được.`);
  const allowMaybe = event.allowMaybe === false;
  const updated = await eventService.updateEvent(event._id, { allowMaybe });
  if (!updated) return show('❌ Trạng thái sự kiện vừa thay đổi, hãy thử lại.');
  scheduleEventRefresh(interaction.client, event._id, 0);
  logEvent('event', 'edit', { ...ixCtx(interaction), eid: eventId, result: 'saved', changed: ['allowMaybe'], allowMaybe });
  return show(`✅ ❓ Có thể: **${allowMaybe ? 'bật' : 'tắt'}** cho **${defang(event.title)}**.${allowMaybe ? '' : ' Ai đã chọn ❓ vẫn nằm trong danh sách.'}`);
}

// ---------- the shortfall notice (admin channel): ev:mincancel | minkeep | minext:<eid>, modal ev:minextModal:<eid> ----------

// Each button edits the notice itself (deferred update) to show who decided; a problem is an ephemeral line to the clicker.
async function onMinDecision(interaction, eventId, decision) {
  const say = (text) => interaction.followUp(eph(text));
  const event = await loadEvent(interaction, eventId);
  if (!event) return say(NOT_FOUND);
  const counts = await eventService.countsOf(event._id);
  const settle = (text, e = event) => interaction.editReply(buildMinNotice(e, counts, text));
  const who = `<@${interaction.user.id}>`;
  const log = (extra) => logEvent('event', 'min_decision', { ...ixCtx(interaction), eid: String(event._id), decision, yes: counts.yes, min: event.minParticipants, ...extra });
  if (!isLive(event)) {
    log({ result: 'closed' });
    return settle(`Sự kiện đã ${event.status === 'cancelled' ? 'huỷ' : 'kết thúc'}, không cần xử lý nữa.`);
  }
  if (decision === 'keep') {
    log({ result: 'ok' });
    return settle(`✅ Vẫn tổ chức · ${who} quyết định ${discordTs(new Date(), 'R')}`);
  }
  const res = await cancelNow(interaction, event, 'min_notice');
  if (!res) return say('❌ Trạng thái sự kiện vừa thay đổi, hãy thử lại.');
  log({ result: 'ok', notice: res.notice });
  return settle(`❌ Đã huỷ sự kiện · ${who} quyết định ${discordTs(new Date(), 'R')}${res.notice === 'failed' ? ' · chưa báo được trong kênh' : ''}`);
}

// The "⏳ Gia hạn" modal was submitted: the event opens again with the new deadline, and a later shortfall notifies again.
async function onMinExtend(interaction, eventId) {
  const say = (text) => interaction.followUp(eph(text));
  const event = await loadEvent(interaction, eventId);
  if (!event) return say(NOT_FOUND);
  const log = (extra) => logEvent('event', 'min_decision', { ...ixCtx(interaction), eid: String(event._id), decision: 'extend', min: event.minParticipants, ...extra });
  if (!isLive(event)) {
    log({ result: 'closed' });
    return say(`Sự kiện đã ${event.status === 'cancelled' ? 'huỷ' : 'kết thúc'}, không gia hạn được.`);
  }
  const { deadlineAt, error } = eventService.parseExtendDeadline(interaction.fields.getTextInputValue('deadline'), event, new Date());
  if (error) {
    log({ result: 'invalid' });
    return say(`❌ ${error}`);
  }
  const updated = await eventService.extendEvent(event._id, deadlineAt);
  if (!updated) return say('❌ Trạng thái sự kiện vừa thay đổi, hãy thử lại.');
  await refreshEventCardNow(interaction.client, event._id); // the card is open again
  scheduleSync(interaction.client, event.guildId);
  const counts = await eventService.countsOf(event._id);
  log({ result: 'ok', deadline: deadlineAt.toISOString(), yes: counts.yes });
  return interaction.editReply(buildMinNotice(updated, counts, `⏳ Đã gia hạn tới ${discordTs(deadlineAt, 'f')} · <@${interaction.user.id}>`));
}

// ev:remind:<eid> (confirm step) | ev:remindok:<eid>: ONE reminder pinging only the ✅ and ❓ people, after an atomic cooldown claim.
async function onRemind(interaction, config, eventId, send) {
  const show = async (opts) => interaction.editReply(await viewOf(interaction.guildId, { selectedId: eventId, ...opts }));
  const event = await loadEvent(interaction, eventId);
  if (!event) return show({ note: `❌ ${NOT_FOUND}` });
  if (!isLive(event)) return show({ note: `❌ Sự kiện đã ${event.status === 'cancelled' ? 'huỷ' : 'kết thúc'}, không nhắc nữa.` });
  if (!send) return show({ confirm: 'remind' });
  const key = String(event._id);
  if (reminding.has(key)) return show({ note: '⏳ Đang gửi nhắc cho sự kiện này, đợi chút.' });
  reminding.add(key);
  try {
    const now = new Date();
    const claim = await eventService.claimManualRemind(event._id, now);
    if (!claim.claimed) {
      logEvent('event', 'remind', { ...ixCtx(interaction), eid: key, mode: 'manual', result: 'cooldown', at: claim.at ? new Date(claim.at).toISOString() : undefined });
      return show({ note: `⏳ Vừa nhắc${claim.at ? ` ${discordTs(new Date(claim.at), 'R')}` : ''}, đợi ${REMIND_COOLDOWN_MIN} phút.` });
    }
    const ids = eventService.remindTargets(await eventService.listReplies(event._id));
    if (!ids.length) {
      await eventService.releaseManualRemind(event._id, now).catch(() => {});
      return show({ note: 'Chưa có ai bấm ✅ hoặc ❓ để nhắc.' });
    }
    const channelId = event.channelId || eventService.eventChannelOf(config);
    const link = eventService.messageLink(event);
    const header = `📣 **${defang(event.title)}** — nhắc tham gia, bắt đầu ${discordTs(new Date(event.startAt), 'R')}.${link ? ` ${link}` : ''}`;
    const messages = eventService.buildRemindMessages(header, ids);
    let sent = 0;
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      for (const m of messages) {
        await channel.send({ content: m.content, allowedMentions: { users: m.users } }); // exactly these users: nothing else in the text can ping
        sent++;
      }
    } catch (err) {
      console.error('[events] manual remind:', err.message);
      logEvent('event', 'remind', { ...ixCtx(interaction), eid: key, mode: 'manual', result: 'failed', pinged: ids.length, sent, messages: messages.length, err });
      if (sent === 0) await eventService.releaseManualRemind(event._id, now).catch(() => {}); // nothing went out: do not burn the cooldown
      return show({ note: `❌ Không gửi được vào <#${channelId}>. Kiểm tra quyền của bot. ${sent ? `Chỉ ${sent}/${messages.length} tin đã gửi.` : 'Chưa có tin nào được gửi.'}` });
    }
    logEvent('event', 'remind', { ...ixCtx(interaction), eid: key, mode: 'manual', result: 'sent', pinged: ids.length, sent, messages: messages.length });
    return show({ note: `✅ Đã nhắc ${ids.length} người (✅ và ❓) ở <#${channelId}>.` });
  } finally {
    reminding.delete(key);
  }
}

// Same gate as the dashboard: Manage Server needs no DB; the manager roles come from the (cached) config. -> the config or null.
async function adminConfig(interaction) {
  if (isAdmin(interaction.member, null, interaction.memberPermissions)) return getConfigOrDefault(interaction.guildId);
  const config = await getConfigOrDefault(interaction.guildId);
  return isAdmin(interaction.member, config, interaction.memberPermissions) ? config : null;
}

const TIMED_OUT = Symbol('timed out');
// The promise's value, or TIMED_OUT after `ms` (the work itself is not cancelled; its result is dropped).
function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A modal must open within 3 s of the click, so nothing here may wait on a slow DB: Manage Server is decided from the interaction alone and
// opens the empty form at once; everything else (manager roles from the config, the event to prefill) gets MODAL_FETCH_MS, then "Thử lại"
// (an expired interaction would only show "this interaction failed"). The submit checks everything again.
async function openModal(interaction, action, eventId) {
  const retry = () => interaction.reply(eph('⏳ Máy chủ phản hồi chậm, bấm lại sau vài giây nhé.'));
  const needsEvent = action === 'edit' || action === 'minext';
  const direct = isAdmin(interaction.member, null, interaction.memberPermissions); // Manage Server: no DB for the gate
  if (direct && !needsEvent) return interaction.showModal(action === 'pnew' ? buildEventModal().setCustomId('ev:pnewModal') : buildEventModal()); // its submit is a new ephemeral reply (the panel stays as it is)
  const got = await within(Promise.all([direct ? null : adminConfig(interaction), needsEvent ? loadEvent(interaction, eventId) : null]), MODAL_FETCH_MS).catch((err) => {
    console.error('[events] modal gate:', err.message);
    return TIMED_OUT;
  });
  if (got === TIMED_OUT) return retry();
  const [config, event] = got;
  if (!direct && !config) return interaction.reply(eph(NO_PERMISSION));
  if (!needsEvent) return interaction.showModal(action === 'pnew' ? buildEventModal().setCustomId('ev:pnewModal') : buildEventModal());
  if (!isLive(event)) return interaction.reply(eph(event ? `Sự kiện đã huỷ hoặc kết thúc, không ${action === 'minext' ? 'gia hạn' : 'sửa'} được.` : NOT_FOUND));
  return interaction.showModal(action === 'minext' ? buildExtendModal(event) : buildEventModal(event));
}

async function handleAdmin(interaction, action, eventId, arg) {
  if (OPENS_MODAL.has(action)) return openModal(interaction, action, eventId);
  // The manager view is an ephemeral message: a modal submit from it edits it in place too.
  const fromMessage = typeof interaction.isFromMessage === 'function' && interaction.isFromMessage();
  if (NEW_EPHEMERAL.has(action) || (SUBMITS.has(action) && !fromMessage)) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  const config = await adminConfig(interaction);
  if (!config) return interaction.followUp(eph(NO_PERMISSION));
  switch (action) {
    case 'pick':
      return interaction.editReply(await viewOf(interaction.guildId, { selectedId: (interaction.values || [])[0] }));
    case 'sel':
      return interaction.editReply(await viewOf(interaction.guildId, { selectedId: eventId }));
    case 'pmanage':
      return openManage(interaction, 'panel');
    case 'newModal':
    case 'pnewModal':
      return onNewSubmit(interaction, config);
    case 'editModal':
      return onEditSubmit(interaction, eventId);
    case 'pk':
      return onPick(interaction, eventId, arg); // (the 3rd part is the picker id, the 4th the field)
    case 'pkok':
      return onPickOk(interaction, config, eventId);
    case 'pkcancel':
      return onPickCancel(interaction, eventId);
    case 'lock':
      return onLock(interaction, eventId);
    case 'cancel':
    case 'cancelok':
      return onCancel(interaction, eventId, action === 'cancelok');
    case 'remind':
    case 'remindok':
      return onRemind(interaction, config, eventId, action === 'remindok');
    case 'maybe':
      return onToggleMaybe(interaction, eventId);
    case 'drtag':
    case 'drmaybe':
    case 'drpost':
    case 'drcancel':
      return onDraft(interaction, config, action, eventId); // (the 3rd part is the draft id)
    case 'mincancel':
      return onMinDecision(interaction, eventId, 'cancel');
    case 'minkeep':
      return onMinDecision(interaction, eventId, 'keep');
    case 'minextModal':
      return onMinExtend(interaction, eventId);
    case 'doc':
      return onDocx(interaction, eventId);
    default:
      return undefined;
  }
}

async function handle(interaction, parts) {
  const [, action, eventId, arg] = parts;
  if (action === 'rp') return onReply(interaction, eventId, arg);
  if (action === 'ls') return onList(interaction, eventId);
  if (action === 'rules') return onRules(interaction, eventId);
  if (ADMIN_ACTIONS.has(action)) return handleAdmin(interaction, action, eventId, arg);
  return undefined;
}

module.exports = { handle };
