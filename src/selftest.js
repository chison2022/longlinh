// `LongLinh.exe --selftest`: proves the install works without logging in to Discord. Checks config, canvas + fonts (native
// module), and a read-only PostgreSQL ping. Returns { ok, lines }.
const { renderRosterPngs } = require('./bot/ui/rosterImage');

// One page of the game roster image: the same canvas + fonts the bot draws with.
const renderRosterPng = async (input) => (await renderRosterPngs(input))[0];

async function runSelftest({ env = process.env, connectDb, disconnect, pingDb, renderPng = renderRosterPng } = {}) {
  const lines = [];
  let ok = true;
  const step = async (name, fn) => {
    try {
      lines.push(`PASS ${name}: ${(await fn()) || 'ok'}`);
    } catch (err) {
      ok = false;
      lines.push(`FAIL ${name}: ${err.message}`);
    }
  };
  await step('config', async () => {
    const missing = ['PG_URL', 'PG_CA'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`missing in .env: ${missing.join(', ')}`);
    return `PG_URL + PG_CA set, DISCORD_TOKEN ${env.DISCORD_TOKEN ? 'set' : 'not set'} (never used by selftest)`;
  });
  await step('canvas+fonts', async () => {
    const png = await renderPng({
      title: 'Self-test danh sách',
      members: [{ name: 'Nguyễn Văn Á', rank: 'Bang Chúng', className: 'Test', daysInGuild: 3, status: 'Online', inDiscord: true }],
      classes: ['Test'],
    });
    if (!Buffer.isBuffer(png) || png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    return `PNG ${png.length} bytes`;
  });
  await step('postgresql', async () => {
    await connectDb();
    try {
      await pingDb();
    } finally {
      await disconnect().catch(() => {});
    }
    return 'DB ping (read-only)';
  });
  lines.push(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL');
  return { ok, lines };
}

module.exports = { runSelftest };
