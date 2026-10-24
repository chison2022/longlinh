// Edits the approval card of a gate request in the admin channel (also when nobody pressed a button: the member left).
// The card's text is read back from the message and rebuilt, so the original facts stay. Never throws.
const { messageTexts } = require('./ui/departNotice');
const { logEvent } = require('../eventLog');

// build(texts) -> edit payload. -> true when the card was edited.
async function editCard(client, request, build) {
  if (!request || !request.adminChannelId || !request.adminMessageId) return false;
  try {
    const channel = await client.channels.fetch(request.adminChannelId);
    const message = await channel.messages.fetch(request.adminMessageId);
    await message.edit(build(messageTexts(message)));
    return true;
  } catch (err) {
    console.warn(`[gate] cannot edit the card of ${request._id}:`, err.message);
    logEvent('gate', 'card_failed', { guild: request.guildId, rid: String(request._id), err, lvl: 'warn' });
    return false;
  }
}

module.exports = { editCard };
