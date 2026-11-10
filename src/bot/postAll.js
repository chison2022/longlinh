// /setup "📌 Đăng tất cả": posts or refreshes the panel of every enabled feature in one go, with sensible default channels when no specific
// one is set. Idempotent: every panel module edits the message it stored and only posts a new one when that is gone. Never throws.
//   dashboard -> admin channel · 🎮 name link -> gnChannelId else announce · 📮 mailbox -> its channel else announce (inbox: its own, else admin)
//   · 🎉 events -> eventAdminChannelId else admin · 🚪 gate -> only with gateChannelId and a member role the bot can manage
// -> [{ key, label, status: 'ok' | 'skip' | 'error', action?, channelId?, reason? }]
const { isOn } = require('../services/features');
const refresher = require('./refresher');
const gnPanel = require('./gnPanel');
const mailPanel = require('./mailPanel');
const eventPanel = require('./eventPanel');
const gatePanel = require('./gatePanel');
const { checkRoles, PROBLEM_TEXT } = require('./gateRoles');
const { eventAdminChannelOf } = require('../services/eventService');
const { logEvent } = require('../eventLog');

const LABELS = { dashboard: '🏯 Bảng điều khiển', gn: '🎮 Bảng liên kết tên', mailbox: '📮 Hòm thư', events: '🎉 Bảng quản lý sự kiện', gate: '🚪 Cổng vào' };
const GATE_SETUP_HINT = 'vào ⚙️ Nâng cao → 🚪 Cổng vào';

// Runs one panel: `channelId` null = skip with `reason`. The post function throws when the channel cannot be used.
async function run(key, channelId, reason, post) {
  const label = LABELS[key];
  if (!channelId) return { key, label, status: 'skip', reason };
  try {
    const res = await post();
    return { key, label, status: 'ok', action: res.action, channelId: res.channelId };
  } catch (err) {
    console.error(`[setup] post all, ${key}:`, err.message);
    return { key, label, status: 'error', channelId, reason: err.code === 50013 || err.code === 50001 ? 'bot thiếu quyền ở kênh này' : 'không gửi được', err };
  }
}

// null when the gate panel can be posted, else the skip line (without the label): needs the gate channel and a member role the bot can hand out.
function gateSkipReason(config, guild) {
  if (!config.gateChannelId) return `chưa chọn kênh welcome — ${GATE_SETUP_HINT}`;
  if (!config.memberRoleId) return 'chưa chọn role thành viên (ở màn /setup chính)';
  const bad = checkRoles(guild, [{ kind: 'member', id: config.memberRoleId }]);
  if (bad.length) return `role thành viên chưa hợp lệ (${PROBLEM_TEXT[bad[0].problem]}) — kiểm tra quyền và thứ tự role của bot`;
  return null;
}

async function postAllPanels(client, config, guild = null) {
  const results = [];
  // the dashboard: always (the core), in the admin channel
  results.push(await run('dashboard', config.announceChannelId && config.adminChannelId ? config.adminChannelId : null, 'chọn kênh thông báo và kênh admin trước', () => refresher.postOrUpdatePanel(client, config)));
  results.push(await run('gn', config.gnChannelId || config.announceChannelId, 'chọn kênh thông báo (hoặc kênh liên kết tên) trước', () => gnPanel.postOrUpdateGnPanel(client, { ...config, gnChannelId: config.gnChannelId || config.announceChannelId })));
  if (isOn(config, 'mailbox')) {
    const channelId = config.mailChannelId || config.announceChannelId;
    const inbox = config.mailInboxChannelId || config.adminChannelId;
    const reason = !channelId ? 'chọn kênh thông báo (hoặc kênh hòm thư) trước' : 'chưa có kênh nhận thư và kênh admin';
    results.push(await run('mailbox', inbox ? channelId : null, reason, () => mailPanel.postOrUpdateMailPanel(client, { ...config, mailChannelId: channelId })));
  }
  if (isOn(config, 'events')) {
    const channelId = eventAdminChannelOf(config);
    results.push(await run('events', channelId, 'chọn kênh admin (hoặc kênh quản lý sự kiện) trước', () => eventPanel.postOrUpdateEventPanel(client, config)));
  }
  if (isOn(config, 'gate')) {
    const why = gateSkipReason(config, guild);
    results.push(await run('gate', why ? null : config.gateChannelId, why, () => gatePanel.postOrUpdateGatePanel(client, config)));
  }
  return results;
}

// The note shown under /setup: one line per panel.
function summaryLines(results) {
  const lines = ['**📌 Đăng tất cả**'];
  for (const r of results) {
    if (r.status === 'ok') lines.push(`✅ ${r.label}: ${r.action === 'edited' ? 'đã cập nhật' : 'đã đăng'} ở <#${r.channelId}>`);
    else if (r.status === 'skip') lines.push(`⏭ ${r.label}: ${r.reason}`);
    else lines.push(`❌ ${r.label}: ${r.reason} <#${r.channelId}> — kiểm tra quyền của bot (Xem kênh, Gửi tin nhắn)`);
  }
  return lines;
}

// Log payload: what happened per panel, without the error objects.
function logResults(ctx, results) {
  logEvent('setup', 'post_all', {
    ...ctx,
    results: results.map((r) => ({ panel: r.key, status: r.status, action: r.action, channel: r.channelId, reason: r.status === 'skip' ? r.reason : undefined })),
    failed: results.filter((r) => r.status === 'error').length || undefined,
    err: (results.find((r) => r.err) || {}).err,
  });
}

module.exports = { postAllPanels, summaryLines, logResults, LABELS };
