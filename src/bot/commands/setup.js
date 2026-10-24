const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } = require('discord.js');
const { getOrCreateConfig } = require('../../services/guildConfigService');
const { isAdmin } = require('../permissions');
const { setupView } = require('../interactions/setup');
const { NO_PERMISSION } = require('../interactions/common');

const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Cài đặt bot bang hội: kênh thông báo, kênh admin, role')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild);

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const config = await getOrCreateConfig(interaction.guildId);
  if (!isAdmin(interaction.member, config, interaction.memberPermissions)) return interaction.editReply(NO_PERMISSION);
  return interaction.editReply(await setupView(interaction, config));
}

module.exports = { data, execute };
