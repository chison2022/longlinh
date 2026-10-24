// The events Google Doc: a document the managers created and shared (Editor) with the service account. The bot rewrites the whole
// body like the Sheet tabs: a heading, then per event (newest first, same events as the LongLinh_SuKien tab) a title, the details,
// the rules and ONE table of the answers. Google Docs API only (no Drive): the bot never creates or deletes files.
// Indexes are UTF-16 code units, as JavaScript string lengths. Each event is inserted at index 1, last event first, so the earlier
// content never moves under a pending index; its table is then the FIRST table of the document and is read back to fill the cells.
const { formatLocalDateTime } = require('../../utils/time');

const COLUMNS = ['STT', 'Trả lời', 'Tên Discord', 'Tên game', 'Phái', 'Lúc trả lời'];
const ANSWER = { yes: '✅ Tham gia', maybe: '❓ Có thể', no: '❌ Không' };
const ORDER = { yes: 0, maybe: 1, no: 2 };
const HEADER_FILL = { red: 0.118, green: 0.337, blue: 0.192 }; // #1E5631, as the Word export

// A Doc link or a bare id -> the id, or null.
function parseDocId(input) {
  const s = String(input || '').trim();
  const m = /\/document\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}


// Control characters other than \n break insertText; tabs become spaces.
const clean = (s) => String(s ?? '').replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
const oneLine = (s) => clean(s).replace(/\n+/g, ' ');

function rowsOf({ replies, gameNames, classOf }) {
  const sorted = [...replies].sort((a, b) => ORDER[a.status] - ORDER[b.status]); // stable: answer order kept inside each group
  const rows = sorted.map((r, i) => {
    const game = gameNames.get(r.discordId) || '';
    return [String(i + 1), ANSWER[r.status] || r.status, oneLine(r.discordName || r.displayName || r.discordId), oneLine(game), game ? oneLine(classOf(game)) : '', r.createdAt ? formatLocalDateTime(new Date(r.createdAt)) : ''];
  });
  return rows.length ? rows : [['', 'Chưa có ai trả lời', '', '', '', '']];
}

function textOf(event, replies, { categoryOf, statusOf }) {
  const count = (s) => replies.filter((r) => r.status === s).length;
  const yes = count('yes');
  const when = `${formatLocalDateTime(new Date(event.startAt))}${event.endAt ? ` – ${formatLocalDateTime(new Date(event.endAt)).split(' ').pop()}` : ''}`;
  const lines = [
    oneLine(event.title),
    [categoryOf(event), statusOf(event)].filter(Boolean).join(' · '),
    `Thời gian: ${when} · hạn trả lời ${formatLocalDateTime(new Date(event.deadlineAt))}`,
    `✅ ${yes}${event.capacity ? `/${event.capacity}` : ''} tham gia · ❓ ${count('maybe')} có thể · ❌ ${count('no')} không${event.minParticipants && yes < event.minParticipants ? ` · ⚠️ còn thiếu ${event.minParticipants - yes}` : ''}`,
  ];
  if (event.description) lines.push(`Thể lệ: ${clean(event.description)}`);
  return lines;
}

// The requests that insert one event at index 1: the table first (Docs puts a newline before it), then the text into that newline.
function eventInsertRequests(lines, rowCount) {
  const text = lines.join('\n');
  const titleEnd = 1 + lines[0].length;
  return [
    { insertTable: { rows: rowCount + 1, columns: COLUMNS.length, location: { index: 1 } } },
    { insertText: { location: { index: 1 }, text } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 1 + text.length }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: titleEnd }, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } },
  ];
}

// Fills the first table of `doc` with header + rows (last cell first so no index moves), then styles the header row.
function fillRequests(doc, rows) {
  const tableEl = ((doc.body && doc.body.content) || []).find((e) => e.table);
  if (!tableEl) throw new Error('bảng vừa chèn không thấy trong tài liệu');
  const grid = [COLUMNS, ...rows];
  const cellIndex = (r, c) => tableEl.table.tableRows[r].tableCells[c].content[0].startIndex;
  const requests = [];
  for (let r = grid.length - 1; r >= 0; r--) {
    for (let c = COLUMNS.length - 1; c >= 0; c--) {
      if (grid[r][c]) requests.push({ insertText: { location: { index: cellIndex(r, c) }, text: grid[r][c] } });
    }
  }
  let shift = 0; // header cell c moved by the header texts inserted before it
  COLUMNS.forEach((h, c) => {
    const start = cellIndex(0, c) + shift;
    requests.push({ updateTextStyle: { range: { startIndex: start, endIndex: start + h.length }, textStyle: { bold: true, foregroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } }, fields: 'bold,foregroundColor' } });
    shift += h.length;
  });
  requests.push({
    updateTableCellStyle: {
      tableRange: { tableCellLocation: { tableStartLocation: { index: tableEl.startIndex }, rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: COLUMNS.length },
      tableCellStyle: { backgroundColor: { color: { rgbColor: HEADER_FILL } } },
      fields: 'backgroundColor',
    },
  });
  return requests;
}

const lastIndex = (doc) => {
  const content = (doc.body && doc.body.content) || [];
  return content.length ? content[content.length - 1].endIndex : 1;
};

// items = [{ event, replies }] (replies: displayName = the live Discord name); gameNames: Map discordId -> game name; classOf: game name -> class;
// categoryOf / statusOf: event -> label. -> { events, title }
async function writeEventDoc(client, docId, items, { gameNames = new Map(), classOf = () => '', categoryOf = () => '', statusOf = () => '', guildName = '', now = new Date() } = {}) {
  const first = await client.docsGet(docId);
  const end = lastIndex(first);
  if (end > 2) await client.docsBatchUpdate(docId, [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } }]);
  for (const { event, replies } of [...items].reverse()) {
    const rows = rowsOf({ replies, gameNames, classOf });
    await client.docsBatchUpdate(docId, eventInsertRequests(textOf(event, replies, { categoryOf, statusOf }), rows.length));
    await client.docsBatchUpdate(docId, fillRequests(await client.docsGet(docId), rows));
  }
  const head = [`Sự kiện bang${guildName ? ` ${oneLine(guildName)}` : ''}`, `Bot Long Linh tự cập nhật · lần cuối ${formatLocalDateTime(now)} · sự kiện 30 ngày gần đây và sắp tới, mới nhất ở trên.${items.length ? '' : ' Chưa có sự kiện nào.'}`, ''];
  const text = head.join('\n');
  await client.docsBatchUpdate(docId, [
    { insertText: { location: { index: 1 }, text } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 1 + text.length }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 1 + head[0].length }, paragraphStyle: { namedStyleType: 'TITLE' }, fields: 'namedStyleType' } },
  ]);
  return { events: items.length, title: first.title || '' };
}

module.exports = { COLUMNS, parseDocId,  rowsOf, textOf, eventInsertRequests, fillRequests, writeEventDoc };
