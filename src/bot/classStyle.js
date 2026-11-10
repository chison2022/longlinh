// Per-class look: server emoji, role colour, plain name. The guild is only READ (roles + emojis); another bot hands out roles.
const { normalizeName, classId } = require('../services/registrationService');
const { plainClass } = require('../services/lineupStyle');
const defaults = require('../../config/defaults');

const TTL_MS = 60 * 1000;
const NONE_TOKEN = 'none'; // `:none:` in the settings: this class never gets a custom emoji

// "Thiết Y" -> "thiety", "Đại Hiệp" -> "daihiep": lower-case, diacritics stripped, only [a-z0-9].
const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// First token of a class label when it is an emoji/symbol (not a letter or digit), else null.
function unicodePrefix(label) {
  const first = String(label).split(/\s+/)[0];
  return first && first.length <= 12 && !/^[\p{L}\p{N}]/u.test(first) ? first : null;
}

// Unicode fallback of a class: the label's own emoji prefix, else the default icon of its plain name, else a bullet.
const fallbackById = new Map(Object.entries(defaults.classFallbackEmoji || {}).map(([k, v]) => [classId(k), v]));
const fallbackText = (label) => unicodePrefix(label) || fallbackById.get(classId(label)) || '•';

const customText = (e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
const byName = (a, b) => a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1);

// Best guild emoji for a class: override by name, else exact slug, else exact initials (no fuzzy matching). Deterministic: shortest name wins.
// "Thiết Y" -> "TY", "Đại Hiệp" -> "DH": first letter of each word, diacritics stripped, upper-case.
const initials = (plain) =>
  String(plain)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

const words = (plain) =>
  String(plain)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

// Short codes of the classes ("Thiết Y" -> TY) by plain name. Two classes with the same initials: the later one gets one more
// letter (the first free of the letters after each word's first) appended (TY / TYh). -> Map<plain name, code>
function classCodes(classes) {
  const out = new Map();
  const used = new Set();
  for (const c of classes) {
    const plain = plainClass(c);
    if (out.has(plain)) continue;
    const base = initials(plain) || plain;
    const rest = initials(plain) ? words(plain).flatMap((w) => [...w.slice(1).toLowerCase()]) : []; // the letters after each word's first
    let code = base;
    for (let i = 0; used.has(code) && i < rest.length; i++) code = base + rest[i];
    used.add(code);
    out.set(plain, code);
  }
  return out;
}

// `useInitials` is false when another class has the same initials (ambiguous).
function findEmoji(className, emojis, override, useInitials) {
  const list = emojis.map((e) => ({ ...e, slug: slug(e.name) })).filter((e) => e.slug);
  if (override && String(override).toLowerCase() === NONE_TOKEN) return null;
  if (override) {
    const want = override.toLowerCase();
    const hit = list.filter((e) => e.name.toLowerCase() === want).sort(byName)[0] || list.filter((e) => e.slug === slug(override)).sort(byName)[0];
    if (hit) return hit;
  }
  const cs = slug(plainClass(className));
  if (!cs) return null;
  const exact = list.filter((e) => e.slug === cs).sort(byName)[0];
  if (exact) return exact;
  const ini = useInitials ? initials(plainClass(className)) : '';
  if (ini.length >= 2) {
    const hit = list.filter((e) => e.name.toUpperCase() === ini).sort(byName)[0];
    if (hit) return hit;
  }
  return null;
}

const asOverrides = (o) => {
  const out = Object.create(null);
  if (Array.isArray(o)) for (const x of o) out[x.className] = x.emoji;
  else if (o) Object.assign(out, o);
  return out;
};

// Pure core. classes: names (no override token); roles: [{ name, color }]; emojis: [{ id, name, animated }];
// overrides: { className: emojiName } or [{ className, emoji }] (`none` = no custom emoji).
// An emoji is used only when it is not managed and not role-restricted, or one of its roles is in botRoleIds.
// -> Map<className, { emoji: {id,name,animated}|null, emojiText, color: number|null, plain }>
function matchClassStyles(classes, roles = [], allEmojis = [], overrides = {}, botRoleIds = []) {
  const ov = Object.create(null); // by class identity, so an override survives a label respelling ("🛡️ Thiết Y" -> "Thiết Y")
  for (const [k, v] of Object.entries(asOverrides(overrides))) ov[classId(k)] = v;
  const mine = new Set(botRoleIds);
  const emojis = allEmojis.filter((e) => !e.managed && (!(e.roleIds && e.roleIds.length) || e.roleIds.some((id) => mine.has(id))));
  const colorByRole = new Map();
  for (const r of roles) {
    const key = normalizeName(r.name);
    if (key && r.color && !colorByRole.has(key)) colorByRole.set(key, r.color);
  }
  const out = new Map();
  const iniCount = new Map();
  for (const c of classes) iniCount.set(initials(plainClass(c)), (iniCount.get(initials(plainClass(c))) || 0) + 1);
  for (const className of classes) {
    const plain = plainClass(className);
    const found = findEmoji(className, emojis, ov[classId(className)], iniCount.get(initials(plain)) === 1);
    out.set(className, {
      emoji: found ? { id: found.id, name: found.name, animated: Boolean(found.animated) } : null,
      emojiText: found ? customText(found) : fallbackText(className),
      color: colorByRole.get(normalizeName(plain)) || null,
      plain,
    });
  }
  return out;
}

// Style of a class that may not be in the map (a class seen only in old registrations, or no styles given).
function styleOf(styles, className) {
  const hit = styles && styles.get(className);
  if (hit) return hit;
  if (styles) {
    const id = classId(className); // an old spelling of a configured class
    for (const [k, v] of styles) if (classId(k) === id) return v;
  }
  return { emoji: null, emojiText: fallbackText(className), color: null, plain: plainClass(className) };
}

const segmenter = new Intl.Segmenter();

// A unicode text as a select option emoji: one grapheme cluster that is a pictograph (any ZWJ / skin-tone / VS16 sequence)
// or a flag. A lone BMP pictograph without VS16 gets it appended ("⚔" -> "⚔️"). Anything else -> undefined.
function unicodeOptionEmoji(text) {
  let t = String(text || '');
  if (t.length === 1 && /^\p{Extended_Pictographic}$/u.test(t)) t += '\u{FE0F}';
  if ([...segmenter.segment(t)].length !== 1) return undefined;
  return /^(\p{Extended_Pictographic}|\p{Regional_Indicator}{2})/u.test(t) ? { name: t } : undefined;
}

// Option emoji for a select: the custom emoji, or the unicode prefix when it is a valid emoji, else undefined.
function optionEmoji(style) {
  if (style.emoji) return { id: style.emoji.id, name: style.emoji.name, animated: style.emoji.animated };
  return unicodeOptionEmoji(style.emojiText);
}

// Discord rejected the message body (error 50035), e.g. an option emoji it will not accept.
const isInvalidFormBody = (e) => Boolean(e) && (e.code === 50035 || (e.rawError && e.rawError.code === 50035));

// editReply(build(false)); on an invalid form body drop the cached styles and retry once with build(true) = no option emojis.
async function editReplyWithEmojiFallback(interaction, build) {
  try {
    return await interaction.editReply(build(false));
  } catch (err) {
    if (!isInvalidFormBody(err)) throw err;
    invalidateClassStyles(interaction.guildId);
    return interaction.editReply(build(true));
  }
}

// Colour number -> '#rrggbb' (null stays null).
const hexOf = (n) => (n ? `#${n.toString(16).padStart(6, '0')}` : null);

// Plain object for the pure image/xlsx renderers: { [className]: { color: '#rrggbb'|null, emoji } }
function lineupStyles(styles) {
  const out = Object.create(null);
  if (styles) for (const [k, s] of styles) out[k] = { color: hexOf(s.color), emoji: s.emoji };
  return out;
}

// ---------- guild wrapper ----------

const cache = new Map(); // guildId -> { at, key, styles }

function invalidateClassStyles(guildId) {
  if (guildId) cache.delete(guildId);
}

function clearClassStyles() {
  cache.clear();
}

function resolveClassStyles(guild, classes, overrides = {}) {
  if (!guild) return new Map();
  const botRoleIds = guild.members && guild.members.me ? [...guild.members.me.roles.cache.keys()] : [];
  const key = JSON.stringify([classes, asOverrides(overrides), botRoleIds]);
  const hit = cache.get(guild.id);
  if (hit && hit.key === key && Date.now() - hit.at < TTL_MS) return hit.styles;
  const roles = guild.roles ? guild.roles.cache.map((r) => ({ name: r.name, color: r.colors?.primaryColor ?? r.color })) : [];
  const emojis = guild.emojis
    ? guild.emojis.cache.filter((e) => e.available !== false).map((e) => ({ id: e.id, name: e.name, animated: e.animated, managed: Boolean(e.managed), roleIds: e.roles ? [...e.roles.cache.keys()] : [] }))
    : [];
  const styles = matchClassStyles(classes, roles, emojis, overrides, botRoleIds);
  cache.set(guild.id, { at: Date.now(), key, styles });
  return styles;
}

// Class -> name of the server emoji auto-matching picks (no overrides), for the settings prefill/parse. Map<className, name|null>.
function autoEmojiNames(guild, classes) {
  const out = new Map();
  for (const [k, s] of resolveClassStyles(guild, classes, {})) out.set(k, s.emoji ? s.emoji.name : null);
  return out;
}

const stylesOf = (guild, config) => resolveClassStyles(guild, config.classes, config.classEmojis);

module.exports = {
  slug,
  matchClassStyles,
  styleOf,
  optionEmoji,
  lineupStyles,
  resolveClassStyles,
  stylesOf,
  initials,
  classCodes,
  autoEmojiNames,
  invalidateClassStyles,
  clearClassStyles,
  editReplyWithEmojiFallback,
};
