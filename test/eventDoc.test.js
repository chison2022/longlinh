// The events Google Doc writer (services/sheets/eventDoc): link parsing, the requests it sends, the cell filling order.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const eventDoc = require('../src/services/sheets/eventDoc');
const { docError } = require('../src/bot/eventDocSync');

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789';
const event = (extra = {}) => ({ title: 'Giải Solo', startAt: new Date('2026-10-18T14:00:00Z'), deadlineAt: new Date('2026-10-18T12:00:00Z'), status: 'open', capacity: 16, minParticipants: 3, ...extra });

// A document whose first table starts at `start` with `rows` x 6 empty cells laid out as Docs does (cell paragraphs 2 apart, rows 1 apart).
function docWithTable(rows, start = 10) {
  const tableRows = [];
  let i = start + 1;
  for (let r = 0; r < rows; r++) {
    i += 1;
    const cells = [];
    for (let c = 0; c < 6; c++) {
      cells.push({ content: [{ startIndex: i + 1 }] });
      i += 2;
    }
    tableRows.push({ tableCells: cells });
  }
  return { body: { content: [{ startIndex: 0, endIndex: 1 }, { startIndex: 1, endIndex: start }, { startIndex: start, endIndex: i, table: { tableRows } }, { startIndex: i, endIndex: i + 1 }] } };
}

describe('eventDoc', () => {
  it('parseDocId takes a Doc link (any suffix) or a bare id; a Sheet link or junk is refused', () => {
    assert.equal(eventDoc.parseDocId(`https://docs.google.com/document/d/${ID}/edit?tab=t.0`), ID);
    assert.equal(eventDoc.parseDocId(`  ${ID} `), ID);
    assert.equal(eventDoc.parseDocId(`https://docs.google.com/spreadsheets/d/${ID}/edit`), null);
    assert.equal(eventDoc.parseDocId('abc'), null);
  });
  it('rows: ✅ then ❓ then ❌ (answer order kept), Discord name, game name + class, one placeholder row when nobody answered', () => {
    const rows = eventDoc.rowsOf({
      replies: [{ discordId: '1', displayName: 'Bình', status: 'no' }, { discordId: '2', displayName: 'An', status: 'yes' }, { discordId: '3', displayName: 'Chi\tX', status: 'yes' }],
      gameNames: new Map([['2', 'Mây Chiều']]),
      classOf: () => 'Tố Vấn',
    });
    assert.deepEqual(rows.map((r) => [r[0], r[1], r[2], r[3], r[4]]), [['1', '✅ Tham gia', 'An', 'Mây Chiều', 'Tố Vấn'], ['2', '✅ Tham gia', 'Chi X', '', ''], ['3', '❌ Không', 'Bình', '', '']]);
    assert.deepEqual(eventDoc.rowsOf({ replies: [], gameNames: new Map(), classOf: () => '' }), [['', 'Chưa có ai trả lời', '', '', '', '']]);
  });
  it('one event = a table at index 1, then its text into the newline Docs adds before it; all NORMAL_TEXT, the title HEADING_2', () => {
    const lines = eventDoc.textOf(event({ description: 'Luật\nhai dòng' }), [{ status: 'yes' }], { categoryOf: () => 'PvP / thi đấu', statusOf: () => 'Đang mở' });
    assert.equal(lines[0], 'Giải Solo');
    assert.match(lines[3], /✅ 1\/16 tham gia · ❓ 0 có thể · ❌ 0 không · ⚠️ còn thiếu 2/);
    assert.equal(lines[4], 'Thể lệ: Luật\nhai dòng');
    const req = eventDoc.eventInsertRequests(lines, 1);
    assert.deepEqual(req[0].insertTable, { rows: 2, columns: 6, location: { index: 1 } });
    assert.equal(req[1].insertText.location.index, 1);
    assert.equal(req[2].updateParagraphStyle.range.endIndex, 1 + lines.join('\n').length);
    assert.deepEqual([req[3].updateParagraphStyle.range.endIndex, req[3].updateParagraphStyle.paragraphStyle.namedStyleType], [1 + 'Giải Solo'.length, 'HEADING_2']);
  });
  it('fills the cells last first (no index moves), styles the header with the shift of the header texts before it, colours the header row', () => {
    const doc = docWithTable(2);
    const req = eventDoc.fillRequests(doc, [['1', '✅ Tham gia', 'An', 'Mây', 'TV', '18/10 20:00']]);
    const inserts = req.filter((r) => r.insertText).map((r) => r.insertText.location.index);
    assert.deepEqual(inserts, [...inserts].sort((a, b) => b - a), 'descending indexes');
    const table = doc.body.content.find((e) => e.table).table;
    const h0 = table.tableRows[0].tableCells[0].content[0].startIndex;
    const h1 = table.tableRows[0].tableCells[1].content[0].startIndex;
    const styles = req.filter((r) => r.updateTextStyle).map((r) => r.updateTextStyle.range);
    assert.deepEqual(styles[0], { startIndex: h0, endIndex: h0 + 'STT'.length });
    assert.deepEqual(styles[1], { startIndex: h1 + 'STT'.length, endIndex: h1 + 'STT'.length + 'Trả lời'.length });
    assert.equal(req.at(-1).updateTableCellStyle.tableRange.tableCellLocation.tableStartLocation.index, 10);
    assert.throws(() => eventDoc.fillRequests({ body: { content: [] } }, []), /không thấy/);
  });
  it('writeEventDoc clears the body, writes the events last first (each: insert, read back, fill), then the heading; a fresh Doc is not cleared', async () => {
    const calls = [];
    let gets = 0;
    const client = {
      docsGet: async () => (gets++ === 0 ? { title: 'Sự kiện HL', body: { content: [{ startIndex: 0, endIndex: 1 }, { startIndex: 1, endIndex: 50 }] } } : docWithTable(2)),
      docsBatchUpdate: async (id, requests) => calls.push(requests),
    };
    const items = [{ event: event({ title: 'Mới' }), replies: [{ discordId: '1', displayName: 'An', status: 'yes' }] }, { event: event({ title: 'Cũ' }), replies: [] }];
    const res = await eventDoc.writeEventDoc(client, ID, items, { guildName: 'Bang Thử Nghiệm' });
    assert.deepEqual(res, { events: 2, title: 'Sự kiện HL' });
    assert.deepEqual(calls[0], [{ deleteContentRange: { range: { startIndex: 1, endIndex: 49 } } }]);
    assert.equal(calls[1][1].insertText.text.split('\n')[0], 'Cũ', 'the older event goes in first: it ends up below');
    assert.ok(calls[2].some((r) => r.updateTableCellStyle));
    assert.equal(calls[3][1].insertText.text.split('\n')[0], 'Mới');
    assert.match(calls.at(-1)[0].insertText.text, /^Sự kiện bang Bang Thử Nghiệm\n/);
    assert.equal(calls.length, 6);
    gets = 0;
    calls.length = 0;
    const fresh = { docsGet: async () => ({ body: { content: [{ startIndex: 0, endIndex: 1 }, { startIndex: 1, endIndex: 2 }] } }), docsBatchUpdate: async (id, r) => calls.push(r) };
    await eventDoc.writeEventDoc(fresh, ID, [], {});
    assert.equal(calls.length, 1, 'nothing to clear, no event: only the heading');
    assert.match(calls[0][0].insertText.text, /Chưa có sự kiện nào/);
  });
  it('Google refusals become sentences a manager can act on', () => {
    assert.match(docError({ status: 403, message: 'Google Docs API has not been used in project 1 before or it is disabled.' }), /chưa bật/);
    assert.match(docError({ status: 403, message: 'The caller does not have permission' }), /Người chỉnh sửa/);
    assert.match(docError({ status: 404, message: 'Requested entity was not found.' }), /Không tìm thấy/);
  });
});
