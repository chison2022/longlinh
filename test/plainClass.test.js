const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const defaults = require('../config/defaults');
const { classId, sameClass, canonicalClass, summarize, groupNamesByClass, orderedClasses, classFromRoles } = require('../src/services/registrationService');
const { parseSettings, formatSettings } = require('../src/services/guildConfigService');
const { resolveClassStyles, autoEmojiNames, clearClassStyles } = require('../src/bot/classStyle');
const { buildWarMessage } = require('../src/bot/ui/warMessage');
const { assertV2Message } = require('./discordLimits');
const { makeRegs } = require('./helpers');

const OLD = '🛡️ Thiết Y';
const NEW = 'Thiết Y';
const INITIALS = { 'Thiết Y': 'TY', 'Tố Vấn': 'TV', 'Huyết Hà': 'HH', 'Thần Tương': 'TT', 'Toái Mộng': 'TM', 'Cửu Linh': 'CL', 'Long Ngâm': 'LN' };
const base = { groupCount: '2', war: 'T7 20:00', open: '', timing: '2/3' };

const coll = (arr) => Object.assign([...arr], { filter: (f) => coll(Array.prototype.filter.call(arr, f)), map: (f) => Array.prototype.map.call(arr, f) });
const fakeGuild = (id, emojiNames) => ({
  id,
  roles: { cache: coll([]) },
  emojis: { cache: coll(emojiNames.map((name, i) => ({ id: String(900 + i), name, animated: false, available: true }))) },
});

describe('defaults', () => {
  it('classes are plain names with a unicode fallback map', () => {
    assert.deepEqual(defaults.classes, Object.keys(INITIALS));
    assert.ok(defaults.classes.every((c) => /^[\p{L} ]+$/u.test(c)));
    assert.ok(defaults.classes.every((c) => defaults.classFallbackEmoji[c]));
  });
});

describe('classId / sameClass / canonicalClass', () => {
  it('old emoji label == plain == lower case; different diacritics differ', () => {
    assert.ok(sameClass(OLD, NEW));
    assert.ok(sameClass(NEW, 'thiết y'));
    assert.equal(classId(OLD), classId(NEW));
    assert.ok(!sameClass('Tố Vấn', 'To Van'));
    assert.ok(!sameClass('Thiết Y', 'Tố Vấn'));
  });
  it('canonicalClass returns the configured label, or the name unchanged', () => {
    assert.equal(canonicalClass(OLD, defaults.classes), NEW);
    assert.equal(canonicalClass('thiết y', defaults.classes), NEW);
    assert.equal(canonicalClass('Phái Mới', defaults.classes), 'Phái Mới');
    assert.equal(canonicalClass(NEW, [OLD]), OLD);
  });
  it('classFromRoles matches plain role to plain or legacy config label', () => {
    assert.equal(classFromRoles(['Thiết Y'], defaults.classes), NEW);
    assert.equal(classFromRoles(['Thiết Y'], [OLD, 'Tố Vấn']), OLD);
  });
});

describe('mixed old/new registrations', () => {
  const regs = [
    { discordId: '1', className: OLD, status: 'join' },
    { discordId: '2', className: NEW, status: 'join' },
    { discordId: '3', className: 'thiết y', status: 'join' },
  ];
  it('summarize / groupNamesByClass / orderedClasses give one bucket with the config label', () => {
    const s = summarize(regs, defaults.classes);
    assert.deepEqual(s.byClass, [{ className: NEW, join: 3 }]);
    const g = groupNamesByClass(regs.map((r) => ({ ...r, displayName: r.discordId })), defaults.classes);
    assert.equal(g.length, 1);
    assert.equal(g[0].className, NEW);
    assert.deepEqual(g[0].join, ['1', '2', '3']);
    assert.equal(orderedClasses(regs, defaults.classes).length, defaults.classes.length);
  });
  it('unknown classes with two spellings merge too', () => {
    const s = summarize([{ discordId: '1', className: '🔥 Lạ', status: 'join' }, { discordId: '2', className: 'Lạ', status: 'join' }], defaults.classes);
    assert.equal(s.byClass.length, 1);
    assert.equal(s.byClass[0].join, 2);
  });
});

describe('settings prefill / save with server emojis', () => {
  beforeEach(() => clearClassStyles());
  const config = (patch) => ({
    classes: [...defaults.classes],
    classEmojis: [],
    groupCount: 2,
    schedule: { enabled: false, warDay: 6, warTime: '20:00', openDay: 1, openTime: '00:00', lockBeforeHours: 2, remindBeforeHours: 3 },
    ...patch,
  });
  const guild = () => fakeGuild('PG1', [...Object.values(INITIALS), 'emoji_1', 'HH_icon']);

  it('prefill shows plain name + matched :TY: token', () => {
    const c = config();
    const f = formatSettings(c, resolveClassStyles(guild(), c.classes, c.classEmojis));
    assert.equal(f.classes, defaults.classes.map((n) => `${n} :${INITIALS[n]}:`).join('\n'));
  });
  it('no server emojis: plain names only', () => {
    const c = config();
    assert.equal(formatSettings(c, resolveClassStyles(fakeGuild('PG2', []), c.classes, [])).classes, defaults.classes.join('\n'));
  });
  it('saving the prefill unchanged stores NO overrides', () => {
    const c = config();
    const g = guild();
    const f = formatSettings(c, resolveClassStyles(g, c.classes, c.classEmojis));
    const r = parseSettings({ ...base, classes: f.classes }, { autoEmoji: (list) => autoEmojiNames(g, list) });
    assert.deepEqual(r.value.classes, defaults.classes);
    assert.deepEqual(r.value.classEmojis, []);
  });
  it('changing one token stores exactly that override; :none: is stored', () => {
    const c = config();
    const g = guild();
    const lines = formatSettings(c, resolveClassStyles(g, c.classes, [])).classes.split('\n');
    lines[2] = 'Huyết Hà :HH_icon:';
    lines[1] = 'Tố Vấn :none:';
    const r = parseSettings({ ...base, classes: lines.join('\n') }, { autoEmoji: (list) => autoEmojiNames(g, list) });
    assert.deepEqual(r.value.classEmojis, [{ className: 'Tố Vấn', emoji: 'none' }, { className: 'Huyết Hà', emoji: 'HH_icon' }]);
  });
  it('stored override is shown in the prefill; legacy emoji label shows plain', () => {
    const c = config({ classes: [OLD, 'Tố Vấn'], classEmojis: [{ className: OLD, emoji: 'none' }] });
    const f = formatSettings(c, resolveClassStyles(guild(), c.classes, c.classEmojis));
    assert.equal(f.classes, 'Thiết Y :none:\nTố Vấn :TV:');
  });
});

describe('unicode fallback', () => {
  it('embed shows the fallback emoji for plain default classes when no server emoji matches', () => {
    const regs = [{ discordId: '1', className: NEW, status: 'join' }, { discordId: '2', className: OLD, status: 'join' }];
    const e = assertV2Message(buildWarMessage({ _id: 'e1', title: 't', startAt: new Date(), status: 'open', deadlineAt: new Date() }, regs, { classes: defaults.classes, schedule: defaults.schedule }));
    assert.match(e.text, /🛡️ TY 2/);
  });
});
