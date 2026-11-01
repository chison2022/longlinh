// The published lineup as a Google Sheet tab "LongLinh_DoiHinh" (pure builder; managedTab writes it): one row per person placed.

const LINEUP_TAB = 'LongLinh_DoiHinh';
const LINEUP_HEADER = ['Nhóm', 'PT', 'Vị trí', 'Tên Discord', 'Phái', 'Discord ID'];

// layout + people ({ [id]: { name, className } }) -> a managedTab spec. The war id is the epoch: a new war starts a clean tab.
function buildLineupTab({ warId, layout, people = {} }) {
  const rows = [];
  layout.groups.forEach((group, g) =>
    group.forEach((party, p) =>
      party.forEach((id, s) => {
        const who = people[id] || { name: id, className: '' };
        rows.push([String(g + 1), String(p + 1), String(s + 1), who.name, who.className || '', id]);
      })
    )
  );
  return { title: LINEUP_TAB, header: LINEUP_HEADER, rows, keyOf: (get) => String(get('Discord ID') || ''), epoch: String(warId), frozenColumns: 0, formats: () => [] };
}

module.exports = { LINEUP_TAB, LINEUP_HEADER, buildLineupTab };
