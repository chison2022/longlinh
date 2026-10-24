// Writes one tab the bot fills but people may edit too: what somebody typed in a cell is never overwritten.
// Each tab has a hidden twin "_LL_<title>" holding exactly what the bot wrote last time. On a rewrite a cell that is not empty and
// differs from that copy was edited by a person, so it is kept; an emptied cell goes back to the bot. Rows are matched by a key
// (keyOf), columns by their header text, so sorting / filtering in the sheet or a column added between two syncs mixes nothing up.
// Columns and rows people added (never written by the bot) are carried along: their rows stay below the bot's rows.
// Without the twin yet (the bot takes the tab over) every cell counts as the bot's, except the `manual` columns: other columns are dropped
// and the tab's conditional formats are replaced by the bot's. Only the formulas the bot marks with fx() are written as formulas.

const MIRROR_PREFIX = '_LL_';

// 1 -> "A", 26 -> "Z", 27 -> "AA".
function columnLetter(n) {
  let letters = '';
  for (let x = Math.max(1, Math.floor(n)); x > 0; x = Math.floor((x - 1) / 26)) letters = String.fromCharCode(65 + ((x - 1) % 26)) + letters;
  return letters;
}

const quote = (title) => `'${String(title).replace(/'/g, "''")}'`;

// A Sheets Table name: letters, digits and _ only, unique per spreadsheet (the tab titles already are).
const tableName = (title) => String(title).replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 100) || 'LongLinh';

const isEmpty = (v) => v === undefined || v === null || v === '';
const isFormula = (v) => typeof v === 'string' && v.startsWith('=');
// A formula the bot writes on purpose: { f: '=...' }. Every other bot value is written RAW, so a Discord name like "=IMPORTDATA(...)"
// stays text. A cell people typed that reads back as "=..." is their formula and is written back as one.
const fx = (f) => ({ f });
const isF = (v) => v !== null && typeof v === 'object' && typeof v.f === 'string';
const plain = (v) => (isF(v) ? v.f : v); // the text form: twin, comparisons
const fromSheet = (v) => (isFormula(v) ? fx(v) : v);
const text = (v) => (isEmpty(plain(v)) ? '' : String(plain(v)));

// The form two cells are compared in: a formula ignores its row numbers (a sort moves rows and Sheets renumbers their
// references), the argument separator (, or ; by the spreadsheet locale) and spaces.
function norm(v) {
  const s = text(v);
  return isFormula(s) ? s.replace(/;/g, ',').replace(/(\$?[A-Z]{1,3})\$?\d+/g, '$1#').replace(/\s+/g, '') : s;
}

// Formulas are built with "," and "{r}" for their own row; the spreadsheet locale may want ";" (vi_VN, most of Europe).
const COMMA_LOCALES = /^(en|ja|zh|ko|th|he|iw|ms|fil|tl|hi|bn|ta|te|mr|gu|kn|ml|pa|ur|my|km|lo|si|ne|sw|ga|cy|mt)(_|$)/i;
const formulaSeparator = (locale) => (!locale || COMMA_LOCALES.test(locale) ? ',' : ';');
const localize = (formula, sep) => (sep === ',' ? formula : formula.replace(/,/g, sep)); // the bot's formulas have no comma inside a string

const EPOCH = '#epoch:'; // last header cell of the twin: what the rows were about (e.g. this week's war)

// Pure part. `current` / `before` = the tab and its twin as read (FORMULA render, header first); `before` null or without a header =
// no twin yet (the bot takes the tab over). `manual` = header names of columns the people fill (the bot's value only lands in an empty
// cell). `epoch` = what the rows are about: when it differs from the twin's, earlier edits do not carry over (a new war).
// `sep` = formula separator. -> { header, rows, mirror, kept, taken } (rows hold plain values and { f } formulas; mirror = the twin to
// write, header included; kept = cells kept because somebody edited them; taken = there was no twin)
function merge({ header, rows, keyOf, manual = [], current = [], before = null, sep = ',', epoch = null }) {
  const twinHeader = before && before[0] && before[0].length ? before[0].map(text) : null;
  const taken = !twinHeader; // nothing to protect yet
  const last = twinHeader ? twinHeader[twinHeader.length - 1] : '';
  const befEpoch = last.startsWith(EPOCH) ? last.slice(EPOCH.length) : null;
  const fresh = taken || (epoch !== null && befEpoch !== String(epoch)); // edits of an earlier epoch do not carry over
  const pastBot = new Set((twinHeader || []).filter((h) => h && !h.startsWith(EPOCH))); // columns the bot wrote last time
  const curNames = (current[0] || []).map((h, i) => text(h) || `\u0000${i}`); // a column without header text is carried by position
  // a bot column whose header somebody retyped is still that column (found at its own position)
  header.forEach((h, j) => {
    if (!curNames.includes(h) && j < curNames.length && !header.includes(curNames[j]) && !pastBot.has(curNames[j])) curNames[j] = h;
  });
  const hasData = (i) => current.slice(1).some((r) => r && !isEmpty(r[i]));
  const extra = taken ? [] : curNames.filter((name, i) => !header.includes(name) && !pastBot.has(name) && (!name.startsWith('\u0000') || hasData(i)));
  const outHeader = [...header, ...extra.map((n) => (n.startsWith('\u0000') ? '' : n))];
  const index = (names) => new Map(names.map((n, i) => [n, i]));
  const curIdx = index(curNames);
  const befIdx = index(twinHeader || []);
  const getter = (row, idx) => (name) => (idx.has(name) ? plain(row[idx.get(name)]) : undefined);
  const cell = (row, idx, name) => (row && idx.has(name) ? row[idx.get(name)] : undefined);
  const byKey = (table, idx) => {
    const map = new Map();
    for (const row of table.slice(1)) {
      if (!row || row.every(isEmpty)) continue;
      const k = keyOf(getter(row, idx));
      if (k && !map.has(k)) map.set(k, row);
    }
    return map;
  };
  const curByKey = byKey(current, curIdx);
  const befByKey = twinHeader ? byKey(before, befIdx) : new Map();
  const botIdx = index(header);
  const used = new Set();
  const out = [];
  const mirror = [];
  let kept = 0;
  rows.forEach((row, n) => {
    const bot = header.map((h, j) => {
      const v = row[j] === undefined || row[j] === null ? '' : row[j];
      return isF(v) ? fx(localize(v.f.replace(/\{r\}/g, n + 2), sep)) : v;
    });
    const k = keyOf(getter(bot, botIdx));
    const cur = k ? curByKey.get(k) : null;
    const was = k ? befByKey.get(k) : null;
    if (cur) used.add(k);
    const cells = header.map((h, j) => {
      const now = cell(cur, curIdx, h);
      if (isEmpty(now)) return bot[j];
      if (manual.includes(h)) return fromSheet(now);
      if (fresh) return bot[j];
      if (norm(now) !== norm(cell(was, befIdx, h)) && norm(now) !== norm(bot[j])) {
        kept += 1;
        return fromSheet(now);
      }
      return bot[j];
    });
    out.push([...cells, ...extra.map((name) => (isEmpty(cell(cur, curIdx, name)) ? '' : fromSheet(cell(cur, curIdx, name))))]);
    mirror.push(bot.map(plain));
  });
  // rows somebody typed (not in the twin, not the bot's) stay below the bot's rows; a row without a key only when it holds something in a
  // column people own (a cleared name in a bot row must not come back forever)
  if (!taken) {
    const own = [...manual, ...extra];
    for (const row of current.slice(1)) {
      if (!row || row.every(isEmpty)) continue;
      const k = keyOf(getter(row, curIdx));
      if (k && (used.has(k) || befByKey.has(k))) continue;
      if (!k && !own.some((name) => !isEmpty(cell(row, curIdx, name)))) continue;
      out.push([...header, ...extra].map((name) => (isEmpty(cell(row, curIdx, name)) ? '' : fromSheet(cell(row, curIdx, name)))));
    }
  }
  return { header: outHeader, rows: out, mirror: [epoch !== null ? [...header, `${EPOCH}${epoch}`] : header, ...mirror], kept, taken };
}

// The tab's Table (Google Sheets "Bảng": a filter on every column) is kept exactly over header + rows. A Table at A1 is resized
// (never recreated, so the managers' column types / colours stay); a tab without one gets one. Best effort: never fails the sync.
// -> 'resized' | 'added' | 'failed'
async function syncTable(client, spreadsheetId, sheetId, title, found, width, rowCount, exact = false) {
  const endRowIndex = Math.max(2, rowCount + 1); // a Table needs one row under its header
  const range = (endColumnIndex) => ({ sheetId, startRowIndex: 0, endRowIndex, startColumnIndex: 0, endColumnIndex });
  const atA1 = ((found && found.tables) || []).filter((t) => !(t.range.startRowIndex > 0) && !(t.range.startColumnIndex > 0));
  const requests = atA1.length
    ? atA1.map((t) => ({ updateTable: { table: { tableId: t.tableId, range: range(exact ? width : Math.max(t.range.endColumnIndex || 0, width)) }, fields: 'range' } }))
    : [{ addTable: { table: { name: tableName(title), range: range(width) } } }];
  try {
    await client.batchUpdate(spreadsheetId, requests);
    return atA1.length ? 'resized' : 'added';
  } catch (err) {
    console.warn(`[sheets] cannot ${atA1.length ? 'resize' : 'add'} the table of ${title}:`, err.message);
    return 'failed';
  }
}

// Runs of formula cells per column -> [{ range, values }] for one USER_ENTERED write (everything else goes RAW: ids stay text).
function formulaRanges(tab, grid) {
  const data = [];
  const width = Math.max(0, ...grid.map((r) => r.length));
  for (let c = 0; c < width; c++) {
    let start = -1;
    for (let r = 0; r <= grid.length; r++) {
      const f = r < grid.length && isF(grid[r][c]);
      if (f && start < 0) start = r;
      if (!f && start >= 0) {
        const col = columnLetter(c + 1);
        data.push({ range: `${quote(tab)}!${col}${start + 1}:${col}${r}`, values: grid.slice(start, r).map((row) => [row[c].f]) });
        start = -1;
      }
    }
  }
  return data;
}

// `spec` = { title, header, rows (values, fx() formulas), keyOf(get), manual?, epoch?, frozenColumns?, formats?(sheetId) -> requests sent
// when the bot takes the tab over }.
// `info` = client.getSpreadsheet() result (read here when not given). -> { created, rows, kept, table }
async function writeManagedTab(client, spreadsheetId, spec, info = null) {
  const { title, header, rows, keyOf, manual = [], epoch = null, frozenColumns = 0, formats = null } = spec;
  const sheet = info || (await client.getSpreadsheet(spreadsheetId));
  const find = (t) => sheet.sheets.find((s) => s.title === t) || sheet.sheets.find((s) => s.title.toLowerCase() === t.toLowerCase()); // tab names are case-insensitive
  const found = find(title);
  const twin = find(MIRROR_PREFIX + title);
  const read = (s) => (s ? client.valuesGet(spreadsheetId, `${quote(s.title)}!A1:${columnLetter(Math.max(26, s.columnCount || 0))}`, { render: 'FORMULA' }) : []);
  const [current, before] = await Promise.all([read(found), read(twin)]);
  const merged = merge({ header, rows, keyOf, manual, epoch, current, before: twin ? before : null, sep: formulaSeparator(sheet.locale) });
  const takeover = merged.taken; // no twin, or an empty one (a sync that failed half way): formats and frozen panes are set again
  const width = merged.header.length;
  const grid = [merged.header, ...merged.rows].map((r) => [...r, ...Array(Math.max(0, width - r.length)).fill('')]);
  const { mirror } = merged;

  const newId = () => 1000000 + Math.floor(Math.random() * 1000000000);
  const tab = { sheetId: found ? found.sheetId : newId(), title: found ? found.title : title };
  const copy = { sheetId: twin ? twin.sheetId : newId(), title: twin ? twin.title : MIRROR_PREFIX + title };
  const size = (s, need, cols) => ({ rowCount: Math.max((s && s.rowCount) || 0, need), columnCount: Math.max((s && s.columnCount) || 0, cols) });
  const requests = [];
  if (!found) requests.push({ addSheet: { properties: { sheetId: tab.sheetId, title: tab.title, gridProperties: { ...size(null, Math.max(1000, grid.length + 200), Math.max(26, width)), frozenRowCount: 1, frozenColumnCount: frozenColumns } } } });
  else requests.push({ updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: size(found, grid.length + 200, Math.max(26, width)) }, fields: 'gridProperties(rowCount,columnCount)' } });
  if (!twin) requests.push({ addSheet: { properties: { sheetId: copy.sheetId, title: copy.title, hidden: true, gridProperties: size(null, Math.max(1000, mirror.length + 200), Math.max(26, header.length + 1)) } } });
  else requests.push({ updateSheetProperties: { properties: { sheetId: copy.sheetId, gridProperties: size(twin, mirror.length + 200, Math.max(26, header.length + 1)) }, fields: 'gridProperties(rowCount,columnCount)' } });
  requests.push({
    repeatCell: {
      range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: width },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });
  await client.batchUpdate(spreadsheetId, requests);

  await client.valuesBatchUpdate(
    spreadsheetId,
    [
      { range: `${quote(tab.title)}!A1`, values: grid.map((r) => r.map((v) => (isF(v) ? '' : v))) },
      { range: `${quote(copy.title)}!A1`, values: mirror },
    ],
    'RAW'
  );
  const formulas = formulaRanges(tab.title, grid);
  if (formulas.length) await client.valuesBatchUpdate(spreadsheetId, formulas, 'USER_ENTERED');
  const lastCol = (s, w) => columnLetter(Math.max(26, w, (s && s.columnCount) || 0));
  await client.valuesBatchClear(spreadsheetId, [
    `${quote(tab.title)}!A${grid.length + 1}:${lastCol(found, width)}`,
    `${quote(tab.title)}!${columnLetter(width + 1)}1:${lastCol(found, width + 1)}`, // right of the columns written (a dropped column)
    `${quote(copy.title)}!A${mirror.length + 1}:${lastCol(twin, header.length + 1)}`,
  ]);
  const table = await syncTable(client, spreadsheetId, tab.sheetId, tab.title, found, width, merged.rows.length, takeover);
  if (takeover && found) {
    // frozen panes on a tab made by somebody else: refused when a merged cell crosses the line, which must not fail the sync
    try {
      await client.batchUpdate(spreadsheetId, [{ updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: frozenColumns } }, fields: 'gridProperties(frozenRowCount,frozenColumnCount)' } }]);
    } catch (err) {
      console.warn(`[sheets] cannot freeze the header of ${title}:`, err.message);
    }
  }
  if (takeover && formats) {
    try {
      const old = Array.from({ length: (found && found.ruleCount) || 0 }, (_, i) => ({ deleteConditionalFormatRule: { sheetId: tab.sheetId, index: found.ruleCount - 1 - i } }));
      const extra = [...old, ...formats(tab.sheetId)];
      if (extra.length) await client.batchUpdate(spreadsheetId, extra);
    } catch (err) {
      console.warn(`[sheets] cannot format ${title}:`, err.message);
    }
  }
  return { created: !found, takenOver: takeover, rows: merged.rows.length, kept: merged.kept, table };
}

// Deletes the listed tabs (and their twins) when the spreadsheet has them. -> titles deleted
async function deleteTabs(client, spreadsheetId, titles, info = null) {
  const sheet = info || (await client.getSpreadsheet(spreadsheetId));
  const lower = new Set(titles.flatMap((t) => [t, MIRROR_PREFIX + t]).map((t) => t.toLowerCase()));
  const gone = sheet.sheets.filter((s) => lower.has(s.title.toLowerCase()));
  if (gone.length) await client.batchUpdate(spreadsheetId, gone.map((s) => ({ deleteSheet: { sheetId: s.sheetId } })));
  return gone.map((s) => s.title);
}

module.exports = { MIRROR_PREFIX, fx, columnLetter, quote, norm, formulaSeparator, merge, syncTable, writeManagedTab, deleteTabs };
