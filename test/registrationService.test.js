const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, groupNamesByClass, UNKNOWN_CLASS } = require('../src/services/registrationService');

const reg = (id, status, className, displayName = `N${id}`) => ({ discordId: String(id), status, className, displayName });

describe('summarize', () => {
  const classes = ['A', 'B', 'C'];
  it('empty input', () => {
    assert.deepEqual(summarize([], classes), { join: 0, reserve: 0, absent: 0, byClass: [] });
    assert.deepEqual(summarize([]), { join: 0, reserve: 0, absent: 0, byClass: [] });
  });
  it('counts statuses and per-class join/reserve; absent excluded from per-class', () => {
    const regs = [reg(1, 'join', 'B'), reg(2, 'reserve', 'B'), reg(3, 'absent', 'A'), reg(4, 'join', 'A'), reg(5, 'join', 'B')];
    assert.deepEqual(summarize(regs, classes), {
      join: 3,
      reserve: 1,
      absent: 1,
      byClass: [
        { className: 'A', join: 1, reserve: 0 },
        { className: 'B', join: 2, reserve: 1 },
      ],
    });
  });
  it('classes not in config come after config classes in first-seen order; missing class => Chưa rõ', () => {
    const regs = [reg(1, 'join', 'Z'), reg(2, 'join', null), reg(3, 'reserve', 'C'), reg(4, 'join', 'Y'), reg(5, 'join', 'Z')];
    const s = summarize(regs, classes);
    assert.deepEqual(
      s.byClass.map((c) => [c.className, c.join, c.reserve]),
      [['C', 0, 1], ['Z', 2, 0], ['Chưa rõ', 1, 0], ['Y', 1, 0]]
    );
  });
  it('class only seen via absent registrations is not listed', () => {
    const s = summarize([reg(1, 'absent', 'X')], classes);
    assert.deepEqual(s.byClass, []);
    assert.equal(s.absent, 1);
  });
  it('totals equal the number of registrations for 80 regs', () => {
    const statuses = ['join', 'reserve', 'absent'];
    const regs = Array.from({ length: 80 }, (_, i) => reg(i, statuses[i % 3], classes[i % 4]));
    const s = summarize(regs, classes);
    assert.equal(s.join + s.reserve + s.absent, 80);
    const perClassTotal = s.byClass.reduce((n, c) => n + c.join + c.reserve, 0);
    assert.equal(perClassTotal, s.join + s.reserve);
  });
});

describe('groupNamesByClass', () => {
  it('groups names by class, join/reserve separated, absent skipped, config order first', () => {
    const regs = [
      reg(1, 'join', 'B', 'Bình'),
      reg(2, 'reserve', 'A', 'An'),
      reg(3, 'absent', 'A', 'Vắng Mặt'),
      reg(4, 'join', null, 'Không Phái'),
      reg(5, 'join', 'A', 'Anh'),
      reg(6, 'join', 'Q', 'Quân'),
    ];
    assert.deepEqual(groupNamesByClass(regs, ['A', 'B']), [
      { className: 'A', join: ['Anh'], reserve: ['An'] },
      { className: 'B', join: ['Bình'], reserve: [] },
      { className: 'Chưa rõ', join: ['Không Phái'], reserve: [] },
      { className: 'Q', join: ['Quân'], reserve: [] },
    ]);
  });
  it('falls back to discordId when displayName is missing', () => {
    const g = groupNamesByClass([{ discordId: '42', status: 'join', className: 'A' }], ['A']);
    assert.deepEqual(g[0].join, ['42']);
  });
  it('empty input -> []', () => {
    assert.deepEqual(groupNamesByClass([], ['A']), []);
    assert.deepEqual(groupNamesByClass([]), []);
  });
});

describe('classFromRoles', () => {
  const { classFromRoles } = require('../src/services/registrationService');
  const classes = ['🛡️ Thiết Y', '💊 Tố Vấn', '🩸 Huyết Hà'];

  it('exact name, and emoji on either side, resolve to the configured class string', () => {
    assert.equal(classFromRoles(['Thiết Y'], classes), '🛡️ Thiết Y');
    assert.equal(classFromRoles(['💊 Tố Vấn'], classes), '💊 Tố Vấn');
    assert.equal(classFromRoles(['🔥 Huyết Hà ✨'], classes), '🩸 Huyết Hà');
    assert.equal(classFromRoles(['Tố Vấn'], ['Tố Vấn']), 'Tố Vấn');
  });
  it('ignores case and extra spaces', () => {
    assert.equal(classFromRoles(['  thiết   y '], classes), '🛡️ Thiết Y');
    assert.equal(classFromRoles(['TỐ VẤN'], classes), '💊 Tố Vấn');
  });
  it('keeps diacritics significant and normalizes Unicode form', () => {
    assert.equal(classFromRoles(['To Van'], classes), null);
    assert.equal(classFromRoles(['Tố Vấn'.normalize('NFD')], classes), '💊 Tố Vấn');
  });
  it('folds Unicode look-alikes: math-bold, fullwidth, decomposed (NFD) input', () => {
    assert.equal(classFromRoles(['𝐓𝐡𝐢ế𝐭 𝐘'], classes), '🛡️ Thiết Y');
    assert.equal(classFromRoles(['Ｔｈｉｅ̂́ｔ Ｙ'], classes), '🛡️ Thiết Y');
    assert.equal(classFromRoles(['Thiết Y'.normalize('NFD')], classes), '🛡️ Thiết Y');
    assert.equal(classFromRoles(['𝐓𝐨 𝐕𝐚𝐧'], classes), null, 'folded look-alikes without diacritics still differ');
  });
  it('a keycap emoji prefix is ignored on either side; a plain leading number is part of the name', () => {
    assert.equal(classFromRoles(['1️⃣ Huyết Hà'], classes), '🩸 Huyết Hà');
    assert.equal(classFromRoles(['1️⃣Huyết Hà'], classes), '🩸 Huyết Hà');
    assert.equal(classFromRoles(['10 Huyết Hà'], classes), null, 'plain digits are kept');
    assert.equal(classFromRoles(['Huyết Hà'], ['2️⃣ Huyết Hà']), '2️⃣ Huyết Hà');
    assert.equal(classFromRoles(['3 Huyết Hà'], ['2 Huyết Hà']), null);
    assert.equal(classFromRoles(['2 Huyết Hà'], ['2 Huyết Hà']), '2 Huyết Hà');
    assert.equal(classFromRoles(['Huyết Hà 2'], classes), null, 'a trailing number is part of the name');
    assert.equal(classFromRoles(['2'], ['2']), '2', 'a name that is only a number still matches itself');
  });
  it('diacritics stay significant after the NFKC change', () => {
    assert.equal(classFromRoles(['Tố Van'], classes), null);
    assert.equal(classFromRoles(['Tô Vấn'], classes), null);
    assert.equal(classFromRoles(['Thiet Y'], classes), null);
  });
  it('no match / no roles -> null; non-class roles are ignored', () => {
    assert.equal(classFromRoles([], classes), null);
    assert.equal(classFromRoles(['Thành viên', 'Admin'], classes), null);
    assert.equal(classFromRoles(['Thành viên', 'Tố Vấn', '@everyone'], classes), '💊 Tố Vấn');
  });
  it('two different class roles -> null (ambiguous); the same class twice is still one class', () => {
    assert.equal(classFromRoles(['Thiết Y', 'Tố Vấn'], classes), null);
    assert.equal(classFromRoles(['Tố Vấn', '💊 Tố Vấn'], classes), '💊 Tố Vấn');
  });
  it('works with a full 25-entry class list', () => {
    const many = Array.from({ length: 25 }, (_, i) => `🔹 Phái ${String.fromCharCode(65 + i)}`);
    assert.equal(classFromRoles(['Phái X'], many), many[23]);
    assert.equal(classFromRoles(['Phái B', 'Phái C'], many), null);
    assert.equal(classFromRoles(['Phái Zz'], many), null);
  });
  it('a class label made only of symbols never matches', () => {
    assert.equal(classFromRoles(['🔥'], ['🔥']), null);
  });
});
