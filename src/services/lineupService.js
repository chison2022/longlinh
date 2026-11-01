// The war lineup the Activity edits (table war_lineups, one row per war). Saves use optimistic concurrency (version); the publish
// request is picked up by the bot (laptop), which posts the image and calls markPublished / markPublishError.
const db = require('../db');
const { layoutOf } = require('./teamService');
const { getConfigOrDefault } = require('./guildConfigService');
const rules = require('./lineupRules');

const LINEUP_COLS = `war_id as "warId", guild_id as "guildId", layout, version, updated_by as "updatedBy", updated_at as "updatedAt",
  publish_requested_at as "publishRequestedAt", publish_requested_by as "publishRequestedBy", published_version as "publishedVersion",
  published_at as "publishedAt", publish_error as "publishError", published_layout as "publishedLayout", claimed_at as "claimedAt"`;
const LINEUP_SQL = `select ${LINEUP_COLS} from war_lineups`;
const CLAIM_MS_SQL = "interval '2 minutes'"; // a claim older than this is dead (the bot died while posting)

// The lineup row of a war, or null when nobody has saved one yet.
function getLineup(warId) {
  if (!db.isId(String(warId))) return Promise.resolve(null);
  return db.one(`${LINEUP_SQL} where war_id = $1`, [String(warId)]);
}

// The 'join' registrations of a war in sign-up order: [{ id, name, className, rolePref, createdAt }].
function listJoiners(warId) {
  if (!db.isId(String(warId))) return Promise.resolve([]);
  return db.q(
    `select m.discord_id as id, m.display_name as name, r.class_name as "className", m.mission_pref as "rolePref", r.created_at as "createdAt"
       from registrations r join discord_members m on m.id = r.member_id
      where r.war_id = $1 and r.status = 'join' order by r.created_at, m.discord_id`,
    [String(warId)]
  );
}


async function shapeOf(guildId) {
  return layoutOf(await getConfigOrDefault(guildId));
}

// -> { ok: true, lineup } | { conflict: true, current } | { error }.
// layout is validated (shape, party size, no duplicates); ids that are not a 'join' registration of that war are dropped.
async function saveLineup({ warId, guildId, layout, expectedVersion, userId }) {
  const war = await db.one('select id, guild_id as "guildId", status from war_events where id = $1', [String(warId)]);
  if (!war || war.guildId !== guildId) return { error: 'Bang chiến không tồn tại.' };
  if (war.status === 'done') return { error: 'Bang chiến đã kết thúc.' };
  const checked = rules.validateLayout(layout, await shapeOf(guildId));
  if (!checked.ok) return { error: checked.error };
  const joined = new Set((await listJoiners(warId)).map((j) => j.id));
  const clean = rules.filterLayout(checked.layout, (id) => joined.has(id));
  const expected = Number.isInteger(expectedVersion) && expectedVersion >= 0 ? expectedVersion : -1;
  const json = JSON.stringify(clean);
  let row = null;
  if (expected === 0) {
    // the first save creates the row; the primary key makes a second first-saver lose
    row = await db.one(
      'insert into war_lineups (war_id, guild_id, layout, version, updated_by) values ($1, $2, $3, 1, $4) on conflict (war_id) do nothing returning version',
      [String(warId), guildId, json, userId || null]
    );
  }
  if (!row && expected >= 0) {
    row = await db.one(
      'update war_lineups set layout = $2, version = version + 1, updated_by = $3, updated_at = now() where war_id = $1 and version = $4 returning version',
      [String(warId), json, userId || null, expected]
    );
  }
  if (!row) return { conflict: true, current: await getLineup(warId) };
  return { ok: true, lineup: await getLineup(warId) };
}

// Asks the bot to post the lineup. A fresh request clears an earlier error. -> the row, or null when the war is not this guild's / done.
async function requestPublish(warId, userId, guildId = null) {
  const war = await db.one('select guild_id as "guildId", status from war_events where id = $1', [String(warId)]);
  if (!war || war.status === 'done' || (guildId && war.guildId !== guildId)) return null;
  await db.q(
    `insert into war_lineups (war_id, guild_id, layout, version) values ($1, $2, $3, 0) on conflict (war_id) do nothing`,
    [String(warId), war.guildId, JSON.stringify(rules.emptyLayout(await shapeOf(war.guildId)))]
  );
  await db.q(
    `update war_lineups set publish_requested_at = date_trunc('milliseconds', now()), publish_requested_by = $2, publish_error = null where war_id = $1`,
    [String(warId), userId || null]
  );
  return getLineup(warId);
}

// Atomically takes the publishes asked for and not done yet (an errored one waits for a new request), so two processes never both
// post one; a claim older than 2 minutes is taken over. Oldest request first. Give the claim back with markPublished / markPublishError.
async function claimPendingPublishes() {
  const rows = await db.q(
    `update war_lineups set claimed_at = now()
      where publish_requested_at is not null and publish_error is null
        and (published_at is null or publish_requested_at > published_at)
        and (claimed_at is null or claimed_at < now() - ${CLAIM_MS_SQL})
      returning ${LINEUP_COLS}`
  );
  return rows.sort((a, b) => new Date(a.publishRequestedAt) - new Date(b.publishRequestedAt));
}

// The post is out; `layout` = exactly what was rendered (kept for "Xem PT của tôi"). `requestedAt` = the request that was served: when a
// newer request arrived meanwhile it stays pending and its error / state are left alone. `warning` = a side step that failed (the
// sheet): kept as publish_error without re-posting. -> true when the row was updated.
async function markPublished(warId, version, requestedAt = null, warning = null, layout = null) {
  const rows = await db.q(
    `update war_lineups set published_version = $2, published_layout = coalesce($5::jsonb, published_layout), claimed_at = null,
       publish_error = case when $3::timestamptz is null or publish_requested_at = $3::timestamptz then $4 else publish_error end,
       published_at = case when $3::timestamptz is null or publish_requested_at = $3::timestamptz then date_trunc('milliseconds', now()) else $3::timestamptz end
     where war_id = $1 returning war_id`,
    [String(warId), version, requestedAt, warning ? String(warning).slice(0, 500) : null, layout ? JSON.stringify(layout) : null]
  );
  return rows.length === 1;
}

// The post failed: shown in the Activity, not retried until the admin presses publish again. Only for the request being served: a newer
// request keeps waiting (the claim is released either way).
async function markPublishError(warId, message, requestedAt = null) {
  const rows = await db.q(
    `update war_lineups set claimed_at = null,
       publish_error = case when $3::timestamptz is null or publish_requested_at = $3::timestamptz then $2 else publish_error end
     where war_id = $1 returning war_id`,
    [String(warId), String(message || 'Lỗi không rõ').slice(0, 500), requestedAt]
  );
  return rows.length === 1;
}

module.exports = {
  getLineup,
  listJoiners,
  saveLineup,
  requestPublish,
  claimPendingPublishes,
  markPublished,
  markPublishError,
  partyWarnings: rules.partyWarnings,
  reshapeLayout: rules.reshapeLayout,
  emptyLayout: rules.emptyLayout,
};
