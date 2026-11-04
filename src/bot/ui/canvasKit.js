// Canvas drawing helpers of the PNG tables (pure: no Discord, no DB). Class emoji do not render reliably in canvas, so a class is
// a coloured rounded square (or the server emoji image) before the name. The font ships with the repo (OFL).
const path = require('node:path');
const { GlobalFonts, loadImage, createCanvas } = require('@napi-rs/canvas');
const { dominantColors } = require('../../services/iconColor');
const { fontDir } = require('../../paths');

const FAMILY = 'Be Vietnam Pro';
let fontsReady = false;

function ensureFonts() {
  if (fontsReady) return;
  for (const file of ['BeVietnamPro-Regular.ttf', 'BeVietnamPro-Bold.ttf']) {
    if (!GlobalFonts.registerFromPath(path.join(fontDir(), file), FAMILY)) throw new Error(`image font missing: ${file}`);
  }
  fontsReady = true;
}

// Custom server emoji drawn instead of the chip: Image objects cached per emoji id (failures only for a short while).
const EMOJI_URL = (id) => `https://cdn.discordapp.com/emojis/${id}.png?size=64`;
const FETCH_TIMEOUT_MS = 3000;
const FAIL_TTL_MS = 60 * 1000;
const MAX_EMOJI_BYTES = 262144;
const MAX_CACHE = 200;
const emojiCache = new Map(); // id -> { promise, image|null, at } (the promise dedupes concurrent fetches)

async function fetchEmojiImage(id, fetchFn) {
  try {
    const res = await fetchFn(EMOJI_URL(id), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const tooBig = Number(res.headers && res.headers.get && res.headers.get('content-length')) > MAX_EMOJI_BYTES;
    if (!res.ok || tooBig) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null; // any network / decode failure: the chip is drawn instead
  }
}

async function loadEmojiImage(id, fetchFn) {
  if (!/^\d{17,20}$/.test(String(id))) return null;
  const hit = emojiCache.get(id);
  if (hit && (hit.promise || hit.image || Date.now() - hit.at < FAIL_TTL_MS)) return hit.promise || hit.image;
  const promise = fetchEmojiImage(id, fetchFn).then((image) => {
    emojiCache.set(id, { image, at: Date.now() });
    return image;
  });
  emojiCache.delete(id); // re-insert at the end (FIFO order)
  while (emojiCache.size >= MAX_CACHE) emojiCache.delete(emojiCache.keys().next().value);
  emojiCache.set(id, { promise, at: Date.now() });
  return promise;
}

// The tones of a class icon (strongest first, hex), cached per emoji id for the process. [] = none / failed.
// The class palette (collision-aware, see services/iconColor.js) is built from these by the image that draws the classes.
const iconTones = new Map();
function iconTonesOf(id, image) {
  if (iconTones.has(id)) return iconTones.get(id);
  let tones = [];
  try {
    const w = Math.min(image.width || 48, 64);
    const h = Math.min(image.height || 48, 64);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, w, h);
    tones = dominantColors(ctx.getImageData(0, 0, w, h).data, w, h, 3).map((t) => t.hex);
  } catch {
    tones = [];
  }
  iconTones.set(id, tones);
  return tones;
}

const INK = '#1f2937';
const MUTED = '#6b7280';
const GRID = '#c4cad4';
const WIDTH = 1500;
const MARGIN = 20;
const BAR_H = 54;
const CHIP = 22;
const font = (size, bold = false) => `${bold ? 'bold ' : ''}${size}px "${FAMILY}"`;

// Names: fold fancy letters, drop emoji (they would draw as empty boxes).
const cleanName = (name) =>
  String(name ?? '')
    .normalize('NFKC')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{E0020}-\u{E007F}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim() || '·';

// `text` shortened with "…" so that it is at most `maxW` wide in the current font.
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  const chars = Array.from(text);
  while (chars.length > 1) {
    chars.pop();
    const cut = `${chars.join('').trimEnd()}…`;
    if (ctx.measureText(cut).width <= maxW) return cut;
  }
  return '…';
}

// The class mark: the emoji image when there is one, else a coloured rounded square.
function drawChip(ctx, x, y, color, image) {
  if (image) return ctx.drawImage(image, x, y, CHIP, CHIP);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, CHIP, CHIP, 6);
  return ctx.fill();
}

// Forget the cached emoji images (tests).
function clearEmojiCache() {
  emojiCache.clear();
  iconTones.clear();
}

function drawBar(ctx, text, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(MARGIN, y, WIDTH - 2 * MARGIN, BAR_H);
  ctx.fillStyle = '#ffffff';
  ctx.font = font(30, true);
  ctx.textAlign = 'left';
  ctx.fillText(text, MARGIN + 16, y + BAR_H / 2 + 1);
}

module.exports = { iconTonesOf, ensureFonts, font, fit, drawChip, drawBar, loadEmojiImage, clearEmojiCache, cleanName, WIDTH, MARGIN, BAR_H, CHIP, INK, MUTED, GRID };
