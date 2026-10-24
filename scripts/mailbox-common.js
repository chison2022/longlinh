// Shared by mailbox-keygen.js and mailbox-who.js: paths and the passphrase prompt.
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PRIVATE = path.join(os.homedir(), 'LongLinh-mailbox-private.pem');
const DEFAULT_PUBLIC = path.join(__dirname, '..', 'config', 'mailbox-public.pem');

// --name value pairs.
function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

// Reads one line from stdin without echoing it (raw-mode TTY). A piped stdin cannot be hidden: the line is read as is.
function readHidden(prompt, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      let buf = '';
      const onData = (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          stdin.removeListener('data', onData);
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ''));
        }
      };
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
      stdin.resume();
      return;
    }
    let text = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const done = (fn, value) => {
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      stdin.pause();
      stdout.write('\n');
      fn(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(resolve, text);
        if (ch === '\u0003') return done(reject, new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ') text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

module.exports = { DEFAULT_PRIVATE, DEFAULT_PUBLIC, arg, readHidden };
