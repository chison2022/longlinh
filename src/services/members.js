// Discord members as the rest of the bot sees them: one plain object per member, with the linked game character folded in
// as gameName / gameNameKey / gameNameSource / gameNameAt (the shape the old Member documents had).
const db = require('../db');

// Columns of a member row joined with its link (aliases = the old field names). `m` = discord_members.
const MEMBER_COLUMNS = `m.id, m.guild_id as "guildId", m.discord_id as "discordId", m.display_name as "displayName", m.class_name as "className",
  m.mission_pref as "missionPref", m.tuyen_khien as "tuyenKhien", m.tk_partners as links, m.created_at as "createdAt", m.updated_at as "updatedAt",
  gc.name as "gameName", gc.name_key as "gameNameKey", gc.left_at as "gameLeftAt", cl.source as "gameNameSource", cl.linked_at as "gameNameAt"`;
const MEMBER_FROM = `discord_members m left join character_links cl on cl.member_id = m.id left join game_characters gc on gc.id = cl.character_id`;

// -> member object or null
function getMember(guildId, discordId) {
  return db.one(`select ${MEMBER_COLUMNS} from ${MEMBER_FROM} where m.guild_id = $1 and m.discord_id = $2`, [guildId, discordId]);
}

// `where` / params: an extra SQL condition on m / gc / cl (params numbered from $2; $1 = guildId).
function listMembers(guildId, where = 'true', params = []) {
  return db.q(`select ${MEMBER_COLUMNS} from ${MEMBER_FROM} where m.guild_id = $1 and (${where})`, [guildId, ...params]);
}

// The row id of (guild, discord id), created when missing. A given displayName replaces the stored one; undefined leaves it.
async function memberId(guildId, discordId, displayName) {
  const row = await db.one(
    `insert into discord_members (guild_id, discord_id, display_name) values ($1, $2, coalesce($3, ''))
     on conflict (guild_id, discord_id) do update set display_name = coalesce($3, discord_members.display_name)
     returning id`,
    [guildId, discordId, displayName === undefined || displayName === null ? null : String(displayName)]
  );
  return row.id;
}

// Writes some member fields (create when missing) -> the member object. `fields`: { displayName?, className?, missionPref?, tuyenKhien?, links? }
const FIELD_COLUMNS = { className: 'class_name', missionPref: 'mission_pref', tuyenKhien: 'tuyen_khien', links: 'tk_partners' };
async function saveMember(guildId, discordId, fields = {}) {
  return db.tx(async () => {
    const id = await memberId(guildId, discordId, fields.displayName);
    const sets = [];
    const params = [id];
    for (const [k, col] of Object.entries(FIELD_COLUMNS)) {
      if (fields[k] === undefined) continue;
      params.push(fields[k]);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length) await db.q(`update discord_members set ${sets.join(', ')} where id = $1`, params);
    return db.one(`select ${MEMBER_COLUMNS} from ${MEMBER_FROM} where m.id = $1`, [id]);
  });
}

module.exports = { MEMBER_COLUMNS, MEMBER_FROM, getMember, listMembers, memberId, saveMember };
