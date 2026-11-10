// The bot's status line under its name: "Báo danh 27/60 · T7 14/11 20:00" while a war is open, "Bang chiến T7 14/11 20:00 · 27 người"
// once it is locked, nothing otherwise. A bot has ONE status for all its servers: the war that starts soonest is shown.
// Fed by the refresher (it already holds the event and its registrations), so this module reads no DB. A presence update is a gateway
// command with its own rate limit: at most one per MIN_GAP_MS, the latest text wins. Nothing here throws.
const { ActivityType } = require('discord.js');
const { toLocalParts } = require('../utils/time');
const { eventStats } = require('./eventStats');

const MIN_GAP_MS = 60 * 1000;
const STALE_MS = 6 * 3600 * 1000; // a war that started this long ago is over, whatever was last heard of it (e.g. it was deleted)
const DAY_NAMES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const pad = (n) => String(n).padStart(2, '0');

const wars = new Map(); // guildId -> { text, startAt } of its unfinished war
let shown = null; // the text last sent to Discord (null = no status)
let lastSentAt = 0;
let timer = null;

// "T7 14/11 20:00" (the guild's local time).
function whenText(startAt) {
  const p = toLocalParts(new Date(startAt));
  return `${DAY_NAMES[p.dow]} ${pad(p.day)}/${pad(p.month + 1)} ${pad(p.hour)}:${pad(p.minute)}`;
}

// The status of one war (pure), or null when it is not worth one (finished, or no event).
function textFor(event, regs, config) {
  if (!event || event.status === 'done') return null;
  const stats = eventStats(event, regs || [], config);
  const when = whenText(event.startAt);
  return event.status === 'open' ? `Báo danh ${stats.join}/${stats.capacity} · ${when}` : `Bang chiến ${when} · ${stats.join} người`;
}

// The text to show now: the war starting soonest; wars long past are dropped.
function current(now = Date.now()) {
  let best = null;
  for (const [guildId, w] of wars) {
    if (now - w.startAt > STALE_MS) wars.delete(guildId);
    else if (!best || w.startAt < best.startAt) best = w;
  }
  return best ? best.text : null;
}

function send(client) {
  const text = current();
  if (text === shown || !client || !client.user) return;
  try {
    client.user.setPresence({ activities: text ? [{ name: text, state: text, type: ActivityType.Custom }] : [] });
    shown = text;
    lastSentAt = Date.now();
  } catch (err) {
    console.warn('[presence]', err.message);
  }
}

// Called with what the refresher just read. Updates the status now, or once the gap since the last update has passed.
function note(client, event, regs, config) {
  if (!event || !event.guildId) return;
  try {
    const text = textFor(event, regs, config);
    if (text) wars.set(event.guildId, { text, startAt: new Date(event.startAt).getTime() });
    else wars.delete(event.guildId);
  } catch (err) {
    console.warn('[presence]', err.message);
    return;
  }
  if (timer) return; // a pending update will read the newest text
  const wait = lastSentAt + MIN_GAP_MS - Date.now();
  if (wait <= 0) return send(client);
  timer = setTimeout(() => {
    timer = null;
    send(client);
  }, wait);
  if (timer.unref) timer.unref();
}

function reset() {
  wars.clear();
  shown = null;
  lastSentAt = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { note, textFor, whenText, reset, MIN_GAP_MS };
