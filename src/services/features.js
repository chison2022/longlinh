// 🙋 Xin nghỉ, ⚖️ Sổ vi phạm and 🎲 Quay thưởng were retired: they are not toggles any more and isOn(config, key) is always false for them (whatever is stored).
// Per-guild feature toggles (GuildConfig.features). Pure: no DB, no Discord.
// The core (war registration, 🎯 Vai trò, class, 📋 list, 👥 unregistered + remind, 📢 publish, 🎮 name link + game roster, 📊 Sheet, 👥 headcount)
// has no toggle and is always on. A config WITHOUT the field (a guild set up before the toggles existed) is computed from what it already uses:
// a feature whose panel was posted (or the gate, when gateEnabled) stays on, the rest follows the new-guild defaults.

const FEATURE_KEYS = ['tuyenKhien', 'events', 'mailbox', 'gate', 'voiceHang', 'offNotice', 'departNotice'];

// Defaults of a NEW guild.
const NEW_GUILD_DEFAULTS = Object.freeze({
  tuyenKhien: true,
  events: false,
  mailbox: false,
  gate: false,
  voiceHang: false,
  offNotice: true,
  departNotice: true,
});

// emoji / label / short description for the 🧩 Tính năng select; `setup` = the extra setup the feature needs once it is turned on (null = none).
const FEATURES = [
  { key: 'tuyenKhien', emoji: '🛡', label: 'Tuyến Khiên', desc: 'Nút chọn nhóm Tuyến Khiên trên thẻ bang chiến', setup: null },
  { key: 'events', emoji: '🎉', label: 'Sự kiện', desc: 'Sự kiện bang ngoài bang chiến (thẻ, nhắc, chốt)', setup: '🎉 Sự kiện: bảng quản lý đăng ở kênh admin (hoặc chọn kênh riêng ở ⚙️ Nâng cao → 🎉 Sự kiện).' },
  { key: 'mailbox', emoji: '📮', label: 'Hòm thư', desc: 'Thành viên gửi góp ý, có thể ẩn danh', setup: '📮 Hòm thư: thư hiện ở kênh admin; thư ẩn danh cần khoá (chủ bot chạy npm run mail:keygen).' },
  { key: 'gate', emoji: '🚪', label: 'Cổng vào', desc: 'Người mới chọn tên game: có trong danh sách thì bot tự duyệt và cấp role', setup: '🚪 Cổng vào cần kênh welcome và role Thành viên: vào ⚙️ Nâng cao → 🚪 Cổng vào.' },
  { key: 'voiceHang', emoji: '🎧', label: 'Treo voice', desc: 'Bot ngồi sẵn trong 1 kênh voice (tắt mic, tắt loa)', setup: '🎧 Treo voice: chọn kênh ở ⚙️ Nâng cao → 🎧 Treo voice.' },
  { key: 'offNotice', emoji: '⏰', label: 'Báo off lâu', desc: 'Báo quản lý ai off game quá N ngày', setup: null },
  { key: 'departNotice', emoji: '👋', label: 'Báo rời game', desc: 'Báo quản lý ai đã rời game mà còn trong Discord', setup: null },
];

// What an existing guild (no `features` field) already uses.
function legacyDefault(config, key) {
  const c = config || {};
  if (key === 'events') return Boolean(c.eventPanelMessageId);
  if (key === 'mailbox') return Boolean(c.mailPanelMessageId);
  if (key === 'gate') return Boolean(c.gateEnabled || c.gatePanelMessageId);
  return NEW_GUILD_DEFAULTS[key];
}

// Is `key` on for this guild? The stored toggle wins; without it the value is computed (see the top of the file).
// `gateEnabled` is still read for configs that have no stored toggle for the gate.
function isOn(config, key) {
  if (!FEATURE_KEYS.includes(key)) return false;
  const stored = config && config.features && config.features[key];
  return typeof stored === 'boolean' ? stored : legacyDefault(config, key);
}

// All the toggles of a config as { key: boolean }.
function featuresOf(config) {
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, isOn(config, key)]));
}

// "🎉 Sự kiện · 📮 Hòm thư · …" of the optional features that are on (the first line of /setup).
function enabledLine(config) {
  const on = FEATURES.filter((f) => isOn(config, f.key));
  return on.length ? on.map((f) => `${f.emoji} ${f.label}`).join(' · ') : '_không có_';
}

module.exports = { FEATURE_KEYS, NEW_GUILD_DEFAULTS, FEATURES, isOn, featuresOf, enabledLine };
