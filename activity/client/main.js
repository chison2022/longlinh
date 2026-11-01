// Bảng xếp đội: the Discord Activity client. Bundled by esbuild into activity/public/app.js (npm run activity:build).
// Drag and drop uses POINTER events (mouse, pen and touch alike); tapping a person and then a slot is the fallback.
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { moveInLayout, locate, partyWarnings, idsOf } from '../../src/services/lineupRules';

const POLL_MS = 2000;
const SAVE_DEBOUNCE_MS = 800;
const DRAG_PX = 6;
const LONG_PRESS_MS = 220;

const app = document.getElementById('app');
const state = {
  token: null,
  guildId: null,
  wars: [],
  canEditGuild: false,
  warId: null,
  data: null, // GET /api/lineup/:id
  layout: null, // the working copy (edited locally, saved by autosave)
  version: 0,
  dirty: false,
  saving: false,
  selected: null,
  search: '',
  classFilter: '',
  notice: '',
  saveState: '',
  confirming: false,
  busy: false,
  sheetOpen: false, // phone: the "Chưa xếp" bottom sheet
};
let saveTimer = null;
let noticeTimer = null;
let drag = null; // { id, ghost, startX, startY, active, timer, target }

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------- api ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(options.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body: body || {} };
}

function flash(text) {
  state.notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    state.notice = '';
    render();
  }, 4000);
}

// ---------- phone layout ----------
const phone = window.matchMedia('(max-width: 700px)');
const isPhone = () => phone.matches;

// "Thiết Y" -> "TY", "Huyết Hà" -> "HH", one word -> its first two letters ("Toái" -> "TO")
function classTag(name) {
  const words = String(name || '').normalize('NFC').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const tag = words.length > 1 ? words.map((w) => Array.from(w)[0]).join('') : Array.from(words[0]).slice(0, 2).join('');
  return tag.toUpperCase().slice(0, 3);
}

// ---------- model ----------
const memberById = () => new Map(state.data.members.map((m) => [m.id, m]));
const classMap = () => Object.fromEntries(state.data.members.map((m) => [m.id, m.className]));
const canEdit = () => Boolean(state.data && state.data.canEdit);

function adopt(data) {
  state.data = data;
  state.layout = data.lineup;
  state.version = data.version;
  state.dirty = false;
  state.selected = null;
}

async function loadWars() {
  const r = await api(`/api/wars?guild=${state.guildId}`);
  if (!r.ok) throw new Error(r.body.error || 'Không tải được danh sách bang chiến.');
  state.wars = r.body.wars;
  state.canEditGuild = r.body.canEdit;
}

async function loadLineup() {
  const r = await api(`/api/lineup/${state.warId}`);
  if (!r.ok) throw new Error(r.body.error || 'Không tải được đội hình.');
  adopt(r.body);
}

// ---------- autosave ----------
function markDirty() {
  state.dirty = true;
  state.saveState = 'Đang chờ lưu…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

async function save() {
  if (state.saving || !state.dirty) return;
  state.saving = true;
  const sent = state.layout;
  const r = await api(`/api/lineup/${state.warId}`, { method: 'PUT', body: JSON.stringify({ layout: sent, version: state.version }) });
  state.saving = false;
  if (r.ok) {
    state.version = r.body.version;
    if (state.layout === sent) {
      state.dirty = false;
      state.saveState = 'Đã lưu';
    } else {
      markDirty(); // edited again while saving
    }
  } else if (r.status === 409) {
    await loadLineup().catch(() => {});
    flash('Đã cập nhật bởi người khác — bản của bạn chưa lưu được, hãy xếp lại.');
  } else {
    state.saveState = r.body.error || 'Lưu lỗi';
    flash(state.saveState);
  }
  render();
}

function change(next) {
  if (next === state.layout) {
    state.selected = null;
    render();
    return;
  }
  state.layout = next;
  state.selected = null;
  markDirty();
  render();
}

function moveTo(id, target) {
  change(moveInLayout(state.layout, id, target, state.data.layout.partySize));
}

// ---------- polling ----------
async function poll() {
  if (!state.warId || !state.data || drag || state.dirty || state.saving || state.confirming) return;
  const r = await api(`/api/lineup/${state.warId}/version`).catch(() => null);
  if (!r || !r.ok) return;
  const pending = state.data.publish && state.data.publish.state === 'pending';
  if (r.body.version !== state.version || pending) {
    const before = state.version;
    await loadLineup().catch(() => {});
    if (state.version !== before) flash('Đã cập nhật bởi người khác');
    render();
  }
}

// ---------- drag and drop ----------
function targetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const zone = el && el.closest('[data-zone]');
  if (!zone) return null;
  if (zone.dataset.zone === 'pool') return { el: zone, target: { type: 'pool' } };
  return { el: zone, target: { type: 'slot', group: Number(zone.dataset.g), party: Number(zone.dataset.p), slot: Number(zone.dataset.s) } };
}

function endDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  if (drag.ghost) drag.ghost.remove();
  document.querySelectorAll('.over').forEach((e) => e.classList.remove('over'));
  document.querySelectorAll('.dragging').forEach((e) => e.classList.remove('dragging'));
  drag = null;
}

function startDrag(d) {
  d.active = true;
  d.ghost = d.chip.cloneNode(true);
  d.ghost.classList.add('ghost');
  d.ghost.style.width = `${d.chip.offsetWidth}px`;
  document.body.append(d.ghost);
  d.chip.classList.add('dragging');
  if (state.sheetOpen && isPhone()) {
    // out of the way of the board; only the classes change, the chip stays in the DOM until the drop
    state.sheetOpen = false;
    app.classList.remove('sheet-open');
    const pool = document.querySelector('.pool');
    if (pool) pool.classList.remove('open');
  }
  moveGhost(d, d.x, d.y);
}

function moveGhost(d, x, y) {
  d.ghost.style.transform = `translate(${x - d.ghost.offsetWidth / 2}px, ${y - d.ghost.offsetHeight / 2}px)`;
}

function onPointerDown(e, id) {
  if (!canEdit() || e.button > 0 || drag) return;
  const chip = e.currentTarget;
  drag = { id, chip, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false, touch: e.pointerType === 'touch' };
  // on touch a long press starts the drag (a quick swipe still scrolls the list)
  if (drag.touch) drag.timer = setTimeout(() => drag && !drag.active && startDrag(drag), LONG_PRESS_MS);
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
  if (!drag.active) {
    if (drag.touch) {
      if (moved > DRAG_PX * 2) endDrag(); // moved before the long press: it is a scroll
      return;
    }
    if (moved < DRAG_PX) return;
    startDrag(drag);
  }
  moveGhost(drag, e.clientX, e.clientY);
  document.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
  const hit = targetAt(e.clientX, e.clientY);
  if (hit) hit.el.classList.add('over');
}

function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  if (d.active) {
    const hit = targetAt(e.clientX, e.clientY);
    endDrag();
    if (hit) moveTo(d.id, hit.target);
    else render();
    return;
  }
  endDrag();
  const slot = d.chip.closest('[data-zone="slot"]');
  if (slot) tapSlot(Number(slot.dataset.g), Number(slot.dataset.p), Number(slot.dataset.s));
  else tapPerson(d.id);
}

function onPointerCancel(e) {
  if (drag && e.pointerId === drag.pointerId) endDrag();
}

document.addEventListener('pointermove', onPointerMove);
document.addEventListener('pointerup', onPointerUp);
document.addEventListener('pointercancel', onPointerCancel);
// once a long press started a drag, the page must not scroll under the finger
document.addEventListener('touchmove', (e) => drag && drag.active && e.cancelable && e.preventDefault(), { passive: false });

// ---------- tap fallback ----------
function tapPerson(id) {
  if (!canEdit()) return;
  state.selected = state.selected === id ? null : id;
  if (state.selected && isPhone()) state.sheetOpen = false; // picked: get the sheet out of the way to tap a slot
  render();
}

function tapSlot(g, p, s) {
  if (!canEdit()) return;
  const party = state.layout.groups[g][p];
  if (state.selected) return moveTo(state.selected, { type: 'slot', group: g, party: p, slot: s });
  if (s < party.length) state.selected = party[s];
  return render();
}

function tapPool() {
  if (canEdit() && state.selected && locate(state.layout, state.selected)) moveTo(state.selected, { type: 'pool' });
}

// ---------- views ----------
function chip(m, where) {
  const me = state.data.me.id === m.id;
  const el = h(
    'div',
    {
      class: `chip${state.selected === m.id ? ' selected' : ''}${me ? ' me' : ''}${canEdit() ? ' movable' : ''}`,
      'data-id': m.id,
      onpointerdown: (e) => onPointerDown(e, m.id),
      title: `${m.name}${m.className ? ` — ${m.className}` : ''}`,
    },
    h('span', { class: 'dot', style: `background:${m.classColor}` }),
    h('span', { class: 'nm' }, m.name),
    where === 'pool' ? h('span', { class: 'cls' }, [m.className, m.rolePref].filter(Boolean).join(' · ')) : h('span', { class: 'tag' }, classTag(m.className))
  );
  return el;
}

function poolView() {
  const placed = new Set(idsOf(state.layout));
  const rest = state.data.members.filter((m) => !placed.has(m.id));
  const classes = [...new Set(state.data.members.map((m) => m.className).filter(Boolean))];
  const list = h('div', { class: 'pool-list' });
  // only the list is redrawn while typing, so the search box keeps the focus
  const fill = () => {
    const q = state.search.trim().toLowerCase();
    const shown = rest.filter((m) => (!q || m.name.toLowerCase().includes(q)) && (!state.classFilter || m.className === state.classFilter));
    list.replaceChildren(...(shown.length ? shown.map((m) => chip(m, 'pool')) : [h('p', { class: 'empty' }, rest.length ? 'Không có ai khớp.' : 'Đã xếp hết 🎉')]));
  };
  const search = h('input', { type: 'search', placeholder: 'Tìm tên…', value: state.search, class: 'search', oninput: (e) => { state.search = e.target.value; fill(); } });
  const select = h('select', { class: 'filter', onchange: (e) => { state.classFilter = e.target.value; fill(); } }, h('option', { value: '' }, 'Mọi phái'), classes.map((c) => h('option', { value: c, selected: c === state.classFilter }, c)));
  fill();
  return h('section', { class: `pool${state.sheetOpen ? ' open' : ''}`, 'data-zone': 'pool', onclick: (e) => e.target.closest('.chip') || tapPool() }, h('h2', null, `Chưa xếp (${rest.length})`), h('div', { class: 'tools' }, search, select), list);
}

function partyView(g, p, byId) {
  const ids = state.layout.groups[g][p];
  const warn = partyWarnings(ids, classMap(), state.data.rules);
  const size = state.data.layout.partySize;
  const warns = [warn.missingHealer ? `thiếu ${state.data.rules.healerClass}` : null, warn.missingTank ? `thiếu ${state.data.rules.tankClass}` : null].filter(Boolean);
  const slots = Array.from({ length: size }, (_, s) => {
    const m = ids[s] ? byId.get(ids[s]) : null;
    return h(
      'div',
      { class: `slot${m ? ' filled' : ''}`, 'data-zone': 'slot', 'data-g': g, 'data-p': p, 'data-s': s, onclick: (e) => !e.target.closest('.chip') && tapSlot(g, p, s) },
      m ? chip(m) : h('span', { class: 'ph' }, s + 1)
    );
  });
  return h('div', { class: `party${warns.length ? ' warn' : ''}` }, h('div', { class: 'party-head' }, h('b', null, `PT ${p + 1}`), h('span', { class: 'count' }, `${ids.length}/${size}`), warns.length ? h('span', { class: 'warns' }, `⚠ ${warns.join(', ')}`) : null), h('div', { class: 'slots' }, slots));
}

function boardView() {
  const byId = memberById();
  return h(
    'div',
    { class: 'board' },
    state.layout.groups.map((group, g) => h('section', { class: 'group' }, h('h2', null, `Nhóm ${g + 1}`, h('small', null, ` ${group.flat().length}/${group.length * state.data.layout.partySize}`)), h('div', { class: 'parties' }, group.map((_, p) => partyView(g, p, byId)))))
  );
}

function meView() {
  const at = locate(state.layout, state.data.me.id);
  if (!state.data.members.some((m) => m.id === state.data.me.id)) return h('div', { class: 'me-bar' }, 'Bạn chưa báo danh tham gia bang chiến này.');
  return h('div', { class: 'me-bar' }, at ? `Bạn ở Nhóm ${at.group + 1} – PT ${at.party + 1}` : 'Bạn chưa được xếp vào PT nào.');
}

function legendView() {
  const seen = new Map();
  for (const m of state.data.members) if (m.className && !seen.has(m.className)) seen.set(m.className, m.classColor);
  if (!seen.size) return null;
  return h('div', { class: 'legend' }, [...seen].map(([name, color]) => h('span', { class: 'lg' }, h('span', { class: 'dot', style: `background:${color}` }), `${name} (${classTag(name)})`)));
}

function sheetToggle(waiting) {
  return h('button', { class: 'sheet-toggle', onclick: () => { state.sheetOpen = !state.sheetOpen; render(); } }, `Chưa xếp (${waiting}) ${state.sheetOpen ? '▼' : '▲'}`);
}

function publishView() {
  const pub = state.data.publish || { state: 'none' };
  const when = (d) => (d ? new Date(d).toLocaleString('vi-VN') : '');
  const text =
    pub.state === 'pending'
      ? '⏳ Đang chờ bot đăng…'
      : pub.state === 'published'
        ? `✅ Đã đăng lúc ${when(pub.publishedAt)}${pub.error ? ` (lưu ý: ${pub.error})` : ''}`
        : pub.state === 'error'
          ? `❌ Lỗi: ${pub.error}`
          : '';
  const placed = idsOf(state.layout).length;
  return h(
    'div',
    { class: 'publish' },
    text ? h('span', { class: `pub-state ${pub.state}` }, text) : null,
    canEdit()
      ? h('button', { class: 'primary', disabled: state.busy || state.dirty || state.saving || pub.state === 'pending', onclick: () => { state.confirming = true; render(); } }, '📢 Công bố đội hình')
      : null,
    placed === 0 && canEdit() ? h('small', null, 'Chưa xếp ai') : null
  );
}

function confirmView() {
  const placed = idsOf(state.layout).length;
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog' },
      h('h3', null, 'Công bố đội hình?'),
      h('p', null, `Bot sẽ đăng bảng ${placed} người vào kênh bang chiến (không tag ai) và đóng đăng ký. Mỗi người tự bấm “Xem PT của tôi”.`),
      h('div', { class: 'row' }, h('button', { onclick: () => { state.confirming = false; render(); } }, 'Huỷ'), h('button', { class: 'primary', onclick: publish }, 'Công bố'))
    )
  );
}

async function publish() {
  state.confirming = false;
  state.busy = true;
  render();
  const r = await api(`/api/lineup/${state.warId}/publish`, { method: 'POST', body: '{}' });
  state.busy = false;
  if (r.ok) {
    state.data.publish = r.body.publish;
    flash('Đã gửi yêu cầu, bot sẽ đăng trong ít giây.');
  } else {
    flash(r.body.error || 'Không công bố được.');
  }
  render();
}

function warPicker() {
  if (state.wars.length < 2) return null;
  return h('select', { class: 'war-pick', onchange: async (e) => {
    state.warId = e.target.value;
    await loadLineup().catch((err) => flash(err.message));
    render();
  } }, state.wars.map((w) => h('option', { value: w.id, selected: w.id === state.warId }, w.title)));
}

function render() {
  if (drag && drag.active) return;
  if (!state.data) return;
  const placed = idsOf(state.layout).length;
  const total = state.data.layout.groupCount * state.data.layout.partiesPerGroup * state.data.layout.partySize;
  const waiting = state.data.members.length - placed;
  const scroll = document.querySelector('.pool-list') ? document.querySelector('.pool-list').scrollTop : 0;
  // replaceChildren turns a null argument into the text "null": drop the absent parts first
  const parts = [
    h(
      'header',
      null,
      h('div', { class: 'title' }, h('b', null, state.data.war.title), warPicker()),
      h('div', { class: 'counters' }, h('span', null, `Đã xếp ${placed}/${total}`), h('span', null, `Chưa xếp ${waiting}`), h('span', { class: 'save' }, canEdit() ? state.saveState : 'Chỉ xem')),
      state.notice ? h('div', { class: 'notice' }, state.notice) : null
    ),
    legendView(),
    !canEdit() ? meView() : null,
    h('main', null, boardView(), poolView()),
    h('footer', null, canEdit() ? sheetToggle(waiting) : null, publishView()),
    state.confirming ? confirmView() : null,
  ];
  app.className = `${canEdit() ? 'editing' : 'viewing'}${state.sheetOpen ? ' sheet-open' : ''}`;
  app.replaceChildren(...parts.filter(Boolean));
  const list = document.querySelector('.pool-list');
  if (list) list.scrollTop = scroll;
}

function fatal(text) {
  app.replaceChildren(h('div', { class: 'fatal' }, text));
}

// ---------- boot ----------
async function boot() {
  const config = await (await fetch('/api/config')).json();
  if (!config.clientId) return fatal('Máy chủ chưa cấu hình CLIENT_ID.');
  if (!new URLSearchParams(location.search).has('frame_id')) return fatal('Hãy mở Bảng xếp đội từ trong Discord: vào kênh thoại → Hoạt động (biểu tượng tên lửa) → Tiểu Dao.');
  const sdk = new DiscordSDK(config.clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({ client_id: config.clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify', 'guilds.members.read'] });
  const t = await api('/api/token', { method: 'POST', body: JSON.stringify({ code }) });
  if (!t.ok) return fatal(t.body.error || 'Không đăng nhập được.');
  state.token = t.body.access_token;
  await sdk.commands.authenticate({ access_token: state.token });
  state.guildId = sdk.guildId;
  if (!state.guildId) return fatal('Hãy mở Bảng xếp đội trong một máy chủ (kênh thoại của máy chủ).');
  await loadWars();
  if (!state.wars.length) return fatal('Chưa có bang chiến nào đang mở. Khi bot đăng bang chiến mới, mở lại Bảng xếp đội.');
  state.warId = state.wars[0].id;
  await loadLineup();
  render();
  setInterval(poll, POLL_MS);
}

fatal('Đang kết nối với Discord…');
boot().catch((err) => fatal(`Có lỗi: ${err && err.message ? err.message : err}`));
