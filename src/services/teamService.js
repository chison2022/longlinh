// The war layout of a guild (pure): how many groups, parties per group and people per party. The admins build the teams
// themselves (their Google Sheet); the bot only uses the layout to size the war (capacity, parties needed).
const defaults = require('../../config/defaults');

// { groupCount, partiesPerGroup, partySize } of a guild config (older configs have no groupCount).
function layoutOf(config) {
  return {
    groupCount: (config && config.groupCount) || defaults.groupCount,
    partiesPerGroup: defaults.partiesPerGroup,
    partySize: defaults.partySize,
  };
}

const partyCount = (layout) => layout.groupCount * layout.partiesPerGroup;

module.exports = { layoutOf, partyCount };
