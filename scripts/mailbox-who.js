// Owner-only lookup of the sender of an anonymous letter (run on YOUR PC, the one holding the private key).
//   npm run mail:who -- --guild <guildId> --no <letter no> [--key <private key file>]
// Asks for the passphrase (typing hidden; or the env MAILBOX_PASSPHRASE of the REAL environment, never one from .env), decrypts senderEnc of that letter and prints the Discord id, the member's
// current name (Discord REST with the bot token), the letter's category and date. Every lookup is appended to logs/mailbox-lookups.log
// (time, guild, letter no, OS user, result) and logged as mail.lookup. Needs PG_URL, PG_CA and DISCORD_TOKEN in .env.
// The passphrase may come from the real process environment only: read BEFORE dotenv runs, so a MAILBOX_PASSPHRASE sitting in .env
// (a file the bot's machine and the installer carry) is ignored.
const REAL_ENV_PASSPHRASE = process.env.MAILBOX_PASSPHRASE;
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/db');
const eventLog = require('../src/eventLog');
const { logDir } = require('../src/paths');
const { DEFAULT_PRIVATE, arg, readHidden } = require('./mailbox-common');
const { letterDigest, getLetterWithSender } = require('../src/services/mailService');

const MAX_AT_SKEW_MS = 2 * 60 * 1000;
const NOT_PROOF = 'Kết quả tra cứu là bằng chứng, không phải chứng cứ tuyệt đối (người có quyền ghi DB có thể giả mạo).';
const OLD_LETTER = '(thư cũ, không kiểm tra được)';

// senderEnc (base64) + the encrypted private key PEM + passphrase -> { discordId, at }. Throws on a wrong passphrase / wrong key.
function decryptSender(senderEnc, privatePem, passphrase) {
  const key = crypto.createPrivateKey({ key: privatePem, passphrase });
  const plain = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(senderEnc, 'base64'));
  return JSON.parse(plain.toString('utf8'));
}

// Compares what was sealed into the ciphertext with the stored letter. -> { checked: bool, problems: [text] }.
// checked=false: an old letter (sealed without guildId / digest), only the time could be compared. A mismatch means the ciphertext does not
// belong to this letter (copied from another one, or the letter was edited): do NOT trust the id.
function verifyLetter(sender, letter) {
  const problems = [];
  const checked = typeof sender.guildId === 'string' && typeof sender.h === 'string';
  if (checked) {
    if (sender.guildId !== String(letter.guildId)) problems.push(`guild mismatch: sealed for ${sender.guildId}, stored in ${letter.guildId}`);
    if (sender.h !== letterDigest(letter.title, letter.content)) problems.push('title / content differ from what was sealed (letter edited, or the ciphertext was taken from another letter)');
  }
  const skew = Math.abs(new Date(sender.at).getTime() - new Date(letter.createdAt).getTime());
  if (!(skew <= MAX_AT_SKEW_MS)) problems.push(`sealed time ${sender.at} is not within 2 minutes of the letter's createdAt ${new Date(letter.createdAt).toISOString()}`);
  return { checked, problems };
}

// One line per lookup, kept next to the other logs. Never the id that was found.
function auditLine({ guild, no, result, user = os.userInfo().username, now = new Date() }) {
  return `${now.toISOString()} guild=${guild} no=${no} os_user=${user} result=${result}\n`;
}

function appendAudit(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'mailbox-lookups.log'), auditLine(entry));
}

// The member's current name: guild nickname / display name, else the account, else null (unknown). The token is never printed.
async function currentName(guildId, userId, token, fetchFn = fetch) {
  const call = async (url) => {
    const res = await fetchFn(`https://discord.com/api/v10${url}`, { headers: { Authorization: `Bot ${token}` } });
    return res.ok ? res.json() : null;
  };
  const member = await call(`/guilds/${guildId}/members/${userId}`);
  if (member) return member.nick || (member.user && (member.user.global_name || member.user.username)) || null;
  const user = await call(`/users/${userId}`);
  return user ? `${user.global_name || user.username} (không còn trong máy chủ)` : null;
}

async function main(argv = process.argv.slice(2), env = process.env, envPassphrase = REAL_ENV_PASSPHRASE) {
  const guild = arg(argv, 'guild');
  const no = Number(arg(argv, 'no'));
  const keyFile = path.resolve(arg(argv, 'key') || DEFAULT_PRIVATE);
  if (!/^\d{17,20}$/.test(String(guild)) || !Number.isInteger(no) || no < 1) {
    throw new Error('usage: npm run mail:who -- --guild <guildId> --no <letter no> [--key <private key file>]');
  }
  if (!env.PG_URL) throw new Error('PG_URL is missing in .env');
  if (!fs.existsSync(keyFile)) throw new Error(`private key not found: ${keyFile} (use --key <file>)`);

  eventLog.init(logDir());
  await db.connectPg({ max: 1 });
  try {
    const letter = await getLetterWithSender(guild, no);
    const dir = logDir();
    if (!letter) {
      appendAudit(dir, { guild, no, result: 'notfound' });
      eventLog.logEvent('mail', 'lookup', { guild, no, result: 'notfound' });
      throw new Error(`no letter #${no} in guild ${guild}`);
    }
    const when = new Date(letter.createdAt).toISOString();
    if (!letter.anonymous) {
      console.log(`Letter #${no} was sent WITH a name: ${letter.senderId} (${letter.category}, ${when})`);
      appendAudit(dir, { guild, no, result: 'named' });
      eventLog.logEvent('mail', 'lookup', { guild, no });
      return;
    }
    let passphrase = envPassphrase;
    if (!passphrase) {
      try {
        passphrase = await readHidden('Passphrase of the private key: ');
      } catch {
        appendAudit(dir, { guild, no, result: 'cancelled' });
        eventLog.logEvent('mail', 'lookup', { guild, no, result: 'cancelled' });
        throw new Error('cancelled');
      }
    }
    let sender;
    try {
      sender = decryptSender(letter.senderEnc, fs.readFileSync(keyFile, 'utf8'), passphrase);
    } catch {
      appendAudit(dir, { guild, no, result: 'failed' });
      throw new Error('cannot decrypt: wrong passphrase, or this letter was not encrypted for this key');
    }
    appendAudit(dir, { guild, no, result: 'ok' });
    eventLog.logEvent('mail', 'lookup', { guild, no });
    let name = null;
    try {
      name = env.DISCORD_TOKEN ? await currentName(guild, sender.discordId, env.DISCORD_TOKEN) : null;
    } catch {
      /* offline: the id alone is enough */
    }
    console.log(`Letter #${no}  ${letter.category}  ${when}`);
    console.log(`Sender Discord id: ${sender.discordId}`);
    console.log(`Current name     : ${name || '(unknown)'}`);
    console.log(`Encrypted at     : ${sender.at}`);
    const check = verifyLetter(sender, letter);
    if (check.problems.length) {
      console.log('');
      console.log('!!! WARNING: THIS RESULT MAY BE FORGED OR SWAPPED. DO NOT ACT ON IT !!!');
      for (const p of check.problems) console.log(`!!! ${p}`);
    } else if (check.checked) {
      console.log('Integrity        : OK (guild, title/content and time match the letter)');
    }
    if (!check.checked) console.log(`Integrity        : ${OLD_LETTER}`);
    console.log(NOT_PROOF);
    console.log('To bar this member: add the id to the guild setting mailBlocked.');
  } finally {
    await db.disconnectPg();
  }
}

if (require.main === module) {
  main().catch((err) => {
    eventLog.logEvent('mail', 'lookup', { ok: false, err });
    console.error(require('../config/pg').redactPg(String((err && err.message) || err)));
    process.exitCode = 1;
  });
}

module.exports = { decryptSender, verifyLetter, NOT_PROOF, OLD_LETTER, auditLine, appendAudit, currentName, main };
