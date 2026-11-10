// UI of the guild events: the public card (Components V2, buttons ev:rp / ev:ls), the ephemeral manager view "📅 Quản lý sự kiện" and the
// list of answers, the preview of a new event and the shortfall notice. customIds: ev:rp:<eid>:<yes|maybe|no> · ev:ls:<eid> · ev:rules:<eid> (card)
// · ev:pick (select) · ev:sel|edit|lock|cancel|cancelok|remind|remindok|maybe:<eid> · ev:new (manager view) · ev:drtag|drmaybe|drpost|drcancel:<draft>
// (preview) · ev:mincancel|minext|minkeep:<eid> (shortfall notice).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ContainerBuilder, escapeMarkdown } = require('discord.js');
const { discordTs, formatLocalDateTime } = require('../../utils/time');
const { V2_TEXT_LIMIT, truncate, packGroups, textDisplay, separator, v2Payload } = require('./common');
const { defang } = require('../../services/mailService');
const eventService = require('../../services/eventService');

const COLORS = { open: 0x1abc9c, locked: 0xe67e22, cancelled: 0x7f8c8d, done: 0x95a5a6 };
const MANAGE_COLOR = 0x9b59b6;

const button = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);

// "✅ 12/20 tham gia · cần ít nhất 15 · ❓ 3 có thể · ❌ 5 không" (the /20 only with a capacity, the minimum only when set, ❓ only when allowed)
function countsLine(event, counts) {
  const c = counts || { yes: 0, maybe: 0, no: 0 };
  const cap = event.capacity ? `/${event.capacity}` : '';
  const min = event.minParticipants ? ` · cần ít nhất ${event.minParticipants}` : '';
  const maybe = event.allowMaybe === false ? '' : ` · ❓ ${c.maybe} có thể`;
  return `✅ **${c.yes}**${cap} tham gia${min}${maybe} · ❌ ${c.no} không`;
}

// The line under the counts: "⚠️ Còn thiếu 6 người" (only while open, unless `anyStatus`) / "✅ Đã đủ tối thiểu"; null without a minimum.
function minLine(event, counts, { anyStatus = false } = {}) {
  if (!event.minParticipants) return null;
  const missing = eventService.shortfallOf(event, counts);
  if (!missing) return '✅ Đã đủ tối thiểu';
  return anyStatus || event.status === 'open' ? `⚠️ Còn thiếu ${missing} người` : null;
}

const isFull = (event, counts) => Boolean(event.capacity) && counts && counts.yes >= event.capacity;

function statusLine(event, counts) {
  if (event.status === 'open') return `🟢 Đang mở · hạn ${discordTs(new Date(event.deadlineAt), 'R')}${isFull(event, counts) ? ' · đã đủ người' : ''}`;
  if (event.status === 'locked') return '🔒 Đã chốt';
  if (event.status === 'cancelled') return '❌ Đã huỷ';
  return '⚫ Đã kết thúc';
}

function timeLine(event) {
  const start = new Date(event.startAt);
  return `🕗 ${discordTs(start, 'f')} (${discordTs(start, 'R')})${event.endAt ? ` – ${discordTs(new Date(event.endAt), 't')}` : ''}`;
}

const RULES_HINT = '… (xem đầy đủ: 📋 Thể lệ)';
const CARD_MARGIN = 60; // text kept free for the one-time role tag of the post (see refresher.postEventCard)

// The description for the card: defanged (no mention, no masked link; line breaks and markdown stay), cut to `budget` chars with a hint to the
// 📋 Thể lệ button when it does not fit. A cut inside a code block closes it. -> { text, truncated }
function fitDescription(description, budget) {
  const text = defang(String(description || '')).trim();
  if (text.length <= budget) return { text, truncated: false };
  const room = Math.max(0, budget - RULES_HINT.length - 5);
  let cut = '';
  for (const ch of Array.from(text)) {
    if (cut.length + ch.length > room) break;
    cut += ch;
  }
  cut = cut.trimEnd();
  const openFence = (cut.match(/```/g) || []).length % 2 === 1;
  return { text: `${cut}${openFence ? '\n```\n' : ''}${RULES_HINT}`, truncated: true };
}

// The public event card: ONE V2 container, accent = status. `counts` = { yes, maybe, no }. Answer buttons are off unless the event is open;
// 📋 always works; ❓ is left out when the event does not allow it; 📋 Thể lệ shows when the description had to be cut to fit the 4000-char
// text budget of a V2 message. `preview` = every button off (the manager's preview), `reserve` = more text to keep free.
// Returns the EDIT payload; use v2Create() from ui/common for channel.send.
function buildEventCard(event, counts, { preview = false, reserve = 0 } = {}) {
  const eid = String(event._id);
  const open = event.status === 'open';
  const cancelled = event.status === 'cancelled';
  const cat = eventService.categoryOf(event);
  const title = truncate(event.title, 100);
  const headFixed = `### ${cancelled ? `~~${cat.emoji} ${title}~~` : `${cat.emoji} ${title}`}\n-# ${cat.emoji} ${cat.label}`;
  const info = [timeLine(event), statusLine(event, counts), countsLine(event, counts), minLine(event, counts)].filter(Boolean).join('\n');
  const footer = open ? `-# Đổi được tới ${discordTs(new Date(event.deadlineAt), 'f')}` : '';
  const budget = V2_TEXT_LIMIT - CARD_MARGIN - reserve - headFixed.length - 1 - info.length - footer.length;
  const desc = event.description ? fitDescription(event.description, budget) : { text: '', truncated: false };
  const off = !open || preview;

  const buttons = [button(`ev:rp:${eid}:yes`, '✅ Tham gia', ButtonStyle.Success, off)];
  if (event.allowMaybe !== false) buttons.push(button(`ev:rp:${eid}:maybe`, '❓ Có thể', ButtonStyle.Secondary, off));
  buttons.push(button(`ev:rp:${eid}:no`, '❌ Không', ButtonStyle.Danger, off), button(`ev:ls:${eid}`, '📋 Danh sách', ButtonStyle.Secondary, preview));
  if (desc.truncated) buttons.push(button(`ev:rules:${eid}`, '📋 Thể lệ', ButtonStyle.Secondary, preview));

  const container = new ContainerBuilder()
    .setAccentColor(COLORS[event.status] ?? COLORS.done)
    .addTextDisplayComponents(textDisplay(desc.text ? `${headFixed}\n${desc.text}` : headFixed))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(textDisplay(info))
    .addActionRowComponents(row(...buttons));
  if (footer) container.addTextDisplayComponents(textDisplay(footer));
  return v2Payload([container]);
}

// Splits text into pieces of at most `limit` chars at line breaks (a longer line is cut at a code-point boundary).
function splitText(text, limit) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    let rest = line;
    while (rest.length > limit) {
      if (cur !== null) out.push(cur);
      cur = null;
      let cut = limit;
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (cur !== null && cur.length + 1 + rest.length > limit) {
      out.push(cur);
      cur = rest;
    } else cur = cur === null ? rest : `${cur}\n${rest}`;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// The full description for the ephemeral 📋 Thể lệ button: messages of at most 1900 chars, defanged (sent without mentions too).
function buildRulesMessages(event, limit = 1900) {
  const head = `📋 **Thể lệ: ${escapeMarkdown(defang(truncate(event.title, 100)))}**`;
  const body = defang(event.description || '').trim();
  if (!body) return [`${head}\n_Sự kiện này chưa có mô tả / thể lệ._`];
  return splitText(`${head}\n${body}`, limit);
}

// ---------- preview of a new event (before it is posted) ----------

const onOff = (flag) => (flag ? 'bật' : 'tắt');

// The ephemeral preview: the card (buttons off) + the options. `event` = the draft as an event object, `draftId` = the key of the draft (ev:dr*:<id>),
// `tag` / `allowMaybe` = the toggles, `hasRole` = a member role is configured (else the tag button is off), `note` = a line at the top.
function buildEventPreview({ event, draftId, tag = false, allowMaybe = true, hasRole = true, note = null }) {
  const card = buildEventCard({ ...event, allowMaybe, status: 'open' }, { yes: 0, maybe: 0, no: 0 }, { preview: true, reserve: 600 });
  const tagOn = tag && hasRole;
  const lines = [
    `🔔 Tag role thành viên: **${onOff(tagOn)}**`,
    `❓ Có thể: **${onOff(allowMaybe)}**`,
    hasRole ? '-# Chỉ tag role một lần lúc đăng, không tag khi sửa thẻ.' : '-# Chưa chọn role thành viên trong /setup nên chưa tag được.',
  ];
  const options = new ContainerBuilder()
    .setAccentColor(MANAGE_COLOR)
    .addTextDisplayComponents(textDisplay(lines.join('\n')))
    .addActionRowComponents(
      row(
        button(`ev:drtag:${draftId}`, `🔔 Tag role thành viên: ${onOff(tagOn)}`, tagOn ? ButtonStyle.Success : ButtonStyle.Secondary, !hasRole),
        button(`ev:drmaybe:${draftId}`, `❓ Có thể: ${onOff(allowMaybe)}`, allowMaybe ? ButtonStyle.Success : ButtonStyle.Secondary)
      ),
      row(button(`ev:drpost:${draftId}`, '📢 Đăng', ButtonStyle.Primary), button(`ev:drcancel:${draftId}`, 'Huỷ'))
    );
  return v2Payload([textDisplay(`### 👁️ Xem trước · chưa đăng${note ? `\n${note}` : ''}`), ...card.components, options]);
}

// ---------- shortfall notice (admin channel) ----------

// "Sự kiện chưa đủ người" with ❌ Huỷ sự kiện / ⏳ Gia hạn / ✅ Vẫn tổ chức. `decision` (text) replaces the buttons once somebody decided.
// Sent with v2Create: no mention in it can ping.
function buildMinNotice(event, counts, decision = null) {
  const c = counts || { yes: 0, maybe: 0, no: 0 };
  const eid = String(event._id);
  const link = eventService.messageLink(event);
  const lines = [
    `### ⚠️ Sự kiện chưa đủ người: ${esc(truncate(event.title, 80))}`,
    `✅ ${c.yes} / cần ${event.minParticipants}${decision ? '' : ` · hạn đã hết ${discordTs(new Date(event.deadlineAt), 'R')}`}`,
  ];
  if (link) lines.push(link);
  if (decision) lines.push(`**${decision}**`);
  const container = new ContainerBuilder().setAccentColor(decision ? COLORS.done : 0xf1c40f).addTextDisplayComponents(textDisplay(lines.join('\n')));
  if (!decision) {
    container.addActionRowComponents(
      row(button(`ev:mincancel:${eid}`, '❌ Huỷ sự kiện', ButtonStyle.Danger), button(`ev:minext:${eid}`, '⏳ Gia hạn', ButtonStyle.Primary), button(`ev:minkeep:${eid}`, '✅ Vẫn tổ chức', ButtonStyle.Success))
    );
  }
  return v2Payload([container]);
}

// Names in order of answer, ✅ then ❓ then ❌ (ephemeral, sent without mentions). Display names are user text: defanged + escaped.
// -> an array of messages (each ≤ 2000 chars): a long list continues in the next one with the section prefix repeated.
function buildListMessages(event, replies) {
  const names = (status) => replies.filter((r) => r.status === status).map((r) => escapeMarkdown(defang(r.displayName || r.discordId)));
  const yes = names('yes');
  const sections = [
    { prefix: `✅ **Tham gia** (${yes.length}${event.capacity ? `/${event.capacity}` : ''}): `, items: yes },
    { prefix: '', items: names('maybe') },
    { prefix: '', items: names('no') },
  ];
  sections[1].prefix = `❓ **Có thể** (${sections[1].items.length}): `;
  sections[2].prefix = `❌ **Không** (${sections[2].items.length}): `;
  const head = `📋 **${escapeMarkdown(defang(truncate(event.title, 100)))}** · ${eventService.STATUS_LABELS[event.status] || event.status}`;
  const chunks = packGroups(sections.filter((s) => s.items.length), 1800);
  if (!chunks.length) return [`${head}\n_Chưa có ai trả lời._`];
  return chunks.map((c, i) => (i ? c.text : `${head}\n${c.text}`));
}

const esc = (text) => escapeMarkdown(defang(String(text))).replace(/[[\]]/g, '');

// One line per event of the manager view: category emoji, title, time, status, numbers (+ the shortfall of a minimum).
function eventLine(event, counts) {
  const link = eventService.messageLink(event);
  const title = truncate(esc(event.title), 60);
  const c = counts || { yes: 0, maybe: 0, no: 0 };
  const cap = event.capacity ? `/${event.capacity}` : '';
  const missing = eventService.shortfallOf(event, c);
  return `${eventService.categoryOf(event).emoji} ${link ? `[${title}](${link})` : title} · ${discordTs(new Date(event.startAt), 'f')} · ${eventService.STATUS_LABELS[event.status] || event.status} · ✅ ${c.yes}${cap} · ❓ ${c.maybe} · ❌ ${c.no}${missing ? ` · ⚠️ thiếu ${missing}` : ''}`;
}

const MAX_LISTED = 10;

// The ephemeral manager view. `events` = open / locked events (soonest first), `counts` = Map eventId -> { yes, maybe, no },
// `selectedId` = the picked one (its buttons show), `confirm` = 'cancel' | 'remind' replaces its buttons with a confirm step, `note` = result line.
function buildEventsView({ events = [], counts = new Map(), selectedId = null, confirm = null, note = null } = {}) {
  const countOf = (e) => counts.get(String(e._id)) || { yes: 0, maybe: 0, no: 0 };
  const selected = events.find((e) => String(e._id) === String(selectedId)) || null;
  const lines = ['### 📅 Quản lý sự kiện'];
  if (note) lines.push(note);
  if (!events.length) lines.push('_Chưa có sự kiện nào đang mở._ Bấm **➕ Tạo sự kiện**.');
  else {
    lines.push(...events.slice(0, MAX_LISTED).map((e) => `• ${eventLine(e, countOf(e))}`));
    if (events.length > MAX_LISTED) lines.push(`… và ${events.length - MAX_LISTED} sự kiện nữa (chọn trong danh sách bên dưới)`);
  }
  const container = new ContainerBuilder().setAccentColor(MANAGE_COLOR).addTextDisplayComponents(textDisplay(lines.join('\n')));

  if (events.length) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ev:pick')
          .setPlaceholder('Chọn sự kiện để quản lý')
          .addOptions(
            events.slice(0, 25).map((e) => ({
              label: truncate(`${eventService.categoryOf(e).emoji} ${e.title}`, 100),
              value: String(e._id),
              description: truncate(`${formatLocalDateTime(new Date(e.startAt))} · ✅ ${countOf(e).yes}${e.capacity ? `/${e.capacity}` : ''} · ${eventService.STATUS_LABELS[e.status] || e.status}`, 100),
              default: selected ? String(e._id) === String(selected._id) : false,
            }))
          )
      )
    );
  }
  container.addActionRowComponents(row(button('ev:new', '➕ Tạo sự kiện', ButtonStyle.Primary)));

  if (selected) {
    const eid = String(selected._id);
    const c = countOf(selected);
    container.addSeparatorComponents(separator());
    if (confirm === 'cancel') {
      container.addTextDisplayComponents(textDisplay(`❌ Huỷ sự kiện **${esc(truncate(selected.title, 80))}**? Thẻ sẽ chuyển sang "Đã huỷ" và bot báo trong kênh.`));
      container.addActionRowComponents(row(button(`ev:cancelok:${eid}`, '✅ Huỷ sự kiện', ButtonStyle.Danger), button(`ev:sel:${eid}`, '↩ Quay lại')));
    } else if (confirm === 'remind') {
      container.addTextDisplayComponents(textDisplay(`📣 Nhắc **${c.yes + c.maybe}** người (✅ ${c.yes} · ❓ ${c.maybe}) về **${esc(truncate(selected.title, 80))}** trong kênh sự kiện?`));
      container.addActionRowComponents(row(button(`ev:remindok:${eid}`, '✅ Gửi nhắc', ButtonStyle.Success, c.yes + c.maybe === 0), button(`ev:sel:${eid}`, '↩ Quay lại')));
    } else {
      const link = eventService.messageLink(selected);
      const cat = eventService.categoryOf(selected);
      container.addTextDisplayComponents(textDisplay([`**${esc(truncate(selected.title, 80))}**`, `${cat.emoji} ${cat.label}`, timeLine(selected), statusLine(selected, c), countsLine(selected, c), minLine(selected, c, { anyStatus: true })].filter(Boolean).join('\n')));
      container.addActionRowComponents(
        row(
          button(`ev:edit:${eid}`, '✏️ Sửa'),
          selected.status === 'locked' ? button(`ev:lock:${eid}`, '🟢 Mở lại', ButtonStyle.Success) : button(`ev:lock:${eid}`, '🔒 Chốt'),
          button(`ev:cancel:${eid}`, '❌ Huỷ sự kiện', ButtonStyle.Danger),
          button(`ev:remind:${eid}`, '📣 Nhắc', ButtonStyle.Primary)
        )
      );
      const second = [button(`ev:ls:${eid}`, '📋 Danh sách'), button(`ev:doc:${eid}`, '📄 Xuất Word'), button(`ev:maybe:${eid}`, `❓ Có thể: ${onOff(selected.allowMaybe !== false)}`)];
      if (link) second.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🔗 Link bài').setURL(link));
      container.addActionRowComponents(row(...second));
    }
  }
  return v2Payload([container]);
}

module.exports = { COLORS, RULES_HINT, esc, countsLine, statusLine, fitDescription, buildEventCard, buildRulesMessages, buildEventPreview, buildMinNotice, buildListMessages, buildEventsView };
