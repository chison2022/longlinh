const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Client, Events } = require('discord.js');
const { startBot, getClient } = require('../src/bot/client');
const { resolveClassStyles, clearClassStyles } = require('../src/bot/classStyle');

// A real discord.js Client, but login() does nothing (no network); events are emitted by hand.
describe('client: class style cache invalidation listeners', () => {
  afterEach(async () => {
    mock.restoreAll();
    clearClassStyles();
    if (getClient()) await getClient().destroy();
  });
  const coll = (arr) => Object.assign([...arr], { filter: (f) => coll(arr.filter(f)), map: (f) => arr.map(f) });
  const guild = (id) => ({ id, roles: { cache: coll([]) }, emojis: { cache: coll([{ id: '7', name: 'tovan', animated: false }]) } });
  const prime = (g) => resolveClassStyles(g, ['Tố Vấn']);
  const cached = (g, before) => resolveClassStyles(g, ['Tố Vấn']) === before;

  it('emoji create/update/delete and role create/delete drop that guild only', async () => {
    mock.method(Client.prototype, 'login', async () => 'x');
    const client = await startBot('t');
    for (const ev of [Events.GuildEmojiCreate, Events.GuildEmojiUpdate, Events.GuildEmojiDelete, Events.GuildRoleCreate, Events.GuildRoleDelete]) {
      const g = guild('G-' + ev);
      const other = guild('O-' + ev);
      const a = prime(g);
      const b = prime(other);
      const arg = { guild: { id: g.id } };
      if (ev === Events.GuildEmojiUpdate) client.emit(ev, { guild: { id: g.id } }, arg);
      else client.emit(ev, arg);
      assert.equal(cached(g, a), false, ev);
      assert.equal(cached(other, b), true, ev + ' other guild untouched');
    }
  });
  it('roleUpdate (old, new) uses the NEW role guild id', async () => {
    mock.method(Client.prototype, 'login', async () => 'x');
    const client = await startBot('t');
    const g = guild('GU');
    const a = prime(g);
    client.emit(Events.GuildRoleUpdate, { guild: { id: 'other' } }, { guild: { id: 'GU' } });
    assert.equal(cached(g, a), false);
  });
  it('an event without a guild is a no-op (does not clear other guilds)', async () => {
    mock.method(Client.prototype, 'login', async () => 'x');
    const client = await startBot('t');
    const g = guild('GN');
    const a = prime(g);
    client.emit(Events.GuildEmojiCreate, {});
    assert.equal(cached(g, a), true);
  });
});
