// Bảng xếp đội: the Discord Activity client. Bundled by esbuild into activity/public/app.js (npm run activity:build).
// Drag and drop uses POINTER events (mouse, pen and touch alike); tapping a person and then a slot is the fallback.
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { moveInLayout, locate, partyWarnings, idsOf, matesOf } from '../../src/services/lineupRules';
import { autoSplit } from '../../src/services/lineupAuto';
import { dominantColors, classPalette, markTone } from '../../src/services/iconColor';

// Motion tokens: the same values as --dur-* / --ease-* in style.css. One vocabulary for every animation of the board.
const MOTION = { fast: 160, base: 260, slow: 460, flip: 340, cascade: 520, step: 18, out: 'cubic-bezier(.2,.8,.2,1)', spring: 'cubic-bezier(.2,1.5,.4,1)', fall: 'cubic-bezier(.15,.7,.3,1)' };
const POLL_MS = 2000;
const SAVE_DEBOUNCE_MS = 800;
const DRAG_PX = 6;
const LONG_PRESS_MS = 220;

const app = document.getElementById('app');
const state = {
  token: null,
  guildId: null,
  wars: [],
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
  tasks: {}, // working copy: discordId -> task key ('' = none); absent = the member's own wish
  notes: {}, // working copy: 'group-party' -> note
  menu: null, // { id }: the task menu of a placed member
  tasksDialog: false,
  taskDeleting: null,
  taskError: '',
  poolSort: 'order', // 'order' = registration order, 'class'
  noteEditing: null, // 'group-party' whose note is being typed
  enter: false, // the next redraw animates its overlay in
  autoDialog: false,
  addDialog: false, // ➕ Thêm người
  addError: '',
  removedDialog: false, // Đã bỏ (N)
  removeConfirm: null, // member id waiting for the confirm of ✖ Bỏ khỏi danh sách
  pop: null, // the person just dropped: springs into place
  stagger: false, // the next redraw glides the chips in a cascade
  fullPrev: null, // PTs that were 6/6 at the last redraw (null = no baseline yet)
  pubPrev: null,
  meterPrev: {},
  statPrev: {},
  meterJobs: [],
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
  toast(text, /lỗi|không|chưa lưu/i.test(text) ? 'warn' : 'info');
}

// ---------- phone layout ----------
const phone = window.matchMedia('(max-width: 700px)');
const isPhone = () => phone.matches;

// "Thiết Y" -> "TY", "Huyết Hà" -> "HH", one word -> its first two letters ("Toái" -> "TO")
function classTag(name) {
  const known = state.data && state.data.classes && state.data.classes.find((c) => c.name === name);
  if (known && known.tag) return known.tag;
  const words = String(name || '').normalize('NFC').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const tag = words.length > 1 ? words.map((w) => Array.from(w)[0]).join('') : Array.from(words[0]).slice(0, 2).join('');
  return tag.toUpperCase().slice(0, 3);
}

// The class mark: the guild's emoji image when there is one (a broken image turns back into the colour dot), else the colour dot.
function classMark(emojiId, color) {
  const dot = () => h('span', { class: 'dot', style: `background:${color}` });
  if (!emojiId) return dot();
  const img = h('img', { class: 'cls-icon', src: `/api/emoji/${emojiId}`, alt: '', draggable: 'false' });
  img.addEventListener('error', () => img.replaceWith(dot()));
  return img;
}

// ---------- model ----------
const memberById = () => new Map(state.data.members.map((m) => [m.id, m]));
const classMap = () => Object.fromEntries(state.data.members.map((m) => [m.id, m.className]));

// ---------- class colours = the colour of the class icon ----------
const ICON_KEY = 'll-icon-tones-v2';
const SURFACE = '#eee6d2'; // the colour of a slot: marks must hold their contrast on it
const iconTones = new Map(); // emoji id -> ['#rrggbb', ...] the icon's tones, strongest first ([] = tried, none)
const iconPending = new Set();
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(ICON_KEY) || '{}'))) iconTones.set(k, v);
} catch {
  /* no storage: computed again next time */
}
function saveIconTones() {
  try {
    localStorage.setItem(ICON_KEY, JSON.stringify(Object.fromEntries(iconTones)));
  } catch {
    /* private mode / full: keep working from memory */
  }
}

// Class colours = the colours of the class icons. classPalette makes them collision-aware (two icons of one hue: the second takes its
// next tone) and gives each class a fill (tints, glows) and a mark (accent bars, dots: darkened to hold contrast on the paper).
// Cached tones are applied before the first render, so nothing flashes.
function applyIconColors(data) {
  const classes = data.classes || [];
  const pal = classPalette(classes.filter((c) => c.emojiId && (iconTones.get(c.emojiId) || []).length).map((c) => [c.name, iconTones.get(c.emojiId)]), SURFACE);
  const byName = new Map();
  for (const c of classes) {
    if (c.base === undefined) c.base = c.color;
    const hit = pal.get(c.name);
    c.color = hit ? hit.fill : c.base;
    c.mark = hit ? hit.mark : markTone(c.base, SURFACE);
    byName.set(c.name, c);
  }
  for (const m of data.members) {
    const c = byName.get(m.className);
    if (c) {
      m.classColor = c.color;
      m.classMark = c.mark;
    } else {
      m.classMark = markTone(m.classColor, SURFACE);
    }
  }
}

// Tones of the icons not seen before: load the (same-origin) image once, read its pixels, then redraw with the new palette.
function computeIconColors() {
  for (const c of state.data.classes || []) {
    const id = c.emojiId;
    if (!id || iconTones.has(id) || iconPending.has(id)) continue;
    iconPending.add(id);
    const img = new Image();
    img.onload = () => {
      let tones = [];
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 48;
        canvas.height = 48;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 48, 48);
        tones = dominantColors(ctx.getImageData(0, 0, 48, 48).data, 48, 48, 3).map((t) => t.hex);
      } catch {
        tones = []; // a tainted canvas or no canvas: the palette colour stays
      }
      iconPending.delete(id);
      iconTones.set(id, tones);
      saveIconTones();
      if (tones.length && state.data) {
        applyIconColors(state.data);
        render();
      }
    };
    img.onerror = () => iconPending.delete(id);
    img.src = `/api/emoji/${id}`;
  }
}

function adopt(data) {
  applyIconColors(data);
  state.data = data;
  state.layout = data.lineup;
  state.tasks = data.tasks || {};
  state.notes = data.partyNotes || {};
  state.menu = null;
  state.fullPrev = null; // somebody else's edit or a reload: no celebration, just a new baseline
  state.version = data.version;
  state.dirty = false;
  state.selected = null;
}

// -> false when the user is not a Leader (the board is for Leaders only), else true
async function loadWars() {
  const r = await api(`/api/wars?guild=${state.guildId}`);
  if (r.status === 403 && r.body.code === 'not_manager') return false;
  if (!r.ok) throw new Error(r.body.error || 'Không tải được danh sách bang chiến.');
  state.wars = r.body.wars;
  return true;
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
  const sentTasks = state.tasks;
  const sentNotes = state.notes;
  const r = await api(`/api/lineup/${state.warId}`, { method: 'PUT', body: JSON.stringify({ layout: sent, tasks: sentTasks, partyNotes: sentNotes, version: state.version }) });
  state.saving = false;
  if (r.ok) {
    state.version = r.body.version;
    if (state.layout === sent && state.tasks === sentTasks && state.notes === sentNotes) {
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
  state.pop = target.type === 'slot' ? id : null;
  change(moveInLayout(state.layout, id, target, state.data.layout.partySize));
}

// ---------- tasks and notes ----------
const taskByKey = (key) => (state.data.taskList || []).find((t) => t.key === key) || null;
const memberOf = (id) => state.data.members.find((m) => m.id === id) || null;

// The task key of a person: the leader's choice, else their own wish; '' = none.
function taskKeyOf(id) {
  if (Object.prototype.hasOwnProperty.call(state.tasks, id)) return state.tasks[id];
  const m = memberOf(id);
  return (m && m.taskDefault) || '';
}
const taskOf = (id) => taskByKey(taskKeyOf(id));
const taskBadge = (t) => (t ? t.emoji || Array.from(t.label).slice(0, 3).join('') : '');

function setTask(id, key) {
  // a choice equal to the own wish is still stored: it must survive a later change of the wish
  state.tasks = { ...state.tasks, [id]: key };
  state.menu = null;
  markDirty();
  render();
}

function setNote(g, p, text) {
  const next = { ...state.notes };
  if (text.trim()) next[`${g}-${p}`] = text.slice(0, 80);
  else delete next[`${g}-${p}`];
  state.notes = next;
  markDirty(); // no render: the input keeps its focus while typing
}

// ---------- polling ----------
async function poll() {
  if (!state.warId || !state.data || drag || state.dirty || state.saving || state.confirming || state.menu || state.tasksDialog || state.autoDialog || state.addDialog || state.removedDialog || state.removeConfirm) return;
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
  d.ghost.style.transform = `translate(${x - d.ghost.offsetWidth / 2}px, ${y - d.ghost.offsetHeight / 2}px) rotate(-1.5deg) scale(1.04)`;
}

function onPointerDown(e, id) {
  if (e.button > 0 || drag) return;
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
  state.selected = state.selected === id ? null : id;
  if (state.selected && isPhone()) state.sheetOpen = false; // picked: get the sheet out of the way to tap a slot
  render();
}

function tapSlot(g, p, s) {
  const party = state.layout.groups[g][p];
  if (state.selected) return moveTo(state.selected, { type: 'slot', group: g, party: p, slot: s });
  if (s < party.length) {
    state.menu = { id: party[s] };
    state.enter = true;
  }
  return render();
}

function tapPool() {
  if (state.selected && locate(state.layout, state.selected)) moveTo(state.selected, { type: 'pool' });
}

// ---------- views ----------

// Task colours: the four built-ins have their own, a custom task takes one by its key.
const TASK_COLORS = { def: '#5b8def', cong: '#ef5b5b', daytru: '#f0a53a', vattu: '#3fb97a' };
const CUSTOM_COLORS = ['#b36bf2', '#2dc4c4', '#e86bb0', '#a3b83f', '#7d8cff'];
function taskColor(key) {
  if (TASK_COLORS[key]) return TASK_COLORS[key];
  let n = 0;
  for (const ch of String(key)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return CUSTOM_COLORS[n % CUSTOM_COLORS.length];
}
const pill = (t) => h('span', { class: 'pill', style: `--t:${taskColor(t.key)}`, title: t.label }, t.label);
// "Tuyến Khiên với: A, B" for a person who is linked to others (the Tuyến Khiên groups are display only), else ''.
function matesText(id) {
  const names = matesOf(state.data.linkGroups, id).map((x) => (memberOf(x) || { name: x }).name);
  return names.length ? `Tuyến Khiên với: ${names.join(', ')}` : '';
}

// ✖ on a pool row: asks before taking the person off the list.
function removeButton(m) {
  return h('button', { class: 'x', title: 'Bỏ khỏi danh sách', 'aria-label': `Bỏ ${m.name} khỏi danh sách`, onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); askRemove(m.id); } }, '✖');
}

function chip(m, where) {
  const t = taskOf(m.id);
  const mates = matesText(m.id);
  const tail =
    where === 'pool'
      ? [h('span', { class: 'cls' }, [m.className, m.rolePref].filter(Boolean).join(' · ')), removeButton(m)]
      : [m.manual ? h('span', { class: 'manual-mark', title: 'Thêm tay: không có nút Xem PT của tôi' }, 'tay') : null, t ? pill(t) : h('span', { class: 'pill none' }, 'Chưa giao'), h('span', { class: 'tag' }, classTag(m.className))];
  return h(
    'div',
    {
      style: `--c:${m.classColor};--cd:${m.classMark || m.classColor}`,
      class: `chip${state.selected === m.id ? ' selected' : ''} movable${state.pop === m.id ? ' pop' : ''}`,
      'data-id': m.id,
      onpointerdown: (e) => onPointerDown(e, m.id),
      title: [m.name, m.linked ? `Discord: ${m.discordName}` : 'Chưa ghép tên game (đang hiện tên Discord)', m.className, mates ? `🔗 ${mates}` : ''].filter(Boolean).join('\n'),
    },
    classMark(m.classEmoji, m.classMark || m.classColor),
    h('span', { class: `nm${m.linked ? '' : ' unlinked'}` }, m.name),
    mates ? h('span', { class: 'tkmark', 'aria-hidden': 'true' }, '🔗') : null,
    tail
  );
}

function poolView() {
  const placed = new Set(idsOf(state.layout));
  const rest = state.data.members.filter((m) => !placed.has(m.id));
  const order = (state.data.classes || []).map((c) => c.name);
  const classes = [...new Set([...order, ...state.data.members.map((m) => m.className)].filter(Boolean))].filter((c) => rest.some((m) => m.className === c));
  const count = (c) => rest.filter((m) => m.className === c).length;
  const list = h('div', { class: 'pool-list' });
  // only the list is redrawn while typing, so the search box keeps the focus
  const fill = () => {
    const q = state.search.trim().toLowerCase();
    let shown = rest.filter((m) => (!q || m.name.toLowerCase().includes(q) || (m.discordName || '').toLowerCase().includes(q)) && (!state.classFilter || m.className === state.classFilter));
    if (state.poolSort === 'class') shown = shown.map((m, i) => [m, i]).sort((a, b) => classes.indexOf(a[0].className) - classes.indexOf(b[0].className) || a[1] - b[1]).map((x) => x[0]);
    list.replaceChildren(...(shown.length ? shown.map((m) => chip(m, 'pool')) : [h('p', { class: 'empty' }, rest.length ? 'Không có ai khớp.' : 'Đã xếp hết 🎉')]));
  };
  const search = h('input', { type: 'search', placeholder: 'Tìm tên…', value: state.search, class: 'search', oninput: (e) => { state.search = e.target.value; fill(); } });
  const select = h('select', { class: 'filter', onchange: (e) => { state.classFilter = e.target.value; fill(); } }, h('option', { value: '' }, `Mọi phái (${rest.length})`), classes.map((c) => h('option', { value: c, selected: c === state.classFilter }, `${c} (${count(c)})`)));
  const sortOptions = [['order', 'Thứ tự báo danh'], ['class', 'Theo phái']];
  const sort = h('select', { class: 'filter', title: 'Sắp xếp', onchange: (e) => { state.poolSort = e.target.value; fill(); } }, sortOptions.map(([v, label]) => h('option', { value: v, selected: state.poolSort === v }, label)));
  fill();
  return h('section', { class: `pool${state.sheetOpen ? ' open' : ''}`, 'data-zone': 'pool', onclick: (e) => e.target.closest('.chip') || tapPool() }, h('div', { class: 'pool-head' }, h('h2', null, 'Chưa xếp'), h('span', { class: 'badge' }, rest.length)), h('div', { class: 'tools' }, search), h('div', { class: 'tools' }, select, sort), list);
}

function editNote(key) {
  state.noteEditing = key;
  render();
  const el = document.getElementById('note-edit');
  if (el) el.focus();
}

function partyView(g, p, byId) {
  const ids = state.layout.groups[g][p];
  const warn = partyWarnings(ids, classMap(), state.data.rules);
  const warns = [warn.missingHealer ? `thiếu ${state.data.rules.healerClass}` : null, warn.missingTank ? `thiếu ${state.data.rules.tankClass}` : null].filter(Boolean);
  const size = state.data.layout.partySize;
  const key = `${g}-${p}`;
  const slots = Array.from({ length: size }, (_, s) => {
    const m = ids[s] ? byId.get(ids[s]) : null;
    return h(
      'div',
      { class: `slot${m ? ' filled' : ''}`, 'data-zone': 'slot', 'data-g': g, 'data-p': p, 'data-s': s, onclick: (e) => !e.target.closest('.chip') && tapSlot(g, p, s) },
      m ? chip(m) : h('span', { class: 'plus', 'aria-hidden': 'true' }, '+')
    );
  });
  const note = state.notes[key] || '';
  let noteView = null;
  if (state.noteEditing === key) {
    noteView = h('input', {
      id: 'note-edit',
      class: 'note-input',
      maxlength: 80,
      value: note,
      placeholder: 'Ghi chú PT (vd: giữ trụ giữa)',
      oninput: (e) => setNote(g, p, e.target.value),
      onblur: (e) => {
        if (!e.target.isConnected) return; // the board was redrawn under it
        state.noteEditing = null;
        render();
      },
      onkeydown: (e) => (e.key === 'Enter' || e.key === 'Escape') && e.target.blur(),
    });
  } else if (note) {
    noteView = h('div', { class: 'note-quote editable', onclick: () => editNote(key) }, note);
  } else {
    noteView = h('button', { class: 'note-add', onclick: () => editNote(key) }, '✎ Thêm ghi chú');
  }
  const full = ids.length === size;
  return h(
    'div',
    { class: `party${warns.length ? ' warn' : ''}${full ? ' complete' : ''}`, 'data-key': key },
    h(
      'div',
      { class: 'party-head' },
      h('b', null, `PT ${p + 1}`),
      h('span', { class: `count${full ? ' full' : ''}` }, full ? '✓ ' : '', `${ids.length}/${size}`),
      warns.length ? h('span', { class: 'warns' }, `⚠ ${warns.join(' · ')}`) : null
    ),
    noteView,
    h('div', { class: 'slots' }, slots)
  );
}

function boardView() {
  const byId = memberById();
  const size = state.data.layout.partySize;
  return h(
    'div',
    { class: 'board' },
    state.layout.groups.map((group, g) => {
      const total = group.length * size;
      const n = group.flat().length;
      const pct = Math.round((n / total) * 100);
      const fill = h('div', { class: `fill${n === total ? ' full' : ''}`, style: `transform:scaleX(${(state.meterPrev[g] ?? pct) / 100})` });
      state.meterJobs.push({ el: fill, pct });
      state.meterPrev[g] = pct;
      return h(
        'section',
        { class: `group g${g % 2}` },
        h(
          'div',
          { class: 'group-head' },
          h('h2', null, `Nhóm ${g + 1}`),
          h('div', { class: 'meter', 'aria-hidden': 'true' }, fill),
          h('span', { class: 'gcount' }, `${n}/${total}`),

        ),
        h('div', { class: 'parties' }, group.map((_, p) => partyView(g, p, byId)))
      );
    })
  );
}

function legendView() {
  const used = new Set(state.data.members.map((m) => m.className).filter(Boolean));
  const list = (state.data.classes || []).filter((c) => used.has(c.name));
  if (!list.length) return null;
  return h('div', { class: 'legend' }, list.map((c) => h('span', { class: 'lg', style: `--c:${c.color};--cd:${c.mark || c.color}` }, classMark(c.emojiId, c.mark || c.color), h('span', null, c.name), h('span', { class: 'tag' }, c.tag || classTag(c.name)))));
}

function sheetToggle(waiting) {
  return h('button', { class: 'sheet-toggle', onclick: () => { state.sheetOpen = !state.sheetOpen; render(); } }, `Chưa xếp (${waiting}) ${state.sheetOpen ? '▼' : '▲'}`);
}

function publishView() {
  const pub = state.data.publish || { state: 'none' };
  const reopened = state.data.war.status === 'open'; // registration was opened again: no publishing until the bot locks it again
  const when = (d) => (d ? new Date(d).toLocaleString('vi-VN') : '');
  const text =
    pub.state === 'pending'
      ? '⏳ Đang chờ bot đăng…'
      : pub.state === 'published'
        ? `✅ Đã đăng lúc ${when(pub.publishedAt)}${pub.error ? ` (lưu ý: ${pub.error})` : ''}`
        : pub.state === 'error'
          ? `❌ Lỗi: ${pub.error}`
          : '';
  const shown = reopened ? '🔓 Đăng ký đang mở lại — chốt lại rồi mới công bố được' : text;
  const placed = idsOf(state.layout).length;
  return h(
    'div',
    { class: 'publish' },
    shown ? h('span', { class: `pub-state ${reopened ? 'pending' : pub.state}` }, shown) : null,
    h('button', { class: 'primary', disabled: state.busy || state.dirty || state.saving || pub.state === 'pending' || reopened, onclick: () => { state.confirming = true; state.enter = true; render(); } }, '📢 Công bố đội hình'),
    placed === 0 ? h('small', null, 'Chưa xếp ai') : null
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

const taskLabel = (t) => `${t.emoji ? `${t.emoji} ` : ''}${t.label}`;

// Tap on a placed person: choose the task, or move them (the tap-to-move flow).
function menuView() {
  const m = memberOf(state.menu.id);
  if (!m) return null;
  const current = taskKeyOf(m.id);
  return h(
    'div',
    { class: 'overlay bottom', onclick: (e) => { if (e.target === e.currentTarget) { state.menu = null; render(); } } },
    h(
      'div',
      { class: 'dialog menu' },
      matesText(m.id) ? h('div', { class: 'tk-line' }, `🔗 ${matesText(m.id)}`) : null,
      h('h3', null, m.name, h('small', null, ` ${[m.linked ? `Discord: ${m.discordName}` : 'chưa ghép tên game', m.className, m.rolePref ? `muốn: ${m.rolePref}` : ''].filter(Boolean).join(' · ')}`)),
      h(
        'div',
        { class: 'task-grid' },
        state.data.taskList.map((t) => h('button', { class: current === t.key ? 'on' : '', style: `--t:${taskColor(t.key)}`, onclick: () => setTask(m.id, t.key) }, h('i', { class: 'tdot' }), taskLabel(t))),
        h('button', { class: current === '' ? 'on' : '', onclick: () => setTask(m.id, '') }, h('i', { class: 'tdot none' }), 'Chưa giao')
      ),
      h('div', { class: 'row' }, h('button', { class: 'danger', onclick: () => askRemove(m.id) }, '✖ Bỏ khỏi danh sách'), h('button', { onclick: () => { state.selected = m.id; state.menu = null; render(); } }, '↔ Chuyển chỗ'), h('button', { onclick: () => { state.menu = null; render(); } }, 'Đóng'))
    )
  );
}

// "Nhiệm vụ": the leader adds / renames / deletes the guild's own tasks.
async function taskCall(method, path, body) {
  await save();
  const r = await api(path, { method, ...(body ? { body: JSON.stringify({ guild: state.guildId, ...body }) } : {}) });
  if (!r.ok) {
    state.taskError = r.body.error || 'Không lưu được.';
    render();
    return;
  }
  state.taskError = '';
  state.taskDeleting = null;
  state.data.taskList = r.body.taskList;
  if (r.body.affected) await loadLineup().catch(() => {}); // members of a deleted task went back to "Chưa giao"
  state.tasksDialog = true;
  render();
}

function tasksDialogView() {
  const custom = state.data.taskList.filter((t) => !t.builtin);
  const rows = custom.map((t) => {
    const emoji = h('input', { class: 'emo', value: t.emoji, maxlength: 4, placeholder: '🙂' });
    const label = h('input', { class: 'lbl', value: t.label, maxlength: 30 });
    const inUse = Object.values(state.tasks).filter((k) => k === t.key).length;
    if (state.taskDeleting === t.key) {
      return h('div', { class: 'trow confirm' }, h('span', null, `Xoá "${t.label}"? ${inUse ? `${inUse} người đang dùng sẽ về "Chưa giao".` : ''}`), h('button', { class: 'primary', onclick: () => taskCall('DELETE', `/api/tasks/${encodeURIComponent(t.key)}?guild=${state.guildId}`) }, 'Xoá'), h('button', { onclick: () => { state.taskDeleting = null; render(); } }, 'Huỷ'));
    }
    return h('div', { class: 'trow' }, emoji, label, h('button', { onclick: () => taskCall('PUT', `/api/tasks/${encodeURIComponent(t.key)}`, { label: label.value, emoji: emoji.value }) }, 'Lưu'), h('button', { title: 'Xoá', onclick: () => { state.taskDeleting = t.key; render(); } }, '🗑'));
  });
  const newEmoji = h('input', { class: 'emo', maxlength: 4, placeholder: '🙂' });
  const newLabel = h('input', { class: 'lbl', maxlength: 30, placeholder: 'Nhiệm vụ mới (vd: Cướp cờ)' });
  return h(
    'div',
    { class: 'overlay bottom' },
    h(
      'div',
      { class: 'dialog menu' },
      h('h3', null, 'Nhiệm vụ'),
      h('p', { class: 'hint' }, `Có sẵn: ${state.data.taskList.filter((t) => t.builtin).map(taskLabel).join(', ')}. Thêm tối đa 15 nhiệm vụ riêng.`),
      ...rows,
      h('div', { class: 'trow' }, newEmoji, newLabel, h('button', { class: 'primary', onclick: () => taskCall('POST', '/api/tasks', { label: newLabel.value, emoji: newEmoji.value }) }, 'Thêm')),
      state.taskError ? h('div', { class: 'notice' }, state.taskError) : null,
      h('div', { class: 'row' }, h('button', { onclick: () => { state.tasksDialog = false; state.taskDeleting = null; state.taskError = ''; render(); } }, 'Xong'))
    )
  );
}

// "Gợi ý chia đội": one click fills the board by the guild's rules (lineupAuto.js); a re-run gives another layout.
function runAuto(mode) {
  const d = state.data;
  const res = autoSplit({
    members: d.members.map((m) => ({ id: m.id, className: m.className, createdAt: m.createdAt })),
    layout: state.layout,
    shape: d.layout,
    mode,
    rules: d.rules,
  });
  state.autoDialog = false;
  state.stagger = true;
  state.layout = res.layout;
  state.selected = null;
  markDirty();
  render();
  toast(res.unplaced.length ? `Đã xếp ${res.placed.length} người · ${res.unplaced.length} người chưa có chỗ (hết ô)` : `Đã xếp ${res.placed.length} người ✨ — bấm lại để thử cách chia khác`, 'ok');
}

function autoDialogView() {
  const placed = idsOf(state.layout).length;
  const total = state.data.layout.groupCount * state.data.layout.partiesPerGroup * state.data.layout.partySize;
  const left = state.data.members.length - placed;
  return h(
    'div',
    { class: 'overlay bottom' },
    h(
      'div',
      { class: 'dialog menu' },
      h('h3', null, '✨ Gợi ý chia đội'),
      h('p', { class: 'hint' }, 'Ngẫu nhiên, nhưng mỗi PT có ít nhất 1 Tố Vấn và 1 Thiết Y (thiếu thì xếp theo thứ tự từ PT 1 Nhóm 1). Bấm lại để ra cách chia khác. Nhiều người hơn ô: ai báo danh trước được xếp trước.'),
      h(
        'div',
        { class: 'auto-choices' },
        h('button', { class: 'primary', disabled: placed >= total || left === 0, onclick: () => runAuto('fill') }, 'Chỉ điền ô trống', h('small', null, `${Math.min(left, total - placed)} người vào các ô còn trống, giữ nguyên người đã xếp`)),
        h('button', { class: placed ? 'danger' : 'primary', onclick: () => runAuto('all') }, 'Chia lại toàn bộ', h('small', null, placed ? `⚠ ghi đè ${placed} người đã xếp (nhiệm vụ và ghi chú giữ nguyên)` : 'xếp tất cả từ đầu'))
      ),
      h('div', { class: 'row' }, h('button', { onclick: () => { state.autoDialog = false; render(); } }, 'Huỷ'))
    )
  );
}

// ---------- people: add by hand, remove, restore ----------
const ROLE_CHOICES = [['any', 'Tùy lead'], ['def', 'Def'], ['cong', 'Công'], ['daytru', 'Đẩy trụ'], ['vattu', 'Vật tư']];

function askRemove(id) {
  state.menu = null;
  state.removeConfirm = id;
  state.enter = true;
  render();
}

// One call to the people endpoints, then the board is reloaded (the list and the version changed).
async function peopleCall(method, path, body) {
  await save();
  const r = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) {
    state.addError = r.body.error || 'Không thực hiện được.';
    render();
    return false;
  }
  await loadLineup().catch(() => {});
  state.addError = '';
  render();
  return true;
}

function confirmRemoveView() {
  const m = memberOf(state.removeConfirm);
  if (!m) return null;
  return h(
    'div',
    { class: 'overlay bottom' },
    h(
      'div',
      { class: 'dialog menu' },
      h('h3', null, `Bỏ ${m.name} khỏi danh sách?`),
      h('p', null, m.manual ? 'Người này do bạn thêm tay nên sẽ bị xoá hẳn.' : 'Người này sẽ rời khỏi bảng (và khỏi đội hình, nhiệm vụ). Bấm “Đã bỏ” ở trên để khôi phục bất cứ lúc nào.'),
      state.addError ? h('div', { class: 'notice' }, state.addError) : null,
      h('div', { class: 'row' }, h('button', { onclick: () => { state.removeConfirm = null; state.addError = ''; render(); } }, 'Huỷ'), h('button', { class: 'danger', onclick: async () => { const id = state.removeConfirm; if (await peopleCall('DELETE', `/api/lineup/${state.warId}/members/${encodeURIComponent(id)}`)) { state.removeConfirm = null; flash(`Đã bỏ ${m.name}`); render(); } } }, 'Bỏ khỏi danh sách'))
    )
  );
}

function addDialogView() {
  const name = h('input', { class: 'lbl', maxlength: 40, placeholder: 'Tên (trong game)' });
  const cls = h('select', { class: 'filter' }, (state.data.classes || []).filter((c) => c.name).map((c) => h('option', { value: c.name }, c.name)));
  const role = h('select', { class: 'filter' }, ROLE_CHOICES.map(([v, label]) => h('option', { value: v }, `Nguyện vọng: ${label}`)));
  const task = h('select', { class: 'filter' }, h('option', { value: '' }, 'Nhiệm vụ: theo nguyện vọng'), state.data.taskList.map((t) => h('option', { value: t.key }, `Nhiệm vụ: ${t.label}`)));
  const submit = async () => {
    const body = { name: name.value, className: cls.value, rolePref: role.value };
    if (task.value) body.task = task.value;
    if (await peopleCall('POST', `/api/lineup/${state.warId}/members`, body)) {
      state.addDialog = false;
      flash(`Đã thêm ${name.value.trim()}`);
      render();
    }
  };
  return h(
    'div',
    { class: 'overlay bottom' },
    h(
      'div',
      { class: 'dialog menu' },
      h('h3', null, '➕ Thêm người'),
      h('p', { class: 'hint' }, 'Cho người chưa báo danh. Người thêm tay hiện trong ảnh và Google Sheet như mọi người nhưng không có nút “Xem PT của tôi”.'),
      h('div', { class: 'form' }, name, cls, role, task),
      state.addError ? h('div', { class: 'notice' }, state.addError) : null,
      h('div', { class: 'row' }, h('button', { onclick: () => { state.addDialog = false; state.addError = ''; render(); } }, 'Huỷ'), h('button', { class: 'primary', onclick: submit }, 'Thêm'))
    )
  );
}

function removedDialogView() {
  const list = state.data.removedMembers || [];
  return h(
    'div',
    { class: 'overlay bottom' },
    h(
      'div',
      { class: 'dialog menu' },
      h('h3', null, `Đã bỏ (${list.length})`),
      list.length ? null : h('p', { class: 'hint' }, 'Không còn ai trong danh sách đã bỏ.'),
      ...list.map((m) => h('div', { class: 'trow' }, h('span', { class: 'lbl' }, `${m.name} · ${m.className || '—'}`), h('button', { onclick: () => peopleCall('POST', `/api/lineup/${state.warId}/members/${encodeURIComponent(m.id)}/restore`) }, 'Khôi phục'))),
      state.addError ? h('div', { class: 'notice' }, state.addError) : null,
      h('div', { class: 'row' }, h('button', { onclick: () => { state.removedDialog = false; state.addError = ''; render(); } }, 'Xong'))
    )
  );
}

function warPicker() {
  if (state.wars.length < 2) return null;
  return h('select', { class: 'war-pick', onchange: async (e) => {
    state.warId = e.target.value;
    await loadLineup().catch((err) => flash(err.message));
    render();
  } }, state.wars.map((w) => h('option', { value: w.id, selected: w.id === state.warId }, w.title)));
}

const stat = (label, value, tone, key, total) => h('div', { class: `stat${tone ? ` ${tone}` : ''}` }, h('span', { class: 'k' }, label), h('b', { 'data-k': key, 'data-total': total, 'data-v': value }, total ? `${state.statPrev[key] ?? value}/${total}` : state.statPrev[key] ?? value));

// A counter that changed counts from its old value to the new one (a state-change cue; instant under reduced motion).
function tickStats() {
  app.querySelectorAll('.stat b[data-k]').forEach((el) => {
    const key = el.dataset.k;
    const to = Number(el.dataset.v);
    const from = state.statPrev[key] ?? to;
    const total = el.dataset.total;
    const show = (v) => { el.textContent = total ? `${Math.round(v)}/${total}` : String(Math.round(v)); };
    state.statPrev[key] = to;
    if (from === to || reduceMotion.matches) return show(to);
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / MOTION.slow);
      show(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
      else show(to);
    };
    return requestAnimationFrame(step);
  });
}

function whenOf(war) {
  const d = new Date(war.startAt);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ---------- effects (all skipped under prefers-reduced-motion) ----------
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const SPARK_COLORS = ['#b3402f', '#2f7a5c', '#c9902a', '#3f5f9a', '#a2306f', '#2b8f9a', '#d8a83a'];

function fxLayer() {
  let el = document.getElementById('fx');
  if (!el) {
    el = h('div', { id: 'fx', 'aria-hidden': 'true' });
    document.body.append(el);
  }
  return el;
}

// A burst of small pieces from (x, y); `big` = confetti falling from the top of the screen.
function burst(x, y, { count = 18, spread = 70, big = false } = {}) {
  if (reduceMotion.matches) return;
  const layer = fxLayer();
  for (let i = 0; i < count; i++) {
    const piece = h('i', { class: 'spark', style: `background:${SPARK_COLORS[i % SPARK_COLORS.length]};left:${big ? Math.random() * innerWidth : x}px;top:${big ? -12 : y}px` });
    layer.append(piece);
    const angle = Math.random() * Math.PI * 2;
    const dist = spread * (0.5 + Math.random());
    const to = big ? `translate(${(Math.random() - 0.5) * 160}px, ${innerHeight * (0.5 + Math.random() * 0.5)}px) rotate(${Math.random() * 720}deg)` : `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist + 24}px) rotate(${Math.random() * 540}deg)`;
    const anim = piece.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `${to} scale(.6)`, opacity: 0 }], { duration: big ? 1600 + Math.random() * 900 : 700 + Math.random() * 400, easing: MOTION.fall, delay: big ? Math.random() * 300 : 0 });
    anim.onfinish = () => piece.remove();
  }
}

// Toasts live outside the app root, so a redraw never removes them.
function toast(text, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', role: 'status' });
    document.body.append(box);
  }
  const el = h('div', { class: `toast ${kind}` }, text);
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, 3800);
}

// FLIP: the chips that moved glide from where they were; `stagger` = a cascade (after the auto-split).
function captureRects() {
  const rects = new Map();
  app.querySelectorAll('.chip[data-id]').forEach((el) => rects.set(el.dataset.id, el.getBoundingClientRect()));
  return rects;
}

function playFlip(prev, stagger) {
  if (reduceMotion.matches || !prev.size) return;
  let i = 0;
  app.querySelectorAll('.chip[data-id]').forEach((el) => {
    const old = prev.get(el.dataset.id);
    if (!old) return;
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    const delay = stagger ? Math.min(i++ * MOTION.step, 700) : 0;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: stagger ? MOTION.cascade : MOTION.flip, delay, easing: MOTION.out, fill: 'backwards' });
  });
}

function render() {
  if (drag && drag.active) return;
  if (!state.data) return;
  const placed = idsOf(state.layout).length;
  const total = state.data.layout.groupCount * state.data.layout.partiesPerGroup * state.data.layout.partySize;
  const waiting = state.data.members.length - placed;
  const scroll = document.querySelector('.pool-list') ? document.querySelector('.pool-list').scrollTop : 0;
  const active = document.activeElement;
  const keepNote = active && active.id === 'note-edit' ? { start: active.selectionStart, end: active.selectionEnd } : null;
  const prevRects = captureRects();
  const oldOverlay = app.querySelector('.overlay');
  const fresh = state.enter; // overlays animate in only when they were just opened, not on every redraw
  const stagger = state.stagger;
  state.enter = false;
  state.stagger = false;
  const saving = state.dirty || state.saving;
  state.meterJobs = [];
  // replaceChildren turns a null argument into the text "null": drop the absent parts first
  const parts = [
    h(
      'header',
      null,
      h('div', { class: 'hd-title' }, h('h1', null, state.data.war.title), h('div', { class: 'hd-sub' }, whenOf(state.data.war)), warPicker()),
      h(
        'div',
        { class: 'hd-stats' },
        stat('Đã xếp', placed, placed === total ? 'ok' : '', 'placed', total),
        stat('Chưa xếp', waiting, waiting ? 'warn' : 'ok', 'waiting'),
        h('span', { class: `save${saving ? ' pending' : ''}` }, h('i'), saving ? 'Đang lưu…' : state.saveState || 'Đã lưu'),
        h('button', { class: 'magic', onclick: () => { state.autoDialog = true; state.enter = true; render(); } }, '✨ Gợi ý chia đội'),
        h('button', { class: 'small', onclick: () => { state.addDialog = true; state.enter = true; render(); } }, '➕ Thêm người'),
        (state.data.removedMembers || []).length ? h('button', { class: 'small', onclick: () => { state.removedDialog = true; state.enter = true; render(); } }, `Đã bỏ (${state.data.removedMembers.length})`) : null,
        h('button', { class: 'small', onclick: () => { state.tasksDialog = true; state.enter = true; render(); } }, '🎯 Nhiệm vụ')
      )
    ),
    legendView(),
    h('main', null, boardView(), poolView()),
    h('footer', null, sheetToggle(waiting), publishView()),
    state.confirming ? confirmView() : null,
    state.menu ? menuView() : null,
    state.tasksDialog ? tasksDialogView() : null,
    state.autoDialog ? autoDialogView() : null,
    state.addDialog ? addDialogView() : null,
    state.removedDialog ? removedDialogView() : null,
    state.removeConfirm ? confirmRemoveView() : null,
  ];
  app.className = `editing${state.sheetOpen ? ' sheet-open' : ''}`;
  app.replaceChildren(...parts.filter(Boolean));
  if (fresh) app.querySelectorAll('.overlay').forEach((o) => o.classList.add('enter'));
  if (oldOverlay && !app.querySelector('.overlay') && !reduceMotion.matches) {
    oldOverlay.classList.add('leave'); // a dialog that was closed: a short fade / sink instead of vanishing
    document.body.append(oldOverlay);
    setTimeout(() => oldOverlay.remove(), MOTION.fast + 40);
  }
  const list = document.querySelector('.pool-list');
  if (list) list.scrollTop = scroll;
  const note = document.getElementById('note-edit');
  if (keepNote && note) {
    note.focus();
    note.setSelectionRange(keepNote.start, keepNote.end);
  }
  // meters grow from their old width to the new one
  requestAnimationFrame(() => requestAnimationFrame(() => state.meterJobs.forEach((j) => { j.el.style.transform = `scaleX(${j.pct / 100})`; })));
  playFlip(prevRects, stagger);
  tickStats();
  state.pop = null;
  // a PT that just became 6/6 sparkles; a publish that just went through rains confetti
  const fullNow = new Set();
  state.layout.groups.forEach((g, gi) => g.forEach((party, pi) => party.length === state.data.layout.partySize && fullNow.add(`${gi}-${pi}`)));
  if (state.fullPrev) {
    for (const k of fullNow) {
      if (state.fullPrev.has(k)) continue;
      const el = app.querySelector(`.party[data-key="${k}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + 24, { count: 22, spread: 90 });
        el.classList.add('celebrate');
      }
    }
  }
  state.fullPrev = fullNow;
  const pubNow = (state.data.publish || {}).state;
  if (state.pubPrev === 'pending' && pubNow === 'published') burst(0, 0, { count: 70, big: true });
  state.pubPrev = pubNow;
  computeIconColors();
}

// Not a Leader: members get the posted image and "Xem PT của tôi" in the war channel instead.
function leaderOnly() {
  app.replaceChildren(h('div', { class: 'leader-card' }, h('div', { class: 'seal', 'aria-hidden': 'true' }, '令'), h('h1', null, 'Bảng xếp đội chỉ dành cho Leader'), h('p', null, 'Đội hình sẽ được đăng trong kênh bang chiến — bấm 👤 Xem PT của tôi ở đó để biết bạn đứng ở đâu.')));
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
  if (!(await loadWars())) return leaderOnly();
  if (!state.wars.length) return fatal('Chưa có bang chiến nào đang mở. Khi bot đăng bang chiến mới, mở lại Bảng xếp đội.');
  state.warId = state.wars[0].id;
  await loadLineup();
  render();
  setInterval(poll, POLL_MS);
}

fatal('Đang kết nối với Discord…');
boot().catch((err) => fatal(`Có lỗi: ${err && err.message ? err.message : err}`));

// Infinite animations (shimmer, pulses) pause while the tab is hidden.
document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('bg', document.visibilityState === 'hidden'));
