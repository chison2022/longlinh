// Register slash commands: `npm run deploy`.
// DEV_GUILD_ID set -> that server only (instant); otherwise global (may take up to 1 hour).
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { commands } = require('./interactions/router');

async function main() {
  const { DISCORD_TOKEN, CLIENT_ID, DEV_GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !CLIENT_ID) throw new Error('DISCORD_TOKEN and CLIENT_ID are required in .env');
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST().setToken(DISCORD_TOKEN);
  const route = DEV_GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID) : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body });
  console.log(`Registered ${body.length} command(s) ${DEV_GUILD_ID ? `to guild ${DEV_GUILD_ID}` : 'globally'}.`);
}

// exitCode (not process.exit): exiting while REST/undici handles are closing aborts libuv on Windows.
main().catch((err) => {
  console.error('Deploy failed:', err.message);
  process.exitCode = 1;
});
