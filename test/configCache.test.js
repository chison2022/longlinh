// getConfig is read-only and cached; writes refresh the cache. The database is a fake backend that hands every guilds query to
// the two stubbed calls below (findOne = a read, findOneAndUpdate = a write with { $set } / { $setOnInsert }), so no database is needed.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const svc = require('../src/services/guildConfigService');

const GuildConfig = { findOne() {}, findOneAndUpdate() {} };
const asRow = (guildId, doc) => (doc ? [{ id: guildId, settings: doc }] : []);
db.useBackend({
  async query(sql, params) {
    const guildId = params[0];
    if (/^\s*select/i.test(sql)) return { rows: asRow(guildId, await GuildConfig.findOne({ guildId }).lean()) };
    if (/with ins as/.test(sql)) return { rows: asRow(guildId, await GuildConfig.findOneAndUpdate({ guildId }, { $setOnInsert: { guildId } })) };
    return { rows: asRow(guildId, await GuildConfig.findOneAndUpdate({ guildId }, { $set: JSON.parse(params[2]) })) };
  },
});
const defaults = require('../config/defaults');

const G = '700000000000000001';
let docs; // what the "database" holds
let reads;
let writes;

beforeEach(() => {
  svc.clearConfigCache();
  docs = new Map();
  reads = 0;
  writes = 0;
  mock.method(GuildConfig, 'findOne', ({ guildId }) => ({
    lean: async () => {
      reads += 1;
      return docs.get(guildId) || null;
    },
  }));
  mock.method(GuildConfig, 'findOneAndUpdate', async ({ guildId }, update) => {
    writes += 1;
    const doc = { ...(docs.get(guildId) || svc.defaultConfig(guildId)), ...(update.$set || {}) };
    docs.set(guildId, doc);
    return doc;
  });
});
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

describe('getConfig cache', () => {
  it('fresh: true bypasses a cached value and refreshes the cache with what it read', async () => {
    docs.set(G, { ...svc.defaultConfig(G), groupCount: 2 });
    assert.equal((await svc.getConfig(G)).groupCount, 2);
    docs.set(G, { ...svc.defaultConfig(G), groupCount: 3 }); // another process changed it
    assert.equal((await svc.getConfig(G)).groupCount, 2, 'cached');
    assert.equal((await svc.getConfigOrDefault(G, { fresh: true })).groupCount, 3);
    assert.equal(reads, 2);
    assert.equal((await svc.getConfig(G)).groupCount, 3);
    assert.equal(reads, 2, 'the fresh read refreshed the cache');
  });
  it('never writes and serves repeated reads from memory', async () => {
    docs.set(G, { ...svc.defaultConfig(G), groupCount: 7 });
    assert.equal((await svc.getConfig(G)).groupCount, 7);
    assert.equal((await svc.getConfig(G)).groupCount, 7);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
  });
  it('returns null (no upsert) for an unknown guild, and getConfigOrDefault falls back to defaults', async () => {
    assert.equal(await svc.getConfig(G), null);
    const c = await svc.getConfigOrDefault(G);
    assert.deepEqual(c.classes, defaults.classes);
    assert.equal(c.groupCount, defaults.groupCount);
    assert.deepEqual(c.adminRoleIds, []);
    assert.equal(writes, 0);
    assert.equal(docs.size, 0);
  });
  it('defaultConfig returns fresh copies', () => {
    const a = svc.defaultConfig(G);
    a.classes.push('x');
    a.schedule.enabled = true;
    assert.deepEqual(svc.defaultConfig(G).classes, defaults.classes);
    assert.equal(svc.defaultConfig(G).schedule.enabled, defaults.schedule.enabled);
  });
  it('updateConfig refreshes the cached value immediately', async () => {
    docs.set(G, svc.defaultConfig(G));
    await svc.getConfig(G);
    await svc.updateConfig(G, { groupCount: 4 });
    assert.equal((await svc.getConfig(G)).groupCount, 4);
    assert.equal(reads, 1, 'served from the refreshed cache entry');
  });
  it('getOrCreateConfig writes (setup only) and primes the cache', async () => {
    await svc.getOrCreateConfig(G);
    assert.equal(writes, 1);
    await svc.getConfig(G);
    assert.equal(reads, 0);
  });
  it('entries expire after the TTL', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    docs.set(G, svc.defaultConfig(G));
    await svc.getConfig(G);
    mock.timers.tick(svc.CONFIG_TTL_MS - 1);
    await svc.getConfig(G);
    assert.equal(reads, 1);
    mock.timers.tick(2);
    await svc.getConfig(G);
    assert.equal(reads, 2);
  });
  it('a read in flight during updateConfig does not re-cache the stale doc', async () => {
    docs.set(G, { ...svc.defaultConfig(G), adminRoleIds: ['role-admin'] });
    let release;
    const gate = new Promise((r) => (release = r));
    mock.restoreAll();
    mock.method(GuildConfig, 'findOne', ({ guildId }) => ({
      lean: async () => {
        const snapshot = docs.get(guildId); // read the old doc, then stall before returning it
        await gate;
        return snapshot;
      },
    }));
    mock.method(GuildConfig, 'findOneAndUpdate', async ({ guildId }, update) => {
      const doc = { ...docs.get(guildId), ...update.$set };
      docs.set(guildId, doc);
      return doc;
    });
    const slowRead = svc.getConfig(G); // starts before the write
    await svc.updateConfig(G, { adminRoleIds: [] });
    release();
    assert.deepEqual((await slowRead).adminRoleIds, ['role-admin'], 'the in-flight caller sees what it read');
    assert.deepEqual((await svc.getConfig(G)).adminRoleIds, [], 'but the cache holds the new value');
  });
  it('a read in flight during getOrCreateConfig does not clobber the cache either', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    mock.restoreAll();
    mock.method(GuildConfig, 'findOne', () => ({
      lean: async () => {
        await gate;
        return null; // read before the document existed
      },
    }));
    mock.method(GuildConfig, 'findOneAndUpdate', async ({ guildId }) => ({ ...svc.defaultConfig(guildId), groupCount: 3 }));
    const slowRead = svc.getConfig(G);
    await svc.getOrCreateConfig(G);
    release();
    assert.equal(await slowRead, null);
    assert.equal((await svc.getConfig(G)).groupCount, 3);
  });
  it('a write that throws still bumps the generation: a read begun during the write and finishing after it does not cache', async () => {
    docs.set(G, { ...svc.defaultConfig(G), groupCount: 4 });
    let releaseRead;
    let failWrite;
    const readGate = new Promise((r) => (releaseRead = r));
    const writeGate = new Promise((r) => (failWrite = r));
    mock.restoreAll();
    mock.method(GuildConfig, 'findOne', () => ({
      lean: async () => {
        const snapshot = docs.get(G);
        await readGate;
        return snapshot;
      },
    }));
    mock.method(GuildConfig, 'findOneAndUpdate', async () => {
      await writeGate;
      throw new Error('db down');
    });
    const write = svc.updateConfig(G, { groupCount: 3 });
    const slowRead = svc.getConfig(G); // starts after the write began (and after its first bump)
    failWrite();
    await assert.rejects(() => write, /db down/);
    releaseRead();
    await slowRead;
    mock.restoreAll();
    let reread = 0;
    mock.method(GuildConfig, 'findOne', () => ({ lean: async () => (reread++, docs.get(G)) }));
    await svc.getConfig(G);
    assert.equal(reread, 1, 'the in-flight read was not cached');
  });
  it('two concurrent writers resolving out of order leave nothing stale in the cache', async () => {
    // A is applied first in the DB but answers last; B is applied second and answers first.
    const release = {};
    const gates = { A: new Promise((r) => (release.A = r)), B: new Promise((r) => (release.B = r)) };
    mock.restoreAll();
    mock.method(GuildConfig, 'findOne', ({ guildId }) => ({
      lean: async () => {
        reads += 1;
        return docs.get(guildId) || null;
      },
    }));
    mock.method(GuildConfig, 'findOneAndUpdate', async ({ guildId }, update) => {
      const who = update.$set.groupCount === 2 ? 'A' : 'B';
      const doc = { ...(docs.get(guildId) || svc.defaultConfig(guildId)), ...update.$set };
      docs.set(guildId, doc); // applied now (A before B)...
      await gates[who]; // ...but answered when released
      return doc;
    });
    const a = svc.updateConfig(G, { groupCount: 2 });
    await Promise.resolve();
    const b = svc.updateConfig(G, { groupCount: 3 });
    await new Promise((r) => setImmediate(r));
    release.B();
    await b;
    release.A();
    const aDoc = await a;
    assert.equal(aDoc.groupCount, 2, 'each caller gets its own result back');
    // A's answer (groupCount 2) is the older one: it must not end up in the cache; the DB value (3) is what reads see.
    assert.equal((await svc.getConfig(G)).groupCount, 3);
  });
  it('the opposite order (first writer answers first) also ends with the DB value', async () => {
    const release = {};
    const gates = { A: new Promise((r) => (release.A = r)), B: new Promise((r) => (release.B = r)) };
    mock.restoreAll();
    mock.method(GuildConfig, 'findOne', ({ guildId }) => ({ lean: async () => docs.get(guildId) || null }));
    mock.method(GuildConfig, 'findOneAndUpdate', async ({ guildId }, update) => {
      const who = update.$set.groupCount === 2 ? 'A' : 'B';
      // B is applied BEFORE A in the DB, but A answers first
      const doc = { ...(docs.get(guildId) || svc.defaultConfig(guildId)), ...update.$set };
      if (who === 'B') docs.set(guildId, doc);
      await gates[who];
      if (who === 'A') docs.set(guildId, { ...docs.get(guildId), ...update.$set });
      return doc;
    });
    const a = svc.updateConfig(G, { groupCount: 2 });
    await Promise.resolve();
    const b = svc.updateConfig(G, { groupCount: 3 });
    await new Promise((r) => setImmediate(r));
    release.A();
    await a;
    release.B();
    await b;
    assert.equal((await svc.getConfig(G)).groupCount, 2, 'B returned a doc without the later write of A: must not be cached');
  });
});
