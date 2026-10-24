// npm run package -> dist/LongLinh.exe (single executable via @yao-pkg/pkg) + dist/LongLinh-Setup.exe (Inno Setup).
// The installer embeds ./.env (secrets): it is encrypted with a password (env INSTALLER_PASSWORD, else a random one written
// ONLY to dist/INSTALLER-PASSWORD.txt). dist/ is git-ignored; never share LongLinh-Setup.exe publicly and send the password
// through a different channel than the file.
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const version = require('../package.json').version;

// No look-alike characters (0/O, 1/l/I).
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generatePassword(length = 16) {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

// -> { password, generated }. A password from the environment: 14-64 chars, restricted alphabet (it reaches ISCC via an env var,
// never via the command line).
function resolvePassword(env = process.env) {
  const given = env.INSTALLER_PASSWORD;
  if (given) {
    if (!/^[A-Za-z0-9._-]{14,64}$/.test(given)) throw new Error('INSTALLER_PASSWORD must be 14-64 characters from A-Z a-z 0-9 . _ -');
    return { password: given, generated: false };
  }
  return { password: generatePassword(), generated: true };
}

// Every candidate is an absolute path (the old literals had lost their backslashes). A relative ISCC/LOCALAPPDATA is ignored.
function isccCandidates(env = process.env) {
  const candidates = [
    env.ISCC,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe') : null,
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  ];
  return candidates.filter((c) => c && path.isAbsolute(c));
}

function findIscc() {
  const found = isccCandidates().find((c) => fs.existsSync(c));
  if (!found) throw new Error('Inno Setup (ISCC.exe) not found. Install: winget install JRSoftware.InnoSetup');
  return found;
}

// --env <path> --out <dir> (both optional). Defaults: <repo>/.env and <repo>/dist. --wsb also writes LongLinh-test.wsb into --out
// (the sandbox config, HostFolder = the out dir); off by default so dist/ keeps only the two exes and the password file.
function parseArgs(argv) {
  const opts = { env: path.join(root, '.env'), out: path.join(root, 'dist'), wsb: false, googleKey: null }; // googleKey: null = default (shipped in a normal build, never with --wsb)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wsb') {
      opts.wsb = true;
    } else if (a === '--with-google-key') {
      opts.googleKey = true;
    } else if (a === '--no-google-key') {
      opts.googleKey = false;
    } else if (a === '--env' || a === '--out') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = path.resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

// PORT from the .env text (the status script needs it but a normal user cannot read the .env). Default 3000.
// GOOGLE_KEY_FILE from the .env text (absolute, or relative to the .env's folder); default <env dir>/google-key.json.
function googleKeyPath(envText, envDir) {
  const m = /^\s*GOOGLE_KEY_FILE\s*=\s*["']?([^"'#\r\n]+?)["']?\s*(?:#.*)?$/m.exec(envText || '');
  const file = m ? m[1].trim() : '';
  return file ? path.resolve(envDir, file) : path.join(envDir, 'google-key.json');
}

// PG_CA from the .env text: the CA certificate of the PostgreSQL service, a path RELATIVE to the .env's folder (the installed
// bot reads it next to its own .env). -> the relative path, or null when the .env has none.
function pgCaPath(envText) {
  const m = /^\s*PG_CA\s*=\s*["']?([^"'#\r\n]+?)["']?\s*(?:#.*)?$/m.exec(envText || '');
  const file = m ? m[1].trim() : '';
  if (!file) return null;
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error(`PG_CA must be a path inside the .env folder (e.g. certs/aiven-ca.pem), not ${file}`);
  return file;
}

function readPort(envText) {
  const m = /^\s*PORT\s*=\s*["']?(\d{1,5})["']?\s*(?:#.*)?$/m.exec(envText || '');
  const port = m ? Number(m[1]) : 3000;
  return port >= 1 && port <= 65535 ? port : 3000;
}

// The password travels ONLY in the environment of the ISCC process (never in argv, so it is not visible in the process list).
// Whatever ISCC/execFileSync throws, the message we surface is sanitized: no command line, no password.
function runIscc(iscc, args, password, exec = execFileSync) {
  try {
    exec(iscc, args, { stdio: 'inherit', env: { ...process.env, LL_INSTALLER_PW: password } });
  } catch (e) {
    const code = e && (e.status != null ? `exit code ${e.status}` : e.code ? `error ${e.code}` : 'unknown error');
    throw new Error(`Inno Setup compile failed (${code}). See the ISCC output above.`);
  }
}

// Minimal environment for the `npx pkg` child: no installer password (INSTALLER_PASSWORD / LL_INSTALLER_PW) and no other secrets.
const PKG_ENV_KEYS = ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'SystemDrive', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'PKG_CACHE_PATH', 'PKG_NODE_PATH',
  'NODE_EXTRA_CA_CERTS', 'USERNAME', 'ALLUSERSPROFILE'];
const PKG_ENV_PREFIXES = ['npm_config_'];
function pkgEnv(env = process.env) {
  const out = {};
  for (const k of Object.keys(env)) if (PKG_ENV_KEYS.some((w) => w.toLowerCase() === k.toLowerCase()) || PKG_ENV_PREFIXES.some((p) => k.toLowerCase().startsWith(p))) out[k] = env[k];
  return out;
}

function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Sandbox config: the template's HostFolder placeholder is replaced by the real out dir (XML-escaped).
function renderWsb(template, outDir) {
  return template.split('@@HOST_FOLDER@@').join(xmlEscape(outDir));
}

// --wsb maps the out dir into the sandbox, and the installer there holds the .env: never allow the real repo .env to go in.
function assertWsbEnvSafe(envFile) {
  if (path.resolve(envFile).toLowerCase() === path.join(root, '.env').toLowerCase()) {
    throw new Error('--wsb refused: --env resolves to the repo .env (its secrets would be mapped into the sandbox). Pass a dummy .env with --env <file>.');
  }
}

// The anonymous mailbox is only private while its PRIVATE key stays off the bot's machine. Walks the folders that pkg bundles (and the
// stage folder that the installer packs) and throws on any *private*.pem, or any .pem holding a PRIVATE KEY block. -> the folders checked.
const KEY_SCAN_DIRS = ['config', 'src', 'assets'];
function findPrivateKeys(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found; // folder does not exist
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') findPrivateKeys(full, found);
    } else if (/private.*\.pem$/i.test(e.name)) {
      found.push(full);
    } else if (/\.(pem|key)$/i.test(e.name)) {
      try {
        if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(fs.readFileSync(full, 'utf8'))) found.push(full);
      } catch {
        /* unreadable: not shipped by us either */
      }
    }
  }
  return found;
}

function assertNoPrivateKeys(dirs) {
  const found = dirs.flatMap((d) => findPrivateKeys(d));
  if (found.length) throw new Error(`private key in the build input, refusing to package: ${found.join(', ')}. The mailbox private key must stay on the owner's PC only.`);
  return dirs;
}

// The installer ships the .env onto the bot's machine: a mailbox passphrase in it would sit next to the encrypted letters' private key
// (and defeat the point of keeping that key off that machine). mail:who reads the passphrase from the real environment only.
const MAIL_PASSPHRASE_RE = /^\s*(?:export\s+)?MAILBOX_PASSPHRASE\s*=/m;
function assertNoMailPassphrase(envText) {
  if (MAIL_PASSPHRASE_RE.test(String(envText || ''))) {
    throw new Error('the .env contains MAILBOX_PASSPHRASE, refusing to package: remove it (the passphrase of the mailbox private key must never reach the bot machine).');
  }
}

function main(argv = process.argv.slice(2)) {
  const { env: envFile, out, wsb, googleKey } = parseArgs(argv);
  if (wsb && googleKey === true) throw new Error('--wsb refused with --with-google-key: the sandbox folder must never hold the Google service-account key.');
  const stage = path.join(out, 'stage');
  if (wsb) assertWsbEnvSafe(envFile);
  if (!fs.existsSync(envFile)) throw new Error(`.env not found (${envFile}): the installer ships it`);
  assertNoMailPassphrase(fs.readFileSync(envFile, 'utf8'));
  const keyFile = googleKeyPath(fs.readFileSync(envFile, 'utf8'), path.dirname(envFile)); // optional: the Google Sheets service-account key (secret, like the .env)
  const shipKey = googleKey === null ? !wsb : googleKey; // --wsb builds never carry the key
  if (googleKey === true && !fs.existsSync(keyFile)) throw new Error(`--with-google-key: key file not found (${keyFile})`);
  const keyIncluded = shipKey && fs.existsSync(keyFile);
  console.log(keyIncluded ? `> Google key: included (${keyFile})` : `> Google key: NOT included (${wsb ? '--wsb build' : shipKey ? 'no key file at ' + keyFile : '--no-google-key'}); the Sheets sync stays off until a key is placed next to the exe`);
  assertNoPrivateKeys(KEY_SCAN_DIRS.map((d) => path.join(root, d))); // before pkg bundles anything
  const mailKey = path.join(root, 'config', 'mailbox-public.pem');
  console.log(fs.existsSync(mailKey) ? '> Mailbox public key: included (config/mailbox-public.pem)' : '> Mailbox public key: MISSING (config/mailbox-public.pem); anonymous letters stay off in this build (run npm run mail:keygen first)');
  fs.mkdirSync(out, { recursive: true });
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, 'tools'), { recursive: true });

    console.log(`> pkg: building ${path.join(out, 'LongLinh.exe')}`);
    execFileSync('npx', ['pkg', '.', '--target', 'node24-win-x64', '--compress', 'GZip', '--output', '"' + path.join(out, 'LongLinh.exe') + '"'], { cwd: root, stdio: 'inherit', shell: true, env: pkgEnv() });

    fs.copyFileSync(path.join(out, 'LongLinh.exe'), path.join(stage, 'LongLinh.exe'));
    fs.copyFileSync(envFile, path.join(stage, '.env'));
    const ca = pgCaPath(fs.readFileSync(envFile, 'utf8'));
    if (ca) {
      // the database CA certificate (public, not a secret): the bot checks the server against it
      fs.mkdirSync(path.dirname(path.join(stage, ca)), { recursive: true });
      fs.copyFileSync(path.join(path.dirname(envFile), ca), path.join(stage, ca));
      console.log(`> PostgreSQL CA: included (${ca})`);
    } else console.log('> PostgreSQL CA: MISSING (PG_CA in the .env): the bot will not connect');
    if (keyIncluded) fs.copyFileSync(keyFile, path.join(stage, 'google-key.json'));
    fs.writeFileSync(path.join(stage, 'port.txt'), `${readPort(fs.readFileSync(envFile, 'utf8'))}\r\n`); // non-secret, user-readable
    fs.cpSync(path.join(root, 'assets', 'fonts'), path.join(stage, 'assets', 'fonts'), { recursive: true });
    for (const f of ['install-task.ps1', 'power.ps1', 'status.ps1', 'status.cmd', 'restart.cmd', 'dir-guard.ps1']) fs.copyFileSync(path.join(__dirname, f), path.join(stage, 'tools', f));
    fs.copyFileSync(path.join(__dirname, 'HUONG-DAN.txt'), path.join(stage, 'HUONG-DAN.txt'));

    assertNoPrivateKeys([stage]); // and nothing private slipped into what the installer packs

    const { password, generated } = resolvePassword();
    const passwordFile = path.join(out, 'INSTALLER-PASSWORD.txt');
    if (generated) fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
    else fs.rmSync(passwordFile, { force: true }); // do not leave a stale password for an installer built with another one

    console.log(`> Inno Setup: building ${path.join(out, 'LongLinh-Setup.exe')}`);
    runIscc(findIscc(), [`/DStageDir=${stage}`, `/DOutDir=${out}`, `/DAppVersion=${version}`, path.join(__dirname, 'longlinh.iss')], password);
    if (wsb) {
      const wsbFile = path.join(out, 'LongLinh-test.wsb');
      fs.writeFileSync(wsbFile, renderWsb(fs.readFileSync(path.join(__dirname, 'sandbox', 'LongLinh-test.wsb'), 'utf8'), out));
      console.log(`Sandbox config: ${wsbFile}`);
    }
    console.log(generated ? `Installer password: written to ${passwordFile} (send it by a different channel than the Setup file)` : 'Installer password: taken from INSTALLER_PASSWORD');
    for (const f of ['LongLinh.exe', 'LongLinh-Setup.exe']) console.log(`${f}: ${(fs.statSync(path.join(out, f)).size / 1048576).toFixed(1)} MB`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true }); // never leave a copy of .env lying around, even when the build failed
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`package failed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { assertNoMailPassphrase, findPrivateKeys, assertNoPrivateKeys, KEY_SCAN_DIRS, isccCandidates, pkgEnv, renderWsb, xmlEscape, assertWsbEnvSafe, generatePassword, resolvePassword, PASSWORD_ALPHABET, parseArgs, readPort, googleKeyPath, pgCaPath, runIscc, main };
