// "Is this guild's member cache complete?" - one shared answer for the warm-up, the admin lists and the reminder.
// The flag is set only after a successful guild.members.fetch(); a failed fetch never marks the guild as loaded.
const fetched = new Set(); // guildIds whose members were fully fetched at least once
const inflight = new Map(); // guildId -> Promise of the running fetch

const isRateLimit = (err) => Boolean(err) && (err.name === 'GatewayRateLimitError' || (err.constructor && err.constructor.name === 'GatewayRateLimitError'));
const retryAfterMs = (err) => Math.max(0, Number(err && err.data && err.data.retry_after) || 1) * 1000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isComplete(guild) {
  if (!fetched.has(guild.id)) return false;
  const total = guild.memberCount;
  return !(Number.isFinite(total) && guild.members.cache.size < total);
}

async function fetchWithRetry(guild, retries, sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await guild.members.fetch();
    } catch (err) {
      if (!isRateLimit(err) || attempt >= retries) throw err;
      await sleep(retryAfterMs(err));
    }
  }
}

// -> { complete, members, error }: `members` = the fetched collection, else whatever is cached. Fetches unless the guild is
// known to be complete (or `force`). GatewayRateLimitError is retried `retries` times after its retry_after.
async function ensureMembers(guild, { force = false, retries = 0, sleep = defaultSleep } = {}) {
  if (!force && isComplete(guild)) return { complete: true, members: guild.members.cache, error: null };
  let run = guild.id ? inflight.get(guild.id) : null;
  if (!run) {
    run = fetchWithRetry(guild, retries, sleep);
    if (guild.id) {
      inflight.set(guild.id, run);
      const clear = () => inflight.get(guild.id) === run && inflight.delete(guild.id);
      run.then(clear, clear);
    }
  }
  try {
    const members = await run;
    if (guild.id) fetched.add(guild.id);
    return { complete: true, members: members || guild.members.cache, error: null };
  } catch (err) {
    console.warn(`[members] cannot fetch members of ${guild.id}:`, err.message);
    return { complete: false, members: guild.members.cache, error: err };
  }
}

const MEMBERS_WARNING = '⚠️ Không tải đủ danh sách thành viên — kết quả có thể thiếu.';

function clearMemberCache() {
  fetched.clear();
  inflight.clear();
}

module.exports = { ensureMembers, MEMBERS_WARNING, clearMemberCache, isComplete };
