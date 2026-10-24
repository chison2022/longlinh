// postWarMessage: delete the event only when sending failed; keep it when only saving the message id failed.
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const warService = require('../src/services/warService');
const { postWarMessage, retryPendingSaves, hasPendingSave } = require('../src/bot/refresher');
const { vn, oid } = require('./helpers');

const event = { _id: oid(1), guildId: 'g', title: 'Bang chiến', startAt: vn(2026, 10, 11, 20), deadlineAt: vn(2026, 10, 11, 18), status: 'open', teams: [] };
const config = { announceChannelId: 'chan', classes: ['A'] };

let deleted;
let saved;
let claims;
let stubs;
beforeEach(() => {
  deleted = [];
  saved = [];
  claims = [];
  warService.claimPost = async (id) => {
    claims.push(id);
    return stubs.claim(id);
  };
  stubs = { claim: async () => true, send: async () => ({ id: 'msg-1' }), setMessage: async (...a) => saved.push(a) };
  warService.deleteEvent = async (id) => deleted.push(id);
  warService.setMessage = (...a) => stubs.setMessage(...a);
  mock.method(console, 'error', () => {});
  mock.method(console, 'log', () => {});
});
const clientOf = () => ({ channels: { fetch: async () => ({ id: 'chan', send: (p) => stubs.send(p) }) } });

describe('postWarMessage', () => {
  it('sends, stores the ids and returns the event with them', async () => {
    const posted = await postWarMessage(clientOf(), config, event);
    assert.deepEqual(saved, [[event._id, 'chan', 'msg-1']]);
    assert.equal(posted.messageId, 'msg-1');
    assert.equal(posted.channelId, 'chan');
    assert.equal(posted.saved, true);
    assert.deepEqual(deleted, []);
    assert.deepEqual(claims, [event._id], 'claimed before sending');
  });
  it('deletes the event and rethrows when the send itself fails', async () => {
    stubs.send = async () => {
      throw new Error('Missing Permissions');
    };
    await assert.rejects(() => postWarMessage(clientOf(), config, event), /Missing Permissions/);
    assert.deepEqual(deleted, [event._id]);
    assert.deepEqual(saved, []);
  });
  it('deletes the event when the channel cannot be fetched', async () => {
    const client = { channels: { fetch: async () => Promise.reject(new Error('Unknown Channel')) } };
    await assert.rejects(() => postWarMessage(client, config, event), /Unknown Channel/);
    assert.deepEqual(deleted, [event._id]);
  });
  it('keeps the event (and logs) when the message was sent but saving its id failed', async () => {
    stubs.setMessage = async () => {
      throw new Error('db timeout');
    };
    const posted = await postWarMessage(clientOf(), config, event);
    assert.deepEqual(deleted, []);
    assert.equal(posted.messageId, 'msg-1');
    assert.equal(posted.saved, false, 'caller can tell the id is unsaved');
    assert.ok(hasPendingSave(event._id));
    await retryPendingSaves(); // clean up the module-level map
    assert.ok(console.error.mock.calls.some((c) => c.arguments.join(' ').includes('db timeout')));
  });
  it('a failing delete does not hide the original send error', async () => {
    stubs.send = async () => {
      throw new Error('send failed');
    };
    warService.deleteEvent = async () => {
      throw new Error('delete failed');
    };
    await assert.rejects(() => postWarMessage(clientOf(), config, event), /send failed/);
  });
  it('send AND delete failing -> one combined error (so the scheduler backs off and retries), keeping the Discord code', async () => {
    stubs.send = async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    };
    warService.deleteEvent = async () => {
      throw new Error('db down');
    };
    await assert.rejects(
      () => postWarMessage(clientOf(), config, event),
      (err) => /Missing Permissions/.test(err.message) && /db down/.test(err.message) && err.code === 50013 && err.cause.message === 'Missing Permissions'
    );
    assert.deepEqual(saved, []);
  });
});

describe('postWarMessage – claim and unsaved ids', () => {
  const sendsOf = () => {
    const sent = [];
    stubs.send = async (p) => {
      sent.push(p);
      return { id: `msg-${sent.length}` };
    };
    return sent;
  };
  it('the claim is taken BEFORE the send; losing it means no send, no delete, null result', async () => {
    const order = [];
    stubs.claim = async () => {
      order.push('claim');
      return true;
    };
    stubs.send = async () => {
      order.push('send');
      return { id: 'm' };
    };
    await postWarMessage(clientOf(), config, event);
    assert.deepEqual(order, ['claim', 'send']);

    const sent = sendsOf();
    stubs.claim = async () => false;
    assert.equal(await postWarMessage(clientOf(), config, event), null);
    assert.equal(sent.length, 0);
    assert.deepEqual(deleted, []);
  });
  it('two concurrent posts of the same event send exactly once (only the claimer sends)', async () => {
    const sent = sendsOf();
    let taken = false;
    stubs.claim = async () => {
      if (taken) return false;
      taken = true;
      return true;
    };
    const [a, b] = await Promise.all([postWarMessage(clientOf(), config, event), postWarMessage(clientOf(), config, event)]);
    assert.equal(sent.length, 1);
    assert.deepEqual([a, b].filter(Boolean).length, 1);
  });
  it('send OK + save fails: retryPendingSaves saves the SAME message id later, with no second send', async () => {
    const sent = sendsOf();
    let failSave = true;
    stubs.setMessage = async (...a) => {
      if (failSave) throw new Error('db timeout');
      saved.push(a);
    };
    const posted = await postWarMessage(clientOf(), config, event);
    assert.equal(posted.saved, false);
    assert.ok(hasPendingSave(event._id));

    await retryPendingSaves(); // still failing: stays pending
    assert.ok(hasPendingSave(event._id));
    assert.deepEqual(saved, []);

    failSave = false;
    await retryPendingSaves();
    assert.deepEqual(saved, [[String(event._id), 'chan', 'msg-1']]);
    assert.ok(!hasPendingSave(event._id));
    assert.equal(sent.length, 1, 'never re-sent');
    await retryPendingSaves();
    assert.equal(saved.length, 1, 'nothing left to retry');
  });
});
