// Which feature a button / select / modal belongs to, and the answer an old message gets once that feature is switched off (see services/features.js).
// Only MEMBER-facing entry points (and the manager screens opened from the dashboard) are gated. The cards managers already got
// (a pending gate request, a letter, an event shortfall notice, the event panel) keep working so pending things can still be resolved.
const { MessageFlags } = require('discord.js');
const { isOn } = require('../services/features');
const { getConfigOrDefault } = require('../services/guildConfigService');

const OFF_TEXT = 'Tính năng này đang tắt — nhờ quản lý bật trong /setup → 🧩 Tính năng.';
const GATE_OFF_TEXT = '🚪 Cổng vào đang tắt, hãy nhờ quản lý.';

const set = (...a) => new Set(a);
// customId prefix -> { feature, actions } (actions = null: every action of the prefix)
const RULES = {
  war: { feature: 'tuyenKhien', actions: set('tk', 'tkpick', 'tkcarry', 'tkclear') },
  ev: { feature: 'events', actions: set('rp', 'ls', 'rules') }, // the event panel and the manager view stay
  mb: { feature: 'mailbox', actions: set('open', 'cat', 'anon', 'named', 'sendModal', 'view', 'codeModal') }, // seen / done / reply / replyModal are the manager's card
  gate: { feature: 'gate', actions: set('member', 'guest', 'swguest', 'back', 'p', 'pick', 'free', 'freeModal', 'cls', 'send', 'gst', 'gyes', 'gback') }, // ok / no / noModal / rv / rvModal / tg are the approval card
};

// -> the feature key a customId needs to be on, or null when it is not gated (core features, manager cards).
function featureOf(customId) {
  const [prefix, action] = String(customId || '').split(':');
  const rule = RULES[prefix];
  if (!rule) return null;
  return !rule.actions || rule.actions.has(action) ? rule.feature : null;
}

// -> the ephemeral payload to answer with when the customId belongs to a switched-off feature, else null. Never throws (a config
// read that fails lets the click through: the handler has its own checks).
async function offReply(interaction) {
  const feature = featureOf(interaction.customId);
  if (!feature) return null;
  let config;
  try {
    config = await getConfigOrDefault(interaction.guildId);
  } catch (err) {
    console.error('[featureGate] config:', err.message);
    return null;
  }
  if (isOn(config, feature)) return null;
  return { content: feature === 'gate' ? GATE_OFF_TEXT : OFF_TEXT, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

module.exports = { featureOf, offReply, OFF_TEXT, GATE_OFF_TEXT };
