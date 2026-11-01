// The published war lineup as ONE PNG (pure: no Discord, no DB). Excel-like: per Nhóm a table, one row per PT, one cell per slot,
// each person with the colour chip of their class; a legend under the tables. Nobody is mentioned. Needs the native canvas binary:
// the publisher loads this module lazily.
const { createCanvas } = require('@napi-rs/canvas');
const { chipColor, plainClass } = require('../../services/lineupStyle');
const { ensureFonts, font, fit, drawChip, drawBar, loadEmojiImage, cleanName, WIDTH, MARGIN, BAR_H, CHIP, INK, MUTED, GRID } = require('./canvasKit');

const TOP = 24 + 38 + 34;
const ROW_H = 46;
const HEAD_H = 40;
const PT_W = 110;
const PAD = 10;
const GAP = 22;
const HEAD_FILL = '#e3eaf5';
const BAR_COLORS = ['#1e3a8a', '#7c2d12', '#14532d', '#581c87']; // one colour per Nhóm
const LEGEND_H = 56;

// data: { title, subtitle, layout: { groups }, people: { [discordId]: { name, className } }, classes: [configured class names],
//         styles?: { [className]: { color, emoji } }, partySize? }
// -> Promise<Buffer> PNG. `fetchFn` is injectable (server emoji images).
async function renderLineupPng({ title, subtitle = '', layout, people = {}, classes = [], styles = {}, partySize = 6 }, { fetchFn = globalThis.fetch } = {}) {
  ensureFonts();
  const used = new Set();
  for (const g of layout.groups) for (const p of g) for (const id of p) if (people[id]) used.add(people[id].className || '');
  const order = [...classes, ...[...used].filter((c) => c && !classes.includes(c))];
  const colorOf = (className) => (styles[className] && styles[className].color) || chipColor(Math.max(order.indexOf(className), 0));
  const images = new Map();
  await Promise.all(
    [...used].map(async (c) => {
      const emoji = styles[c] && styles[c].emoji;
      const image = emoji && typeof fetchFn === 'function' ? await loadEmojiImage(emoji.id, fetchFn) : null;
      if (image) images.set(c, image);
    })
  );

  const innerW = WIDTH - 2 * MARGIN;
  const slotW = (innerW - PT_W) / partySize;
  const groupH = BAR_H + HEAD_H + layout.groups[0].length * ROW_H;
  const legendClasses = order.filter((c) => c && (used.has(c) || classes.includes(c)));
  const legendRows = Math.max(1, Math.ceil(legendClasses.length / 4));
  const height = TOP + layout.groups.length * (groupH + GAP) + legendRows * 36 + LEGEND_H - 36;
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.font = font(34, true);
  ctx.fillText(fit(ctx, cleanName(title), innerW), MARGIN, 24 + 17);
  ctx.fillStyle = MUTED;
  ctx.font = font(24);
  ctx.fillText(fit(ctx, subtitle, innerW), MARGIN, 24 + 38 + 12);

  let y = TOP;
  layout.groups.forEach((group, g) => {
    const total = group.reduce((n, p) => n + p.length, 0);
    drawBar(ctx, `NHÓM ${g + 1} — ${total}/${group.length * partySize} người`, y, BAR_COLORS[g % BAR_COLORS.length]);
    y += BAR_H;
    const gridTop = y;
    ctx.fillStyle = HEAD_FILL;
    ctx.fillRect(MARGIN, y, innerW, HEAD_H);
    ctx.fillStyle = INK;
    ctx.font = font(22, true);
    ctx.textAlign = 'center';
    ctx.fillText('PT', MARGIN + PT_W / 2, y + HEAD_H / 2 + 1);
    for (let s = 0; s < partySize; s++) ctx.fillText(String(s + 1), MARGIN + PT_W + s * slotW + slotW / 2, y + HEAD_H / 2 + 1);
    y += HEAD_H;
    group.forEach((party, p) => {
      ctx.fillStyle = p % 2 ? '#f8fafc' : '#ffffff';
      ctx.fillRect(MARGIN, y, innerW, ROW_H);
      ctx.fillStyle = INK;
      ctx.font = font(24, true);
      ctx.textAlign = 'center';
      ctx.fillText(`PT ${p + 1}`, MARGIN + PT_W / 2, y + ROW_H / 2 + 1);
      party.slice(0, partySize).forEach((id, s) => {
        const who = people[id] || { name: id, className: '' };
        const x = MARGIN + PT_W + s * slotW;
        drawChip(ctx, x + PAD, y + (ROW_H - CHIP) / 2, colorOf(who.className), images.get(who.className) || null);
        ctx.fillStyle = INK;
        ctx.font = font(22);
        ctx.textAlign = 'left';
        ctx.fillText(fit(ctx, cleanName(who.name), slotW - 2 * PAD - CHIP - 8), x + PAD + CHIP + 8, y + ROW_H / 2 + 1);
      });
      y += ROW_H;
    });
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const cx of [MARGIN, MARGIN + PT_W, ...Array.from({ length: partySize }, (_, s) => MARGIN + PT_W + (s + 1) * slotW)]) {
      ctx.moveTo(Math.round(cx) + 0.5, gridTop);
      ctx.lineTo(Math.round(cx) + 0.5, y);
    }
    for (let r = 0; r <= group.length + 1; r++) {
      const ly = gridTop + (r === 0 ? 0 : HEAD_H + (r - 1) * ROW_H) + 0.5;
      ctx.moveTo(MARGIN, ly);
      ctx.lineTo(MARGIN + innerW, ly);
    }
    ctx.stroke();
    y += GAP;
  });

  // legend: class colours, four per row
  ctx.font = font(22);
  ctx.textAlign = 'left';
  const colW = innerW / 4;
  legendClasses.forEach((c, i) => {
    const x = MARGIN + (i % 4) * colW;
    const ly = y + Math.floor(i / 4) * 36;
    drawChip(ctx, x, ly + 4, colorOf(c), images.get(c) || null);
    ctx.fillStyle = INK;
    ctx.fillText(fit(ctx, plainClass(c), colW - CHIP - 16), x + CHIP + 8, ly + 4 + CHIP / 2);
  });
  return canvas.encode('png');
}

module.exports = { renderLineupPng };
