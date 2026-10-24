// One-time setup of the anonymous mailbox: makes an RSA-3072 key pair.
//   npm run mail:keygen -- [--out <private key file>] [--pub <public key file>] [--force]
// - the PUBLIC key goes to config/mailbox-public.pem (commit it, it ships in the build; the bot only encrypts with it),
// - the PRIVATE key goes, encrypted with a passphrase, to --out (default %USERPROFILE%\LongLinh-mailbox-private.pem). Keep it ONLY on
//   your own PC (never in the repo, never on the machine the bot runs on): it is the only way to find out who wrote an anonymous letter.
// The passphrase is asked twice (typing hidden), at least 14 characters; it is NEVER read from an environment variable or the .env.
// The PKCS#8 wrapper (aes-256-cbc, PBKDF2 with OpenSSL's modest iteration count) leaves the passphrase as the real protection of the file:
// use a long phrase of several words. Existing keys are never overwritten without --force.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_PRIVATE, DEFAULT_PUBLIC, arg, readHidden } = require('./mailbox-common');
const { keyFingerprint } = require('../src/services/mailService');

const MIN_PASSPHRASE = 14;

function assertFree(files, force) {
  for (const f of files) {
    if (fs.existsSync(f) && !force) {
      throw new Error(`${f} already exists. Replacing the keys makes every old anonymous letter impossible to look up. Use --force only if you are sure.`);
    }
  }
}

// Writes both files. Throws (and writes nothing) when one exists and force is off. bits is only lowered by tests.
function generate({ outPrivate = DEFAULT_PRIVATE, outPublic = DEFAULT_PUBLIC, passphrase, force = false, bits = 3072 }) {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE) throw new Error(`the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  assertFree([outPrivate, outPublic], force);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  });
  fs.mkdirSync(path.dirname(outPrivate), { recursive: true });
  fs.mkdirSync(path.dirname(outPublic), { recursive: true });
  fs.writeFileSync(outPrivate, privateKey, { mode: 0o600 });
  fs.writeFileSync(outPublic, publicKey);
  return { outPrivate, outPublic, fingerprint: keyFingerprint(publicKey) };
}

async function main(argv = process.argv.slice(2)) {
  const outPrivate = path.resolve(arg(argv, 'out') || DEFAULT_PRIVATE);
  const outPublic = path.resolve(arg(argv, 'pub') || DEFAULT_PUBLIC);
  const force = argv.includes('--force');
  assertFree([outPrivate, outPublic], force); // before asking for a passphrase
  const passphrase = await readHidden(`Passphrase for the private key (at least ${MIN_PASSPHRASE} characters, a long phrase is best): `);
  if (passphrase !== (await readHidden('Type it again: '))) throw new Error('the two passphrases differ');
  console.log('Generating RSA-3072 key pair (a few seconds)...');
  const { fingerprint } = generate({ outPrivate, outPublic, passphrase, force });
  console.log(`Public key : ${outPublic}  (commit it; npm run package ships it)`);
  console.log(`Private key: ${outPrivate}  (encrypted with your passphrase)`);
  console.log(`Public key fingerprint: ${fingerprint}  (/setup > Hòm thư shows the same value: compare them)`);
  console.log('');
  console.log('IMPORTANT: back up the private key file and remember the passphrase. If either is lost, NO anonymous letter can ever be traced.');
  console.log('Keep the private key on your own PC only: never in the repo, never on the machine the bot runs on.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`keygen failed: ${err.message}`); // never contains the passphrase
    process.exitCode = 1;
  });
}

module.exports = { generate, main, MIN_PASSPHRASE };
