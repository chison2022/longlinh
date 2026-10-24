// The role a member picks on the war message (pure: no Discord, no DB); the admins arrange the teams themselves.
// Texts come from config/defaults.js (roles). 'any' = "tùy lead sắp xếp". Older rows and old selects may still say mid / mobile / supply.
const defaults = require('../../config/defaults');

const ROLE_IDS = ['def', 'cong', 'daytru', 'vattu'];
const ROLE_PREFS = [...ROLE_IDS, 'any'];
const LEGACY_ROLES = { mid: 'cong', mobile: 'daytru', supply: 'vattu' };

// Any saved value -> one of ROLE_PREFS (legacy wishes are mapped when read; unknown / missing = 'any').
const normalizeRole = (p) => (ROLE_PREFS.includes(p) ? p : LEGACY_ROLES[p] || 'any');

// A value a role select may send (an old message may still send mid / mobile / supply).
const isRoleValue = (v) => ROLE_PREFS.includes(v) || Object.prototype.hasOwnProperty.call(LEGACY_ROLES, v);

// "🛡️ Def" / "⚔️ Công" ...; 'any' -> "🤷 Không biết — tùy lead sắp xếp"
const roleName = (value) => defaults.roles[normalizeRole(value)].label;
// The same without the emoji (the sheet): "Def", "Công", "Đẩy trụ", "Vật tư", "Tùy lead"
const plainRoleName = (value) => defaults.roles[normalizeRole(value)].plain;


// Select options of the member role (value, label, description <= 100 chars).
const ROLE_OPTIONS = ROLE_PREFS.map((value) => ({ value, label: defaults.roles[value].label, description: defaults.roles[value].desc }));

module.exports = { ROLE_IDS, ROLE_PREFS, ROLE_OPTIONS, normalizeRole, isRoleValue, roleName, plainRoleName };
