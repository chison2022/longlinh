// Real attendance: text parser, name -> Discord resolution, comparison with the registrations, history numbers and the
// LongLinh_ChuyenCan rows. DB reads are stubbed (no connection).
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const gameRoster = require('../src/services/gameRosterService');
const memberStore = require('../src/services/members');
const attendance = require('../src/services/attendanceService');
const { sid, vn } = require('./helpers');

describe('parseAttendanceText', () => {
  it('Tên alone or Tên|key=value; blanks, comments, BOM and CRLF are skipped; numbers become numbers', () => {
    const text = '﻿# trận 10/10\r\n\r\nHắc Phong|diem=1.234|ha=5|ghi chu=tốt\r\n  Long   Thần  \r\n#bỏ qua\r\nZed|chet=0|\r\n';
    assert.deepEqual(attendance.parseAttendanceText(text), [
      { name: 'Hắc Phong', stats: { diem: 1234, ha: 5, 'ghi chu': 'tốt' } },
      { name: 'Long Thần', stats: {} },
      { name: 'Zed', stats: { chet: 0 } },
    ]);
  });
  it('a name seen twice (same nameKey: case, accents, spacing) is kept once, first line wins', () => {
    const out = attendance.parseAttendanceText('Hắc Phong|diem=1\nhac  phong|diem=2\nHẮC PHONG');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { name: 'Hắc Phong', stats: { diem: 1 } });
  });
  it('a broken line throws with its number', () => {
    assert.throws(() => attendance.parseAttendanceText('An\nBình|diem'), /dòng 2/);
    assert.throws(() => attendance.parseAttendanceText('|diem=1'), /dòng 1.*thiếu tên/);
  });
  it('a trailing "..." is the cut "…" of the game', () => {
    assert.deepEqual(attendance.parseAttendanceText('Thiên Long Bá...|diem=3\nAn ...\nBình'), [
      { name: 'Thiên Long Bá…', stats: { diem: 3 } },
      { name: 'An…', stats: {} },
      { name: 'Bình', stats: {} },
    ]);
  });
  it('empty input -> []', () => {
    assert.deepEqual(attendance.parseAttendanceText(''), []);
    assert.deepEqual(attendance.parseAttendanceText(undefined), []);
  });
});

describe('resolve', () => {
  const G = 'g1';
  const ROSTER = ['Hắc Phong', 'Thiên Long Bát Bộ', 'Kiếm Vương A', 'Kiếm Vương B'].map((name) => ({ name, rank: '', className: '', daysInGuild: 1, status: '' }));
  let links;
  beforeEach(() => {
    mock.restoreAll();
    links = [];
    mock.method(memberStore, 'listMembers', async () => links);
    mock.method(gameRoster, 'latest', async () => ({ members: ROSTER }));
    mock.method(gameRoster, 'loadMappings', async () => new Map());
  });
  const run = (names, members) => attendance.resolve(G, names, { members });
  const people = [
    { id: '1', name: 'hac phong' }, // folds to the roster name
    { id: '2', name: 'Long' },
    { id: '3', name: 'Kiếm' },
    { id: '4', name: 'Người Khác' },
  ];

  it('a saved link wins (any case / accents), then the automatic roster match, else none', async () => {
    links = [{ discordId: '9', gameName: 'Zed Link' }, { discordId: '4', gameName: 'Hắc Phong' }];
    const out = await run(['zed link', 'Hắc Phong', 'Kẻ Lạ'], people);
    assert.deepEqual(out, [
      { gameName: 'zed link', discordId: '9', how: 'link' },
      { gameName: 'Hắc Phong', discordId: '4', how: 'link' }, // the link beats the automatic match to member 1
      { gameName: 'Kẻ Lạ', discordId: null, how: 'none' },
    ]);
  });

  it('automatic match of the latest roster (name equal to a Discord name once folded)', async () => {
    const out = await run(['HẮC PHONG'], people);
    assert.deepEqual(out, [{ gameName: 'HẮC PHONG', discordId: '1', how: 'auto' }]);
  });

  it('a name cut with "…" takes the one roster name it starts, then the link / match of that name', async () => {
    links = [{ discordId: '7', gameName: 'Thiên Long Bát Bộ' }];
    const out = await run(['Thiên Long Bá…'], people);
    assert.deepEqual(out, [{ gameName: 'Thiên Long Bá…', discordId: '7', how: 'link' }]);
    links = [];
    const viaAuto = await run(['Hắc P…'], people);
    assert.deepEqual(viaAuto, [{ gameName: 'Hắc P…', discordId: '1', how: 'auto' }]);
  });

  it('a cut name never takes the direct lookup of its bare stem: "Abc…" is not the linked "Abc"', async () => {
    links = [{ discordId: '9', gameName: 'Abc' }];
    mock.method(gameRoster, 'latest', async () => ({ members: [{ name: 'Abc' }, { name: 'Abcd' }] }));
    const ambiguous = await run(['Abc…', 'Abc...'], people);
    assert.deepEqual(ambiguous.map((o) => [o.discordId, o.how]), [[null, 'none'], [null, 'none']], 'two roster names start with the stem');
    gameRoster.latest.mock.restore();
    mock.method(gameRoster, 'latest', async () => ({ members: [{ name: 'Xyz' }] }));
    const noRoster = await run(['Abc…'], people);
    assert.deepEqual(noRoster.map((o) => [o.discordId, o.how]), [[null, 'none']], 'no roster name behind the stem: the link of "Abc" is not used');
    gameRoster.latest.mock.restore();
    mock.method(gameRoster, 'latest', async () => ({ members: [{ name: 'Abc' }, { name: 'Zed' }] }));
    assert.deepEqual((await run(['Abc…'], people)).map((o) => [o.discordId, o.how]), [['9', 'link']], 'a roster name equal to the stem is the one candidate');
  });

  it('a roster name cut with "…": the same cut name, or the whole name it starts, takes that entry; two cut entries -> none', async () => {
    links = [{ discordId: '5', gameName: 'Đầu Hổ Nhất L…' }];
    mock.method(gameRoster, 'latest', async () => ({ members: [{ name: 'Đầu Hổ Nhất L…' }, { name: 'Zed' }] }));
    const out = await run(['Đầu Hổ Nhất L…', 'Đầu Hổ Nhất Lớp', 'Đầu Hổ'], people);
    assert.deepEqual(out.map((o) => [o.discordId, o.how]), [['5', 'link'], ['5', 'link'], [null, 'none']]);
    gameRoster.latest.mock.restore();
    mock.method(gameRoster, 'latest', async () => ({ members: [{ name: 'Đầu Hổ Nhất L…' }, { name: 'Đầu Hổ N…' }] }));
    assert.deepEqual((await run(['Đầu Hổ Nhất Lớp'], people)).map((o) => o.how), ['none'], 'two cut roster names fit the whole name');
  });

  it('an ambiguous prefix (two roster names, both linked) or one with no roster name -> none', async () => {
    links = [{ discordId: '5', gameName: 'Kiếm Vương A' }, { discordId: '6', gameName: 'Kiếm Vương B' }];
    const out = await run(['Kiếm Vư…', 'Không Có…', '…'], people);
    assert.deepEqual(out.map((o) => [o.discordId, o.how]), [[null, 'none'], [null, 'none'], [null, 'none']]);
  });

  it('without any roster only the saved links work', async () => {
    gameRoster.latest.mock.restore();
    mock.method(gameRoster, 'latest', async () => null);
    links = [{ discordId: '9', gameName: 'Zed' }];
    const out = await run(['Zed', 'Hắc Phong'], people);
    assert.deepEqual(out.map((o) => o.how), ['link', 'none']);
  });
});

describe('compare', () => {
  const regs = [
    { discordId: 'a', displayName: 'An', status: 'join' },
    { discordId: 'b', displayName: 'Bình', status: 'join' },
    { discordId: 'c', displayName: 'Chi', status: 'absent' },
    { discordId: 'd', displayName: 'Dũng', status: 'absent' },
    { discordId: 'r', displayName: 'Ri', status: 'join' },
  ];
  const att = {
    entries: [
      { gameName: 'An G', discordId: 'a', how: 'link' },
      { gameName: 'Chi G', discordId: 'c', how: 'auto' },
      { gameName: 'Eo G', discordId: 'e', how: 'auto' },
      { gameName: 'Eo G2', discordId: 'e', how: 'auto' }, // the same person twice counts once
      { gameName: 'Lạ…', discordId: null, how: 'none' },
    ],
  };
  it('splits into came / noShow / walkIn (+ saidAbsent) / unknown', () => {
    const out = attendance.compare({}, regs, att, { displayNames: new Map([['e', 'Em']]), names: new Map([['b', 'Bình G'], ['r', 'Ri G']]) });
    assert.deepEqual(out.came, [{ discordId: 'a', gameName: 'An G', displayName: 'An' }]);
    assert.deepEqual(out.noShow, [
      { discordId: 'b', gameName: 'Bình G', displayName: 'Bình' },
      { discordId: 'r', gameName: 'Ri G', displayName: 'Ri' }, // older 'join' counts as join
    ]);
    assert.deepEqual(out.walkIn, [
      { discordId: 'c', gameName: 'Chi G', displayName: 'Chi', saidAbsent: true },
      { discordId: 'e', gameName: 'Eo G', displayName: 'Em', saidAbsent: false },
    ]);
    assert.deepEqual(out.unknown, [{ discordId: null, gameName: 'Lạ…', displayName: '' }]);
  });
  it('registered absent who stayed away is in no group; no attendance -> everybody who joined is a no-show', () => {
    const out = attendance.compare({}, regs, { entries: [] });
    assert.equal(out.noShow.length, 3);
    assert.deepEqual([out.came, out.walkIn, out.unknown], [[], [], []]);
    assert.equal(attendance.compare({}, [], null).noShow.length, 0);
    assert.deepEqual(attendance.compare({}, regs, { entries: [] }).unconfirmed, []);
  });
  it('with unknown names, a registrant who is not on the screen and has no linked game name is unconfirmed, not a no-show', () => {
    const out = attendance.compare({}, regs, att, { names: new Map([['b', 'Bình G']]) });
    assert.deepEqual(out.noShow.map((x) => x.discordId), ['b'], 'b has a link: really absent');
    assert.deepEqual(out.unconfirmed.map((x) => x.discordId), ['r'], 'r has no link: could be the unknown "Lạ…"');
    const none = attendance.compare({}, regs, { entries: [att.entries[0]] }, {});
    assert.deepEqual([none.noShow.length, none.unconfirmed.length], [2, 0], 'no unknown names: nothing is unconfirmed');
  });
});

describe('buildHistory', () => {
  const war = (n, day) => ({ eventId: `w${n}`, title: `Trận ${n}`, startAt: vn(2026, 10, day, 20) });
  const items = [
    { war: war(2, 10), regs: [{ discordId: 'a', status: 'join' }, { discordId: 'b', status: 'join' }, { discordId: 'c', status: 'absent' }], attendance: { entries: [{ gameName: 'A2', discordId: 'a' }, { gameName: 'C2', discordId: 'c' }] } },
    { war: war(1, 3), regs: [{ discordId: 'a', status: 'join', displayName: 'An' }, { discordId: 'b', status: 'join' }, { discordId: 'c', status: 'absent' }], attendance: { entries: [{ gameName: 'A1', discordId: 'a' }, { gameName: 'B1', discordId: 'b' }, { gameName: 'D1', discordId: 'd' }] } },
  ];
  it('wars oldest first; per person registered / came / noShow / walkIn / rate and the cell of each war', () => {
    const h = attendance.buildHistory(items);
    assert.deepEqual(h.wars.map((w) => w.eventId), ['w1', 'w2']);
    const a = h.people.get('a');
    assert.deepEqual([a.registered, a.came, a.noShow, a.walkIn, a.rate, a.gameName, a.displayName], [2, 2, 0, 0, 1, 'A2', 'An']);
    const b = h.people.get('b');
    assert.deepEqual([b.registered, b.came, b.noShow, b.rate], [2, 1, 1, 0.5]);
    assert.deepEqual([...b.byWar], [['w1', 'came'], ['w2', 'noShow']]);
    const c = h.people.get('c');
    assert.deepEqual([c.registered, c.walkIn, c.rate], [0, 1, null]); // said absent twice, came once
    assert.deepEqual([...c.byWar], [['w1', 'absent'], ['w2', 'walkIn']]);
    const d = h.people.get('d');
    assert.deepEqual([d.registered, d.walkIn, d.rate], [0, 1, null]);
    assert.equal(d.byWar.get('w2'), undefined);
  });
  it('unconfirmed wars stay out of registered / noShow / rate', () => {
    const h = attendance.buildHistory([{ war: war(1, 3), regs: [{ discordId: 'a', status: 'join' }, { discordId: 'b', status: 'join' }], attendance: { entries: [{ gameName: 'A1', discordId: 'a' }, { gameName: 'Lạ…', discordId: null }] }, names: new Map([['a', 'A1']]) }]);
    const b = h.people.get('b');
    assert.deepEqual([b.registered, b.noShow, b.unconfirmed, b.rate, b.byWar.get('w1')], [0, 0, 1, null, 'unconfirmed']);
  });
  it('no wars -> empty', () => {
    assert.deepEqual(attendance.buildHistory([]), { wars: [], people: new Map() });
  });
});

