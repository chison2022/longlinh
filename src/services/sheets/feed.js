// The member sheet the bot keeps in the admin's spreadsheet: ThanhVien (one row per character in the guild, plus the members who are
// only on Discord), BangChien_TuanNay (this week's war), BangChien_LichSu (the finished wars of this month; older ones stay in the DB)
// and SuKien (event answers). The war / event tabs look names up in ThanhVien with VLOOKUP formulas. People who left the guild and
// holders of the "Kẻ lạ mặt" role are never written. Pure builders: sheetSync loads the data, managedTab writes the tabs.
const { plainClass } = require('../lineupStyle');
const { makeCanon, UNKNOWN_CLASS } = require('../registrationService');
const { nameKey, fold } = require('../gameRosterService');
const { plainRoleName, normalizeRole } = require('../missions');
const { isStranger } = require('../rosterService');
const { toLocalParts, fromLocal, formatLocalDateTime } = require('../../utils/time');
const { columnLetter, fx } = require('./managedTab');

const MEMBER_TAB = 'ThanhVien';
const WEEK_TAB = 'BangChien_TuanNay';
const HISTORY_TAB = 'BangChien_LichSu';
const EVENT_TAB = 'SuKien';
const ALL_TABS = [MEMBER_TAB, WEEK_TAB, HISTORY_TAB, EVENT_TAB];
// Tabs of the older layouts: deleted on sync (the user's choice, 2026-10-22; the data stays in the DB).
const OLD_TABS = ['LongLinh_DangKy', 'LongLinh_GameRoster', 'LongLinh_DanhBa', 'LongLinh_ChuyenCan', 'LongLinh_SuKien', 'LongLinh_XinNghi', 'LongLinh_ViPham', 'LongLinh_QuayThuong', 'BaoDanh_BangChien', 'BangChien'];
// The sentence part that names them (the "sheet connected" reply and the 📊 view).
const tabsText = () => `${MEMBER_TAB}, ${WEEK_TAB}, ${HISTORY_TAB}; khi bang có sự kiện thì thêm ${EVENT_TAB}`;

// Columns are only ever APPENDED: the lookups below (and the managers' own formulas) count them.
const MEMBER_HEADER = ['Tên game', 'Phái', 'Chức vụ', 'Ngày trong bang', 'Online lần cuối', 'Trạng thái', 'Tên Discord', 'Discord ID', 'Liên kết', 'Trong server', 'Vai trò', 'Tuyến Khiên', 'Ghi chú', 'Tên cũ', 'Ngày quay lại', 'ID game'];
const MEMBER_MANUAL = ['Ghi chú']; // the managers' column: the bot never writes it
const COL = Object.fromEntries(MEMBER_HEADER.map((h, i) => [h, i + 1]));
const LAST_COL = columnLetter(MEMBER_HEADER.length);
const WEEK_HEADER = ['Tên game', 'Tên Discord', 'Phái', 'Báo danh', 'Phái lúc báo danh', 'Vai trò', 'Lúc báo danh', 'Discord ID'];
const EVENT_HEADER = ['Sự kiện', 'Ngày', 'Trạng thái sự kiện', 'Tên game', 'Tên Discord', 'Phái', 'Trả lời', 'Discord ID'];
const HISTORY_FIXED = ['Tên game', 'Tên Discord', 'Phái', 'Trạng thái']; // then one column per war, 'Số lần báo đi', 'Discord ID'

const STATUS = { in: 'Đang ở bang', fresh: 'Mới vào', back: 'Quay lại', discordOnly: 'Chỉ có Discord', noGame: 'Chưa có tên game' };
const BACK_DAYS = 30; // 'Quay lại' for this many days after the import that listed the character again
const FRESH_DAYS = 7; // 'Mới vào' up to this many days in the guild
const DAY_MS = 24 * 3600 * 1000;
const LINK = { admin: 'Admin ghép', self: 'Tự liên kết', selfFree: 'Tự gõ tên', auto: 'Tự khớp tên' };
const WEEK_STATE = { join: '✅ Đi', absent: '❌ Vắng', none: '⏳ Chưa báo' };
// a past war. With the war's result screen imported (attendance): went (registered or not), registered but did not come; without it
// the registration alone tells. notYet = joined the guild after that war.
const WAR_STATE = { join: '✅ Đi', none: '⏳ Không đi', absent: '❌ Vắng', noShow: '⚠️ Đăng ký nhưng không tham gia', notYet: '🆕 Chưa vào bang' };
const EVENT_STATUS = { open: 'Đang mở', locked: 'Đã chốt', cancelled: 'Đã huỷ', done: 'Đã kết thúc' };
const EVENT_REPLY = { yes: '✅ Tham gia', maybe: '❓ Có thể', no: '❌ Không' };

// A VLOOKUP into ThanhVien by the game name in column `keyCol` of the same row ("{r}"; managedTab fills it in, and the separator).
const lookup = (header, keyCol = 'A') => fx(`=IFERROR(VLOOKUP($${keyCol}{r},${MEMBER_TAB}!$A:$${LAST_COL},${COL[header]},FALSE),"")`);

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => {
  const p = toLocalParts(new Date(d));
  return `${pad(p.day)}/${pad(p.month + 1)}/${p.year}`;
};
const DAY_NAMES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const warLabel = (w) => {
  const p = toLocalParts(new Date(w.startAt));
  return `${DAY_NAMES[p.dow]} ${pad(p.day)}/${pad(p.month + 1)}`;
};
const roleOf = (m) => (m && normalizeRole(m.missionPref) !== 'any' ? plainRoleName(m.missionPref) : '');

// 00:00 local time on the 1st of the current month (the history tab keeps the wars from then on).
function monthStart(now = new Date()) {
  const p = toLocalParts(now);
  return fromLocal(p.year, p.month, 1, 0, 0);
}

// Key of a war / member row: the game name (case / accent / spacing blind), else the Discord id.
const personKey = (get) => {
  const game = String(get('Tên game') || '').trim();
  if (game) return `g:${nameKey(game)}`;
  const id = String(get('Discord ID') || '').trim();
  return id ? `d:${id}` : '';
};
const eventKey = (get) => `${get('Sự kiện') || ''}|${get('Ngày') || ''}|${get('Discord ID') || get('Tên Discord') || ''}`;

// Every tab of the sheet. `data`:
//   config      guild config (classes, memberRoleId, strangerRoleId)
//   infos       the guild's Discord members (rosterService.memberInfo, the complete list)
//   roster      characters of the latest import (still in the guild), [] without one
//   rosterAt    when that roster was taken (the video date; days in the guild count back from it), or null
//   match       gameRosterService.matchDiscord() of them (null without a roster)
//   dbMembers   linkService.loadMembers() rows (mission wish, Tuyến Khiên)
//   departed    { ids: Set of Discord ids linked to characters that left, keys: Set of their name keys }
//   week        { war, regs } of this week's war, or null
//   history     [{ war, regs }] of the finished wars of this month, oldest first
//   attendance  attendanceService.history(): { wars: [{ eventId }], people: Map discordId -> { byWar: Map eventId -> came|noShow|walkIn|absent|unconfirmed } }
//   events      eventService.listForSheet().items, or null for no SuKien tab
// `sep` = formula separator of the spreadsheet (the conditional format rules are written in its locale).
// -> [{ title, header, rows, keyOf, manual?, frozenColumns, formats }]
function buildSheet(data, { sep = ',' } = {}) {
  const { config = {}, infos = [], roster = [], rosterAt = null, match = null, dbMembers = [], departed = { ids: new Set(), keys: new Set() }, week = null, history = [], attendance = null, events = null } = data;
  const canon = makeCanon(config.classes || []);
  const classText = (c) => (c ? plainClass(canon(c)) : UNKNOWN_CLASS);
  const infoById = new Map(infos.map((i) => [i.id, i]));
  const dbById = new Map(dbMembers.map((m) => [m.discordId, m]));
  const stranger = (i) => isStranger(i, config);
  const statusOf = (g) => {
    if (g.returnedAt && (!rosterAt || new Date(rosterAt) - new Date(g.returnedAt) <= BACK_DAYS * DAY_MS)) return STATUS.back;
    return Number(g.daysInGuild) <= FRESH_DAYS ? STATUS.fresh : STATUS.in;
  };
  // a Discord member the sheet may show on their own (not as a linked character): in the server, a member, not a stranger, not gone from the guild
  const counted = (id) => {
    const i = infoById.get(id);
    if (!i || i.bot || stranger(i)) return false;
    if (config.memberRoleId && !(i.roleIds || []).includes(config.memberRoleId)) return false;
    return !departed.ids.has(id) && !departed.keys.has(nameKey(i.name));
  };

  // ---- ThanhVien ----
  const links = new Map(); // character name -> { id, source, present }
  for (const m of (match && match.matched) || []) links.set(m.game.name, { id: m.discordId, source: m.manual ? m.source || 'admin' : 'auto' });
  for (const u of (match && match.uncached) || []) if (!links.has(u.gameName)) links.set(u.gameName, { id: u.discordId, source: 'admin' });
  const order = (config.classes || []).map((c) => fold(plainClass(c)));
  const classRank = (c) => {
    const i = order.indexOf(fold(plainClass(c || '')));
    return i < 0 ? order.length : i;
  };
  const chars = [...roster].sort((a, b) => classRank(a.className) - classRank(b.className) || a.name.localeCompare(b.name, 'vi'));
  const linkedIds = new Map(); // discord id -> name of their character (still in the guild)
  const memberRows = chars.map((g) => {
    const link = links.get(g.name);
    if (link) linkedIds.set(link.id, g.name);
    const info = link && infoById.get(link.id);
    const db = link && dbById.get(link.id);
    return [
      g.name,
      g.className ? plainClass(g.className) : '',
      g.rank || '',
      Number(g.daysInGuild) || 0,
      g.status || '',
      statusOf(g),
      info ? info.name : (db && db.displayName) || '',
      link ? link.id : '',
      link ? LINK[link.source] || link.source : '',
      link ? (info ? 'Có' : 'Đã rời server') : '',
      roleOf(db),
      db && db.tuyenKhien ? 'Có' : '',
      '',
      (g.oldNames || []).join(', '),
      g.returnedAt ? day(g.returnedAt) : '',
      g.gameUid || '', // a string: RAW keeps it text (leading zeros, no 1.2E+10)
    ];
  });
  const discordOnly = infos.filter((i) => !linkedIds.has(i.id) && counted(i.id)).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  for (const i of discordOnly) {
    const db = dbById.get(i.id);
    memberRows.push(['', '', '', '', '', STATUS.discordOnly, i.name, i.id, 'Chưa liên kết', 'Có', roleOf(db), db && db.tuyenKhien ? 'Có' : '', '', '', '', '']);
  }
  const shown = (id) => linkedIds.has(id) || counted(id); // may a registration / answer of this person be written

  // ---- BangChien_TuanNay ----
  const weekRegs = new Map(((week && week.regs) || []).map((r) => [r.discordId, r]));
  const when = (r) => (r ? formatLocalDateTime(new Date(r.updatedAt || r.createdAt)) : '');
  const state = (r) => (!r ? WEEK_STATE.none : r.status === 'absent' ? WEEK_STATE.absent : WEEK_STATE.join);
  const weekRows = chars.map((g) => {
    const link = links.get(g.name);
    const reg = link ? weekRegs.get(link.id) : null;
    return [g.name, lookup('Tên Discord'), lookup('Phái'), state(reg), reg && reg.className ? classText(reg.className) : '', lookup('Vai trò'), when(reg), link ? link.id : ''];
  });
  for (const r of (week && week.regs) || []) {
    if (linkedIds.has(r.discordId) || !counted(r.discordId)) continue;
    weekRows.push(['', infoById.get(r.discordId).name, '', state(r), classText(r.className), roleOf(dbById.get(r.discordId)), when(r), r.discordId]);
  }

  // ---- BangChien_LichSu ----
  const wars = history.map((h) => ({ war: h.war, label: warLabel(h.war), regs: new Map((h.regs || []).map((r) => [r.discordId, r])) }));
  const historyHeader = [...HISTORY_FIXED, ...wars.map((w) => w.label), 'Số lần báo đi', 'Discord ID'];
  const screened = new Set(((attendance && attendance.wars) || []).map((w) => String(w.eventId)));
  const seen = (attendance && attendance.people) || new Map();
  const mark = (w, id, joinedAt) => {
    const r = id ? w.regs.get(id) : null;
    const key = String(w.war._id);
    const got = id && screened.has(key) && seen.get(id) ? seen.get(id).byWar.get(key) : undefined;
    if (got === 'came' || got === 'walkIn') return WAR_STATE.join;
    if (got === 'noShow') return WAR_STATE.noShow;
    if (r) return r.status === 'absent' ? WAR_STATE.absent : WAR_STATE.join;
    return joinedAt && joinedAt > new Date(w.war.startAt) ? WAR_STATE.notYet : WAR_STATE.none;
  };
  // the day a character joined: the roster's day minus its days in the guild (null when unknown)
  const joinedOf = (g) => (rosterAt && Number.isFinite(Number(g.daysInGuild)) ? new Date(new Date(rosterAt).getTime() - (Number(g.daysInGuild) + 1) * DAY_MS) : null);
  const firstWar = columnLetter(HISTORY_FIXED.length + 1);
  const lastWar = columnLetter(HISTORY_FIXED.length + wars.length);
  const count = wars.length ? fx(`=COUNTIF(${firstWar}{r}:${lastWar}{r},"✅*")`) : 0;
  const historyRows = chars.map((g) => {
    const link = links.get(g.name);
    return [g.name, lookup('Tên Discord'), lookup('Phái'), lookup('Trạng thái'), ...wars.map((w) => mark(w, link && link.id, joinedOf(g))), count, link ? link.id : ''];
  });
  const extra = [...new Set(wars.flatMap((w) => [...w.regs.keys()]))].filter((id) => !linkedIds.has(id) && counted(id));
  for (const id of extra) historyRows.push(['', infoById.get(id).name, '', STATUS.noGame, ...wars.map((w) => mark(w, id, infoById.get(id).joinedAt ? new Date(infoById.get(id).joinedAt) : null)), count, id]);

  // ---- SuKien ----
  let eventRows = null;
  if (events) {
    eventRows = [];
    for (const { event, replies } of events) {
      const head = [event.title, day(event.startAt), EVENT_STATUS[event.status] || event.status];
      const list = (replies || []).filter((r) => shown(r.discordId));
      if (!list.length) eventRows.push([...head, '', '', '', '(chưa ai trả lời)', '']);
      for (const status of ['yes', 'maybe', 'no']) {
        for (const r of list.filter((x) => x.status === status)) {
          const game = linkedIds.get(r.discordId) || '';
          const info = infoById.get(r.discordId);
          eventRows.push([...head, game, info ? info.name : r.displayName || '', game ? lookup('Phái', 'D') : '', EVENT_REPLY[status], r.discordId]);
        }
      }
    }
  }

  // ---- formats (sent when the bot first takes a tab over: colours of the states) ----
  const color = (red, green, blue) => ({ red, green, blue });
  const GREEN = color(0.78, 0.92, 0.79);
  const RED = color(0.96, 0.8, 0.8);
  const YELLOW = color(1, 0.95, 0.7);
  const rule = (index, ranges, condition, format) => ({ addConditionalFormatRule: { index, rule: { ranges, booleanRule: { condition, format } } } });
  const starts = (text) => ({ type: 'TEXT_STARTS_WITH', values: [{ userEnteredValue: text }] });
  const cols = (sheetId, from, to = from + 1) => ({ sheetId, startRowIndex: 1, startColumnIndex: from, endColumnIndex: to });
  const states = (sheetId, from, to) => [rule(0, [cols(sheetId, from, to)], starts('✅'), { backgroundColor: GREEN }), rule(1, [cols(sheetId, from, to)], starts('❌'), { backgroundColor: RED })];
  const idCol = columnLetter(COL['Discord ID']);

  return [
    {
      title: MEMBER_TAB,
      header: MEMBER_HEADER,
      rows: memberRows,
      keyOf: personKey,
      manual: MEMBER_MANUAL,
      frozenColumns: 1,
      // a character nobody is linked to
      formats: (sheetId) => [rule(0, [cols(sheetId, 0, MEMBER_HEADER.length)], { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=AND($A2<>""${sep}$${idCol}2="")` }] }, { backgroundColor: YELLOW })],
    },
    {
      title: WEEK_TAB,
      header: WEEK_HEADER,
      rows: weekRows,
      keyOf: personKey,
      epoch: week && week.war ? String(week.war._id) : 'none', // a new war: the edits of the last one do not carry over
      frozenColumns: 1,
      formats: (sheetId) => [...states(sheetId, 3, 4), rule(2, [cols(sheetId, 3)], starts('⏳'), { backgroundColor: YELLOW })],
    },
    {
      title: HISTORY_TAB,
      header: historyHeader,
      rows: historyRows,
      keyOf: personKey,
      frozenColumns: 2,
      formats: (sheetId) => {
        const wars6 = cols(sheetId, HISTORY_FIXED.length, HISTORY_FIXED.length + 6); // a month has at most 5 wars
        return [...states(sheetId, HISTORY_FIXED.length, HISTORY_FIXED.length + 6), rule(2, [wars6], starts('⏳'), { backgroundColor: YELLOW }), rule(3, [wars6], starts('🆕'), { backgroundColor: color(0.85, 0.9, 1) }), rule(4, [wars6], starts('⚠️'), { backgroundColor: color(1, 0.85, 0.6) })];
      },
    },
    ...(eventRows
      ? [{ title: EVENT_TAB, header: EVENT_HEADER, rows: eventRows, keyOf: eventKey, frozenColumns: 1, formats: (sheetId) => [...states(sheetId, 6, 7), rule(2, [cols(sheetId, 6)], starts('❓'), { backgroundColor: YELLOW })] }]
      : []),
  ];
}

module.exports = { WAR_STATE, MEMBER_TAB, WEEK_TAB, HISTORY_TAB, EVENT_TAB, ALL_TABS, OLD_TABS, tabsText, MEMBER_HEADER, WEEK_HEADER, EVENT_HEADER, HISTORY_FIXED, STATUS, monthStart, buildSheet };
