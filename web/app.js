/**
 * LumoX-Viewer GUI client.
 *
 * Subscribes to the server's SSE stream and renders the three panes:
 *   left   — source list   (event: sources, 1 Hz)
 *   center — channel grid  (event: frame, ~30 Hz for the focused source)
 *   right  — history graph of the selected channel + source info
 *
 * Channel history is kept here (per focused source): each incoming frame
 * pushes the selected channel's value into a ring buffer the graph plots.
 */

const HIST = 300; // frames of history retained for the graph

const state = {
  focusKey: null,
  selChannel: 0,           // 0-based index of the channel being graphed
  format: 'dec',
  data: new Uint8Array(0), // latest frame
  meta: {},                // latest frame metadata
  history: new Float32Array(HIST).fill(NaN),
  histCount: 0,
  cells: [],               // cached cell DOM refs (built on slot-count change)
};

// --- DOM refs ------------------------------------------------------------
const el = (id) => document.getElementById(id);
const list = el('source-list'), grid = el('grid'), gridEmpty = el('grid-empty');
const conn = el('conn'), gfx = el('graph'), ctx = gfx.getContext('2d');

// --- SSE -----------------------------------------------------------------
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('open', () => setConn(true));
  es.addEventListener('error', () => setConn(false));
  es.addEventListener('sources', (e) => renderSources(JSON.parse(e.data)));
  es.addEventListener('frame', (e) => onFrame(JSON.parse(e.data)));
}
function setConn(ok) {
  conn.textContent = ok ? 'live' : 'offline';
  conn.className = 'badge ' + (ok ? 'on' : 'off');
}

// --- left: source list ---------------------------------------------------
function renderSources(sources) {
  el('src-count').textContent = sources.length;
  list.innerHTML = '';
  for (const s of sources) {
    const li = document.createElement('li');
    if (s.key === state.focusKey) li.className = 'active';
    const live = s.fps > 0 ? 'live' : '';
    li.innerHTML = `
      <div class="row1">
        <span class="tag ${s.proto}">${s.proto === 'artnet' ? 'ART' : 'sACN'}</span>
        <span class="uni">U${s.universe}</span>
        <span class="name">${esc(s.sourceName || '')}</span>
      </div>
      <div class="row2">
        <span>${s.ip}</span>
        <span class="fps ${live}">${s.hz ? s.hz.toFixed(1) : '0'} Hz</span>
        <span>${s.dropped ? '⚠ ' + s.dropped : ''}</span>
      </div>`;
    li.onclick = () => focus(s.key, s);
    list.appendChild(li);
  }
  // refresh info pane scalars from the list too (covers <1 frame/s sources)
  const cur = sources.find((s) => s.key === state.focusKey);
  if (cur) updateInfo(cur);
}

function focus(key, meta) {
  state.focusKey = key;
  state.meta = meta || {};
  state.history.fill(NaN);
  state.histCount = 0;
  state.cells = [];
  grid.innerHTML = '';
  fetch('/focus?key=' + encodeURIComponent(key)).catch(() => {});
  // mark active immediately
  [...list.children].forEach((li) => li.classList.remove('active'));
  el('grid-title').textContent = meta ? `CHANNELS · U${meta.universe}` : 'CHANNELS';
}

// --- center: channel grid ------------------------------------------------
function onFrame(f) {
  if (f.key !== state.focusKey) return;
  state.data = b64ToBytes(f.data);
  state.meta = { ...state.meta, ...f };
  ensureGrid(state.data.length);
  paintGrid();
  pushHistory(state.data[state.selChannel] ?? 0);
  drawGraph();
  updateInfo(f);
}

function ensureGrid(n) {
  if (state.cells.length === n) return;
  grid.innerHTML = '';
  gridEmpty.style.display = n ? 'none' : 'block';
  state.cells = [];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'cell';
    c.innerHTML = `<div class="bar"></div><div class="n">${i + 1}</div><div class="v">0</div>`;
    c.onclick = () => selectChannel(i);
    grid.appendChild(c);
    state.cells.push(c);
  }
  highlightSel();
}

function paintGrid() {
  const d = state.data;
  for (let i = 0; i < state.cells.length; i++) {
    const v = d[i] || 0;
    const c = state.cells[i];
    c.querySelector('.v').textContent = fmt(v);
    c.querySelector('.bar').style.height = (v / 255 * 100).toFixed(0) + '%';
    c.classList.toggle('zero', v === 0);
    c.classList.toggle('full', v === 255);
  }
}

function selectChannel(i) {
  state.selChannel = i;
  state.history.fill(NaN);
  state.histCount = 0;
  highlightSel();
  el('ch-label').textContent = (i + 1);
}
function highlightSel() {
  state.cells.forEach((c, i) => c.classList.toggle('sel', i === state.selChannel));
}

// --- right: graph --------------------------------------------------------
function pushHistory(v) {
  state.history.copyWithin(0, 1);
  state.history[HIST - 1] = v;
  state.histCount = Math.min(HIST, state.histCount + 1);
  el('hist-len').textContent = state.histCount;
}

function drawGraph() {
  const w = gfx.width, h = gfx.height;
  ctx.clearRect(0, 0, w, h);
  // gridlines at 0/64/128/192/255
  ctx.strokeStyle = '#282c34'; ctx.lineWidth = 1; ctx.font = '9px monospace';
  ctx.fillStyle = '#7c828d';
  for (const lvl of [0, 64, 128, 192, 255]) {
    const y = h - (lvl / 255) * (h - 2) - 1;
    ctx.beginPath(); ctx.moveTo(22, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText(String(lvl).padStart(3), 0, y + 3);
  }
  // trace
  ctx.strokeStyle = '#e5c07b'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < HIST; i++) {
    const v = state.history[i];
    if (Number.isNaN(v)) continue;
    const x = 22 + (i / (HIST - 1)) * (w - 22);
    const y = h - (v / 255) * (h - 2) - 1;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// --- right: info ---------------------------------------------------------
function updateInfo(m) {
  const set = (id, v) => { el(id).textContent = v ?? '—'; };
  if (m.proto) set('i-proto', m.proto.toUpperCase());
  if (m.universe != null) set('i-univ', m.universe);
  if ('sourceName' in m) set('i-name', m.sourceName || '—');
  if (m.ip) set('i-ip', m.ip);
  set('i-hz', m.hz != null ? m.hz.toFixed(1) + ' Hz' : '—');
  set('i-prio', m.priority ?? '—');
  if ('sequence' in m) set('i-seq', m.sequence);
  set('i-pkts', m.packets);
  set('i-drop', m.dropped);
  if (state.data.length) set('i-active', state.data.reduce((n, v) => n + (v > 0), 0));
}

// --- format / util -------------------------------------------------------
function fmt(v) {
  if (state.format === 'hex') return v.toString(16).padStart(2, '0').toUpperCase();
  if (state.format === 'pct') return Math.round(v / 255 * 100);
  return v;
}
document.getElementById('fmt-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.format = b.dataset.fmt;
  [...e.currentTarget.children].forEach((x) => x.classList.toggle('active', x === b));
  paintGrid();
});

function b64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

connect();
