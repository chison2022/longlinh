// In-game member list as PNG table pages (pure: no Discord, no DB). Needs the native canvas
// binary: callers load this module lazily (see interactions/gameRoster.js).
const { createCanvas } = require('@napi-rs/canvas');
const { chipColor, plainClass } = require('../../services/lineupStyle');
const { classPalette } = require('../../services/iconColor');
const { iconTonesOf, ensureFonts, font, fit, drawChip, drawBar, loadEmojiImage, cleanName, WIDTH, MARGIN, BAR_H, CHIP, INK, MUTED, GRID } = require('./canvasKit');

const PAGE_SIZE = 35;
const ROW_H = 40;
const HEAD_H = 44;
const TOP = 24 + 38 + 34;
const HEAD_FILL = '#e3eaf5';
const BAR_COLOR = '#1e3a8a';
const YES = '#2f9e44';
// [header, width, align]; the widths add up to WIDTH - 2 * MARGIN
const COLUMNS = [
  ['#', 70, 'center'],
  ['Tên', 520, 'left'],
  ['Chức vụ', 230, 'left'],
  ['Phái', 240, 'left'],
  ['Ngày', 90, 'right'],
  ['Trạng thái', 190, 'left'],
  ['Discord', 120, 'center'],
];
const PAD = 12;

// The font has no check mark glyph: drawn as a stroke.
function drawCheck(ctx, cx, cy) {
  ctx.save();
  ctx.strokeStyle = YES;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - 9, cy);
  ctx.lineTo(cx - 3, cy + 7);
  ctx.lineTo(cx + 9, cy - 7);
  ctx.stroke();
  ctx.restore();
}

// members: [{ name, rank, className, daysInGuild, status, inDiscord }] (already in display order)
// -> Promise<Buffer[]> one PNG per page of `pageSize` rows (at least one page, also for an empty list).
// styles: { [className]: { color: '#rrggbb'|null, emoji: {id,...}|null } } (optional); `fetchFn` is injectable for tests.
async function renderRosterPngs({ title, subtitle = '', members = [], classes = [], styles = {} }, { fetchFn = globalThis.fetch, pageSize = PAGE_SIZE } = {}) {
  ensureFonts();
  const used = new Set(members.map((m) => m.className));
  const order = [...classes, ...[...used].filter((c) => !classes.includes(c))];
  const tones = [];
  const iconColors = new Map(); // class -> the colour of its icon
  const colorOf = (className) => iconColors.get(className) || (styles[className] && styles[className].color) || chipColor(Math.max(order.indexOf(className), 0));
  const images = new Map();
  await Promise.all(
    [...used].map(async (c) => {
      const emoji = styles[c] && styles[c].emoji;
      const image = emoji && typeof fetchFn === 'function' ? await loadEmojiImage(emoji.id, fetchFn) : null;
      if (image) {
        images.set(c, image);
        tones.push([c, iconTonesOf(emoji.id, image)]);
      }
    })
  );
  // icon colours, collision-aware: two classes never share a hue (a pale-pink icon gives a rose next to a red one)
  tones.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])); // the guild's class order decides who keeps a contested hue
  for (const [c, v] of classPalette(tones, '#ffffff')) iconColors.set(c, v.mark);

  const pages = [];
  for (let i = 0; i < Math.max(members.length, 1); i += pageSize) pages.push(members.slice(i, i + pageSize));
  const out = [];
  for (let p = 0; p < pages.length; p++) {
    const rows = pages[p];
    const height = TOP + BAR_H + HEAD_H + rows.length * ROW_H + 20;
    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, height);
    ctx.textBaseline = 'middle';

    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.font = font(34, true);
    ctx.fillText(fit(ctx, cleanName(title), WIDTH - 2 * MARGIN - 220), MARGIN, 24 + 17);
    ctx.fillStyle = MUTED;
    ctx.font = font(24);
    ctx.textAlign = 'right';
    ctx.fillText(`Trang ${p + 1}/${pages.length}`, WIDTH - MARGIN, 24 + 17);
    ctx.textAlign = 'left';
    ctx.fillText(fit(ctx, subtitle, WIDTH - 2 * MARGIN), MARGIN, 24 + 38 + 12);

    let y = TOP;
    const first = p * pageSize + 1;
    drawBar(ctx, `THÀNH VIÊN TRONG GAME — ${rows.length ? `${first}–${first + rows.length - 1}` : 0} / ${members.length}`, y, BAR_COLOR);
    y += BAR_H;
    const gridTop = y;
    const xs = [];
    let x = MARGIN;
    for (const [, w] of COLUMNS) {
      xs.push(x);
      x += w;
    }
    const cell = (c, text, rowY, { size = 24, color = INK, bold = false, dx = 0, h = ROW_H } = {}) => {
      const [, w, align] = COLUMNS[c];
      ctx.font = font(size, bold);
      ctx.fillStyle = color;
      ctx.textAlign = align;
      const room = w - 2 * PAD - dx;
      const px = align === 'left' ? xs[c] + PAD + dx : align === 'right' ? xs[c] + w - PAD : xs[c] + w / 2;
      ctx.fillText(fit(ctx, text, room), px, rowY + h / 2 + 1);
    };

    ctx.fillStyle = HEAD_FILL;
    ctx.fillRect(MARGIN, y, WIDTH - 2 * MARGIN, HEAD_H);
    COLUMNS.forEach(([label], c) => cell(c, label, y, { size: 23, bold: true, h: HEAD_H }));
    y += HEAD_H;

    rows.forEach((m, r) => {
      ctx.fillStyle = r % 2 ? '#f8fafc' : '#ffffff';
      ctx.fillRect(MARGIN, y, WIDTH - 2 * MARGIN, ROW_H);
      cell(0, String(first + r), y, { size: 22, color: MUTED });
      cell(1, cleanName(m.name), y);
      cell(2, m.rank || '—', y, { size: 22 });
      drawChip(ctx, xs[3] + PAD, y + (ROW_H - CHIP) / 2, colorOf(m.className), images.get(m.className) || null);
      cell(3, plainClass(m.className), y, { size: 22, dx: CHIP + 8 });
      cell(4, String(m.daysInGuild ?? ''), y, { size: 22 });
      cell(5, m.status || '', y, { size: 22, color: MUTED });
      if (m.inDiscord) drawCheck(ctx, xs[6] + COLUMNS[6][1] / 2, y + ROW_H / 2);
      y += ROW_H;
    });

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const cx of [...xs, WIDTH - MARGIN]) {
      ctx.moveTo(Math.round(cx) + 0.5, gridTop);
      ctx.lineTo(Math.round(cx) + 0.5, y);
    }
    for (let r = 0; r <= rows.length + 1; r++) {
      const ly = gridTop + (r === 0 ? 0 : HEAD_H + (r - 1) * ROW_H) + 0.5;
      ctx.moveTo(MARGIN, ly);
      ctx.lineTo(WIDTH - MARGIN, ly);
    }
    ctx.stroke();
    out.push(await canvas.encode('png'));
  }
  return out;
}

module.exports = { renderRosterPngs, PAGE_SIZE };
