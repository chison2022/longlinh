const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isDisallowedIntentsError, isUnrecoverableLoginError, startBotWithRetry, describeLoginError, RETRY_DELAYS_MS } = require('../src/bot/client');

describe('login error handling', () => {
  it('recognises discord.js DisallowedIntents, close code 4014 and the gateway wording', () => {
    assert.equal(isDisallowedIntentsError({ code: 'DisallowedIntents', message: 'Privileged intent provided is not enabled or whitelisted.' }), true);
    assert.equal(isDisallowedIntentsError({ code: 4014 }), true);
    assert.equal(isDisallowedIntentsError(new Error('Used disallowed intents')), true);
  });
  it('does not mistake other errors for it', () => {
    assert.equal(isDisallowedIntentsError(new Error('An invalid token was provided.')), false);
    assert.equal(isDisallowedIntentsError(null), false);
    assert.equal(isDisallowedIntentsError(undefined), false);
  });
  it('disallowed intents message is bilingual and names Server Members Intent', () => {
    const msg = describeLoginError({ code: 4014 });
    assert.match(msg, /Server Members Intent/);
    assert.match(msg, /Developer Portal/);
    assert.match(msg, /chưa bật/); // Vietnamese
    assert.match(msg, /not enabled/); // English
  });
  it('other errors are reported with their message', () => {
    assert.match(describeLoginError(new Error('An invalid token was provided.')), /invalid token/);
  });
});

describe('login retry', () => {
  const tokenInvalid = Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' });
  it('unrecoverable: disallowed intents, invalid token, close code 4004; transient: network/DNS/timeouts', () => {
    assert.equal(isUnrecoverableLoginError({ code: 4014 }), true);
    assert.equal(isUnrecoverableLoginError(tokenInvalid), true);
    assert.equal(isUnrecoverableLoginError({ code: 4004 }), true);
    for (const code of ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']) assert.equal(isUnrecoverableLoginError(Object.assign(new Error(code), { code })), false);
    assert.equal(isUnrecoverableLoginError(new Error('WebSocket was closed before the connection was established')), false);
    assert.equal(isUnrecoverableLoginError(null), false);
  });
  it('retries transient failures with 5s, 15s, 60s, 60s... backoff, then returns the client', async () => {
    const delays = [];
    let n = 0;
    const client = { ok: true };
    const res = await startBotWithRetry('t', {
      start: async () => {
        if (++n <= 5) throw Object.assign(new Error('getaddrinfo ENOTFOUND discord.com'), { code: 'ENOTFOUND' });
        return client;
      },
      sleep: async (ms) => delays.push(ms),
    });
    assert.equal(res, client);
    assert.deepEqual(delays, [5000, 15000, 60000, 60000, 60000]);
    assert.deepEqual(RETRY_DELAYS_MS, [5000, 15000, 60000]);
  });
  it('rejects immediately (no sleep) on an unrecoverable error', async () => {
    let slept = 0;
    let tries = 0;
    await assert.rejects(
      () =>
        startBotWithRetry('t', {
          start: async () => {
            tries += 1;
            throw tokenInvalid;
          },
          sleep: async () => (slept += 1),
        }),
      /invalid token/
    );
    assert.equal(tries, 1);
    assert.equal(slept, 0);
  });
  it('reports each transient failure through onRetry', async () => {
    const seen = [];
    let n = 0;
    await startBotWithRetry('t', {
      start: async () => {
        if (++n === 1) throw new Error('boom');
        return {};
      },
      sleep: async () => {},
      onRetry: (err, delay) => seen.push([err.message, delay]),
    });
    assert.deepEqual(seen, [['boom', 5000]]);
  });
});
