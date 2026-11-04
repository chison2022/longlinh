// The colour of a class icon (pure: no canvas, no DOM; the Activity client and the bot image both feed it pixels).
// Transparent, grey, near-white and near-black pixels are ignored; the rest vote for their hue (weighted by saturation and brightness),
// the strongest hue bin wins and its average is normalised so it reads on the dark UI.

// Collision rule (classPalette -> assignDistinct): the icon is the standard, so each class takes its strongest tone. If another class already
// holds a hue within 24 degrees AND a similar lightness (< 0.12), it takes its next tone: the next hue-distinct bin of its icon, or the
// "pastel wash" of an icon that is mostly white (a pale pink wash becomes a rose, hue nudged 28 degrees). Classes with fewer tones choose
// first, so a class that only has red keeps it. Marks (bars, rims, dots) are then darkened to hold 2.6:1 on the paper, and neighbouring
// hues get a lightness step so colour-blind readers can tell them apart; the icon, the 2-letter tag and the name always carry identity too.
const BINS = 30; // 12 degrees each

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// '#rrggbb' lightness / saturation brought into a readable range. mode 'dark' (default) = for the dark UI, 'light' = for a white image.
function shade(hex, mode = 'dark') {
  const n = parseInt(String(hex).slice(1), 16);
  const [h, s, l] = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  const sat = Math.min(0.9, Math.max(0.55, s));
  // on paper / white the tone is darkened by a fixed step (not clamped), so a pale tone stays lighter than a strong one of the same hue
  const light = mode === 'light' ? Math.min(0.56, Math.max(0.3, l - 0.16)) : Math.min(0.64, Math.max(0.52, l));
  return hslToHex(h, sat, light);
}

// The hue-distinct colours of an icon, strongest first: [{ hex, hue, share }] (share = part of the coloured pixels). Each is normalised like
// dominantColor. A hue spreads over neighbouring bins, so a winner suppresses the bins within 24 degrees before the next one is picked.
function dominantColors(rgba, width, height, max = 3) {
  const sum = new Float64Array(BINS);
  const rs = new Float64Array(BINS);
  const gs = new Float64Array(BINS);
  const bs = new Float64Array(BINS);
  const pixels = Math.min(width * height, Math.floor(rgba.length / 4));
  let all = 0;
  const pastel = { w: 0, r: 0, g: 0, b: 0 }; // pale, slightly coloured pixels (an icon that is mostly white with a pink wash)
  for (let i = 0; i < pixels; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 110) continue;
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const v = mx / 255;
    const sat = mx ? (mx - mn) / mx : 0;
    if (sat >= 0.12 && sat < 0.28 && v >= 0.6) {
      const w = sat * v * (a / 255);
      pastel.w += w;
      pastel.r += r * w;
      pastel.g += g * w;
      pastel.b += b * w;
    }
    if (sat < 0.28 || v < 0.25) continue; // grey, near-white, near-black
    const [h] = rgbToHsl(r, g, b);
    const bin = Math.min(BINS - 1, Math.floor((h / 360) * BINS));
    const w = sat * v * (a / 255);
    sum[bin] += w;
    rs[bin] += r * w;
    gs[bin] += g * w;
    bs[bin] += b * w;
    all += w;
  }
  const out = [];
  const taken = new Set();
  while (out.length < max) {
    let best = -1;
    let bestScore = 0;
    for (let k = 0; k < BINS; k++) {
      if (taken.has(k)) continue;
      const score = sum[k] + 0.5 * (sum[(k + 1) % BINS] + sum[(k + BINS - 1) % BINS]);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (best < 0 || !(sum[best] > 0)) break;
    for (const d of [-2, -1, 0, 1, 2]) taken.add((best + d + BINS) % BINS);
    const [h, sat, l] = rgbToHsl(rs[best] / sum[best], gs[best] / sum[best], bs[best] / sum[best]);
    out.push({ hex: hslToHex(h, Math.min(0.9, Math.max(0.55, sat)), Math.min(0.64, Math.max(0.52, l))), hue: Math.round(h), share: sum[best] / all });
    if (out[out.length - 1].share < 0.06) out.pop(); // a stray accent, not a tone of the icon
  }
  // the pastel wash, when it is a real part of the icon, is the last tone: lighter and softer than the strong ones of the same hue
  if (out.length < max && pastel.w > 0 && pastel.w / (all + pastel.w) >= 0.25) {
    const [h, sat, l] = rgbToHsl(pastel.r / pastel.w, pastel.g / pastel.w, pastel.b / pastel.w);
    const rose = (h + 318) % 360; // a pale wash reads as rose / pink: its hue is nudged 42 degrees toward magenta
    out.push({ hex: hslToHex(rose, Math.min(0.75, Math.max(0.45, sat * 2.2)), Math.min(0.78, Math.max(0.68, l))), hue: Math.round(rose), share: pastel.w / (all + pastel.w), pastel: true });
  }
  return out;
}

// The strongest colour of an icon (what dominantColors puts first), or null.
function dominantColor(rgba, width, height) {
  const top = dominantColors(rgba, width, height, 1)[0];
  return top ? top.hex : null;
}

const hueOf = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255)[0];
};
const lightOf = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255)[2];
};
const hueGap = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

// Collision-aware colours for a set of classes. items: [[key, [hex, ...]]] (the guild's class order), each list the icon's tones strongest
// first. A class takes its strongest tone unless a class already holds a hue within `minGap` degrees AND a similar lightness; then it takes
// its next distinct tone (an icon that is mostly white with a pink wash gives a rose). No distinct tone left: the strongest stays.
// -> Map key -> hex (classes without any tone are absent).
function assignDistinct(items, minGap = 24) {
  const chosen = new Map();
  const used = [];
  // classes with the fewest tones choose first (a class that only has red keeps it; the one with a spare tone moves over)
  const order = items.map((it, i) => [it, i]).filter(([it]) => it[1] && it[1].length).sort((x, y) => x[0][1].length - y[0][1].length || x[1] - y[1]);
  const apart = (hex) => used.every((u) => hueGap(hueOf(hex), u.hue) >= minGap || Math.abs(lightOf(hex) - u.light) >= 0.12);
  for (const [[key, list]] of order) {
    const pick = list.find(apart) || list[0];
    chosen.set(key, pick);
    used.push({ hue: hueOf(pick), light: lightOf(pick) });
  }
  return chosen;
}

// WCAG contrast of two '#rrggbb'.
function contrastOf(a, b) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The tone as a MARK on a light surface (accent bar, icon rim, legend ring): the same hue darkened until it holds 2.6:1 against the surface (the tag text and the icon carry identity too).
function markTone(hex, surface) {
  const n = parseInt(hex.slice(1), 16);
  const [h, s, l0] = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  const sat = Math.min(0.95, Math.max(0.72, s)); // a dark tone keeps its chroma: it must not fall to grey
  let l = Math.min(0.58, l0);
  let out = hslToHex(h, sat, l);
  while (contrastOf(out, surface) < 2.6 && l > 0.26) {
    l -= 0.02;
    out = hslToHex(h, sat, l);
  }
  return out;
}

// The class palette for a light surface. items: [[key, [tone, ...]]] as for assignDistinct. -> Map key -> { fill, mark }
//   fill = the chosen tone (tints, glows); mark = markTone of it. Tones whose hues sit within 50 degrees of the previous one (hue order)
//   get a darker mark (10% lightness down) so blue/violet or green/teal neighbours also differ in lightness, which colour-blind readers use.
function classPalette(items, surface = '#eee6d2') {
  const chosen = assignDistinct(items);
  const keys = [...chosen.keys()].sort((a, b) => hueOf(chosen.get(a)) - hueOf(chosen.get(b)));
  const out = new Map();
  const done = [];
  for (const key of keys) {
    let mark = markTone(chosen.get(key), surface);
    if (done.some((m) => hueGap(hueOf(mark), hueOf(m)) < 50 && Math.abs(lightOf(mark) - lightOf(m)) < 0.1)) {
      const n = parseInt(mark.slice(1), 16);
      const [h, s, l] = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
      mark = hslToHex(h, s, Math.max(0.24, l - 0.1));
    }
    out.set(key, { fill: chosen.get(key), mark });
    done.push(mark);
  }
  return out;
}

module.exports = { classPalette, markTone, contrastOf, dominantColor, dominantColors, assignDistinct, shade, hueOf, hueGap };
