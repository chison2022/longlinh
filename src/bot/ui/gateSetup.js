// The ✏️ Lời chào modal of /setup → 🚪 Cổng vào: the guild name on the member button and the member welcome text.
// A text equal to the built-in default (or empty) is stored as null, so the default keeps following the configured channels.
const { ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const gateService = require('../../services/gateService');

function buildWelcomeModal(config, guild) {
  const input = (id, style, max, value, extra = {}) => {
    const t = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(false).setMaxLength(max);
    if (value) t.setValue(String(value).slice(0, max));
    if (extra.placeholder) t.setPlaceholder(extra.placeholder);
    return t;
  };
  return new ModalBuilder()
    .setCustomId('setup:gatewelcomeModal')
    .setTitle('Lời chào cổng vào')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Tên bang (hiện trên nút Thành viên)')
        .setDescription('Để trống = tên server.')
        .setTextInputComponent(input('guildName', TextInputStyle.Short, gateService.MAX_GUILD_NAME, config.gateGuildName, { placeholder: (guild && guild.name) || '' })),
      new LabelBuilder()
        .setLabel('Lời chào gửi thành viên mới được duyệt')
        .setDescription('Gửi qua tin nhắn riêng. Xoá hết = dùng bản mặc định.')
        .setTextInputComponent(input('member', TextInputStyle.Paragraph, gateService.MAX_WELCOME_MEMBER, gateService.welcomeMemberText(config, guild)))
    );
}

// -> { guildName, member } (null = default)
function readWelcomeModal(fields, guild, config = {}) {
  const get = (id) => String(fields.getTextInputValue(id) || '').trim();
  const name = get('guildName');
  const member = get('member');
  return {
    guildName: !name || (guild && name === guild.name) ? null : name.slice(0, gateService.MAX_GUILD_NAME),
    member: !member || member === gateService.defaultWelcomeMember(config, guild) ? null : member.slice(0, gateService.MAX_WELCOME_MEMBER),
  };
}

module.exports = { buildWelcomeModal, readWelcomeModal };
