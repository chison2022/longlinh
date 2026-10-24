// In-memory stand-in for services/sheets/googleClient (no network). Not a test file (no .test.js suffix).
// Tabs: title -> { sheetId, rows: string[][] }. Understands addSheet / deleteSheet / tables / conditional format counts in batchUpdate,
// "'Tab'!A1" and "'Tab'!A5:Z" ranges in values calls. Every call is logged in `calls`.
function createFakeSheets({ title = 'Bảng bang hội', email = 'bot@proj.iam.gserviceaccount.com', tabs = [], fail = null, locale = 'en_US' } = {}) {
  const sheets = new Map(tabs.map((t, i) => [t, { sheetId: i + 1, rows: [], rowCount: 1000, columnCount: 26, tables: [], ruleCount: 0 }]));
  let nextTable = 500;
  const calls = [];
  const maybeFail = (name) => {
    if (fail && (fail.on === undefined || fail.on === name)) throw Object.assign(new Error(fail.message || 'boom'), { status: fail.status, code: fail.code });
  };
  const parseRange = (range) => {
    const m = /^'((?:[^']|'')+)'!([A-Z]+)(\d+)(?::([A-Z]+))?(\d+)?$/.exec(range);
    if (!m) throw new Error(`bad range ${range}`);
    return { tab: m[1].replace(/''/g, "'"), row: Number(m[3]) - 1, col: [...m[2]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 };
  };
  return {
    calls,
    sheets,
    email: () => email,
    async getSpreadsheet(id) {
      calls.push(['getSpreadsheet', id]);
      maybeFail('getSpreadsheet');
      return { title, locale, sheets: [...sheets].map(([t, s]) => ({ sheetId: s.sheetId, title: t, rowCount: s.rowCount, columnCount: s.columnCount, hidden: Boolean(s.hidden), ruleCount: s.ruleCount || 0, tables: s.tables.map((x) => ({ ...x, range: { ...x.range } })) })) };
    },
    async batchUpdate(id, requests) {
      calls.push(['batchUpdate', id, requests]);
      maybeFail('batchUpdate');
      const bySheetId = (id) => [...sheets.values()].find((s) => s.sheetId === id);
      for (const r of requests) {
        if (r.addTable) {
          if (fail && fail.on === 'table') throw Object.assign(new Error('table refused'), { status: 400 });
          const t = r.addTable.table;
          bySheetId(t.range.sheetId).tables.push({ tableId: String(nextTable++), name: t.name, range: { ...t.range } });
        }
        if (r.updateTable) {
          if (fail && fail.on === 'table') throw Object.assign(new Error('table refused'), { status: 400 });
          const t = r.updateTable.table;
          const own = bySheetId(t.range.sheetId).tables.find((x) => x.tableId === t.tableId);
          own.range = { ...t.range };
        }
        if (r.addSheet) {
          const p = r.addSheet.properties;
          if (sheets.has(p.title)) throw Object.assign(new Error('duplicate tab'), { status: 400 });
          sheets.set(p.title, { sheetId: p.sheetId, rows: [], rowCount: p.gridProperties.rowCount, columnCount: p.gridProperties.columnCount, tables: [], hidden: Boolean(p.hidden), ruleCount: 0 });
        }
        if (r.deleteSheet) {
          const hit = [...sheets].find(([, s]) => s.sheetId === r.deleteSheet.sheetId);
          if (hit) sheets.delete(hit[0]);
        }
        if (r.addConditionalFormatRule) bySheetId(r.addConditionalFormatRule.rule.ranges[0].sheetId).ruleCount += 1;
        if (r.deleteConditionalFormatRule) bySheetId(r.deleteConditionalFormatRule.sheetId).ruleCount -= 1;
      }
      return { replies: [] };
    },
    async valuesGet(id, range, opts) {
      calls.push(['valuesGet', id, range, opts]);
      const { tab } = parseRange(range);
      return (sheets.get(tab) || { rows: [] }).rows.map((r) => [...r]);
    },
    async valuesBatchUpdate(id, data, input) {
      calls.push(['valuesBatchUpdate', id, data, input]);
      maybeFail('valuesBatchUpdate');
      for (const d of data) {
        const { tab, row, col } = parseRange(d.range);
        const sheet = sheets.get(tab);
        if (!sheet) throw Object.assign(new Error('Unable to parse range'), { status: 400 });
        d.values.forEach((vals, i) => {
          sheet.rows[row + i] = sheet.rows[row + i] || [];
          vals.forEach((v, j) => (sheet.rows[row + i][col + j] = v));
        });
      }
      return {};
    },
    async valuesBatchClear(id, ranges) {
      calls.push(['valuesBatchClear', id, ranges]);
      maybeFail('valuesBatchClear');
      for (const range of ranges) {
        const { tab, row, col } = parseRange(range);
        const sheet = sheets.get(tab);
        if (sheet && col > 0) sheet.rows.slice(row).forEach((r) => r && (r.length = Math.min(r.length, col))); // a block right of column A
        else if (sheet) sheet.rows.length = Math.min(sheet.rows.length, row);
      }
      return {};
    },
  };
}

module.exports = { createFakeSheets };
