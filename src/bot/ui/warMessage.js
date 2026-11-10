const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ContainerBuilder,
  SectionBuilder,
} = require('discord.js');
const defaults = require('../../../config/defaults');
const { sameClass, summarize, groupNamesByClass, makeCanon, UNKNOWN_CLASS } = require('../../services/registrationService');
const { warEnd } = require('../../services/warService');
const { discordTs } = require('../../utils/time');
const { truncate, packGroups, paginateFields, textDisplay, separator, v2Payload, TK_MARK, TK_LEGEND } = require('./common');
const { styleOf, optionEmoji, initials, classCodes } = require('../classStyle');
const { ROLE_OPTIONS, normalizeRole } = require('../../services/missions');
const { eventStats, progressBar, missingLine } = require('../eventStats');
const { linkButton, parseLineupUrl } = require('./lineupLink');
const { isOn } = require('../../services/features');

const COLORS = { open: 0x2ecc71, locked: 0xe67e22, published: 0x3498db, done: 0x95a5a6 };
const STATUS_LINES = {
  open: (deadline) => `🟢 Đang mở · chốt ${discordTs(deadline, 'R')}`,
  locked: () => '🔒 Đã chốt',
  published: () => '📢 Đã công bố',
  done: () => '⚫ Đã kết thúc',
};

// "💊 TV": the class emoji and a short code (initials of the plain name: Tố Vấn -> TV, Thiết Y -> TY). A class without an emoji
// of its own falls back to a bare bullet, which says nothing: its plain name is shown there instead ("• Tên").
const classMark = (style, codes) => (style.emojiText === '•' ? `• ${style.plain}` : `${style.emojiText} ${(codes && codes.get(style.plain)) || initials(style.plain) || style.plain}`);

// The public war message: ONE Components V2 container (accent colour = status). `config` = { classes, schedule, groupCount }.
// `styles` = Map from resolveClassStyles (optional: without it a class shows its own unicode emoji).
// `unregistered` = members with the member role who have not registered (null = unknown: that part is left out).
// Returns the EDIT payload (content/embeds cleared, V2 flag, no mentions); use v2Create() from ui/common for channel.send.
function buildWarMessage(event, regs, config, styles, { unregistered = null } = {}) {
  const cfg = config || {};
  const stats = eventStats(event, regs, cfg, { unregistered });
  const eid = String(event._id);
  const open = event.status === 'open';
  const start = new Date(event.startAt);
  const deadline = new Date(event.deadlineAt);
  const statusLine = (STATUS_LINES[event.status] || (() => event.status))(deadline);
  const button = (id, label, style, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  const section = (content, accessory) => new SectionBuilder().addTextDisplayComponents(textDisplay(content)).setButtonAccessory(accessory);

  const joinLine = `✅ **${stats.join}**/${stats.capacity} đi  ${progressBar(stats.join, stats.capacity)}`;
  const absentLine = `❌ ${stats.absent} vắng${stats.unregistered === null ? '' : ` · ⏳ ${stats.unregistered} chưa đăng ký`}`;
  const codes = classCodes(cfg.classes || defaults.classes); // two classes with the same initials get different codes
  const classLine = stats.byClass.length
    ? stats.byClass.map((c) => `${classMark(styleOf(styles, c.className), codes)} ${c.count}`).join('  ')
    : '_Chưa có ai đăng ký._';
  const info = [classLine, ...stats.missing.map(missingLine)].join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(COLORS[event.status] ?? COLORS.done)
    .addTextDisplayComponents(
      textDisplay(`### ⚔️ ${truncate(event.title, 200)}\n${statusLine}\n🕗 ${discordTs(start, 'f')} – ${discordTs(warEnd(start, cfg.schedule), 't')}`)
    )
    .addSeparatorComponents(separator())
    .addSectionComponents(
      section(joinLine, button(`war:st:${eid}:join`, '✅ Tham gia', ButtonStyle.Success, !open)),
      section(absentLine, button(`war:st:${eid}:absent`, '❌ Vắng', ButtonStyle.Danger, !open))
    )
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(textDisplay(info))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        button(`war:chg:${eid}`, '🎭 Phái của tôi', ButtonStyle.Secondary),
        button(`war:list:${eid}`, '📋 Danh sách', ButtonStyle.Secondary),
        ...(isOn(cfg, 'tuyenKhien') ? [button(`war:tk:${eid}`, `${TK_MARK} Tuyến Khiên`, ButtonStyle.Secondary)] : []),
        button(`war:mis:${eid}`, '🎯 Vai trò', ButtonStyle.Secondary),
        ...((event.status === 'published' || event.status === 'done') && parseLineupUrl(event.lineupUrl) ? [linkButton(parseLineupUrl(event.lineupUrl), '📊 Đội hình')] : [])
      )
    );
  if (open) container.addTextDisplayComponents(textDisplay(`-# Đổi được tới ${discordTs(deadline, 't')} ${discordTs(deadline, 'd')}`));
  return v2Payload([container]);
}

const namesInOrder = (regs, className, canon) =>
  regs
    .filter((r) => r.status !== 'absent' && (r.className ? canon(r.className) : UNKNOWN_CLASS) === className)
    .map((r) => r.displayName || r.discordId);

// Name list per class. Long classes continue in "<class> (tiếp)" fields and, when one embed is not
// enough, in further embeds; no name is ever cut. Returns an array of embeds (group with toMessages).
// `tk` = { groups } (optional): people of a confirmed Tuyến Khiên group get a marker after the name.
function buildListEmbeds(event, regs, classes, styles, tk) {
  const linked = new Set(((tk && tk.groups) || []).flat());
  if (linked.size) regs = regs.map((r) => (linked.has(r.discordId) ? { ...r, displayName: `${r.displayName || r.discordId} ${TK_MARK}` } : r));
  const s = summarize(regs, classes);
  const label = (className) => `${styleOf(styles, className).emojiText} ${styleOf(styles, className).plain}`;
  const canon = makeCanon(classes);
  const fields = groupNamesByClass(regs, classes).flatMap((g) => {
    const names = namesInOrder(regs, g.className, canon); // registration order
    return packGroups([{ items: names }]).map((c, i) => ({ name: i ? `${label(g.className)} (tiếp)` : `${label(g.className)} (${names.length})`, value: c.text }));
  });
  const absent = regs.filter((r) => r.status === 'absent').map((r) => r.displayName || r.discordId);
  if (absent.length) {
    packGroups([{ items: absent }]).forEach((c, i) => fields.push({ name: i ? '❌ Vắng (tiếp)' : `❌ Vắng (${absent.length})`, value: c.text }));
  }
  const title = truncate(`📋 ${event.title}`, 256);
  const description = `✅ Tham gia: **${s.join}** · ❌ Vắng: **${s.absent}**${linked.size ? `
${TK_LEGEND}` : ''}`;
  const pages = paginateFields(fields, title.length + description.length + 12, title.length + 12);
  return pages.map((page, i) => {
    const embed = new EmbedBuilder()
      .setTitle(pages.length > 1 ? truncate(`${title} (${i + 1}/${pages.length})`, 256) : title)
      .setColor(COLORS[event.status] || COLORS.done)
      .addFields(page);
    if (i === 0) embed.setDescription(description);
    return embed;
  });
}

// `customId` = war:cls:<eid>:<status|->
// Option value = the class name (its identity); label = plain name when the emoji goes in the option emoji, else the full
// class name (so a marker that is not a valid option emoji is not lost). `noEmoji` drops every option emoji (retry path).
function buildClassSelect(customId, classes, current, styles, { noEmoji = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Chọn môn phái')
      .addOptions(
        classes.slice(0, 25).map((c) => {
          const st = styleOf(styles, c);
          const emoji = noEmoji ? undefined : optionEmoji(st);
          return { label: truncate(emoji ? st.plain : c, 100), value: c, default: current != null && sameClass(c, current), ...(emoji ? { emoji } : {}) };
        })
      )
  );
}

// `customId` = war:mispick:<eid>; `current` = the saved role (an older mid / mobile / supply shows as its new role), preselected.
function buildMissionSelect(customId, current) {
  const now = normalizeRole(current);
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Chọn vai trò của bạn')
      .addOptions(ROLE_OPTIONS.map((o) => ({ ...o, default: o.value === now })))
  );
}

module.exports = { buildWarMessage, buildListEmbeds, buildClassSelect, buildMissionSelect };
