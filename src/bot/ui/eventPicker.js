// The date / time picker of the event form (the modal has no date field): one ephemeral V2 message with how-to text, five select menus
// (day, hour, minute, duration, registration deadline) and ✅ / ↩. customIds: ev:pk:<draft>:<day|hour|min|dur|dl> (the selects) ·
// ev:pkok:<draft> (✅ Tạo sự kiện / ✅ Lưu) · ev:pkcancel:<draft> (↩ Huỷ). Handlers in ../interactions/events.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ContainerBuilder } = require('discord.js');
const { textDisplay, v2Payload } = require('./common');
const eventService = require('../../services/eventService');
const { esc } = require('./eventCard');

const PICKER_COLOR = 0x9b59b6;

const row = (...components) => new ActionRowBuilder().addComponents(...components);

function select(id, placeholder, options, current) {
  return row(
    new StringSelectMenuBuilder()
      .setCustomId(id)
      .setPlaceholder(placeholder)
      .addOptions(options.map((o) => ({ label: o.label, value: o.value, default: String(o.value) === String(current) })))
  );
}

// `pick` = { day, hour, min, dur, dl }; `times` = eventService.pickTimes(pick); `error` = why ✅ is off (null: fine); `note` = a line of its own
// (e.g. "the stored time is not in the lists"). `editing` turns ✅ Tạo sự kiện into ✅ Lưu.
function buildEventPicker({ draftId, title, editing = false, pick, times, error = null, note = null, now = new Date() }) {
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));
  const minutes = eventService.PICK_MINUTES.map((m) => ({ value: String(m), label: `:${String(m).padStart(2, '0')}` }));
  const durations = eventService.PICK_DURATIONS.map(([value, label]) => ({ value, label }));
  const deadlines = eventService.PICK_DEADLINES.map(([value, label]) => ({ value, label }));
  const go = editing ? '✅ Lưu' : '✅ Tạo sự kiện';
  const guide = [
    `### 📅 Chọn thời gian cho sự kiện **${esc(title).slice(0, 100)}**`,
    '1. Chọn **ngày**, **giờ** và **phút** bắt đầu.',
    '2. Chọn sự kiện **kéo dài** bao lâu.',
    '3. Chọn **hạn đăng ký** (mặc định: đến lúc bắt đầu).',
    `Dòng → bên dưới cập nhật ngay sau mỗi lần chọn. Kiểm tra lại rồi bấm **${go}**.`,
    '-# Giờ Việt Nam. Bấm ↩ Huỷ để bỏ.',
  ];
  const summary = [eventService.pickSummary(times, now)];
  if (error) summary.push(`⚠️ ${error}`);
  if (note) summary.push(note);
  const container = new ContainerBuilder()
    .setAccentColor(PICKER_COLOR)
    .addTextDisplayComponents(textDisplay(guide.join('\n')), textDisplay('📅 **Ngày**'))
    .addActionRowComponents(select(`ev:pk:${draftId}:day`, 'Chọn ngày diễn ra…', eventService.pickDayOptions(now, pick.day), pick.day))
    .addTextDisplayComponents(textDisplay('🕗 **Giờ bắt đầu**'))
    .addActionRowComponents(select(`ev:pk:${draftId}:hour`, 'Chọn giờ bắt đầu…', hours, pick.hour))
    .addTextDisplayComponents(textDisplay('⏱ **Phút**'))
    .addActionRowComponents(select(`ev:pk:${draftId}:min`, 'Chọn phút bắt đầu…', minutes, pick.min))
    .addTextDisplayComponents(textDisplay('⌛ **Kéo dài**'))
    .addActionRowComponents(select(`ev:pk:${draftId}:dur`, 'Chọn thời lượng…', durations, pick.dur))
    .addTextDisplayComponents(textDisplay('📝 **Hạn đăng ký**'))
    .addActionRowComponents(select(`ev:pk:${draftId}:dl`, 'Chọn hạn đăng ký…', deadlines, pick.dl))
    .addTextDisplayComponents(textDisplay(summary.join('\n')))
    .addActionRowComponents(
      row(
        new ButtonBuilder().setCustomId(`ev:pkok:${draftId}`).setLabel(go).setStyle(ButtonStyle.Success).setDisabled(Boolean(error)),
        new ButtonBuilder().setCustomId(`ev:pkcancel:${draftId}`).setLabel('↩ Huỷ').setStyle(ButtonStyle.Secondary)
      )
    );
  return v2Payload([container]);
}

module.exports = { buildEventPicker };
