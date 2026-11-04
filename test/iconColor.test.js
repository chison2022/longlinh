// Dominant colour of a class icon from raw RGBA pixels.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dominantColor, dominantColors, assignDistinct, classPalette, markTone, contrastOf, hueGap, hueOf, shade } = require('../src/services/iconColor');

// n x n image: `paint(x, y)` -> [r, g, b, a]
function image(n, paint) {
  const px = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) px.set(paint(x, y), (y * n + x) * 4);
  return px;
}
const hue = (hex) => {
  const v = parseInt(hex.slice(1), 16);
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

describe('dominantColor', () => {
  it('orange-dominant: an orange shape with grey outline and transparent corners', () => {
    const px = image(20, (x, y) => (x < 2 ? [120, 120, 120, 255] : y < 3 ? [0, 0, 0, 0] : x % 5 === 0 ? [255, 255, 255, 255] : [240, 140, 30, 255]));
    const c = dominantColor(px, 20, 20);
    assert.match(c, /^#[0-9a-f]{6}$/);
    assert.ok(Math.abs(hue(c) - 33) < 12, `orange, got ${c} hue ${hue(c)}`);
  });
  it('yellow-dominant, even with a smaller orange part', () => {
    const px = image(20, (x) => (x < 14 ? [250, 215, 40, 255] : [235, 120, 20, 255]));
    const c = dominantColor(px, 20, 20);
    assert.ok(hue(c) > 42 && hue(c) < 62, `yellow, got ${c} hue ${hue(c)}`);
  });
  it('mostly white with a little blue: blue wins (white is ignored)', () => {
    const px = image(20, (x, y) => (x < 4 && y < 10 ? [40, 90, 230, 255] : [255, 255, 255, 255]));
    const c = dominantColor(px, 20, 20);
    assert.ok(hue(c) > 205 && hue(c) < 235, `blue, got ${c}`);
  });
  it('a fully transparent, grey or black image has no colour', () => {
    assert.equal(dominantColor(image(8, () => [255, 0, 0, 0]), 8, 8), null);
    assert.equal(dominantColor(image(8, () => [128, 128, 128, 255]), 8, 8), null);
    assert.equal(dominantColor(image(8, () => [10, 10, 10, 255]), 8, 8), null);
    assert.equal(dominantColor(new Uint8ClampedArray(0), 0, 0), null);
  });
  it('the result is bright enough for the dark UI; the light variant is darker', () => {
    const dark = dominantColor(image(8, () => [90, 20, 20, 255]), 8, 8); // a dim red
    const lightness = (hex) => { const v = parseInt(hex.slice(1), 16); return (Math.max((v >> 16) & 255, (v >> 8) & 255, v & 255) + Math.min((v >> 16) & 255, (v >> 8) & 255, v & 255)) / 510; };
    assert.ok(lightness(dark) >= 0.5);
    assert.ok(lightness(shade(dark, 'light')) < lightness(dark));
  });

  it('dominantColors: hue-distinct tones strongest first; a pale wash is a rose tone after the strong red', () => {
    const red = (x, y) => (x < 6 ? [230, 60, 50, 255] : x < 16 ? [240, 190, 185, 255] : [0, 0, 0, 0]); // red part + pale pink part
    const tones = dominantColors(image(20, red), 20, 20, 3);
    assert.ok(tones.length >= 2 && tones[0].share > 0 && !tones[0].pastel);
    assert.ok(tones[tones.length - 1].pastel, 'the wash comes last');
    assert.ok(hueGap(hueOf(tones[tones.length - 1].hex), tones[0].hue) >= 24, 'rose is nudged away from the red');
    assert.deepEqual(dominantColors(image(8, () => [255, 0, 0, 0]), 8, 8), []);
  });
  it('assignDistinct: a class that only has red keeps it, the one with a rose tone moves to the rose', () => {
    const m = assignDistinct([['TV', ['#f66451', '#f19dce']], ['HH', ['#f66251']], ['TY', ['#f6bc51']]]);
    assert.equal(m.get('HH'), '#f66251');
    assert.equal(m.get('TV'), '#f19dce');
    assert.equal(m.get('TY'), '#f6bc51');
    assert.equal(assignDistinct([['A', ['#f66451']], ['B', ['#f66251']]]).get('B'), '#f66251', 'no distinct tone left: it keeps its own');
  });
  it('classPalette: marks hold 2.6:1 on the paper, neighbouring hues differ in lightness, every class gets a fill', () => {
    const paper = '#eee6d2';
    const pal = classPalette([['Y', ['#f6bc51']], ['V', ['#f66451', '#f19dce']], ['H', ['#f66251']], ['T', ['#4575f5']], ['L', ['#9751f6']], ['C', ['#e6d761']]], paper);
    assert.equal(pal.size, 6);
    for (const [, v] of pal) assert.ok(contrastOf(v.mark, paper) >= 2.55, v.mark);
    assert.notEqual(pal.get('V').mark, pal.get('H').mark);
    assert.ok(contrastOf(markTone('#e6d761', paper), paper) >= 2.55, 'a pale yellow still gets a readable mark');
  });
});
