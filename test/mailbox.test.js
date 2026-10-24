// Anonymous feedback mailbox: encryption (the bot can only encrypt), codes, rate limits, defang, payloads, the admin gate on the
// card, the logging rules (no user id for mb:*), keygen and the build guard. DB and Discord are stubbed; the stubs on guildConfigService
// are installed BEFORE the handlers are required (they destructure at load time).
const { describe, it, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionsBitField, PermissionFlagsBits, MessageFlags } = require('discord.js');
const guildConfigService = require('../src/services/guildConfigService');
const { assertV2Message, assertMessage, assertModal } = require('./discordLimits');
const { sid } = require('./helpers');

let config;
guildConfigService.getConfigOrDefault = async () => config;
guildConfigService.getConfig = async () => config;

const mail = require('../src/services/mailService');
const real = { ...mail }; // the DB functions before the handler tests below replace them
const realLoadPublicKey = mail.loadPublicKey; // stubService() replaces it on the module object
const db = require('../src/db');
const { setupDb, resetDb } = require('./pgdb');
const ui = require('../src/bot/ui/mailbox');
const handler = require('../src/bot/interactions/mailbox');
const eventLog = require('../src/eventLog');
const { routeInteraction } = require('../src/bot/interactions/router');
const keygen = require('../scripts/mailbox-keygen');
const who = require('../scripts/mailbox-who');
const build = require('../packaging/build');
const { NO_PERMISSION } = require('../src/bot/interactions/common');

const GUILD = '800000000000000001';
const USER = sid(4242);
const ADMIN = sid(900);
const MANAGE = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
const NOBODY = new PermissionsBitField(PermissionFlagsBits.SendMessages);
const PASS = 'correct horse battery'; // 21 characters: keygen wants 14+

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'longlinh-mail-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// One 2048-bit pair for the fast tests (the 3072-bit default is checked once, in the keygen tests).
const keys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASS },
});

// loadPublicKey wants >= 3072 bits: one real-size public key for it (generated once, unencrypted: only its public half is used).
const strong = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

describe('encryption: the bot can only encrypt', () => {
  it('round trip: what encryptSender writes, the owner script decrypts', () => {
    const at = new Date('2026-10-12T10:00:00Z');
    const enc = mail.encryptSender(keys.publicKey, USER, { at });
    assert.match(enc, /^[A-Za-z0-9+/]+=*$/);
    assert.deepEqual(who.decryptSender(enc, keys.privateKey, PASS), { discordId: USER, at: at.toISOString() });
  });
  it('binds the guild and a digest of title + content into the ciphertext', () => {
    const at = new Date('2026-10-12T10:00:00Z');
    const enc = mail.encryptSender(keys.publicKey, USER, { guildId: GUILD, title: 't', content: 'c', at });
    const got = who.decryptSender(enc, keys.privateKey, PASS);
    assert.equal(got.guildId, GUILD);
    assert.equal(got.h, mail.letterDigest('t', 'c'));
    assert.notEqual(mail.letterDigest('t', 'c'), mail.letterDigest('tc', ''));
    assert.ok(Buffer.from(enc, 'base64').length === 256 && JSON.stringify(got).length < 318);
  });
  it('is randomised (OAEP): the same sender never gives the same ciphertext', () => {
    assert.notEqual(mail.encryptSender(keys.publicKey, USER), mail.encryptSender(keys.publicKey, USER));
  });
  it('the ciphertext contains neither the id nor a hash of it', () => {
    const enc = mail.encryptSender(keys.publicKey, USER);
    assert.ok(!Buffer.from(enc, 'base64').includes(USER));
    for (const algo of ['sha256', 'sha1', 'md5']) assert.ok(!enc.includes(crypto.createHash(algo).update(USER).digest('hex')));
  });
  it('a wrong passphrase cannot decrypt', () => {
    const enc = mail.encryptSender(keys.publicKey, USER);
    assert.throws(() => who.decryptSender(enc, keys.privateKey, 'wrong passphrase'));
  });
  it('the service exports no decrypt, and no file under src/ can decrypt or load a private key', () => {
    for (const name of Object.keys(mail)) assert.ok(!/decrypt|private/i.test(name), `export ${name}`);
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js') && /privateDecrypt|createPrivateKey|privateEncrypt/.test(fs.readFileSync(full, 'utf8').replace(/\/\/.*$/gm, ''))) offenders.push(full);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    assert.deepEqual(offenders, []);
  });
  it('loadPublicKey: a public key loads; a missing file, junk, or a PRIVATE key gives null', () => {
    const pub = path.join(tmp, 'pub.pem');
    fs.writeFileSync(pub, strong.publicKey);
    assert.equal(realLoadPublicKey(pub), strong.publicKey);
    assert.equal(realLoadPublicKey(path.join(tmp, 'nope.pem')), null);
    fs.writeFileSync(path.join(tmp, 'junk.pem'), 'hello');
    assert.equal(realLoadPublicKey(path.join(tmp, 'junk.pem')), null);
    fs.writeFileSync(path.join(tmp, 'priv.pem'), keys.privateKey);
    assert.equal(realLoadPublicKey(path.join(tmp, 'priv.pem')), null);
    assert.equal(mail.mailboxReady(path.join(tmp, 'nope.pem')), false);
  });
  it('loadPublicKey refuses an RSA key under 3072 bits and a non-RSA key', () => {
    const weak = path.join(tmp, 'weak.pem');
    fs.writeFileSync(weak, keys.publicKey); // 2048
    assert.equal(realLoadPublicKey(weak), null);
    const ec = path.join(tmp, 'ec.pem');
    fs.writeFileSync(ec, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }));
    assert.equal(realLoadPublicKey(ec), null);
  });
  it('keyFingerprint: first 16 hex characters of sha256(SPKI DER); null for junk', () => {
    const der = crypto.createPublicKey(strong.publicKey).export({ type: 'spki', format: 'der' });
    assert.equal(mail.keyFingerprint(strong.publicKey), crypto.createHash('sha256').update(der).digest('hex').slice(0, 16));
    assert.match(mail.keyFingerprint(strong.publicKey), /^[0-9a-f]{16}$/);
    assert.equal(mail.keyFingerprint('junk'), null);
  });
});

describe('letter code', () => {
  it('10 Crockford base32 characters from the alphabet, shown XXXXX-XXXXX', () => {
    for (let i = 0; i < 200; i++) {
      const code = mail.newCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
      assert.match(mail.formatCode(code), /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    }
    assert.notEqual(mail.newCode(), mail.newCode());
  });
  it('normalizeCode: case, dash, spaces and look-alikes (O/I/L) are forgiven; anything else is null', () => {
    assert.equal(mail.normalizeCode('abcde-fghjk'), 'ABCDEFGHJK');
    assert.equal(mail.normalizeCode(' ABCDE FGHJK '), 'ABCDEFGHJK');
    assert.equal(mail.normalizeCode('OOOOO-lllll'), '0000011111');
    assert.equal(mail.normalizeCode('ABCDE-FGHJ'), null);
    assert.equal(mail.normalizeCode('ABCDE-FGHJU'), null);
    assert.equal(mail.normalizeCode(''), null);
    assert.equal(mail.normalizeCode(null), null);
  });
  it('findByCode finds a letter by its code in any spelling, only in its own guild; a malformed code finds nothing (PostgreSQL)', async () => {
    await setupDb();
    await resetDb();
    await db.q('insert into guilds (id) values ($1), ($2)', [GUILD, 'other-guild']);
    const { letter, code } = await real.createLetter({ guildId: GUILD, category: 'idea', title: 'T', content: 'Nội dung', anonymous: true, senderEnc: 'enc' });
    assert.equal(letter.no, 1);
    assert.equal(letter.senderEnc, undefined, 'a normal read never carries the encrypted sender');
    const typed = mail.formatCode(code).toLowerCase();
    assert.equal((await real.findByCode(GUILD, typed)).no, 1);
    assert.equal(await real.findByCode('other-guild', typed), null);
    assert.equal(await real.findByCode(GUILD, 'bad'), null);
    const row = await db.one('select code_hash from mail_letters where id = $1', [letter._id]);
    assert.equal(row.code_hash, crypto.createHash('sha256').update(code).digest('hex'));
  });
  it('letters are numbered per guild; a reply marks a new letter seen and is kept with its time (PostgreSQL)', async () => {
    await setupDb();
    await resetDb();
    await db.q('insert into guilds (id) values ($1), ($2)', [GUILD, 'other-guild']);
    const a = (await real.createLetter({ guildId: GUILD, category: 'idea', content: 'A', anonymous: false, senderId: 'u1' })).letter;
    const b = (await real.createLetter({ guildId: GUILD, category: 'idea', content: 'B', anonymous: true, senderEnc: 'e' })).letter;
    const c = (await real.createLetter({ guildId: 'other-guild', category: 'idea', content: 'C', anonymous: true, senderEnc: 'e' })).letter;
    assert.deepEqual([a.no, b.no, c.no], [1, 2, 1]);
    assert.equal(a.senderId, 'u1');
    assert.equal(b.senderId, null);
    const replied = await real.addReply(GUILD, 1, { by: 'm1', text: 'Cảm ơn' });
    assert.equal(replied.status, 'seen');
    assert.equal(replied.replies.length, 1);
    assert.ok(replied.replies[0].at instanceof Date);
    assert.equal((await real.setStatus(GUILD, 1, 'seen')), null, "'seen' only moves a new letter forward");
    assert.equal((await real.setStatus(GUILD, 1, 'done')).status, 'done');
    assert.equal((await real.getLetterWithSender(GUILD, 2)).senderEnc, 'e');
  });
  it('the stored hash is the only trace of the code', () => {
    assert.match(mail.hashCode('ABCDEFGHJK'), /^[0-9a-f]{64}$/);
  });
});

describe('rate limits (rolling windows, memory only)', () => {
  it('3 letters per 24 h: the 4th is refused until the oldest ages out', () => {
    let now = 1_000_000;
    const lim = mail.createLimiter({ max: 3, windowMs: 24 * 3600 * 1000, clock: () => now });
    for (let i = 0; i < 3; i++) {
      assert.equal(lim.allowed('u'), true);
      lim.hit('u');
      now += 60_000;
    }
    assert.equal(lim.allowed('u'), false);
    assert.equal(lim.allowed('other'), true);
    now += 24 * 3600 * 1000 - 2 * 60_000 + 1; // the first hit is now > 24 h old
    assert.equal(lim.allowed('u'), true);
  });
  it('5 wrong codes per 10 minutes', () => {
    let now = 0;
    const lim = mail.createLimiter({ max: 5, windowMs: 10 * 60 * 1000, clock: () => now });
    for (let i = 0; i < 5; i++) lim.hit('u');
    assert.equal(lim.allowed('u'), false);
    now += 10 * 60 * 1000 + 1;
    assert.equal(lim.allowed('u'), true);
  });
  it('the module limiters are the documented sizes and keep nothing on disk', () => {
    mail.resetLimits();
    for (let i = 0; i < 3; i++) mail.sendLimit.hit('k');
    assert.equal(mail.sendLimit.allowed('k'), false);
    for (let i = 0; i < 4; i++) mail.guessLimit.hit('k');
    assert.equal(mail.guessLimit.allowed('k'), true);
    mail.guessLimit.hit('k');
    assert.equal(mail.guessLimit.allowed('k'), false);
    mail.resetLimits();
    assert.equal(mail.sendLimit.allowed('k'), true);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'mailService.js'), 'utf8');
    assert.ok(!/MailLimit|rateLimit.*(create|save)/i.test(src));
  });
});

describe('limiter undo and the charge-before-await rule', () => {
  it('undo takes back the latest hit', () => {
    const lim = mail.createLimiter({ max: 1, windowMs: 1000 });
    lim.hit('u');
    assert.equal(lim.allowed('u'), false);
    lim.undo('u');
    assert.equal(lim.allowed('u'), true);
    lim.undo('u'); // nothing to take back: harmless
  });
});

describe('defang', () => {
  it('breaks @everyone / @here, user / role / channel mentions and masked links', () => {
    const out = mail.defang('hi @everyone @here <@123> <@!123> <@&9> <#5> [click](https://evil.example) [x] (y)');
    assert.ok(!/@everyone|@here|<@|<#|\]\(/.test(out), out);
    assert.ok(out.includes('everyone') && out.includes('click') && out.includes('https://evil.example'));
  });
  it('wrapLinks puts plain URLs in <...> (no embed) once; safeReply defangs first', () => {
    assert.equal(mail.wrapLinks('xem https://a.b/c?d=1 nhé'), 'xem <https://a.b/c?d=1> nhé');
    assert.equal(mail.wrapLinks('đã có <https://a.b>'), 'đã có <https://a.b>');
    const out = mail.safeReply('@everyone http://x.y [a](http://z.w)');
    assert.ok(out.includes('<http://x.y>') && !/@everyone|\]\(/.test(out));
  });
  it('leaves ordinary text alone', () => {
    assert.equal(mail.defang('Xếp đội sai rồi, 20/21h nhé :)'), 'Xếp đội sai rồi, 20/21h nhé :)');
  });
});

describe('payloads', () => {
  const letter = (extra = {}) => ({ no: 12, category: 'idea', title: '**hi** @everyone', content: 'ping <@123> @here [a](http://x.y)', anonymous: true, status: 'new', replies: [], createdAt: new Date('2026-10-12T10:00:00Z'), ...extra });

  it('panel: the V2 text, the two buttons, no mention', () => {
    const v2 = assertV2Message(ui.buildMailPanel(), {});
    assert.ok(v2.text.includes('### 📮 Hòm thư góp ý'));
    assert.ok(v2.text.includes('Gửi góp ý, khiếu nại, báo lỗi cho quản lý bang.'));
    assert.ok(v2.text.includes('🕵️ Thư ẩn danh: quản lý không thấy tên bạn. Chủ bot có thể tra người gửi khi thư vi phạm nghiêm trọng (đe doạ, bôi nhọ).'));
    assert.deepEqual(v2.buttons.map((b) => [b.custom_id, b.label]), [['mb:open', '📮 Gửi ý kiến'], ['mb:view', '📬 Xem trả lời']]);
    assert.ok(!/<@/.test(v2.text));
  });
  it('panel without a public key says the mailbox is not set up yet', () => {
    const v2 = assertV2Message(ui.buildMailPanel({ ready: false }));
    assert.ok(/chưa được thiết lập/.test(v2.text));
    assert.ok(!v2.text.includes('quản lý không thấy tên bạn'));
  });
  it('send step: category select, buttons disabled until chosen, category carried in the customId, anonymous off without a key', () => {
    const first = assertMessage(ui.buildSendStep());
    assert.equal(first.rows[0].components[0].options.length, 5);
    assert.deepEqual(first.rows[1].components.map((b) => [b.custom_id, b.disabled]), [['mb:anon:-', true], ['mb:named:-', true]]);
    const chosen = assertMessage(ui.buildSendStep({ category: 'war' }));
    assert.deepEqual(chosen.rows[1].components.map((b) => [b.custom_id, Boolean(b.disabled)]), [['mb:anon:war', false], ['mb:named:war', false]]);
    assert.equal(chosen.rows[0].components[0].options.find((o) => o.default).value, 'war');
    const noKey = assertMessage(ui.buildSendStep({ category: 'war', ready: false }));
    assert.deepEqual(noKey.rows[1].components.map((b) => Boolean(b.disabled)), [true, false]);
  });
  it('modals: content required (max 1000), title optional; code; reply', () => {
    const m = assertModal(ui.buildSendModal('bug', true));
    assert.equal(m.custom_id, 'mb:sendModal:a:bug');
    const [title, content] = m.components.map((l) => l.component);
    assert.equal(title.required, false);
    assert.equal(content.required, true);
    assert.equal(content.max_length, 1000);
    assert.equal(assertModal(ui.buildSendModal('bug', false)).custom_id, 'mb:sendModal:n:bug');
    assert.equal(assertModal(ui.buildCodeModal()).custom_id, 'mb:codeModal');
    assert.equal(assertModal(ui.buildReplyModal(12)).components[0].component.max_length, 1000);
  });
  it('anonymous card: heading, no sender, hostile text defanged, accent by status, no mention anywhere', () => {
    const payload = ui.buildLetterCard(letter());
    const v2 = assertV2Message(payload);
    assert.ok(v2.text.startsWith('### 📮 Thư #12 · 💡 Góp ý'));
    assert.ok(v2.text.includes('-# 🕵️ Ẩn danh · <t:'));
    assert.ok(!/@everyone|@here|<@|\]\(/.test(v2.text), v2.text);
    assert.equal(v2.json[0].accent_color, 0xf1c40f);
    assert.equal(assertV2Message(ui.buildLetterCard(letter({ status: 'seen' }))).json[0].accent_color, 0x3498db);
    assert.equal(assertV2Message(ui.buildLetterCard(letter({ status: 'done' }))).json[0].accent_color, 0x2ecc71);
    assert.deepEqual(v2.buttons.map((b) => b.custom_id), ['mb:seen:12', 'mb:reply:12', 'mb:done:12']);
  });
  it('named card shows <@id> (rendered, never pinged: allowedMentions parse []); the last reply sits under a separator', () => {
    const payload = ui.buildLetterCard(letter({ anonymous: false, senderId: USER, replies: [{ by: ADMIN, text: 'first answer', at: new Date() }, { by: ADMIN, text: 'second answer <@5>', at: new Date() }] }));
    const v2 = assertV2Message(payload);
    assert.ok(v2.text.includes(`-# 🙋 <@${USER}> · <t:`));
    assert.ok(v2.text.includes(`💬 <@${ADMIN}> · <t:`) && v2.text.includes('second answer') && !v2.text.includes('first answer'));
    assert.ok(!v2.text.includes('<@5>'));
    assert.ok(v2.json[0].components.some((c) => c.type === 14), 'separator');
    assert.deepEqual(payload.allowedMentions, { parse: [] });
  });
  it('the anonymous card carries nothing about the sender, whatever the letter record holds', () => {
    const json = JSON.stringify(ui.buildLetterCard(letter({ senderEnc: 'SECRET', senderId: USER })));
    assert.ok(!json.includes('SECRET') && !json.includes(USER));
  });
  it('reply view (by code): status + replies, manager names left out', () => {
    const view = ui.buildReplyView(letter({ status: 'seen', replies: [{ by: ADMIN, text: 'ok <@9>', at: new Date() }] }));
    assert.ok(view.content.includes('Thư #12') && view.content.includes('Đã xem') && view.content.includes('ok'));
    assert.ok(!view.content.includes(ADMIN) && !view.content.includes('<@9>'));
    assert.deepEqual(view.allowedMentions, { parse: [] });
    assert.ok(ui.buildReplyView(letter()).content.includes('chưa trả lời'));
  });
  it('reply view: URLs in <...> and the warning line', () => {
    const view = ui.buildReplyView(letter({ replies: [{ by: ADMIN, text: 'vào https://evil.example/x', at: new Date() }] }));
    assert.ok(view.content.includes('<https://evil.example/x>'));
    assert.ok(view.content.includes('⚠️ Cẩn thận khi mở link trong trả lời.'));
    assert.ok(!ui.buildReplyView(letter()).content.includes('Cẩn thận'));
  });
  it('a hostile category key ("__proto__", "constructor") is not a category', () => {
    assert.equal(mail.isCategory('idea'), true);
    for (const k of ['__proto__', 'constructor', 'toString', undefined, 5]) assert.equal(mail.isCategory(k), false, String(k));
    const step = assertMessage(ui.buildSendStep({ category: '__proto__' }));
    assert.deepEqual(step.rows[1].components.map((b) => b.custom_id), ['mb:anon:-', 'mb:named:-']);
    assert.ok(mail.categoryLine('constructor').includes('Khác'));
  });
});

// ---------- handler (DB and Discord stubbed) ----------

let lines; // eventLog lines
let created; // createLetter args
let posted; // channel.send payloads
let letterStore; // what getLetter / setStatus / addReply see
let dms;

function stubService() {
  mail.loadPublicKey = () => keys.publicKey;
  mail.createLetter = async (args) => {
    created.push(args);
    const letter = { ...args, no: created.length, status: 'new', replies: [], createdAt: new Date() };
    letterStore = letter;
    return { letter, code: 'ABCDEFGHJK' };
  };
  mail.setInbox = async () => {};
  mail.getLetter = async () => letterStore;
  mail.setStatus = async (_g, _no, status) => (letterStore ? (letterStore = { ...letterStore, status }) : null);
  mail.addReply = async (_g, _no, r) => (letterStore = { ...letterStore, status: 'seen', replies: [...letterStore.replies, { ...r, at: new Date() }] });
}

function interaction(extra = {}) {
  const log = [];
  const channel = { id: 'inbox', send: async (p) => posted.push(p) };
  const i = {
    guildId: GUILD,
    user: { id: USER, username: 'u' },
    member: { roles: [], permissions: NOBODY },
    memberPermissions: NOBODY,
    customId: 'mb:x',
    message: { id: 'm1' },
    values: [],
    client: { channels: { fetch: async () => channel }, users: { fetch: async (id) => ({ send: async (p) => (dms.fail ? Promise.reject(new Error('Cannot send messages to this user')) : dms.push([id, p])) }) } },
    isFromMessage: () => true,
    deferReply: async (o) => log.push(['deferReply', o]),
    deferUpdate: async () => log.push(['deferUpdate']),
    editReply: async (o) => log.push(['editReply', o]),
    reply: async (o) => log.push(['reply', o]),
    followUp: async (o) => log.push(['followUp', o]),
    showModal: async (m) => log.push(['showModal', m]),
    fields: { getTextInputValue: (id) => ({ title: 'tít', content: 'nội dung', code: 'abcde-fghjk', text: 'trả lời' }[id] ?? '') },
    ...extra,
  };
  return { i, log };
}
const last = (log, kind) => log.filter((l) => l[0] === kind).pop()[1];

beforeEach(() => {
  config = { ...guildConfigService.defaultConfig(GUILD), adminChannelId: 'admin-chan', adminRoleIds: [] };
  lines = [];
  created = [];
  posted = [];
  dms = [];
  letterStore = null;
  stubService();
  mail.resetLimits();
  mail.flushDaily({ all: true, log: () => {} });
  eventLog.setSink((l) => lines.push(JSON.parse(l)));
  mock.method(console, 'error', () => {});
});

after(() => eventLog.setSink(null));

describe('sending a letter', () => {
  it('anonymous: encrypted sender only, card posted in the inbox (default = admin channel), code shown, no user id logged', async () => {
    const { i, log } = interaction({ customId: 'mb:sendModal:a:idea' });
    await handler.handle(i, ['mb', 'sendModal', 'a', 'idea']);
    assert.equal(created.length, 1);
    assert.equal(created[0].anonymous, true);
    assert.equal(created[0].senderId, null);
    assert.equal(who.decryptSender(created[0].senderEnc, keys.privateKey, PASS).discordId, USER);
    assert.equal(posted.length, 1);
    assertV2Message(posted[0], { forCreate: true });
    const text = last(log, 'editReply').content;
    assert.ok(text.includes('✅ Đã gửi thư #1.'));
    assert.ok(text.includes('Mã thư của bạn: **ABCDE-FGHJK** — lưu lại để xem trả lời (bấm 📬 Xem trả lời). Mất mã thì không xem được.'));
    assert.deepEqual(last(log, 'editReply').allowedMentions, { parse: [] });
    assert.equal(lines.some((l) => l.area === 'mail' && ['sent', 'post_failed', 'view_code'].includes(l.ev)), false, 'no per-letter line at all');
    const sealed = who.decryptSender(created[0].senderEnc, keys.privateKey, PASS);
    assert.equal(sealed.guildId, GUILD);
    assert.equal(sealed.h, mail.letterDigest(created[0].title, created[0].content));
    assert.deepEqual(mail.flushDaily({ all: true, log: () => {} }), [{ guild: GUILD, day: new Date().toLocaleDateString('en-CA'), sent: 1 }]);
    assert.ok(!JSON.stringify(lines).includes(USER), 'the sender id is nowhere in the event log');
    assert.ok(!JSON.stringify(created).includes(USER) || created[0].senderId === null, 'plain id not stored');
    assert.ok(!JSON.stringify(created[0]).includes(USER));
  });
  it('named: plain senderId, no senderEnc, the reply tells managers answer by DM', async () => {
    const { i, log } = interaction();
    await handler.handle(i, ['mb', 'sendModal', 'n', 'war']);
    assert.equal(created[0].senderId, USER);
    assert.equal(created[0].senderEnc, null);
    assert.equal(created[0].category, 'war');
    const text = last(log, 'editReply').content;
    assert.ok(text.includes('✅ Đã gửi thư #1.') && text.includes('Quản lý sẽ trả lời qua tin nhắn riêng.'));
  });
  it('the inbox channel setting wins over the admin channel', async () => {
    config.mailInboxChannelId = 'special';
    const fetched = [];
    const { i } = interaction({ client: { channels: { fetch: async (id) => (fetched.push(id), { id, send: async (p) => posted.push(p) }) } } });
    await handler.handle(i, ['mb', 'sendModal', 'n', 'idea']);
    assert.deepEqual(fetched, ['special']);
  });
  it('blocked id: "Bạn không thể gửi thư.", nothing saved or posted, mail.blocked logged without the user', async () => {
    config.mailBlocked = [USER];
    const { i, log } = interaction();
    await handler.handle(i, ['mb', 'sendModal', 'a', 'idea']);
    assert.equal(last(log, 'editReply').content, 'Bạn không thể gửi thư.');
    assert.equal(created.length + posted.length, 0);
    assert.equal(lines.some((l) => l.ev === 'blocked'), false, 'counted, not logged per event');
    assert.equal(mail.flushDaily({ all: true, log: () => {} })[0].blocked, 1);
    assert.ok(!JSON.stringify(lines).includes(USER));
    assert.equal(mail.sendLimit.allowed(`${GUILD}:${USER}`), true, 'a refused send does not use up the allowance');
  });
  it('the 4th letter within 24 h is refused (mail.ratelimited); another user is not affected', async () => {
    for (let n = 0; n < 3; n++) await handler.handle(interaction().i, ['mb', 'sendModal', 'a', 'idea']);
    assert.equal(created.length, 3);
    const { i, log } = interaction();
    await handler.handle(i, ['mb', 'sendModal', 'a', 'idea']);
    assert.equal(created.length, 3);
    assert.ok(/3 thư trong 24 giờ/.test(last(log, 'editReply').content));
    assert.equal(mail.flushDaily({ all: true, log: () => {} })[0].ratelimited, 1);
    await handler.handle(interaction({ user: { id: sid(1) } }).i, ['mb', 'sendModal', 'a', 'idea']);
    assert.equal(created.length, 4);
  });
  it('no public key: anonymous sending is refused, sending with a name still works', async () => {
    mail.loadPublicKey = () => null;
    const realReady = mail.mailboxReady;
    mail.mailboxReady = () => false; // (mailboxReady reads the key file itself: a real config/mailbox-public.pem on this machine must not matter)
    const a = interaction();
    await handler.handle(a.i, ['mb', 'sendModal', 'a', 'idea']);
    assert.equal(created.length, 0);
    assert.ok(/chưa được thiết lập/.test(last(a.log, 'editReply').content));
    await handler.handle(interaction().i, ['mb', 'sendModal', 'n', 'idea']);
    assert.equal(created.length, 1);
    const btn = interaction();
    await handler.handle(btn.i, ['mb', 'anon', 'idea']);
    assert.ok(/chưa được thiết lập/.test(last(btn.log, 'reply').content));
    assert.equal(btn.log.some((l) => l[0] === 'showModal'), false);
    mail.mailboxReady = realReady;
  });
  it('no inbox channel at all: nothing saved', async () => {
    config.adminChannelId = null;
    const { i, log } = interaction();
    await handler.handle(i, ['mb', 'sendModal', 'n', 'idea']);
    assert.equal(created.length, 0);
    assert.ok(/chưa được thiết lập/.test(last(log, 'editReply').content));
  });
  it('a card that cannot be posted still saves the letter and tells the sender', async () => {
    const { i, log } = interaction({ client: { channels: { fetch: async () => Promise.reject(new Error('Missing Access')) } } });
    await handler.handle(i, ['mb', 'sendModal', 'n', 'idea']);
    assert.equal(created.length, 1);
    assert.ok(last(log, 'editReply').content.includes('chưa đăng được thư'));
  });
  it('step buttons open the modal with the category from the customId', async () => {
    const { i, log } = interaction();
    await handler.handle(i, ['mb', 'named', 'bug']);
    assert.equal(last(log, 'showModal').toJSON().custom_id, 'mb:sendModal:n:bug');
    const open = interaction();
    await handler.handle(open.i, ['mb', 'open']);
    assert.equal(last(open.log, 'reply').flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
    const cat = interaction({ values: ['war'] });
    await handler.handle(cat.i, ['mb', 'cat']);
    assert.equal(assertMessage(last(cat.log, 'editReply')).rows[1].components[0].custom_id, 'mb:anon:war');
  });
});

describe('viewing replies by code', () => {
  it('a found code shows the letter; wrong codes are counted and the 6th attempt is refused', async () => {
    letterStore = { no: 3, category: 'idea', status: 'seen', replies: [{ by: ADMIN, text: 'đã nhận', at: new Date() }] };
    mail.findByCode = async (_g, code) => (code === 'abcde-fghjk' ? letterStore : null);
    const ok = interaction();
    await handler.handle(ok.i, ['mb', 'codeModal']);
    assert.ok(last(ok.log, 'editReply').content.includes('đã nhận'));
    for (let n = 0; n < 5; n++) {
      const bad = interaction({ fields: { getTextInputValue: () => 'zzzzz-zzzzz' } });
      await handler.handle(bad.i, ['mb', 'codeModal']);
      assert.equal(last(bad.log, 'editReply').content, 'Không tìm thấy thư với mã này.');
    }
    const limited = interaction();
    await handler.handle(limited.i, ['mb', 'codeModal']);
    assert.ok(/quá nhiều lần/.test(last(limited.log, 'editReply').content));
    assert.equal(lines.filter((l) => l.ev === 'view_code').length, 0);
    assert.deepEqual(mail.flushDaily({ all: true, log: () => {} })[0], { guild: GUILD, day: new Date().toLocaleDateString('en-CA'), viewed: 1, badCode: 5, ratelimited: 1 });
    assert.ok(!JSON.stringify(lines).includes(USER));
  });
  it('parallel submits are charged before the first await: only 3 of 6 simultaneous sends make letters; a failed send is refunded', async () => {
    await Promise.all(Array.from({ length: 6 }, () => handler.handle(interaction().i, ['mb', 'sendModal', 'n', 'idea'])));
    assert.equal(created.length, 3);
    mail.resetLimits();
    config.mailBlocked = [USER];
    await handler.handle(interaction().i, ['mb', 'sendModal', 'n', 'idea']);
    config.mailBlocked = [];
    config.adminChannelId = null;
    await handler.handle(interaction().i, ['mb', 'sendModal', 'n', 'idea']);
    assert.equal(mail.sendLimit.allowed(`${GUILD}:${USER}`), true);
    for (let n = 0; n < 3; n++) mail.sendLimit.hit(`${GUILD}:${USER}`);
    assert.equal(mail.sendLimit.allowed(`${GUILD}:${USER}`), false);
  });
  it('parallel wrong guesses are charged before the first await; a correct code is refunded', async () => {
    mail.findByCode = async (_g, code) => (code === 'abcde-fghjk' ? { no: 1, category: 'idea', status: 'new', replies: [] } : null);
    const bad = () => interaction({ fields: { getTextInputValue: () => 'zzzzz-zzzzz' } }).i;
    await Promise.all(Array.from({ length: 8 }, () => handler.handle(bad(), ['mb', 'codeModal'])));
    const day = mail.flushDaily({ all: true, log: () => {} })[0];
    assert.equal(day.badCode, 5);
    mail.resetLimits();
    for (let n = 0; n < 10; n++) await handler.handle(interaction().i, ['mb', 'codeModal']);
    assert.equal(mail.guessLimit.allowed(`${GUILD}:${USER}`), true);
  });
  it('a letter that cannot be posted is only counted (postFailed): no console / event line with its number', async () => {
    const { i } = interaction({ client: { channels: { fetch: async () => Promise.reject(new Error('Missing Access')) } } });
    await handler.handle(i, ['mb', 'sendModal', 'n', 'idea']);
    assert.equal(lines.length, 0);
    assert.equal(console.error.mock.calls.length, 0);
    assert.equal(mail.flushDaily({ all: true, log: () => {} })[0].postFailed, 1);
  });
  it('flushDaily writes mail.daily once per past day and keeps today\'s until asked', () => {
    mail.countDaily(GUILD, 'sent', new Date(2026, 9, 12, 20, 3));
    mail.countDaily(GUILD, 'sent', new Date(2026, 9, 12, 23, 59));
    mail.countDaily(GUILD, 'viewed', new Date(2026, 9, 13, 1, 0));
    const written = [];
    mail.flushDaily({ now: new Date(2026, 9, 13, 9, 0), log: (a, e, f) => written.push([a, e, f]) });
    assert.deepEqual(written, [['mail', 'daily', { guild: GUILD, day: '2026-10-12', sent: 2 }]]);
    assert.deepEqual(mail.flushDaily({ now: new Date(2026, 9, 14, 0, 1), log: () => {} }), [{ guild: GUILD, day: '2026-10-13', viewed: 1 }]);
  });
});

describe('manager buttons are admin-gated', () => {
  const asAdmin = { member: { roles: [], permissions: MANAGE }, memberPermissions: MANAGE, user: { id: ADMIN, username: 'a' } };
  const actions = [['seen'], ['done'], ['reply'], ['replyModal']];

  for (const [action] of actions) {
    it(`mb:${action}:12 by a non-admin: NO_PERMISSION, ephemeral, the card is not touched`, async () => {
      letterStore = { no: 12, anonymous: true, status: 'new', replies: [], category: 'idea', content: 'x', createdAt: new Date() };
      const writes = [];
      mail.setStatus = async (...a) => writes.push(a);
      mail.addReply = async (...a) => writes.push(a);
      const { i, log } = interaction();
      await handler.handle(i, ['mb', action, '12']);
      assert.deepEqual(log.map((l) => l[0]), ['reply']);
      assert.equal(log[0][1].content, NO_PERMISSION);
      assert.equal(log[0][1].flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
      assert.equal(writes.length, 0);
    });
  }
  it('a configured admin role passes the gate too', async () => {
    config.adminRoleIds = ['role-mgr'];
    letterStore = { no: 12, anonymous: true, status: 'new', replies: [], category: 'idea', content: 'x', createdAt: new Date() };
    const { i, log } = interaction({ member: { roles: ['role-mgr'], permissions: NOBODY } });
    await handler.handle(i, ['mb', 'seen', '12']);
    assert.equal(last(log, 'editReply').flags & (1 << 15), 1 << 15);
  });
  it('👀 Đã xem and ✔️ Xong redraw the card with the new status and log mail.status', async () => {
    letterStore = { no: 12, anonymous: true, status: 'new', replies: [], category: 'idea', content: 'x', createdAt: new Date() };
    const seen = interaction(asAdmin);
    await handler.handle(seen.i, ['mb', 'seen', '12']);
    assert.equal(assertV2Message(last(seen.log, 'editReply')).json[0].accent_color, 0x3498db);
    const done = interaction(asAdmin);
    await handler.handle(done.i, ['mb', 'done', '12']);
    assert.equal(assertV2Message(last(done.log, 'editReply')).json[0].accent_color, 0x2ecc71);
    assert.deepEqual(lines.filter((l) => l.ev === 'status').map((l) => l.status), ['seen', 'done']);
  });
  it('💬 Trả lời opens the 1000-character modal', async () => {
    const { i, log } = interaction(asAdmin);
    await handler.handle(i, ['mb', 'reply', '12']);
    assert.equal(last(log, 'showModal').toJSON().custom_id, 'mb:replyModal:12');
  });
  it('a reply to a named letter is DMed; a closed DM is fine; an anonymous letter is not DMed', async () => {
    letterStore = { no: 12, anonymous: false, senderId: USER, status: 'new', replies: [], category: 'idea', content: 'x', createdAt: new Date() };
    const sent = interaction(asAdmin);
    await handler.handle(sent.i, ['mb', 'replyModal', '12']);
    assert.equal(dms.length, 1);
    assert.equal(dms[0][0], USER);
    assert.deepEqual(dms[0][1].allowedMentions, { parse: [] });
    assert.ok(dms[0][1].content.includes('trả lời'));
    const v2 = assertV2Message(last(sent.log, 'editReply'));
    assert.ok(v2.text.includes(`💬 <@${ADMIN}>`) && v2.text.includes('trả lời'));
    assert.equal(lines.find((l) => l.ev === 'reply').dm, 'sent');

    letterStore = { no: 13, anonymous: false, senderId: USER, status: 'new', replies: [], category: 'idea', content: 'x', createdAt: new Date() };
    dms.fail = true;
    const closed = interaction(asAdmin);
    await handler.handle(closed.i, ['mb', 'replyModal', '13']);
    assert.ok(last(closed.log, 'followUp').content.includes('Không nhắn riêng được'));
    assert.equal(lines.filter((l) => l.ev === 'reply').pop().dm, 'failed');
    dms.fail = false;

    letterStore = { no: 14, anonymous: true, status: 'new', replies: [], category: 'idea', content: 'x', createdAt: new Date() };
    const anon = interaction(asAdmin);
    await handler.handle(anon.i, ['mb', 'replyModal', '14']);
    assert.equal(dms.length, 1, 'no DM for an anonymous letter');
    assert.equal(lines.filter((l) => l.ev === 'reply').pop().dm, 'none');
  });
});

describe('ix.done never records who clicked a mailbox button', () => {
  const route = async (customId) => {
    const lines2 = [];
    eventLog.setSink((l) => lines2.push(JSON.parse(l)));
    const i = {
      guildId: GUILD,
      customId,
      user: { id: USER },
      inGuild: () => true,
      isChatInputCommand: () => false,
      isMessageComponent: () => true,
      isModalSubmit: () => false,
      isButton: () => true,
      isRepliable: () => false,
      showModal: async () => {},
      replied: false,
      deferred: false,
    };
    await routeInteraction(i);
    return lines2.find((l) => l.area === 'ix' && l.ev === 'done');
  };
  it('mb:* interactions write NO ix.done line at all; other prefixes keep theirs, with the user', async () => {
    for (const id of ['mb:view', 'mb:sendModal:a:idea', 'mb:codeModal', 'mb:seen:12']) assert.equal(await route(id), undefined, id);
    assert.equal((await route('zz:other')).user, USER);
  });
  it('a failing mb:* handler leaves one mail.error line without customId, user or letter number, and a console line without the customId', async () => {
    const lines2 = [];
    eventLog.setSink((l) => lines2.push(l));
    const i = { guildId: GUILD, customId: 'mb:seen:12', user: { id: USER }, inGuild: () => true, isChatInputCommand: () => false, isMessageComponent: () => true, isModalSubmit: () => false, isButton: () => true, isRepliable: () => false, member: null, memberPermissions: null, replied: false, deferred: false };
    await routeInteraction(i);
    assert.equal(lines2.length, 1);
    const line = JSON.parse(lines2[0]);
    assert.equal(line.ev, 'error');
    assert.ok(!lines2[0].includes(USER) && !lines2[0].includes('mb:seen') && !lines2[0].includes('"no":'));
    assert.ok(console.error.mock.calls.every((c) => !c.arguments.join(' ').includes('mb:seen')));
  });
});

describe('keygen', () => {
  it('writes a 3072-bit pair: public in the repo file, private encrypted with the passphrase', () => {
    const outPrivate = path.join(tmp, 'k1', 'private.pem');
    const outPublic = path.join(tmp, 'k1', 'public.pem');
    keygen.generate({ outPrivate, outPublic, passphrase: PASS });
    const pub = fs.readFileSync(outPublic, 'utf8');
    const priv = fs.readFileSync(outPrivate, 'utf8');
    assert.ok(pub.includes('BEGIN PUBLIC KEY') && !pub.includes('PRIVATE'));
    assert.ok(priv.includes('BEGIN ENCRYPTED PRIVATE KEY'));
    assert.equal(crypto.createPublicKey(pub).asymmetricKeyDetails.modulusLength, 3072);
    assert.throws(() => crypto.createPrivateKey(priv), 'unreadable without the passphrase');
    assert.equal(realLoadPublicKey(outPublic), pub);
    const enc = mail.encryptSender(pub, USER);
    assert.equal(who.decryptSender(enc, priv, PASS).discordId, USER);
    const made = keygen.generate({ outPrivate: path.join(tmp, 'k1b', 'p.pem'), outPublic: path.join(tmp, 'k1b', 'q.pem'), passphrase: PASS, bits: 2048 });
    assert.match(made.fingerprint, /^[0-9a-f]{16}$/);
  });
  it('refuses to overwrite an existing key without --force, and leaves it untouched', () => {
    const outPrivate = path.join(tmp, 'k2', 'private.pem');
    const outPublic = path.join(tmp, 'k2', 'public.pem');
    keygen.generate({ outPrivate, outPublic, passphrase: PASS, bits: 2048 });
    const before = fs.readFileSync(outPrivate, 'utf8');
    assert.throws(() => keygen.generate({ outPrivate, outPublic, passphrase: PASS, bits: 2048 }), /already exists/);
    assert.equal(fs.readFileSync(outPrivate, 'utf8'), before);
    // only the public file present is also an overwrite
    fs.rmSync(outPrivate);
    assert.throws(() => keygen.generate({ outPrivate, outPublic, passphrase: PASS, bits: 2048 }), /already exists/);
    assert.equal(fs.existsSync(outPrivate), false);
    keygen.generate({ outPrivate, outPublic, passphrase: PASS, force: true, bits: 2048 });
    assert.notEqual(fs.readFileSync(outPrivate, 'utf8'), before);
  });
  it('rejects a passphrase under 14 characters (13 fails, 14 passes)', () => {
    assert.equal(keygen.MIN_PASSPHRASE, 14);
    assert.throws(() => keygen.generate({ outPrivate: path.join(tmp, 'k3', 'p.pem'), outPublic: path.join(tmp, 'k3', 'q.pem'), passphrase: '1234567890123', bits: 2048 }), /at least 14/);
    assert.doesNotThrow(() => keygen.generate({ outPrivate: path.join(tmp, 'k3b', 'p.pem'), outPublic: path.join(tmp, 'k3b', 'q.pem'), passphrase: '12345678901234', bits: 2048 }));
    fs.rmSync(path.join(tmp, 'k3b'), { recursive: true, force: true });
    assert.throws(() => keygen.generate({ outPrivate: path.join(tmp, 'k3', 'p.pem'), outPublic: path.join(tmp, 'k3', 'q.pem'), passphrase: 'short', bits: 2048 }), /passphrase/);
    assert.equal(fs.existsSync(path.join(tmp, 'k3')), false);
  });
  it('main(): never reads a passphrase from the environment; refuses an existing key before asking anything', async () => {
    const out = path.join(tmp, 'k4', 'private.pem');
    const pub = path.join(tmp, 'k4', 'public.pem');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'x');
    const before = process.env.MAILBOX_PASSPHRASE;
    process.env.MAILBOX_PASSPHRASE = PASS;
    try {
      await assert.rejects(keygen.main(['--out', out, '--pub', pub]), /already exists/); // would hang on stdin if it asked first
    } finally {
      if (before === undefined) delete process.env.MAILBOX_PASSPHRASE;
      else process.env.MAILBOX_PASSPHRASE = before;
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'mailbox-keygen.js'), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/MAILBOX_PASSPHRASE/.test(src), 'keygen has no env passphrase option');
  });
});

describe('owner lookup script', () => {
  it('audit line: time, guild, letter no, OS user, result - and never the found id', () => {
    const line = who.auditLine({ guild: GUILD, no: 12, result: 'ok', user: 'boss', now: new Date('2026-10-13T01:02:03Z') });
    assert.equal(line, `2026-10-13T01:02:03.000Z guild=${GUILD} no=12 os_user=boss result=ok\n`);
    const dir = path.join(tmp, 'logs');
    who.appendAudit(dir, { guild: GUILD, no: 1, result: 'ok' });
    who.appendAudit(dir, { guild: GUILD, no: 2, result: 'failed' });
    assert.equal(fs.readFileSync(path.join(dir, 'mailbox-lookups.log'), 'utf8').trim().split('\n').length, 2);
  });
  it('currentName: guild nickname first, then the account, never printing the token', async () => {
    const calls = [];
    const fetchFn = async (url, opts) => {
      calls.push([url, opts.headers.Authorization]);
      if (url.includes('/members/')) return { ok: true, json: async () => ({ nick: 'Biệt danh', user: { username: 'acc' } }) };
      return { ok: false };
    };
    assert.equal(await who.currentName(GUILD, USER, 'TOKEN', fetchFn), 'Biệt danh');
    assert.equal(calls[0][1], 'Bot TOKEN');
    const left = async (url) => (url.includes('/members/') ? { ok: false } : { ok: true, json: async () => ({ username: 'acc' }) });
    assert.match(await who.currentName(GUILD, USER, 'TOKEN', left), /acc \(không còn trong máy chủ\)/);
    assert.equal(await who.currentName(GUILD, USER, 'TOKEN', async () => ({ ok: false })), null);
  });
});

describe('owner lookup: forged / swapped ciphertext (verifyLetter)', () => {
  const at = new Date('2026-10-12T10:00:00Z');
  const stored = { guildId: GUILD, title: 'tít', content: 'nội dung', createdAt: new Date(at.getTime() + 30_000) };
  const seal = (extra = {}) => who.decryptSender(mail.encryptSender(keys.publicKey, USER, { guildId: GUILD, title: 'tít', content: 'nội dung', at, ...extra }), keys.privateKey, PASS);

  it('a genuine letter passes', () => {
    assert.deepEqual(who.verifyLetter(seal(), stored), { checked: true, problems: [] });
  });
  it('a ciphertext from another letter (other content) or another guild is flagged', () => {
    assert.equal(who.verifyLetter(seal({ content: 'khác' }), stored).problems.length, 1);
    assert.match(who.verifyLetter(seal({ title: 'khác' }), stored).problems[0], /title \/ content/);
    assert.match(who.verifyLetter(seal({ guildId: '800000000000000009' }), stored).problems[0], /guild mismatch/);
  });
  it('a sealed time more than 2 minutes from createdAt is flagged', () => {
    assert.equal(who.verifyLetter(seal(), { ...stored, createdAt: new Date(at.getTime() + 119_000) }).problems.length, 0);
    assert.match(who.verifyLetter(seal(), { ...stored, createdAt: new Date(at.getTime() + 121_000) }).problems[0], /2 minutes/);
  });
  it('an old letter (no guild / digest) is "not checkable" but its time is still compared', () => {
    const old = who.decryptSender(mail.encryptSender(keys.publicKey, USER, { at }), keys.privateKey, PASS);
    assert.deepEqual(who.verifyLetter(old, stored), { checked: false, problems: [] });
    assert.equal(who.verifyLetter(old, { ...stored, createdAt: new Date('2027-01-01') }).problems.length, 1);
    assert.equal(who.OLD_LETTER, '(thư cũ, không kiểm tra được)');
    assert.equal(who.NOT_PROOF, 'Kết quả tra cứu là bằng chứng, không phải chứng cứ tuyệt đối (người có quyền ghi DB có thể giả mạo).');
  });
  it('the passphrase is read from the real environment before dotenv, never from .env', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'mailbox-who.js'), 'utf8');
    assert.ok(src.indexOf('REAL_ENV_PASSPHRASE = process.env.MAILBOX_PASSPHRASE') < src.indexOf("require('dotenv')"));
    assert.ok(!/(?<!process\.)env\.MAILBOX_PASSPHRASE/.test(src));
    assert.match(src, /result: 'notfound'/);
    assert.match(src, /result: 'cancelled'/);
  });
});

describe('packaging guard', () => {
  it('refuses an .env that holds MAILBOX_PASSPHRASE', () => {
    for (const bad of ['MAILBOX_PASSPHRASE=abc', '  export MAILBOX_PASSPHRASE = "x y"', 'A=1\nMAILBOX_PASSPHRASE=\n']) assert.throws(() => build.assertNoMailPassphrase(bad), /MAILBOX_PASSPHRASE/, bad);
    for (const ok of ['TOKEN=x\n# MAILBOX_PASSPHRASE=nope', 'MY_MAILBOX_PASSPHRASE=1', '']) assert.doesNotThrow(() => build.assertNoMailPassphrase(ok), ok);
  });
  it('assertNoPrivateKeys throws on a *private*.pem, and on any .pem holding a private key block', () => {
    const dir = path.join(tmp, 'stage1');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'hi');
    fs.writeFileSync(path.join(dir, 'mailbox-public.pem'), keys.publicKey);
    assert.deepEqual(build.assertNoPrivateKeys([dir]), [dir], 'a public key passes');
    fs.writeFileSync(path.join(dir, 'sub', 'LongLinh-mailbox-private.pem'), 'x');
    assert.throws(() => build.assertNoPrivateKeys([dir]), /private key in the build input.*LongLinh-mailbox-private\.pem/);
    fs.rmSync(path.join(dir, 'sub', 'LongLinh-mailbox-private.pem'));
    fs.writeFileSync(path.join(dir, 'renamed.pem'), keys.privateKey);
    assert.throws(() => build.assertNoPrivateKeys([dir]), /renamed\.pem/);
  });
  it('a missing folder is skipped; the real repo inputs are clean', () => {
    assert.doesNotThrow(() => build.assertNoPrivateKeys([path.join(tmp, 'does-not-exist')]));
    assert.doesNotThrow(() => build.assertNoPrivateKeys(build.KEY_SCAN_DIRS.map((d) => path.join(__dirname, '..', d))));
  });
  it('the public key is a pkg asset, the private key patterns are git-ignored, npm scripts exist', () => {
    const pkg = require('../package.json');
    assert.ok(pkg.pkg.assets.includes('config/mailbox-public.pem'));
    assert.equal(pkg.scripts['mail:keygen'], 'node scripts/mailbox-keygen.js');
    assert.equal(pkg.scripts['mail:who'], 'node scripts/mailbox-who.js');
    const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('*private*.pem') && ignore.includes('LongLinh-mailbox-private.pem'));
  });
});
