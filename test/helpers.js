// Shared test fixtures. Not a test file (no .test.js suffix).

// Vietnam local wall-clock time (UTC+7, no DST) -> UTC Date. Month is 1-based.
function vn(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute));
}

// Deterministic 24-hex ObjectId-like string.
function oid(n = 1) {
  return String(n).padStart(24, '0');
}

// Deterministic 18-digit Discord snowflake-like id.
function sid(n) {
  return String(100000000000000000n + BigInt(n));
}

// Long Vietnamese display names, capped at Discord's 32-char display-name limit.
const LONG_NAMES = [
  'Nguyễn Thị Phương Thảo Xinh',
  'Trần Hoàng Long Bá Đạo Thiên',
  'Lê Văn Quyết Chiến Không Lùi',
  'Phạm Ngọc Ánh Dương Rực Rỡ',
  'Hoàng Đức Thắng Vô Địch Sơn',
];

function longName(i) {
  const name = `${LONG_NAMES[i % LONG_NAMES.length]} ${i.toString(36).padStart(3, '0')}`; // unique up to 46655
  if (name.length > 32) throw new Error(`fixture name too long: ${name}`);
  return name;
}

// Build n registrations; `classOf(i)` decides className, `statusOf(i)` decides status.
function makeRegs(n, { classOf = () => 'Tố Vấn', statusOf = () => 'join', nameOf = longName, offset = 0 } = {}) {
  return Array.from({ length: n }, (_, k) => {
    const i = k + offset;
    return { discordId: sid(i), displayName: nameOf(i), className: classOf(i), status: statusOf(i) };
  });
}

module.exports = { vn, oid, sid, longName, makeRegs };
