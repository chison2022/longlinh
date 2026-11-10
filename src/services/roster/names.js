// Character-name keys and checks (pure): comparison keys, names the game cut with "…", names a member types.
// Comparison key of a character name: NFKC, lower-case, spaces and punctuation/symbols removed.
const norm = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '');
// Same, with Vietnamese accents folded ("Hắc Phong" == "hac phong").
const fold = (s) => norm(s).normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');

// Lookalike letters of other scripts -> the Latin letter they are drawn like (a typed name must not be able to hide behind them).
const CONFUSABLES = new Map(
  Object.entries({
    а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', к: 'k', м: 'm', т: 't', н: 'h', в: 'b', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g',
    А: 'a', В: 'b', Е: 'e', К: 'k', М: 'm', Н: 'h', О: 'o', Р: 'p', С: 'c', Т: 't', Х: 'x', І: 'i', Ј: 'j', Ѕ: 's',
    α: 'a', ο: 'o', ν: 'v', ρ: 'p', ι: 'i', κ: 'k', τ: 't', υ: 'u', χ: 'x', Α: 'a', Β: 'b', Ε: 'e', Ζ: 'z', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm', Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Υ: 'y', Χ: 'x',
  })
);
const skeleton = (s) => [...String(s)].map((ch) => CONFUSABLES.get(ch) || ch).join('');
// The key a game name is unique by: fold() of the name with lookalike letters mapped to Latin ("Кelo" == "Kelo").
const nameKey = (s) => fold(skeleton(String(s).normalize('NFKC')));

// A name the game cut is written "Abc…"; a transcription may have "Abc..." instead. Both are cut names; normalizeCut gives the "…" form.
const CUT_RE = /\s*(?:…|\.{3})$/;
const isCutName = (name) => CUT_RE.test(String(name));
const normalizeCut = (name) => String(name).replace(/\s*\.{3}$/, '…');
const cutStem = (name) => String(name).replace(CUT_RE, '');

const FREE_NAME_MAX = 32;
// Letters: Basic Latin, Latin-1, Latin Extended-A/B and Latin Extended Additional (Vietnamese); NOT IPA / phonetic / small-capital lookalikes (ʙ ꜰ ᴏ ɑ)
const FREE_NAME_OK = /^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u1E00-\u1EFF\u0300-\u036F\p{N}\s_.\-'·]+$/u; // letters, combining accents, digits, space and a few symbols
// A name the member typed -> { name } (NFKC, invisible format characters removed, spaces collapsed) or { error } (Vietnamese sentence).
function cleanFreeName(input) {
  const name = String(input ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || [...name].length > FREE_NAME_MAX) return { error: `Tên phải từ 1 đến ${FREE_NAME_MAX} ký tự.` };
  if (!FREE_NAME_OK.test(name)) return { error: "Tên chỉ được dùng chữ Latin / tiếng Việt, số, khoảng trắng và các ký tự _ . - ' · (không trộn chữ của bảng chữ cái khác, không emoji)." };
  if (!nameKey(name)) return { error: 'Tên phải có ít nhất một chữ hoặc số.' };
  return { name };
}

module.exports = { norm, fold, skeleton, nameKey, isCutName, normalizeCut, cutStem, FREE_NAME_MAX, cleanFreeName };
