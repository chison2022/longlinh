// The few Discord REST calls the Activity server makes, with small caches. `fetchFn` is injected (tests); tokens are never logged.
const crypto = require('node:crypto');

const API = 'https://discord.com/api/v10';
const CDN = 'https://cdn.discordapp.com';
const EMOJI_CACHE = 200;
const MAX_EMOJI_BYTES = 262144;
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

function createDiscordApi({ fetchFn = globalThis.fetch, clientId, clientSecret } = {}) {
  const users = new Map(); // token hash -> user | null
  const members = new Map(); // `${token hash}:${guildId}` -> member | null
  const images = new Map(); // emoji id -> Buffer (LRU: a hit is re-inserted)

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
    if (!res.ok) {
      // Discord's reason (e.g. invalid_client = wrong CLIENT_SECRET, invalid_grant = bad/expired code); never the code or secret
      const err = await res.json().catch(() => ({}));
      console.warn(`[activity] code exchange refused: ${res.status} ${err.error || ''} ${err.error_description || ''}`.trim());
      return null;
    }
    const body = await res.json();
    return body && typeof body.access_token === 'string' ? body.access_token : null;
  }

  // Startup self-check: a client_credentials grant only succeeds with a valid CLIENT_ID + CLIENT_SECRET pair.
  // -> true | false (wrong pair) | null (Discord unreachable)
  async function checkCredentials() {
    try {
      const res = await fetchFn(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials', scope: 'identify' }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return null;
    }
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

  // The PNG of a custom emoji (static, 48 px) from the CDN, cached. -> Buffer | null
  async function emojiImage(id) {
    if (images.has(id)) {
      const buf = images.get(id);
      images.delete(id);
      images.set(id, buf);
      return buf;
    }
    try {
      const res = await fetchFn(`${CDN}/emojis/${id}.png?size=48`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_EMOJI_BYTES) return null;
      if (images.size >= EMOJI_CACHE) images.delete(images.keys().next().value);
      images.set(id, buf);
      return buf;
    } catch {
      return null;
    }
  }

  return { exchangeCode, checkCredentials, userOf, memberOf, emojiImage };
}

module.exports = { createDiscordApi, API };
