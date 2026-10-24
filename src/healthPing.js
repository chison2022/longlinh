// Optional dead-man switch (healthchecks.io): GET HEALTHCHECK_URL every 5 minutes while the db and the bot are healthy.
const INTERVAL_MS = 5 * 60 * 1000;

async function pingOnce({ url, isHealthy, fetchFn = globalThis.fetch, log = console }) {
  if (!url || !isHealthy()) return false;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch (err) {
    log.warn(`[healthcheck] ping failed: ${err.message}`);
    return false;
  }
}

function startHealthPing(options) {
  if (!options.url) return () => {};
  const timer = setInterval(() => pingOnce(options), INTERVAL_MS);
  timer.unref();
  pingOnce(options);
  return () => clearInterval(timer);
}

module.exports = { pingOnce, startHealthPing, INTERVAL_MS };
