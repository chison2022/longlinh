// Lineup colours and class labels shared by the PNG and the spreadsheet (pure).
// Distinct, readable on white; a class takes the colour of its index (modulo the palette size).
const PALETTE = ['#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#0c8599', '#d6336c', '#5c940d', '#6741d9', '#868e96'];
const chipColor = (index) => PALETTE[index % PALETTE.length];

// "🛡️ Thiết Y" -> "Thiết Y" (the legend shows the colour, not the emoji).
const plainClass = (name) =>
  String(name)
    .replace(/^\d[\u{FE0F}]?\u{20E3}\s*/u, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim() || String(name);

// Settings line "🩸 Huyết Hà :HH_icon:" -> { name: '🩸 Huyết Hà', emoji: 'HH_icon' }. The trailing :token: names a server
// emoji to use for the class (`:none:` = no custom emoji); a trailing :x: token is ALWAYS an override, never part of the name. It is NOT part of the class name (registrations store the name without it). A line that is
// only a token, or has no token, is returned unchanged with emoji null.
const CLASS_TOKEN = /^(.*\S)\s+:([A-Za-z0-9_]{2,32}):$/;
function splitClassToken(line) {
  const m = CLASS_TOKEN.exec(String(line).trim());
  return m ? { name: m[1].trim(), emoji: m[2] } : { name: String(line).trim(), emoji: null };
}

module.exports = { chipColor, plainClass, splitClassToken };
