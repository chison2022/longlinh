// 📄 Xuất Word for a guild event (ev:doc:<eid>): one .docx with the event details and the answers grouped by ✅ / ❓ / ❌.
// Built by hand as WordprocessingML in a zip (jszip, already a dependency): no Word library, opens in Word, Google Docs and LibreOffice.
// Pure: no Discord client, no DB.
const JSZip = require('jszip');
const { formatLocalDateTime } = require('../utils/time');

const esc = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // characters XML 1.0 forbids
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// One run of text; `\n` becomes a line break inside the paragraph.
function run(text, { bold = false, size = null, color = null } = {}) {
  const props = [bold ? '<w:b/>' : '', color ? `<w:color w:val="${color}"/>` : '', size ? `<w:sz w:val="${size}"/>` : ''].join('');
  const parts = String(text ?? '').split('\n').map((line) => `<w:t xml:space="preserve">${esc(line)}</w:t>`);
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${parts.join('<w:br/>')}</w:r>`;
}

const para = (runs, { spacingAfter = 120 } = {}) => `<w:p><w:pPr><w:spacing w:after="${spacingAfter}"/></w:pPr>${[].concat(runs).join('')}</w:p>`;

const CELL_BORDERS = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders>';

// widths in twentieths of a point; the header row is dark green with white bold text and repeats on every page.
function table(header, rows, widths) {
  const cell = (text, w, head) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="1E5631"/>' : ''}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(text, head ? { bold: true, color: 'FFFFFF' } : {})}</w:p></w:tc>`;
  const tr = (cells, head) => `<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((c, i) => cell(c, widths[i], head)).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${CELL_BORDERS}</w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${tr(header, true)}${rows.map((r) => tr(r, false)).join('')}</w:tbl>`;
}

const GROUPS = [
  { status: 'yes', title: '✅ Tham gia' },
  { status: 'maybe', title: '❓ Có thể' },
  { status: 'no', title: '❌ Không' },
];
const HEADER = ['STT', 'Tên Discord', 'Tên game', 'Phái', 'Trả lời lúc'];
const WIDTHS = [700, 2600, 2600, 1500, 1900];

// event: the GuildEvent; replies: EventReply rows (oldest first) with the live displayName; gameNames: Map discordId -> game name;
// classOf: game name -> class (''); category: { label }; statusLabel: text. -> { buffer, fileName }
async function buildEventDocx({ event, replies = [], gameNames = new Map(), classOf = () => '', category = null, statusLabel = '', guildName = '', now = new Date() }) {
  const body = [];
  body.push(para(run(event.title, { bold: true, size: 36 }), { spacingAfter: 200 }));
  const when = `${formatLocalDateTime(new Date(event.startAt))}${event.endAt ? ` – ${formatLocalDateTime(new Date(event.endAt)).split(' ').pop()}` : ''}`;
  const yes = replies.filter((r) => r.status === 'yes').length;
  const facts = [
    ['Bang', guildName],
    ['Loại', category ? category.label : ''],
    ['Thời gian', `${when} (giờ Việt Nam)`],
    ['Hạn trả lời', formatLocalDateTime(new Date(event.deadlineAt))],
    ['Trạng thái', statusLabel],
    ['Số người', `${yes}${event.capacity ? `/${event.capacity}` : ''} tham gia${event.minParticipants ? ` · cần ít nhất ${event.minParticipants}${yes < event.minParticipants ? ` (còn thiếu ${event.minParticipants - yes})` : ''}` : ''}`],
  ].filter(([, v]) => v);
  for (const [k, v] of facts) body.push(para([run(`${k}: `, { bold: true }), run(v)], { spacingAfter: 60 }));
  if (event.description) {
    body.push(para(run('Thể lệ', { bold: true, size: 28 }), { spacingAfter: 80 }));
    body.push(para(run(event.description)));
  }
  for (const g of GROUPS) {
    const list = replies.filter((r) => r.status === g.status);
    body.push(para(run(`${g.title} (${list.length})`, { bold: true, size: 28 }), { spacingAfter: 80 }));
    if (!list.length) {
      body.push(para(run('Chưa có ai.', { color: '808080' })));
      continue;
    }
    const rows = list.map((r, i) => {
      const game = gameNames.get(r.discordId) || '';
      return [String(i + 1), r.displayName || r.discordId, game, game ? classOf(game) : '', r.createdAt ? formatLocalDateTime(new Date(r.createdAt)) : ''];
    });
    body.push(table(HEADER, rows, WIDTHS));
    body.push(para(''));
  }
  body.push(para(run(`Xuất từ bot Long Linh lúc ${formatLocalDateTime(now)}.`, { color: '808080', size: 18 })));

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', document);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const day = formatLocalDateTime(new Date(event.startAt)).split(' ')[0].replace(/\//g, '-');
  const slug = String(event.title).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'su-kien';
  return { buffer, fileName: `su-kien-${slug}-${day}.docx` };
}

module.exports = { buildEventDocx, HEADER };
