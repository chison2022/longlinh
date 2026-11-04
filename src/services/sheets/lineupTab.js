// The published lineup as a Google Sheet tab "LongLinh_DoiHinh" (pure builder; managedTab writes it): one row per person placed.

const LINEUP_TAB = 'LongLinh_DoiHinh';
const LINEUP_HEADER = ['Nhóm', 'PT', 'Vị trí', 'Tên game', 'Tên Discord', 'Phái', 'Nhiệm vụ', 'Ghi chú PT', 'Discord ID'];

// layout + people ({ [id]: { name, className } }) -> a managedTab spec. The war id is the epoch: a new war starts a clean tab.
function buildLineupTab({ warId, layout, people = {}, notes = {} }) {
  const rows = [];
  layout.groups.forEach((group, g) =>
    group.forEach((party, p) =>
      party.forEach((id, s) => {
        const who = people[id] || { name: id, className: '' };
        rows.push([String(g + 1), String(p + 1), String(s + 1), who.linked === false ? '(chưa ghép)' : who.name, who.discordName || (who.linked === false ? who.name : ''), who.className || '', who.task || '', notes[`${g}-${p}`] || '', id]);
      })
    )
  );
  return { title: LINEUP_TAB, header: LINEUP_HEADER, rows, keyOf: (get) => String(get('Discord ID') || ''), epoch: String(warId), frozenColumns: 0, formats: () => [] };
}

module.exports = { LINEUP_TAB, LINEUP_HEADER, buildLineupTab };
