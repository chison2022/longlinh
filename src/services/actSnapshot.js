// The one-time snapshot the bot copies into the Activity's own database (see sideDb.js, activity/schema.sql) when registration locks:
// the guild (who may edit, classes, layout shape), the war and its joiners. Nothing else is synced afterwards.
// listJoiners / linkGroupsOf read the MAIN database; writeSnapshot writes the SIDE database only.
const db = require('../db');
const side = require('../sideDb');
const linkService = require('./linkService');
const { plainClass } = require('./lineupStyle');

// THE joiner list of a war (everything the board shows about a person): the 'join' registrations in sign-up order ->
// [{ id (Discord id), name (in-game name when linked, else Discord name), discordName, linked, gameClass, className (class chosen at
// registration), rolePref, links (declared Tuyến Khiên partners), createdAt }].
async function listJoiners(warId) {
  if (!db.isId(String(warId))) return [];
  const rows = await db.q(
    `select m.discord_id as id, m.display_name as "discordName", r.class_name as "className", m.mission_pref as "rolePref", r.created_at as "createdAt",
            m.tk_partners as links, g.name as "gameName", g.class_name as "gameClass"
       from registrations r join discord_members m on m.id = r.member_id
       left join character_links l on l.member_id = m.id
       left join game_characters g on g.id = l.character_id
      where r.war_id = $1 and r.status = 'join' order by r.created_at, m.discord_id`,
    [String(warId)]
  );
  return rows.map((r) => ({ ...r, name: r.gameName || r.discordName || r.id, discordName: r.discordName || '', linked: Boolean(r.gameName), links: r.links || [] }));
}

// Tuyến Khiên groups among these joiners: [[id]] of people linked (either one declared the link), 2 or more each.
const linkGroupsOf = (joiners) => linkService.buildGroups(joiners.map((j) => ({ discordId: j.id, links: j.links })), joiners.map((j) => j.id));

// guild: { guildId, adminRoleIds, managerRoleIds, ownerId, classes: [{ name, tag, emojiId }], rules, shape }; war: the main war (_id, title,
// startAt, status); joiners: listJoiners(). Re-running it (a re-lock) refreshes the joiners and keeps everything the board edited:
// placements / tasks / notes live in act_lineups (untouched), hand-added people stay, a manager's removal stays, and people who
// un-joined are removed (they come back if they join again).
async function writeSnapshot({ guild, war, joiners }) {
  const keys = joiners.map((j) => j.id);
  await side.tx(async () => {
    await side.q(
      `insert into act_guilds (guild_id, admin_role_ids, manager_role_ids, owner_id, classes, rules, shape, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (guild_id) do update set admin_role_ids = excluded.admin_role_ids, manager_role_ids = excluded.manager_role_ids, owner_id = excluded.owner_id,
         classes = excluded.classes, rules = excluded.rules, shape = excluded.shape, updated_at = now()`,
      [guild.guildId, guild.adminRoleIds || [], guild.managerRoleIds || [], guild.ownerId || null, JSON.stringify(guild.classes || []), JSON.stringify(guild.rules || {}), JSON.stringify(guild.shape || {})]
    );
    await side.q(
      `insert into act_wars (war_id, guild_id, title, start_at, status, locked_at, snapshot_at, link_groups)
       values ($1, $2, $3, $4, $5, now(), now(), $6)
       on conflict (war_id) do update set title = excluded.title, start_at = excluded.start_at, status = excluded.status,
         locked_at = coalesce(act_wars.locked_at, excluded.locked_at), snapshot_at = now(), link_groups = excluded.link_groups`,
      [String(war._id), guild.guildId, war.title, war.startAt, war.status, JSON.stringify(linkGroupsOf(joiners))]
    );
    if (joiners.length) {
      // all joiners in one statement (one round trip, however many people)
      const rows = joiners.map((j) => ({ key: j.id, name: j.name, discord_name: j.discordName || '', linked: Boolean(j.linked), class_name: j.className ? plainClass(j.className) : '', role_pref: j.rolePref || 'any', created_at: j.createdAt }));
      await side.q(
        `insert into act_members (war_id, member_key, discord_id, name, discord_name, linked, class_name, role_pref, created_at)
         select $1, j.key, j.key, j.name, j.discord_name, j.linked, j.class_name, j.role_pref, j.created_at
           from jsonb_to_recordset($2::jsonb) as j(key text, name text, discord_name text, linked boolean, class_name text, role_pref text, created_at timestamptz)
         on conflict (war_id, member_key) do update set discord_id = excluded.discord_id, name = excluded.name, discord_name = excluded.discord_name,
           linked = excluded.linked, class_name = excluded.class_name, role_pref = excluded.role_pref, created_at = excluded.created_at,
           removed = (act_members.removed_by is not null)`,
        [String(war._id), JSON.stringify(rows)]
      );
    }
    await side.q('update act_members set removed = true where war_id = $1 and not manual and not removed and member_key <> all($2::text[])', [String(war._id), keys]);
  });
}

module.exports = { listJoiners, linkGroupsOf, writeSnapshot };
