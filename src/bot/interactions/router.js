const { MessageFlags } = require('discord.js');
const setupCommand = require('../commands/setup');
const { logEvent, parseCustomId } = require('../../eventLog');
const { offReply } = require('../featureGate');

const commands = new Map([[setupCommand.data.name, setupCommand]]);

// customId prefix -> handler(interaction, parts)
const handlers = {
  setup: require('./setup').handle,
  war: require('./war').handle,
  adm: require('./admin').handle,
  tm: require('./teams').handle,
  gn: require('./gameName').handle,
  mb: require('./mailbox').handle,
  ev: require('./events').handle,
  gate: require('./gate').handle,
};

async function replyError(interaction) {
  if (!interaction.isRepliable()) return;
  const payload = { content: '❌ Có lỗi xảy ra, vui lòng thử lại.', flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (err) {
    console.error('[router] could not send error reply:', err.message);
  }
}

const SLOW_MS = 2500; // Discord wants the first answer within 3 s

// button / select / modal / command, from whichever type guards the interaction has
function kindOf(interaction) {
  const is = (name) => typeof interaction[name] === 'function' && interaction[name]();
  if (is('isChatInputCommand')) return 'command';
  if (is('isModalSubmit')) return 'modal';
  if (is('isButton')) return 'button';
  if (is('isAnySelectMenu') || is('isStringSelectMenu')) return 'select';
  return 'other';
}

// ONE ix.done line per interaction: what was clicked, how long it took, whether it failed (err.code 10062 = answered too late,
// 50013 = missing permissions). Never throws.
function logDone(interaction, ms, err) {
  try {
    // Mailbox: NO ix.done line at all. Even without the user, "mb:sendModal at 20:03:11.402" next to the Discord audit trail or a
    // member's own claim of when they clicked would tie a sender to a letter. A failure leaves one line with the error only.
    if (String(interaction.customId || '').startsWith('mb:')) {
      if (err) logEvent('mail', 'error', { guild: interaction.guildId, err });
      return;
    }
    const id = interaction.customId ? parseCustomId(interaction.customId) : { action: `cmd:${interaction.commandName}` };
    logEvent('ix', 'done', {
      kind: kindOf(interaction),
      action: id.action,
      arg: id.arg,
      eid: id.eid,
      guild: interaction.guildId,
      user: interaction.user && interaction.user.id,
      ms,
      slow: ms > SLOW_MS || undefined,
      outcome: err ? 'error' : 'ok',
      replied: Boolean(interaction.replied),
      deferred: Boolean(interaction.deferred),
      err,
    });
  } catch {
    /* logging must never break an interaction */
  }
}

async function routeInteraction(interaction) {
  const started = Date.now();
  let failure;
  let failedAfter; // the handler's own time, not counting the error reply
  try {
    if (!interaction.inGuild()) {
      if (interaction.isRepliable()) await interaction.reply({ content: 'Bot chỉ dùng trong máy chủ.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (command) await command.execute(interaction);
      return;
    }
    if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      const parts = interaction.customId.split(':');
      const handler = handlers[parts[0]];
      if (handler) {
        const off = await offReply(interaction); // an old button of a switched-off feature: told so, nothing else happens
        if (off) await interaction.reply(off);
        else await handler(interaction, parts);
      }
    }
  } catch (err) {
    failure = err;
    failedAfter = Date.now() - started;
    const mailbox = String(interaction.customId || '').startsWith('mb:');
    if (mailbox) console.error('[router] mailbox interaction failed:', err && err.message); // no customId (a letter no.), no stack
    else console.error(`[router] ${interaction.customId || interaction.commandName}:`, err);
    await replyError(interaction);
  } finally {
    logDone(interaction, failedAfter === undefined ? Date.now() - started : failedAfter, failure);
  }
}

module.exports = { routeInteraction, commands };
