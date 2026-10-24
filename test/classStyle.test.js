const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadEmojiImage, clearEmojiCache } = require('../src/bot/ui/canvasKit');
const defaults = require('../config/defaults');
const { createCanvas } = require('@napi-rs/canvas');
const { classCodes, slug, matchClassStyles, resolveClassStyles, invalidateClassStyles, clearClassStyles, editReplyWithEmojiFallback, lineupStyles, optionEmoji } = require('../src/bot/classStyle');
const { splitClassToken } = require('../src/services/lineupStyle');
const { classFromRoles } = require('../src/services/registrationService');
const { parseSettings, formatSettings } = require('../src/services/guildConfigService');
const { buildWarMessage, buildListEmbeds, buildClassSelect } = require('../src/bot/ui/warMessage');
const { assertEmbed, assertV2Message } = require('./discordLimits');
const { vn, makeRegs } = require('./helpers');

const CLASSES = defaults.classes;
const emo = (name, id, animated = false) => ({ id, name, animated });
const TEST_EMOJIS = ['huyetha', 'tovan', 'thantuong', 'toaimong', 'thiety', 'cuulinh', 'longngam'].map((n, i) => emo(n, `10${i}`));

describe('slug', () => {
  it('lower-case, no diacritics, đ -> d, only [a-z0-9]', () => {
    assert.equal(slug('Thiết Y'), 'thiety');
    assert.equal(slug('Đại Hiệp'), 'daihiep');
    assert.equal(slug('Toái Mộng!'), 'toaimong');
    assert.equal(slug('HH_icon'), 'hhicon');
  });
});

describe('matchClassStyles', () => {
  it('exact slug match for every default class, with emojiText <:name:id>', () => {
    const m = matchClassStyles(CLASSES, [], TEST_EMOJIS);
    assert.equal(m.get('Huyết Hà').emojiText, '<:huyetha:100>');
    assert.deepEqual(m.get('Thiết Y').emoji, { id: '104', name: 'thiety', animated: false });
    assert.equal(m.get('Long Ngâm').plain, 'Long Ngâm');
    assert.ok(CLASSES.every((c) => m.get(c).emoji));
  });
  it('animated emoji uses <a:name:id>', () => {
    assert.equal(matchClassStyles(['Thiết Y'], [], [emo('thiety', '9', true)]).get('Thiết Y').emojiText, '<a:thiety:9>');
  });
  it('no fuzzy "contains" tier: linh / long / huyetha_icon do not match; exact still beats near names', () => {
    assert.equal(matchClassStyles(['Cửu Linh'], [], [emo('linh', '1')]).get('Cửu Linh').emoji, null);
    assert.equal(matchClassStyles(['Long Ngâm'], [], [emo('long', '1')]).get('Long Ngâm').emoji, null);
    assert.equal(matchClassStyles(['Huyết Hà'], [], [emo('huyetha_icon', '1')]).get('Huyết Hà').emoji, null);
    assert.equal(matchClassStyles(['Tố Vấn'], [], [emo('tovan_x', '1'), emo('tovan', '2')]).get('Tố Vấn').emoji.id, '2');
  });
  it('override :none: opts out of a custom emoji (unicode prefix fallback)', () => {
    const m = matchClassStyles(['🩸 Huyết Hà'], [], TEST_EMOJIS, [{ className: '🩸 Huyết Hà', emoji: 'none' }]);
    assert.equal(m.get('🩸 Huyết Hà').emoji, null);
    assert.equal(m.get('🩸 Huyết Hà').emojiText, '🩸');
  });
  it('managed and role-restricted emojis are skipped unless the bot has one of the roles', () => {
    assert.equal(matchClassStyles(['Huyết Hà'], [], [{ ...emo('huyetha', '1'), managed: true }]).get('Huyết Hà').emoji, null);
    const restricted = { ...emo('huyetha', '2'), roleIds: ['r1'] };
    assert.equal(matchClassStyles(['Huyết Hà'], [], [restricted], {}, ['r9']).get('Huyết Hà').emoji, null);
    assert.equal(matchClassStyles(['Huyết Hà'], [], [restricted], {}, ['r9', 'r1']).get('Huyết Hà').emoji.id, '2');
    assert.equal(matchClassStyles(['Huyết Hà'], [], [{ ...emo('huyetha', '3'), roleIds: [], managed: false }]).get('Huyết Hà').emoji.id, '3');
  });
  it('ambiguous emoji names are deterministic: shortest name, then alphabetical, whatever the input order', () => {
    const list = [emo('huyet_ha', '3'), emo('Huyet_Ha', '2'), emo('huyet__ha', '1')];
    for (const l of [list, [...list].reverse()]) assert.equal(matchClassStyles(['Huyết Hà'], [], l).get('Huyết Hà').emoji.id, '2');
  });
  it('override :name: wins over auto match; unknown override falls back to auto', () => {
    const emojis = [...TEST_EMOJIS, emo('HH_icon', '55')];
    assert.equal(matchClassStyles(['🩸 Huyết Hà'], [], emojis, { '🩸 Huyết Hà': 'hh_icon' }).get('🩸 Huyết Hà').emoji.id, '55');
    assert.equal(matchClassStyles(['🩸 Huyết Hà'], [], emojis, [{ className: '🩸 Huyết Hà', emoji: 'nope' }]).get('🩸 Huyết Hà').emoji.id, '100');
  });
  it('no match: unicode prefix of the label, else a bullet', () => {
    const m = matchClassStyles(['🩸 Huyết Hà', 'Tố Vấn', 'Phái Mới'], [], []);
    assert.equal(m.get('🩸 Huyết Hà').emojiText, '🩸');
    assert.equal(m.get('Tố Vấn').emojiText, '💊'); // plain default class: fallback map
    assert.equal(m.get('Phái Mới').emojiText, '•');
    assert.equal(m.get('Tố Vấn').emoji, null);
  });
  it('role colour by normalised name; colour 0 -> null; no role -> null', () => {
    const roles = [{ name: 'Huyết Hà', color: 0xff0000 }, { name: '🛡️ Thiết Y', color: 0 }, { name: 'Other', color: 5 }];
    const m = matchClassStyles(['🩸 Huyết Hà', '🛡️ Thiết Y', 'Tố Vấn'], roles, []);
    assert.equal(m.get('🩸 Huyết Hà').color, 0xff0000);
    assert.equal(m.get('🛡️ Thiết Y').color, null);
    assert.equal(m.get('Tố Vấn').color, null);
  });
});

describe('initials rule (real guild emoji names)', () => {
  const INITIALS = ['TT', 'CL', 'TY', 'LN', 'HH', 'TM', 'TV'];
  const real = INITIALS.map((n, i) => emo(n, String(500 + i)));
  const noise = Array.from({ length: 26 }, (_, i) => emo(`emoji_${i + 7}`, String(600 + i)));
  noise.push(emo('emoji_11', '699')); // duplicate name
  const all = [...noise.slice(0, 10), ...real, ...noise.slice(10)];
  const want = { 'Thiết Y': 'TY', 'Tố Vấn': 'TV', 'Huyết Hà': 'HH', 'Thần Tương': 'TT', 'Toái Mộng': 'TM', 'Cửu Linh': 'CL', 'Long Ngâm': 'LN' };
  it('all 7 classes map to their initials emoji; emoji_N noise never matches', () => {
    for (const list of [all, [...all].reverse()]) {
      const m = matchClassStyles(CLASSES, [], list);
      for (const [c, n] of Object.entries(want)) assert.equal(m.get(c).emoji.name, n, c);
    }
    const none = matchClassStyles(CLASSES, [], noise);
    assert.ok(CLASSES.every((c) => none.get(c).emoji === null));
  });
  it('exact slug beats initials; initials are case-insensitive', () => {
    assert.equal(matchClassStyles(['Thiết Y'], [], [emo('ty', '1'), emo('thiety', '2')]).get('Thiết Y').emoji.id, '2');
    assert.equal(matchClassStyles(['Thiết Y'], [], [emo('Ty', '1')]).get('Thiết Y').emoji.id, '1');
  });
  it('classes with the same initials skip the rule (unless slug/override matches)', () => {
    const m = matchClassStyles(['Thần Tương', 'Thiên Thanh'], [], [emo('TT', '1'), emo('thiênthanh', '2')]);
    assert.equal(m.get('Thần Tương').emoji, null);
    assert.equal(m.get('Thiên Thanh').emoji.id, '2');
    const o = matchClassStyles(['Thần Tương', 'Thiên Thanh'], [], [emo('TT', '1')], { 'Thần Tương': 'TT' });
    assert.equal(o.get('Thần Tương').emoji.id, '1');
  });
});

describe('class override token', () => {
  it('splitClassToken strips a trailing :name:', () => {
    assert.deepEqual(splitClassToken('Huyết Hà :huyetha:'), { name: 'Huyết Hà', emoji: 'huyetha' });
    assert.deepEqual(splitClassToken('🩸 Huyết Hà :HH_icon:'), { name: '🩸 Huyết Hà', emoji: 'HH_icon' });
    assert.deepEqual(splitClassToken('🩸 Huyết Hà'), { name: '🩸 Huyết Hà', emoji: null });
    assert.deepEqual(splitClassToken(':only:'), { name: ':only:', emoji: null });
  });
  it('parseSettings stores the class WITHOUT the token and keeps the override separately', () => {
    const r = parseSettings({ classes: '🩸 Huyết Hà :HH_icon:\nTố Vấn\n🛡️ Thiết Y :thiety:', groupCount: '2', war: 'T7 20:00', open: '', timing: '2/3' });
    assert.deepEqual(r.value.classes, ['🩸 Huyết Hà', 'Tố Vấn', '🛡️ Thiết Y']);
    assert.deepEqual(r.value.classEmojis, [{ className: '🩸 Huyết Hà', emoji: 'HH_icon' }, { className: '🛡️ Thiết Y', emoji: 'thiety' }]);
  });
  it('the token does not count toward the class length limit and "A" / "A :x:" are reported as one class', () => {
    const name = 'x'.repeat(40);
    assert.equal(parseSettings({ classes: `${name} :abc_def:`, groupCount: '2', war: 'T7 20:00', open: '', timing: '2/3' }).error, undefined);
    const r = parseSettings({ classes: 'A\nA :ab:', groupCount: '2', war: 'T7 20:00', open: '', timing: '2/3' });
    assert.match(r.error, /trùng/);
  });
  it('formatSettings shows the token again; settings round-trip', () => {
    const config = {
      classes: ['🩸 Huyết Hà', 'Tố Vấn'],
      classEmojis: [{ className: '🩸 Huyết Hà', emoji: 'HH_icon' }],
      groupCount: 2,
      schedule: { enabled: false, warDay: 6, warTime: '20:00', openDay: 1, openTime: '00:00', lockBeforeHours: 2, remindBeforeHours: 3 },
    };
    const f = formatSettings(config);
    assert.equal(f.classes, 'Huyết Hà :HH_icon:\nTố Vấn'); // legacy emoji label shows plain
    const back = parseSettings(f).value;
    assert.deepEqual(back.classes, ['Huyết Hà', 'Tố Vấn']);
    assert.deepEqual(back.classEmojis, [{ className: 'Huyết Hà', emoji: 'HH_icon' }]);
  });
  it('registered classNames equal the clean class and classFromRoles still matches the role', () => {
    const { classes } = parseSettings({ classes: 'Huyết Hà :HH_icon:\nTố Vấn', groupCount: '2', war: 'T7 20:00', open: '', timing: '2/3' }).value;
    assert.equal(classFromRoles(['Huyết Hà', '@everyone'], classes), 'Huyết Hà');
    assert.equal(classFromRoles(['Huyết Hà'], ['🩸 Huyết Hà', 'Tố Vấn']), '🩸 Huyết Hà'); // legacy config label
    assert.ok(classes.every((c) => !c.includes(':')));
  });
});

describe('resolveClassStyles (guild wrapper)', () => {
  const coll = (arr) => Object.assign([...arr], { filter: (f) => coll(Array.prototype.filter.call(arr, f)), map: (f) => Array.prototype.map.call(arr, f) });
  const guildOf = (id, emojis) => {
    const g = { id, reads: 0, roles: { cache: coll([{ name: 'Tố Vấn', color: 0x00ff00 }]) } };
    g.emojis = { get cache() { g.reads++; return coll(emojis); } };
    return g;
  };
  beforeEach(() => clearClassStyles());
  it('reads roles + emojis, caches per guild, and invalidates on demand', () => {
    const g = guildOf('G1', [{ id: '7', name: 'tovan', animated: false, available: true }]);
    const a = resolveClassStyles(g, ['Tố Vấn']);
    assert.equal(a.get('Tố Vấn').emojiText, '<:tovan:7>');
    assert.equal(a.get('Tố Vấn').color, 0x00ff00);
    assert.equal(resolveClassStyles(g, ['Tố Vấn']), a);
    assert.equal(g.reads, 1);
    assert.notEqual(resolveClassStyles(g, ['Tố Vấn', 'Khác']), a, 'a different class list recomputes');
    invalidateClassStyles('G1');
    resolveClassStyles(g, ['Tố Vấn', 'Khác']);
    assert.equal(g.reads, 3);
  });
  it('available === false, managed and role-restricted emojis are filtered by the wrapper', () => {
    const rolesOf = (...ids) => ({ cache: { keys: () => ids[Symbol.iterator]() } });
    const g = guildOf('G2', [
      { id: '1', name: 'tovan', animated: false, available: false },
      { id: '2', name: 'tovan', animated: false, managed: true },
      { id: '3', name: 'tovan', animated: false, roles: rolesOf('rx') },
    ]);
    assert.equal(resolveClassStyles(g, ['Tố Vấn']).get('Tố Vấn').emoji, null);
    invalidateClassStyles('G2');
    g.members = { me: { roles: { cache: { keys: () => ['rx'][Symbol.iterator]() } } } };
    assert.equal(resolveClassStyles(g, ['Tố Vấn']).get('Tố Vấn').emoji.id, '3');
  });
  it('invalidateClassStyles with a falsy id is a no-op; clearClassStyles drops everything', () => {
    const g = guildOf('G3', [{ id: '7', name: 'tovan', animated: false }]);
    const a = resolveClassStyles(g, ['Tố Vấn']);
    invalidateClassStyles(undefined);
    assert.equal(resolveClassStyles(g, ['Tố Vấn']), a);
    clearClassStyles();
    assert.notEqual(resolveClassStyles(g, ['Tố Vấn']), a);
  });
  it('role colour comes from colors.primaryColor (falls back to the deprecated color)', () => {
    const g = guildOf('G4', []);
    g.roles = { cache: coll([{ name: 'Tố Vấn', colors: { primaryColor: 0x123456 }, color: 1 }, { name: 'Huyết Hà', color: 0x654321 }]) };
    const m = resolveClassStyles(g, ['Tố Vấn', 'Huyết Hà']);
    assert.equal(m.get('Tố Vấn').color, 0x123456);
    assert.equal(m.get('Huyết Hà').color, 0x654321);
  });
  it('no guild -> empty map', () => {
    assert.equal(resolveClassStyles(null, ['A']).size, 0);
  });
});

describe('builders with styles', () => {
  const event = { _id: '652f1c2e9b1d4a0012345678', guildId: '1', title: 'Bang chiến', startAt: vn(2026, 10, 11, 20, 0), deadlineAt: vn(2026, 10, 11, 18, 0), status: 'open', teams: [] };
  const styles = matchClassStyles(CLASSES, [{ name: 'Huyết Hà', color: 0xff0000 }], TEST_EMOJIS);
  const regs = makeRegs(6, { classOf: (i) => CLASSES[2 + (i % 2)] });

  it('war embed per-class counts use the custom emoji and plain name', () => {
    const text = assertV2Message(buildWarMessage(event, regs, { classes: CLASSES, schedule: defaults.schedule }, styles)).text;
    assert.match(text, /<:huyetha:100> HH 3  <:thantuong:102> TT 3/);
  });
  it('without styles a class shows its unicode emoji', () => {
    const text = assertV2Message(buildWarMessage(event, regs, { classes: CLASSES, schedule: defaults.schedule })).text;
    assert.match(text, /🩸 HH 3  ⚔️ TT 3/);
  });
  it('list embed field names use the custom emoji', () => {
    const names = buildListEmbeds(event, regs, CLASSES, styles).flatMap((e) => e.toJSON().fields.map((f) => f.name));
    assert.ok(names[0].startsWith('<:huyetha:100> Huyết Hà (3)'), names[0]);
  });
  it('class select: label = plain, value = class name, emoji object (custom) or unicode or omitted', () => {
    const opts = buildClassSelect('war:cls:x:join', [...CLASSES, 'Phái Mới'], '🩸 Huyết Hà', styles).toJSON().components[0].options;
    assert.deepEqual(opts[2], { label: 'Huyết Hà', value: 'Huyết Hà', default: true, emoji: { id: '100', name: 'huyetha', animated: false } });
    assert.equal(opts.at(-1).emoji, undefined);
    const plain = buildClassSelect('war:cls:x:join', CLASSES, undefined).toJSON().components[0].options;
    assert.deepEqual(plain[0].emoji, { name: '🛡️' });
    assert.equal(optionEmoji({ emoji: null, emojiText: '•' }), undefined);
  });
});

describe('loadEmojiImage hardening', () => {
  beforeEach(() => clearEmojiCache());
  const ID = (n) => `3000000000000${String(n).padStart(4, '0')}`;
  const png = async () => {
    const c = createCanvas(8, 8);
    c.getContext('2d').fillRect(0, 0, 8, 8);
    return c.encode('png');
  };
  const okRes = async () => {
    const buf = await png();
    return { ok: true, headers: { get: () => String(buf.length) }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  it('concurrent loads of one id share one fetch', async () => {
    let calls = 0;
    const fetchFn = async () => (calls++, okRes());
    const [a, b] = await Promise.all([loadEmojiImage(ID(1), fetchFn), loadEmojiImage(ID(1), fetchFn)]);
    assert.ok(a && a === b);
    assert.equal(calls, 1);
  });
  it('an invalid id is never fetched', async () => {
    let calls = 0;
    for (const id of ['1', '../x', '123456789012345678/../../a', 'abcdefghijklmnopq', undefined]) assert.equal(await loadEmojiImage(id, async () => (calls++, okRes())), null);
    assert.equal(calls, 0);
  });
  it('a non-ok response cancels its body; a too-large content-length is skipped', async () => {
    let cancelled = 0;
    const body = { cancel: async () => cancelled++ };
    assert.equal(await loadEmojiImage(ID(2), async () => ({ ok: false, body })), null);
    assert.equal(cancelled, 1);
    let read = 0;
    const big = async () => ({ ok: true, body, headers: { get: () => '262145' }, arrayBuffer: async () => (read++, new ArrayBuffer(8)) });
    assert.equal(await loadEmojiImage(ID(3), big), null);
    assert.equal(read, 0);
  });
  it('the cache is capped at 200 entries, oldest first', async () => {
    let calls = 0;
    const res = await okRes();
    const fetchFn = async () => (calls++, res);
    for (let n = 0; n < 201; n++) await loadEmojiImage(ID(100 + n), fetchFn);
    assert.equal(calls, 201);
    await loadEmojiImage(ID(300), fetchFn); // newest: still cached
    assert.equal(calls, 201);
    await loadEmojiImage(ID(100), fetchFn); // oldest: evicted, fetched again
    assert.equal(calls, 202);
  });
});

describe('lineup workbook with role colours', () => {
});

describe('optionEmoji (unicode) and select labels', () => {
  const text = (emojiText) => optionEmoji({ emoji: null, emojiText });
  it('appends VS16 to a lone BMP pictograph; keeps whole single-cluster sequences; rejects the rest', () => {
    assert.deepEqual(text('⚔'), { name: '⚔\u{FE0F}' });
    assert.deepEqual(text('⚔️'), { name: '⚔️' });
    assert.deepEqual(text('🩸'), { name: '🩸' });
    assert.deepEqual(text('👨‍👩‍👧‍👦'), { name: '👨‍👩‍👧‍👦' });
    assert.deepEqual(text('👍🏽'), { name: '👍🏽' });
    assert.deepEqual(text('🇻🇳'), { name: '🇻🇳' });
    assert.equal(text('⚔⚔'), undefined, 'two clusters');
    assert.equal(text('•'), undefined);
  });
  it('a label whose marker is not a valid option emoji keeps the full class name; noEmoji drops all option emoji', () => {
    const classes = ['⚔⚔ Kiếm', '🩸 Huyết Hà'];
    const styles = matchClassStyles(classes, [], []);
    const opts = buildClassSelect('war:cls:x:join', classes, undefined, styles).toJSON().components[0].options;
    assert.equal(opts[0].label, '⚔⚔ Kiếm');
    assert.equal(opts[0].emoji, undefined);
    assert.equal(opts[1].label, 'Huyết Hà');
    const off = buildClassSelect('war:cls:x:join', classes, undefined, styles, { noEmoji: true }).toJSON().components[0].options;
    assert.deepEqual(off.map((o) => o.label), ['⚔⚔ Kiếm', '🩸 Huyết Hà']);
    assert.ok(off.every((o) => !o.emoji));
  });
});

describe('editReplyWithEmojiFallback', () => {
  const invalid = () => Object.assign(new Error('Invalid Form Body'), { code: 50035 });
  it('50035 -> invalidates the guild cache and retries once without option emojis', async () => {
    clearClassStyles();
    const arr = Object.assign([{ id: '7', name: 'tovan', animated: false }], {});
    arr.filter = (fn) => Object.assign(Array.prototype.filter.call(arr, fn), { map: (m) => Array.prototype.map.call(Array.prototype.filter.call(arr, fn), m) });
    const g = { id: 'GF', roles: { cache: { map: () => [] } }, emojis: { cache: arr } };
    const first = resolveClassStyles(g, ['Tố Vấn']);
    const sent = [];
    const interaction = {
      guildId: 'GF',
      editReply: async (p) => {
        sent.push(p);
        if (sent.length === 1) throw invalid();
        return 'ok';
      },
    };
    assert.equal(await editReplyWithEmojiFallback(interaction, (noEmoji) => ({ noEmoji })), 'ok');
    assert.deepEqual(sent, [{ noEmoji: false }, { noEmoji: true }]);
    assert.notEqual(resolveClassStyles(g, ['Tố Vấn']), first, 'cache was invalidated');
  });
  it('other errors propagate without a retry; a second 50035 is not swallowed', async () => {
    let n = 0;
    await assert.rejects(editReplyWithEmojiFallback({ editReply: async () => (n++, Promise.reject(new Error('x'))) }, () => ({})), /x/);
    assert.equal(n, 1);
    n = 0;
    await assert.rejects(editReplyWithEmojiFallback({ editReply: async () => (n++, Promise.reject(invalid())) }, () => ({})), { code: 50035 });
    assert.equal(n, 2);
  });
});

describe('classCodes', () => {
  it('initials, and the next letter when two classes share them', () => {
    assert.deepEqual([...classCodes(['Tố Vấn', 'Thiết Y', 'Huyết Hà'])], [['Tố Vấn', 'TV'], ['Thiết Y', 'TY'], ['Huyết Hà', 'HH']]);
    const m = classCodes(['Thiết Y', 'Tây Yên', 'Tây Yến']);
    assert.equal(m.get('Thiết Y'), 'TY');
    assert.equal(new Set(m.values()).size, 3);
    assert.ok(m.get('Tây Yên').startsWith('TY') && m.get('Tây Yên') !== 'TY');
  });
  it('the war message shows the disambiguated code', () => {
    const cfg = { classes: ['Thiết Y', 'Tây Yên'], groupCount: 1, schedule: defaults.schedule };
    const ev = { _id: 'e1', title: 'W', status: 'open', startAt: new Date(), deadlineAt: new Date(Date.now() + 1e6), teams: [] };
    const regs = [{ discordId: '1', displayName: 'a', className: 'Thiết Y', status: 'join' }, { discordId: '2', displayName: 'b', className: 'Tây Yên', status: 'join' }];
    const styles = new Map([['Thiết Y', { emojiText: '💊', plain: 'Thiết Y' }], ['Tây Yên', { emojiText: '🗡️', plain: 'Tây Yên' }]]);
    const text = JSON.stringify(buildWarMessage(ev, regs, cfg, styles).components.map((c) => c.toJSON()));
    assert.match(text, /💊 TY 1/);
    assert.match(text, /🗡️ TYa 1/);
  });
});
