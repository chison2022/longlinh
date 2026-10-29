const { ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, FileUploadBuilder, StringSelectMenuBuilder } = require('discord.js');
const { formatSettings } = require('../../services/guildConfigService');
const defaults = require('../../../config/defaults');
const { formatLocalDateTime } = require('../../utils/time');
const eventService = require('../../services/eventService');
const { plainClass } = require('../../services/lineupStyle');

function textField(id, label, { description, style = TextInputStyle.Short, value, required = true, maxLength, placeholder } = {}) {
  const input = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required);
  if (maxLength) input.setMaxLength(maxLength);
  if (placeholder) input.setPlaceholder(placeholder);
  if (value) input.setValue(String(value));
  const field = new LabelBuilder().setLabel(label).setTextInputComponent(input);
  if (description) field.setDescription(description);
  return field;
}

function buildSettingsModal(config, styles) {
  const v = formatSettings(config, styles);
  return new ModalBuilder()
    .setCustomId('adm:settingsModal')
    .setTitle('Cài đặt bang chiến')
    .addLabelComponents(
      textField('classes', 'Môn phái (mỗi dòng 1 phái)', {
        style: TextInputStyle.Paragraph,
        value: v.classes,
        maxLength: 2000,
        description: 'Emoji server hiện sau tên (:TY:). Đổi: sửa :ten_emoji:, bỏ emoji: :none:',
      }),
      textField('groupCount', `Số nhóm (mỗi nhóm ${defaults.partiesPerGroup} PT × ${defaults.partySize})`, { value: v.groupCount, maxLength: 1, description: '1-4 nhóm' }),
      textField('war', 'Lịch đánh (vd: T7 20:00)', { value: v.war, maxLength: 20, description: 'CN, T2 … T7 + giờ (giờ Việt Nam)' }),
      textField('open', 'Tự mở đăng ký (vd: T2 00:00)', {
        value: v.open,
        required: false,
        maxLength: 20,
        description: 'Để trống = tắt tự động tạo bang chiến',
      }),
      textField('timing', 'Hạn chốt / nhắc (giờ, vd: 2/3)', {
        value: v.timing,
        maxLength: 20,
        description: 'Chốt trước giờ đánh 2 tiếng / nhắc trước hạn chốt 3 tiếng (0 = không nhắc)',
      })
    );
}

// `values` = { deadline, war } strings: deadline prefill and the war window shown in the field description
function buildCreateModal(values) {
  return new ModalBuilder()
    .setCustomId('adm:createModal')
    .setTitle('Tạo bang chiến')
    .addLabelComponents(
      textField('deadline', 'Hạn chốt đăng ký (dd/mm HH:mm)', {
        value: values.deadline,
        maxLength: 20,
        description: values.war ? `Giờ Việt Nam. Bang chiến: ${values.war}` : 'Giờ Việt Nam, vd: 25/12 18:00',
      })
    );
}

// One .xlsx of the in-game member list (sheet "Thành viên"); the file is read from the attachment on submit.
function buildGameUploadModal() {
  return new ModalBuilder()
    .setCustomId('adm:gameupModal')
    .setTitle('Cập nhật thành viên game')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('File danh sách (.xlsx)')
        .setDescription('Sheet "Thành viên" như file mẫu (tải bằng nút 📥). Tối đa 2 MB.')
        .setFileUploadComponent(new FileUploadBuilder().setCustomId('file').setMinValues(1).setMaxValues(1).setRequired(true))
    );
}

// The lineup link the admins published (their own Google Sheet or any page) + an optional note for the announcement.
function buildPublishModal(event) {
  return new ModalBuilder()
    .setCustomId(`tm:pubModal:${event._id}`)
    .setTitle('Công bố đội hình')
    .addLabelComponents(
      textField('url', 'Link đội hình (Google Sheet…)', { value: event.lineupUrl && event.lineupUrl.length <= 500 ? event.lineupUrl : undefined, maxLength: 500, placeholder: 'https://docs.google.com/spreadsheets/…', description: 'Link tab đội hình bạn đã chia. Nhớ chia sẻ "Bất kỳ ai có liên kết: Người xem".' }),
      textField('note', 'Ghi chú (không bắt buộc)', { style: TextInputStyle.Paragraph, value: event.lineupNote && event.lineupNote.length <= 800 ? event.lineupNote : undefined, required: false, maxLength: 800, description: 'Hiện trong bài thông báo, vd: giờ tập trung, kênh voice' })
    );
}

// The spreadsheet the bot feeds with the registrations: a link or just its id.
function buildSheetModal(config) {
  return new ModalBuilder()
    .setCustomId('adm:sheetModal')
    .setTitle('Google Sheet của bang')
    .addLabelComponents(
      textField('sheetId', 'Link hoặc ID Google Sheet', { value: config.sheetId, required: false, maxLength: 300, description: 'Bot ghi các tab ThanhVien, BangChien_TuanNay, BangChien_LichSu, SuKien. Để trống = tắt.' })
    );
}

// The "Loại sự kiện" select of the event form (a string select inside a modal, read back with fields.getStringSelectValues('category')).
function categorySelect(current) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('category')
    .setPlaceholder('Chọn loại sự kiện')
    .setRequired(true)
    .addOptions(
      Object.entries(defaults.eventCategories).map(([key, c]) => ({ label: `${c.emoji} ${c.label}`, value: key, default: key === current }))
    );
  return new LabelBuilder().setLabel('Loại sự kiện').setStringSelectMenuComponent(select);
}

// "15-32" · "15-" · "20" (max only) · '' (see eventService.parsePeopleField)
const peopleValue = (event) => (event.minParticipants ? `${event.minParticipants}-${event.capacity || ''}` : event.capacity ? String(event.capacity) : '');

// The create / edit form of a guild event (ev:newModal / ev:editModal:<eid>), four fields: name, category (select), description / rules,
// people (min-max). The time is NOT typed: the next step is the date / time picker (see ./eventPicker). `event` = the stored event to prefill, or null.
function buildEventModal(event = null) {
  return new ModalBuilder()
    .setCustomId(event ? `ev:editModal:${event._id}` : 'ev:newModal')
    .setTitle(event ? 'Sửa sự kiện' : 'Tạo sự kiện')
    .addLabelComponents(
      textField('title', 'Tên sự kiện', { value: event && event.title, maxLength: 100, description: 'Bước tiếp theo: chọn ngày giờ bằng danh sách.' }),
      categorySelect(event ? eventService.categoryOf(event).key : defaults.eventCategoryDefault),
      textField('description', 'Mô tả / thể lệ (không bắt buộc)', { style: TextInputStyle.Paragraph, value: event && event.description, required: false, maxLength: eventService.DESCRIPTION_MAX, description: 'Xuống dòng và **in đậm** dùng được. Không tag được ai.' }),
      textField('people', 'Số người: tối thiểu-tối đa', { value: event ? peopleValue(event) : undefined, required: false, maxLength: 12, placeholder: '15-32', description: '15-32 · 15- (chỉ tối thiểu) · -20 hoặc 20 (chỉ tối đa) · trống = không giới hạn' })
    );
}

// The "⏳ Gia hạn" form of the shortfall notice (ev:minextModal:<eid>): one new deadline.
function buildExtendModal(event) {
  return new ModalBuilder()
    .setCustomId(`ev:minextModal:${event._id}`)
    .setTitle('Gia hạn đăng ký')
    .addLabelComponents(
      textField('deadline', 'Hạn đăng ký mới (dd/mm HH:mm)', { maxLength: 20, placeholder: '15/10 20:00', description: `Giờ Việt Nam, phải trước giờ bắt đầu (${formatLocalDateTime(new Date(event.startAt))})` })
    );
}

// The "⚙️ Ngưỡng" form (adm:offcfgModal): after each game roster import the managers are told who has been offline this many days or more;
// the second field is the wanted number of official members (the dashboard says to recruit below it).
function buildOffWarnModal(config) {
  const current = config && Number.isInteger(config.offWarnDays) ? config.offWarnDays : 5;
  const target = config && Number.isInteger(config.rosterTarget) ? config.rosterTarget : defaults.rosterTarget;
  return new ModalBuilder()
    .setCustomId('adm:offcfgModal')
    .setTitle('Ngưỡng cảnh báo và quân số')
    .addLabelComponents(
      textField('days', 'Báo off lâu: số ngày (0 = tắt)', { value: String(current), maxLength: 2, description: 'Cập nhật danh sách game xong, bot báo quản lý người off từ ngần này ngày. Mặc định 5.' }),
      textField('target', 'Mục tiêu quân số chính thức', { value: String(target), maxLength: 2, description: `1-${defaults.officialCap}. Dưới mức này bảng điều khiển báo nên mở tuyển. Mặc định ${defaults.rosterTarget}.` })
    );
}

// ➕ Thêm tên game (adm:gameaddModal): a character the last import does not have yet (joined in game since). classes = config.classes.
function buildGameAddModal(classes) {
  return new ModalBuilder()
    .setCustomId('adm:gameaddModal')
    .setTitle('Thêm tên game')
    .addLabelComponents(
      textField('name', 'Tên nhân vật trong game', { maxLength: 32, description: 'Gõ đúng như trong game. Lần cập nhật danh sách sau sẽ thay bằng dữ liệu thật.' }),
      formSelect('cls', 'Phái', classes.slice(0, 25).map((c, i) => [String(i), plainClass(c) || c]), null, 'Chọn phái…'),
      formSelect('rank', 'Cấp bậc', [['Học Việc', 'Học Việc'], ['Bang Chúng', 'Bang Chúng']], 'Học Việc')
    );
}

// 🆔 ID game (adm:gameuidModal): a manager sets the in-game ID of a character; empty ID = remove it.
function buildGameUidModal() {
  return new ModalBuilder()
    .setCustomId('adm:gameuidModal')
    .setTitle('ID game của nhân vật')
    .addLabelComponents(
      textField('name', 'Tên nhân vật', { maxLength: 32, description: 'Nhân vật đang trong danh sách game.' }),
      textField('uid', 'ID game (để trống = xoá)', { required: false, maxLength: 20, description: 'Chỉ chữ số, 5 đến 20 số.' })
    );
}

// 📄 Google Doc of the events (setup:evdocModal): the link of a Doc the managers shared (Editor) with the bot; empty = disconnect.
function buildEventDocModal(config, botEmail) {
  return new ModalBuilder()
    .setCustomId('setup:evdocModal')
    .setTitle('Google Doc sự kiện')
    .addLabelComponents(
      textField('link', 'Link Google Doc (để trống = ngắt)', {
        value: config.eventDocId ? `https://docs.google.com/document/d/${config.eventDocId}/edit` : undefined,
        required: false,
        maxLength: 300,
        placeholder: 'https://docs.google.com/document/d/…/edit',
        description: `Tạo 1 Google Doc trống, chia sẻ quyền Người chỉnh sửa cho ${botEmail || 'email của bot'}. Bot sẽ GHI ĐÈ toàn bộ Doc.`.slice(0, 100),
      })
    );
}

// A string select inside a form (read back with fields.getStringSelectValues(id)); `current` is preselected.
function formSelect(id, label, options, current, placeholder) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder(placeholder || label)
    .setRequired(true)
    .addOptions(options.map(([value, text]) => ({ label: text, value, default: value === current })));
  return new LabelBuilder().setLabel(label).setStringSelectMenuComponent(select);
}

module.exports = { buildOffWarnModal, buildEventModal, buildExtendModal, buildPublishModal, buildSheetModal, buildSettingsModal, buildCreateModal, buildGameUploadModal, buildGameAddModal, buildGameUidModal, buildEventDocModal };
