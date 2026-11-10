// Keeps the public war message in sync with the DB.
const defaults = require('../../config/defaults');
const warService = require('../services/warService');
const { listRegistrations } = require('../services/registrationService');
const { getConfig, defaultConfig, updateConfig, clearPanelIf, listPanelConfigs } = require('../services/guildConfigService');
const gameRosterService = require('../services/gameRosterService');
const { buildWarMessage } = require('./ui/warMessage');
const { buildPanel } = require('./ui/panel');
const headcountService = require('../services/headcountService');
const eventService = require('../services/eventService');
const { buildEventCard } = require('./ui/eventCard');
const { buildEventPanelFor } = require('./eventPanel');
const { v2Create, textDisplay } = require('./ui/common');
const { eventStats, unregisteredCount, roleIsEmpty, completeInfos } = require('./eventStats');
const { resolveClassStyles } = require('./classStyle');
const presence = require('./presence');
const { logEvent } = require('../eventLog');

const IGNORED_CODES = new Set([10003, 10008, 50001]); // Unknown Channel, Unknown Message, Missing Access
const timers = new Map();
// Messages that were sent but whose id could not be saved yet: eventId -> { channelId, messageId }. The scheduler retries
// the save from here instead of sending the message again.
const pendingSaves = new Map();

// Runs `fn` for `key` one at a time. A call made while one is in flight does not start another edit in parallel: it marks
// the key dirty and the run repeats once the current one finishes (so it reads fresh DB state), then every waiting caller
// gets the result of the last run. A startup redraw and a click-triggered refresh can therefore never overwrite each other
// with an older read.
function serialized(flights, key, fn) {
  const current = flights.get(key);
  if (current) {
    current.dirty = true;
    return current.promise;
  }
  const flight = { dirty: false, promise: null };
  flight.promise = (async () => {
    try {
      let result;
      do {
        flight.dirty = false;
        result = await fn();
      } while (flight.dirty);
      return result;
    } finally {
      flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight.promise;
}

const eventFlights = new Map(); // eventId -> in-flight war message refresh
const panelFlights = new Map(); // guildId -> in-flight dashboard refresh

// The war message of an event as a V2 payload (live counts, "chưa đăng ký" when the member cache is complete).
function warPayload(event, regs, config, guild) {
  const styles = resolveClassStyles(guild, config.classes, config.classEmojis);
  return buildWarMessage(event, regs, config, styles, { unregistered: unregisteredCount(guild, config, regs) });
}

// Re-draws the war message of one event (an old embed message is converted into a V2 message in place), serialized per
// event, and, unless `panel` is false, schedules the guild's dashboard (debounced: its numbers come from the same
// registrations, but it is not worth an edit per click).
async function refreshNow(client, eventId, { panel = true } = {}) {
  const guildId = await serialized(eventFlights, String(eventId), () => refreshEventOnce(client, eventId));
  if (panel && guildId) schedulePanelRefresh(client, guildId);
}

// One read-and-edit of the war message -> the event's guild id (null when the event is gone).
async function refreshEventOnce(client, eventId) {
  let guildId = null;
  try {
    const event = await warService.getEvent(eventId);
    if (!event) return null;
    guildId = event.guildId;
    if (event.channelId && event.messageId) {
      const [regs, config] = await Promise.all([listRegistrations(event._id), getConfig(event.guildId)]);
      presence.note(client, event, regs, config || defaultConfig(event.guildId)); // the bot's status line follows the same numbers
      const channel = await client.channels.fetch(event.channelId);
      await channel.messages.edit(event.messageId, warPayload(event, regs, config || defaultConfig(event.guildId), channel.guild));
    }
  } catch (err) {
    if (IGNORED_CODES.has(err.code)) console.warn(`[refresh] event ${eventId}: ${err.message}`);
    else console.error(`[refresh] event ${eventId}:`, err);
    logEvent('refresh', 'failed', { kind: 'event', eid: String(eventId), guild: guildId, err, lvl: IGNORED_CODES.has(err.code) ? 'warn' : undefined });
  }
  return guildId;
}

// Coalesce bursts of clicks: at most one edit per `delay` per event, always reading fresh DB state.
function scheduleRefresh(client, eventId, delay = defaults.refreshDebounceMs) {
  const key = String(eventId);
  if (timers.has(key)) return;
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      refreshNow(client, key);
    }, delay)
  );
}

// Send the war message to the announce channel and store its id.
// If the message could not be sent the event is deleted so the caller (or the next scheduler tick) can retry
// cleanly; if that delete fails too, a combined error is thrown (the event stays without a message, which the
// scheduler picks up again). If it was sent but saving its id failed, the event is kept (a live message must not be
// orphaned): the result then has `saved: false` and the id is remembered in memory for retryPendingSaves.
// The right to send is claimed atomically first (warService.claimPost); returns null when someone else holds the claim.
async function postWarMessage(client, config, event) {
  if (!(await warService.claimPost(event._id))) return null;
  let channel;
  let msg;
  try {
    channel = await client.channels.fetch(config.announceChannelId);
    msg = await channel.send(v2Create(warPayload(event, [], config, channel.guild)));
  } catch (err) {
    try {
      const regs = await listRegistrations(event._id).catch(() => []);
      if (regs.length) throw Object.assign(new Error(`${regs.length} registrations would be lost`), { keep: true }); // keep it: the backoff posts again
      await warService.deleteEvent(event._id);
    } catch (delErr) {
      if (delErr.keep) throw err;
      console.error(`[refresh] event ${event._id}: could not delete after failed send:`, delErr.message);
      logEvent('refresh', 'failed', { kind: 'post_cleanup', eid: String(event._id), guild: event.guildId, err: delErr });
      const combined = new Error(`${err.message} (and the event could not be deleted afterwards: ${delErr.message})`, { cause: err });
      combined.code = err.code; // keep the Discord code so callers can still explain the send failure
      combined.deleteError = delErr;
      throw combined;
    }
    throw err;
  }
  try {
    await warService.setMessage(event._id, channel.id, msg.id);
  } catch (err) {
    console.error(`[refresh] event ${event._id}: posted message ${msg.id} but could not save its id (will retry):`, err.message);
    logEvent('refresh', 'failed', { kind: 'save_id', eid: String(event._id), guild: event.guildId, msg: msg.id, err });
    pendingSaves.set(String(event._id), { channelId: channel.id, messageId: msg.id });
    return { ...event, channelId: channel.id, messageId: msg.id, saved: false };
  }
  return { ...event, channelId: channel.id, messageId: msg.id, saved: true };
}

const DELETE_IGNORED_CODES = new Set([10003, 10008]); // Unknown Channel / Unknown Message: the old post is already gone

// Re-post the war message (live counts) into the announce channel and point the event at it; the old message is deleted
// afterwards. Registrations are untouched. Compare-and-set on the old message id (warService.moveMessage): when somebody
// else moved or closed the event meanwhile, the message just sent is removed again and { moved: false } is returned.
// -> { moved: true, event, oldDelete: 'ok'|'gone'|'failed' } | { moved: false }. A failed send throws (the event is unchanged).
async function moveWarMessage(client, config, event) {
  const regs = await listRegistrations(event._id);
  const channel = await client.channels.fetch(config.announceChannelId);
  const msg = await channel.send(v2Create(warPayload(event, regs, config, channel.guild)));
  let swapped = false;
  try {
    swapped = await warService.moveMessage(event._id, event.messageId, channel.id, msg.id);
  } finally {
    if (!swapped) await channel.messages.delete(msg.id).catch((err) => console.warn(`[refresh] event ${event._id}: could not remove the duplicate message ${msg.id}: ${err.message}`));
  }
  if (!swapped) return { moved: false };
  let oldDelete = 'ok';
  try {
    const oldChannel = await client.channels.fetch(event.channelId);
    await oldChannel.messages.delete(event.messageId);
  } catch (err) {
    oldDelete = DELETE_IGNORED_CODES.has(err.code) ? 'gone' : 'failed';
    console.warn(`[refresh] event ${event._id}: old message ${event.messageId} not deleted: ${err.message}`);
  }
  return { moved: true, event: { ...event, channelId: channel.id, messageId: msg.id }, oldDelete };
}

function hasPendingSave(eventId) {
  return pendingSaves.has(String(eventId));
}

// Retry saving ids of already-sent messages (no new send). Entries are dropped once saved.
async function retryPendingSaves() {
  for (const [eventId, { channelId, messageId }] of [...pendingSaves]) {
    try {
      await warService.setMessage(eventId, channelId, messageId);
      pendingSaves.delete(eventId);
      console.log(`[refresh] event ${eventId}: saved the id of the already-posted message ${messageId}`);
      logEvent('refresh', 'pending_saved', { eid: String(eventId), msg: messageId });
    } catch (err) {
      console.error(`[refresh] event ${eventId}: still cannot save message id ${messageId}:`, err.message);
      logEvent('refresh', 'failed', { kind: 'pending_save', eid: String(eventId), msg: messageId, err });
    }
  }
}

// ---------- admin dashboard (one live V2 message per guild; its ids live in GuildConfig) ----------

const panelTimers = new Map();
const GONE_CODES = new Set([10003, 10008]); // Unknown Channel / Unknown Message: the dashboard was deleted

// The Google Sheet state shown on the dashboard: connected or not, last successful sync, last error (sheetSync keeps them in memory).
// sheetSync requires this module, so it is required lazily here.
function sheetState(config) {
  const status = require('./sheetSync').getStatus(config.guildId) || {};
  return { configured: Boolean(config.sheetId), at: status.at || null, error: status.error || null };
}

// The dashboard payload of a guild: the current event, its numbers and the last in-game roster import.
async function buildPanelFor(guild, config) {
  const event = await warService.getCurrentEvent(config.guildId);
  const infos = completeInfos(guild, config); // the member list is built once for both numbers below
  let stats = null;
  if (event) {
    const regs = await listRegistrations(event._id);
    stats = eventStats(event, regs, config, { unregistered: unregisteredCount(guild, config, regs, infos) });
  }
  const meta = await gameRosterService.latestMeta(config.guildId).catch(() => null); // count + date only, not the member list
  const headcount = await headcountService.loadHeadcount(config.guildId).catch(() => null); // official / apprentice ranks of the same roster
  return buildPanel({ event, stats, game: meta ? { count: meta.count, at: meta.importedAt } : null, roleEmpty: roleIsEmpty(guild, config, infos), sheet: sheetState(config), headcount, rosterTarget: headcountService.targetOf(config), config });
}

// Forgets the stored ids only while they are still the ones that failed (a dashboard posted meanwhile is kept).
const forgetPanel = (guildId, failedMessageId) => clearPanelIf(guildId, failedMessageId);

// Edits the stored dashboard (serialized per guild). A deleted channel / message is forgotten silently (no repost); other
// failures are logged.
function refreshPanelNow(client, guildId) {
  return serialized(panelFlights, String(guildId), () => refreshPanelOnce(client, guildId));
}

async function refreshPanelOnce(client, guildId) {
  try {
    const config = await getConfig(guildId);
    if (!config || !config.panelChannelId || !config.panelMessageId) return;
    try {
      const channel = await client.channels.fetch(config.panelChannelId);
      await channel.messages.edit(config.panelMessageId, await buildPanelFor(channel.guild, config));
    } catch (err) {
      if (!GONE_CODES.has(err.code)) throw err;
      console.warn(`[panel] guild ${guildId}: dashboard is gone, forgetting it`);
      await forgetPanel(guildId, config.panelMessageId);
    }
  } catch (err) {
    if (IGNORED_CODES.has(err.code)) console.warn(`[panel] guild ${guildId}: ${err.message}`);
    else console.error(`[panel] guild ${guildId}:`, err);
    logEvent('refresh', 'failed', { kind: 'panel', guild: guildId, err, lvl: IGNORED_CODES.has(err.code) ? 'warn' : undefined });
  }
}

// Debounced like scheduleRefresh: one edit per `delay` per guild.
function schedulePanelRefresh(client, guildId, delay = defaults.refreshDebounceMs) {
  const key = String(guildId);
  if (panelTimers.has(key)) return;
  const timer = setTimeout(() => {
    panelTimers.delete(key);
    refreshPanelNow(client, key);
  }, delay);
  if (timer.unref) timer.unref(); // never keeps a process (or a test run) alive
  panelTimers.set(key, timer);
}

const OLD_PANEL_IGNORED_CODES = new Set([10003, 10008]); // already gone: nothing to clean up (50001/50013 = cannot reach it: warned)

// Best effort: deletes the previously stored dashboard when it sits in another channel than the new one.
async function removeOldPanel(client, config, newChannelId) {
  if (!config.panelMessageId || !config.panelChannelId || config.panelChannelId === newChannelId) return;
  try {
    const old = await client.channels.fetch(config.panelChannelId);
    await old.messages.delete(config.panelMessageId);
  } catch (err) {
    if (!OLD_PANEL_IGNORED_CODES.has(err.code)) console.warn(`[panel] guild ${config.guildId}: old dashboard ${config.panelMessageId} not deleted: ${err.message}`);
  }
}

// /setup "Đăng / làm mới": edits the stored dashboard if it still exists in the admin channel, else posts a new one and
// stores its ids. -> { action: 'edited' | 'posted', channelId, messageId }. Throws when the admin channel cannot be used.
async function postOrUpdatePanel(client, config) {
  const channel = await client.channels.fetch(config.adminChannelId);
  const payload = await buildPanelFor(channel.guild, config);
  if (config.panelMessageId && config.panelChannelId === channel.id) {
    try {
      await channel.messages.edit(config.panelMessageId, payload);
      return { action: 'edited', channelId: channel.id, messageId: config.panelMessageId };
    } catch (err) {
      if (!GONE_CODES.has(err.code)) throw err;
    }
  }
  const msg = await channel.send(v2Create(payload));
  await updateConfig(config.guildId, { panelChannelId: channel.id, panelMessageId: msg.id }); // store the new ids first: a failed delete must not lose them
  await removeOldPanel(client, config, channel.id); // the admin channel changed: do not leave the old dashboard behind
  return { action: 'posted', channelId: channel.id, messageId: msg.id };
}

// Startup: draw every unfinished war message and every dashboard again, one after another with a pause (rate limits), so
// messages posted before this version become V2. Failures are logged, never thrown.
async function redrawAll(client, { delayMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let events = [];
  let panels = [];
  try {
    events = await warService.listAllWithMessage();
    panels = await listPanelConfigs();
  } catch (err) {
    console.error('[redraw] cannot list messages:', err.message);
    logEvent('refresh', 'failed', { kind: 'redraw_list', err });
  }
  for (const event of events) {
    try {
      await refreshNow(client, event._id, { panel: false });
    } catch (err) {
      console.error(`[redraw] event ${event._id}:`, err.message);
      logEvent('refresh', 'failed', { kind: 'redraw_event', eid: String(event._id), err });
    }
    await sleep(delayMs);
  }
  for (const config of panels) {
    try {
      await refreshPanelNow(client, config.guildId);
    } catch (err) {
      console.error(`[redraw] guild ${config.guildId}:`, err.message);
      logEvent('refresh', 'failed', { kind: 'redraw_panel', guild: config.guildId, err });
    }
    await sleep(delayMs);
  }
  return { events: events.length, panels: panels.length };
}

// ---------- guild event cards (ev:*, one V2 message per GuildEvent) ----------

const cardTimers = new Map();
const cardFlights = new Map(); // eventId -> in-flight card refresh

// One read-and-edit of an event card (live counts from the answers).
async function refreshEventCardOnce(client, eventId) {
  let guildId = null;
  let event = null;
  try {
    event = await eventService.getEvent(eventId);
    if (!event) return null;
    guildId = event.guildId;
    if (event.channelId && event.messageId) {
      const counts = await eventService.countsOf(event._id);
      const channel = await client.channels.fetch(event.channelId);
      await channel.messages.edit(event.messageId, buildEventCard(event, counts));
    }
  } catch (err) {
    if (err.code === 10008 && event && event.messageId) {
      // The card was deleted by hand: forget its id so the next refreshes skip it, and say so once (not on every answer).
      logEvent('refresh', 'card_gone', { eid: String(eventId), guild: guildId, msg: event.messageId, lvl: 'warn' });
      console.warn(`[refresh] event card ${eventId}: the card message was deleted, its id is forgotten`);
      await eventService.clearMessage(event._id, event.messageId).catch((clearErr) => console.error(`[refresh] event card ${eventId}: could not forget the id:`, clearErr.message));
      return guildId;
    }
    if (IGNORED_CODES.has(err.code)) console.warn(`[refresh] event card ${eventId}: ${err.message}`);
    else console.error(`[refresh] event card ${eventId}:`, err);
    logEvent('refresh', 'failed', { kind: 'event_card', eid: String(eventId), guild: guildId, err, lvl: IGNORED_CODES.has(err.code) ? 'warn' : undefined });
  }
  return guildId;
}

// Serialized per event like the war message: a refresh asked while one is running repeats once with fresh state. The guild's event panel
// follows (debounced): every create / edit / status change / answer count change redraws a card, so the panel list never lags behind.
async function refreshEventCardNow(client, eventId) {
  const guildId = await serialized(cardFlights, String(eventId), () => refreshEventCardOnce(client, eventId));
  if (guildId) scheduleEventPanelRefresh(client, guildId);
  return guildId;
}

// Debounced like scheduleRefresh: at most one edit per `delay` per event card.
function scheduleEventRefresh(client, eventId, delay = defaults.refreshDebounceMs) {
  const key = String(eventId);
  if (cardTimers.has(key)) return;
  const timer = setTimeout(() => {
    cardTimers.delete(key);
    refreshEventCardNow(client, key);
  }, delay);
  if (timer.unref) timer.unref();
  cardTimers.set(key, timer);
}

// ---------- the event management panel (one live V2 message per guild; its ids live in GuildConfig) ----------

const eventPanelFlights = new Map(); // guildId -> in-flight event panel refresh
const eventPanelTimers = new Map();

async function refreshEventPanelOnce(client, guildId) {
  try {
    const config = await getConfig(guildId);
    if (!config || !config.eventPanelChannelId || !config.eventPanelMessageId) return;
    try {
      const channel = await client.channels.fetch(config.eventPanelChannelId);
      await channel.messages.edit(config.eventPanelMessageId, await buildEventPanelFor(guildId));
    } catch (err) {
      if (!GONE_CODES.has(err.code)) throw err;
      console.warn(`[event panel] guild ${guildId}: the panel is gone, forgetting it`);
      const cur = await getConfig(guildId, { fresh: true });
      if (cur && cur.eventPanelMessageId === config.eventPanelMessageId) await updateConfig(guildId, { eventPanelChannelId: null, eventPanelMessageId: null });
    }
  } catch (err) {
    if (IGNORED_CODES.has(err.code)) console.warn(`[event panel] guild ${guildId}: ${err.message}`);
    else console.error(`[event panel] guild ${guildId}:`, err);
    logEvent('refresh', 'failed', { kind: 'event_panel', guild: guildId, err, lvl: IGNORED_CODES.has(err.code) ? 'warn' : undefined });
  }
}

// Edits the stored event panel (serialized per guild, like the dashboard). A deleted channel / message is forgotten silently (no repost).
const refreshEventPanelNow = (client, guildId) => serialized(eventPanelFlights, String(guildId), () => refreshEventPanelOnce(client, guildId));

// Debounced like schedulePanelRefresh: one edit per `delay` per guild.
function scheduleEventPanelRefresh(client, guildId, delay = defaults.refreshDebounceMs) {
  const key = String(guildId);
  if (eventPanelTimers.has(key)) return;
  const timer = setTimeout(() => {
    eventPanelTimers.delete(key);
    refreshEventPanelNow(client, key);
  }, delay);
  if (timer.unref) timer.unref();
  eventPanelTimers.set(key, timer);
}

// Sends the card of a new event to `channelId` and stores its id. A failed send throws (the caller removes the event); a failed save of the
// id removes the message again, so no card is left that the bot cannot edit.
// `tagRoleId` = ping that ONE role: a V2 message has no content, so the mention is a text line on top of the card and the send allows exactly
// that role. It only exists on this first post: every later edit (refreshEventCardOnce) rebuilds the card without it, with nothing allowed.
async function postEventCard(client, channelId, event, { tagRoleId = null } = {}) {
  const channel = await client.channels.fetch(channelId);
  const payload = v2Create(buildEventCard(event, { yes: 0, maybe: 0, no: 0 }));
  if (tagRoleId) {
    payload.components = [textDisplay(`<@&${tagRoleId}>`), ...payload.components];
    payload.allowedMentions = { roles: [tagRoleId] };
  }
  const msg = await channel.send(payload);
  try {
    await eventService.setMessage(event._id, channel.id, msg.id);
  } catch (err) {
    await channel.messages.delete(msg.id).catch(() => {});
    throw err;
  }
  if (event.guildId) scheduleEventPanelRefresh(client, event.guildId); // the new event joins the panel list
  return { ...event, channelId: channel.id, messageId: msg.id };
}

// Tests: drop every pending debounce timer.
function cancelScheduled() {
  for (const map of [timers, panelTimers, cardTimers, eventPanelTimers]) {
    for (const timer of map.values()) clearTimeout(timer);
    map.clear();
  }
}

module.exports = {
  cancelScheduled,
  refreshNow,
  scheduleRefresh,
  postWarMessage,
  moveWarMessage,
  hasPendingSave,
  retryPendingSaves,
  refreshPanelNow,
  schedulePanelRefresh,
  postOrUpdatePanel,
  redrawAll,
  refreshEventCardNow,
  scheduleEventRefresh,
  postEventCard,
  refreshEventPanelNow,
};
