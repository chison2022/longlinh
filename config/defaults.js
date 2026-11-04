// Default values used when a guild runs /setup for the first time.
// Admins can change classes and schedule later via the "Cài đặt" button.
module.exports = {
  timezoneOffsetHours: 7, // Asia/Ho_Chi_Minh, no DST

  classes: ['Thiết Y', 'Tố Vấn', 'Huyết Hà', 'Thần Tương', 'Toái Mộng', 'Cửu Linh', 'Long Ngâm'],

  // Unicode icon per class (by plain name): shown only when no server emoji matches the class (see bot/classStyle.js).
  classFallbackEmoji: {
    'Thiết Y': '🛡️',
    'Tố Vấn': '💊',
    'Huyết Hà': '🩸',
    'Thần Tương': '⚔️',
    'Toái Mộng': '🌙',
    'Cửu Linh': '🔮',
    'Long Ngâm': '🐉',
  },

  // One Nhóm (group) = 5 PT (party) x 6 people = 30; a full guild war is 2 Nhóm = 10 PT = 60 people.
  groupCount: 2,
  partiesPerGroup: 5,
  partySize: 6,

  // The war message warns when the joined people lack one healer and one tank per PT they fill.
  healerClass: 'Tố Vấn',
  tankClass: 'Thiết Y',

  // Member role (the "🎯 Vai trò" button): label + description for the select, plain = the sheet cell (no emoji).
  roles: {
    def: { label: '🛡️ Def', plain: 'Def', desc: 'Thủ trụ / thủ nhà' },
    cong: { label: '⚔️ Công', plain: 'Công', desc: 'Đánh chính, công trụ địch' },
    daytru: { label: '🗼 Đẩy trụ', plain: 'Đẩy trụ', desc: 'Đi cánh đẩy trụ' },
    vattu: { label: '📦 Vật tư', plain: 'Vật tư', desc: 'Nhặt vật tư, buff sĩ khí' },
    any: { label: '🤷 Không biết — tùy lead sắp xếp', plain: 'Tùy lead', desc: 'Để lead xếp vào chỗ cần' },
  },

  schedule: {
    enabled: false,
    warDay: 6, // 0 = Chủ nhật, 1 = Thứ 2 ... 6 = Thứ 7 (in-game guild war: Saturday 20:00-21:00)
    warTime: '20:00',
    warDurationMinutes: 60,
    openDay: 1,
    openTime: '00:00',
    lockBeforeHours: 2, // lock registration N hours before the war starts
    remindBeforeHours: 3, // remind N hours before the lock (0 = off)
    openPing: false, // when the war message is auto-posted, one extra message tags the member role ("no mass tags" stays the default)
  },

  // Registration message refresh is debounced so 80 people clicking at once
  // does not hit Discord's message edit rate limit.
  refreshDebounceMs: 2500,

  // Guild event categories (the key is stored on the event): emoji on the card title + label under it. Order = order in the form's select.
  eventCategories: {
    pvp: { emoji: '⚔️', label: 'PvP / thi đấu' },
    mind: { emoji: '♟️', label: 'Cờ / trí tuệ' },
    music: { emoji: '🎤', label: 'Văn nghệ / hát' },
    video: { emoji: '🎬', label: 'Quay video / sáng tạo' },
    social: { emoji: '🎉', label: 'Giao lưu / họp mặt' },
    pve: { emoji: '🐉', label: 'Boss / phó bản' },
    other: { emoji: '📦', label: 'Khác' },
  },
  eventCategoryDefault: 'other',

  // Guild size (the draft rules): up to 60 official members + 20 apprentices (Học Việc, counted apart); below the target the guild opens recruiting.
  officialCap: 60,
  apprenticeCap: 20,
  rosterTarget: 50, // default of the per-guild config rosterTarget (1..officialCap)

  // Events are marked "done" this long after the war started.
  doneAfterHours: 12,
};
