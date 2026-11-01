// The few Discord REST calls the Activity server makes, with small caches. `fetchFn` is injected (tests); tokens are never logged.
const crypto = require('node:crypto');

const API = 'https://discord.com/api/v10';
const USER_TTL_MS = 5 * 60 * 1000;
const GUILD_TTL_MS = 5 * 60 * 1000;
const FAIL_TTL_MS = 30 * 1000; // a refused token / non-member / failed lookup is remembered briefly: random tokens cannot hammer Discord
const MAX_CACHE = 2000;

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function remember(map, key, value) {
  if (map.size >= MAX_CACHE) map.delete(map.keys().next().value);
  map.set(key, { value, at: Date.now() });
}
const recall = (map, key, ttl) => {
  const hit = map.get(key);
  return hit && Date.now() - hit.at < (hit.value === null ? FAIL_TTL_MS : ttl) ? hit.value : undefined;
};

function createDiscordApi({ fetchFn = globalThis.fetch, clientId, clientSecret, botToken } = {}) {
  const users = new Map(); // token hash -> user | null
  const members = new Map(); // `${token hash}:${guildId}` -> member | null
  const guilds = new Map(); // guildId -> { id, ownerId, roles } | null

  async function json(url, headers) {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(8000) });
    return res.ok ? res.json() : null;
  }

  // authorization code -> access token string | null
  async function exchangeCode(code) {
    const res = await fetchFn(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code: String(code) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body.access_token === 'string' ? body.access_token : null;
  }

  // user access token -> { id, name } | null
  async function userOf(token) {
    const key = hash(token);
    const hit = recall(users, key, USER_TTL_MS);
    if (hit !== undefined) return hit;
    const u = await json(`${API}/users/@me`, { Authorization: `Bearer ${token}` });
    const user = u && u.id ? { id: String(u.id), name: u.global_name || u.username || String(u.id) } : null;
    remember(users, key, user);
    return user;
  }

  // -> { roles: [id], nick } | null (not a member of that guild, or the scope is missing)
  async function memberOf(token, guildId) {
    const key = `${hash(token)}:${guildId}`;
    const hit = recall(members, key, USER_TTL_MS);
    if (hit !== undefined) return hit;
    const m = await json(`${API}/users/@me/guilds/${guildId}/member`, { Authorization: `Bearer ${token}` });
    const member = m ? { roles: Array.isArray(m.roles) ? m.roles.map(String) : [], nick: m.nick || null } : null;
    remember(members, key, member);
    return member;
  }

  // The guild's owner and role permissions through the bot token (REST only). null without a token or on failure.
  async function guildInfo(guildId) {
    const hit = recall(guilds, guildId, GUILD_TTL_MS);
    if (hit !== undefined) return hit;
    let info = null;
    if (botToken) {
      const headers = { Authorization: `Bot ${botToken}` };
      try {
        const [g, roles] = await Promise.all([json(`${API}/guilds/${guildId}`, headers), json(`${API}/guilds/${guildId}/roles`, headers)]);
        if (g && roles) info = { id: String(guildId), ownerId: String(g.owner_id), roles: roles.map((r) => ({ id: String(r.id), permissions: String(r.permissions) })) };
      } catch {
        info = null;
      }
    }
    remember(guilds, guildId, info);
    return info;
  }

  return { exchangeCode, userOf, memberOf, guildInfo };
}

module.exports = { createDiscordApi, API };
