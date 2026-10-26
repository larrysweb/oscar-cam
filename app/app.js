// Oscar Cam 0.1.3 — LAN-only camera grid for webOS TV.
// Playback: go2rtc / WebRTC tiles use VideoRTC (AlexxIT, go2rtc project,
// MIT) bundled as video-rtc.js. HLS tiles use hls.js. MJPEG tiles use <img>.
// State lives in localStorage under LS_KEY. The exported JSON format is a
// portable backup of the whole configuration.
import { VideoRTC } from './video-rtc.js';
customElements.define('video-rtc', VideoRTC);

const LS_KEY = 'oscarcam-v1';
const $ = (id) => document.getElementById(id);
const uid = () => 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let state = loadState();
let currentView = 'grid';
let draftLayout = null;      // layout being edited (deep copy)
let moveCell = null;         // cell being moved with the remote in the editor
let moveSnapshot = null;     // cell geometry before the move (for cancel)
let resizeMode = false;
let focusZone = 'tiles';     // 'tiles' | 'header'
let focusIndex = 0;          // index into visible tiles (grid view) or editor tiles
let headerFocus = 0;
let fsCam = null;            // camera shown fullscreen
let fsMuted = true;
let tileTimers = new Map();  // tile key -> [timer ids] for mjpeg retry
let hlsInstances = new Map(); // tile key -> Hls instance

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.cameras) && Array.isArray(parsed.layouts)) {
        if (!parsed.settings) parsed.settings = { go2rtcBase: '' };
        if (!parsed.settings.burnin) parsed.settings.burnin = { hideUi: true, orbit: true, dim: true };
        if (parsed.settings.camUser === undefined) parsed.settings.camUser = '';
        if (parsed.settings.camPass === undefined) parsed.settings.camPass = '';
        if (parsed.settings.ptzBase === undefined) parsed.settings.ptzBase = '';
        return parsed;
      }
    }
  } catch (e) { /* fall through to default */ }
  return { settings: { go2rtcBase: '', ptzBase: '', burnin: { hideUi: true, orbit: true, dim: true }, camUser: '', camPass: '' }, cameras: [], layouts: [], activeLayoutId: null };
}

function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* storage full/blocked */ }
}

function activeLayout() {
  return state.layouts.find((l) => l.id === state.activeLayoutId) || state.layouts[0] || null;
}

// Return the active layout, creating the automatic "All" layout first when
// none exists yet (so Edit layout and the grid never dead-end on first run).
function ensureLayout() {
  let layout = activeLayout();
  if (layout) return layout;
  const cols = 3;
  layout = {
    id: uid(), name: 'All', cols,
    rows: Math.max(1, Math.ceil(state.cameras.length / cols)),
    cells: state.cameras.map((cam, i) => ({ cameraId: cam.id, x: i % cols, y: Math.floor(i / cols), w: 1, h: 1 })),
  };
  state.layouts.push(layout);
  state.activeLayoutId = layout.id;
  saveState();
  refreshLayoutSelect();
  return layout;
}

function camById(id) { return state.cameras.find((c) => c.id === id) || null; }

function go2rtcBase() { return (state.settings.go2rtcBase || '').replace(/\/+$/, ''); }

// Strip embedded credentials from a URL before showing it on screen
// (camera list, diagnostics). The stored value keeps them; only the
// displayed copy is masked.
function maskCreds(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '…';
      u.password = '';
      return u.toString();
    }
  } catch (e) { /* not an absolute URL; fall through */ }
  return url.replace(/:\/\/[^/@\s]+@/, '://…@');
}
function withCreds(url, cam) {
  if (!cam.username || !url) return url;
  try {
    const u = new URL(url);
    if (!u.username) {
      u.username = encodeURIComponent(cam.username);
      if (cam.password) u.password = encodeURIComponent(cam.password);
      return u.toString();
    }
  } catch (e) { /* not an absolute URL; return as-is */ }
  return url;
}

function showView(name) {
  currentView = name;
  for (const v of ['grid', 'editor', 'cameras', 'settings']) {
    $('view-' + v).classList.toggle('hidden', v !== name);
  }
  if (name === 'grid') renderGridView();
  if (name === 'cameras') { renderCameraList(); $('d-user').value = state.settings.camUser || ''; $('d-pass').value = state.settings.camPass || ''; }
  if (name === 'settings') { refreshExport(); refreshDiagnostics(); refreshBurninSettings(); }
  if (name === 'grid') resetIdle();
  else clearIdle();
}

// ---- Burn-in protection (OLED) ----
// Active on the grid view and fullscreen only: hide the app's own chrome
// after 10s idle, shift the grid a few pixels every 5 minutes (pixel
// orbit — this also moves the cameras' on-screen timestamps, which are
// burned into the streams), dim after 15 minutes idle, blank after 30.
// Any remote key or pointer activity resets everything.
const ORBIT_OFFSETS = [[0, 0], [4, 0], [4, 4], [0, 4], [-4, 0], [-4, -4], [0, -4]];
let idleHideTimer = null;
let idleDimTimer = null;
let idleBlankTimer = null;
let orbitTimer = null;
let orbitStep = 0;

function burnin() { return state.settings.burnin || { hideUi: true, orbit: true, dim: true }; }

function clearIdle() {
  for (const t of [idleHideTimer, idleDimTimer, idleBlankTimer]) if (t) clearTimeout(t);
  if (orbitTimer) { clearInterval(orbitTimer); orbitTimer = null; }
  idleHideTimer = idleDimTimer = idleBlankTimer = null;
  orbitStep = 0;
  document.body.classList.remove('ui-hidden');
  const dimmer = $('burnin-dimmer');
  if (dimmer) dimmer.classList.remove('dim', 'blank');
  const grid = $('grid');
  if (grid) grid.style.transform = '';
}

function resetIdle() {
  clearIdle();
  const fullscreenOpen = $('fullscreen') && !$('fullscreen').classList.contains('hidden');
  if (currentView !== 'grid' && !fullscreenOpen) return;
  const b = burnin();
  if (b.hideUi) {
    idleHideTimer = setTimeout(() => document.body.classList.add('ui-hidden'), 10000);
  }
  if (b.dim) {
    idleDimTimer = setTimeout(() => { const d = $('burnin-dimmer'); if (d) d.classList.add('dim'); }, 15 * 60 * 1000);
    idleBlankTimer = setTimeout(() => { const d = $('burnin-dimmer'); if (d) d.classList.add('blank'); }, 30 * 60 * 1000);
  }
  if (b.orbit && currentView === 'grid') {
    orbitTimer = setInterval(() => {
      orbitStep = (orbitStep + 1) % ORBIT_OFFSETS.length;
      const off = ORBIT_OFFSETS[orbitStep];
      const grid = $('grid');
      if (grid) grid.style.transform = 'translate(' + off[0] + 'px,' + off[1] + 'px)';
    }, 5 * 60 * 1000);
  }
}

['keydown', 'pointerdown', 'mousemove'].forEach((ev) =>
  document.addEventListener(ev, () => {
    const fullscreenOpen = $('fullscreen') && !$('fullscreen').classList.contains('hidden');
    if (currentView === 'grid' || fullscreenOpen) resetIdle();
  }, true));

function setTileStatus(tileEl, text) {
  const st = tileEl.querySelector('.status');
  if (!st) return;
  if (!text) { st.classList.add('ok'); st.textContent = ''; }
  else { st.classList.remove('ok'); st.textContent = text; }
}

function clearTileTimers(key) {
  const timers = tileTimers.get(key) || [];
  for (const t of timers) clearTimeout(t);
  tileTimers.delete(key);
  const h = hlsInstances.get(key);
  if (h) { try { h.destroy(); } catch (e) { /* ignore */ } hlsInstances.delete(key); }
}

function destroyAllPlayers() {
  for (const key of Array.from(tileTimers.keys())) clearTileTimers(key);
  document.querySelectorAll('#grid .tile .player-slot, #editor-grid .tile .player-slot')
    .forEach((slot) => { slot.innerHTML = ''; });
}

// Build the playable element for a camera. forFullscreen picks the
// camera's fullscreen stream when one is set.
function createPlayer(cam, forFullscreen, tileEl, tileKey) {
  const streamName = (forFullscreen && cam.mainStream) ? cam.mainStream : cam.stream;
  const wrap = document.createElement('div');
  wrap.className = 'player-slot';
  wrap.style.cssText = 'width:100%;height:100%;';

  if (cam.type === 'go2rtc' || cam.type === 'webrtc') {
    const el = document.createElement('video-rtc');
    el.style.cssText = 'width:100%;height:100%;display:block;';
    if (cam.type === 'go2rtc') {
      const base = go2rtcBase();
      el.src = base + '/api/ws?src=' + encodeURIComponent(streamName || '');
    } else {
      el.src = cam.url || '';
    }
    wrap.appendChild(el);
    // Mute grid tiles; fullscreen starts muted too (button unmutes).
    setTimeout(() => { if (el.video) el.video.muted = true; }, 0);
    setTimeout(() => {
      if (!el.video) return;
      el.video.addEventListener('playing', () => setTileStatus(tileEl, null));
      el.video.addEventListener('error', () => setTileStatus(tileEl, 'Offline — retrying'));
    }, 300);
    return wrap;
  }

  if (cam.type === 'mjpeg') {
    const img = document.createElement('img');
    img.alt = cam.name;
    let delay = 3000;
    const load = () => {
      clearTileTimers(tileKey);
      img.src = withCreds(cam.url || '', cam);
    };
    img.addEventListener('load', () => { setTileStatus(tileEl, null); delay = 3000; });
    img.addEventListener('error', () => {
      setTileStatus(tileEl, 'Offline — retrying');
      const t = setTimeout(load, delay);
      delay = Math.min(delay * 2, 30000);
      tileTimers.set(tileKey, [t]);
    });
    wrap.appendChild(img);
    load();
    return wrap;
  }

  // hls
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  wrap.appendChild(video);
  const url = withCreds(cam.url || '', cam);
  video.addEventListener('playing', () => setTileStatus(tileEl, null));
  video.addEventListener('error', () => setTileStatus(tileEl, 'Offline — retrying'));
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ maxBufferLength: 10 });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      setTileStatus(tileEl, 'Offline — retrying');
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        const t = setTimeout(() => { try { hls.startLoad(); } catch (e) { /* ignore */ } }, 3000);
        tileTimers.set(tileKey, [t]);
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch (e) { /* ignore */ }
      }
    });
    hlsInstances.set(tileKey, hls);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
  } else {
    setTileStatus(tileEl, 'HLS not supported here');
  }
  video.play().catch(() => { /* autoplay rules; muted play usually passes */ });
  return wrap;
}

function makeTile(cam, cell, opts) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.tabIndex = 0;
  tile.dataset.cameraId = cam.id;
  tile.style.gridColumn = (cell.x + 1) + ' / span ' + cell.w;
  tile.style.gridRow = (cell.y + 1) + ' / span ' + cell.h;
  const status = document.createElement('div');
  status.className = 'status';
  status.textContent = 'Loading…';
  tile.appendChild(status);
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = cam.name;
  tile.appendChild(label);
  if (opts && opts.editable) {
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.title = 'Drag to resize';
    tile.appendChild(handle);
  }
  return tile;
}

function renderGridInto(container, layout, opts) {
  destroyAllPlayers();
  container.innerHTML = '';
  container.style.gridTemplateColumns = 'repeat(' + layout.cols + ', 1fr)';
  container.style.gridTemplateRows = 'repeat(' + layout.rows + ', 1fr)';
  const tiles = [];
  for (const cell of layout.cells) {
    const cam = camById(cell.cameraId);
    if (!cam) continue;
    const tile = makeTile(cam, cell, opts);
    container.appendChild(tile);
    const key = (opts && opts.prefix ? opts.prefix : 'g') + ':' + cam.id;
    const player = createPlayer(cam, false, tile, key);
    tile.insertBefore(player, tile.querySelector('.label'));
    tiles.push({ tile, cell, cam });
  }
  return tiles;
}

function renderGridView() {
  const layout = activeLayout();
  const empty = $('grid-empty');
  const grid = $('grid');
  if (!layout || layout.cells.length === 0) {
    empty.classList.remove('hidden');
    grid.innerHTML = '';
    destroyAllPlayers();
    return;
  }
  empty.classList.add('hidden');
  const tiles = renderGridInto(grid, layout, { prefix: 'g' });
  tiles.forEach(({ tile }, i) => {
    tile.addEventListener('click', () => openFullscreen(tiles[i].cam));
  });
  focusZone = 'tiles';
  focusIndex = Math.min(focusIndex, tiles.length - 1);
  if (focusIndex < 0) focusIndex = 0;
  const focusable = grid.querySelectorAll('.tile');
  if (focusable[focusIndex]) focusable[focusIndex].focus();
  refreshLayoutSelect();
}

function refreshLayoutSelect() {
  const sel = $('layout-select');
  sel.innerHTML = '';
  state.layouts.forEach((l) => {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.name;
    if (l.id === state.activeLayoutId) o.selected = true;
    sel.appendChild(o);
  });
}

// ---- Fullscreen ----
function openFullscreen(cam) {
  fsCam = cam;
  fsMuted = true;
  destroyAllPlayers();
  const bar = $('fs-name');
  bar.textContent = cam.name;
  const slot = $('fs-player');
  slot.innerHTML = '';
  const tileEl = document.createElement('div');
  tileEl.className = 'tile';
  tileEl.style.cssText = 'width:100%;height:100%;border:none;';
  const player = createPlayer(cam, true, tileEl, 'fs');
  tileEl.appendChild(player);
  slot.appendChild(tileEl);
  const muteBtn = $('btn-fs-mute');
  const isImg = cam.type === 'mjpeg';
  muteBtn.classList.toggle('hidden', isImg);
  muteBtn.textContent = 'Unmute';
  $('btn-fs-ptz').classList.toggle('hidden', cam.type !== 'go2rtc');
  setPtzMode(false);
  $('fullscreen').classList.remove('hidden');
  $('btn-fs-back').focus();
  resetIdle();
}

function closeFullscreen() {
  fsCam = null;
  setPtzMode(false);
  clearTileTimers('fs');
  $('fs-player').innerHTML = '';
  $('fullscreen').classList.add('hidden');
  renderGridView();
}

function toggleFsMute() {
  const video = $('fs-player').querySelector('video');
  if (!video) return;
  fsMuted = !fsMuted;
  video.muted = fsMuted;
  $('btn-fs-mute').textContent = fsMuted ? 'Unmute' : 'Mute';
}

// ---- PTZ (through the NAS-side proxy) ----
// The TV cannot call the cameras' ONVIF services directly (no CORS), so
// fullscreen PTZ mode sends small JSON actions to the proxy on the NAS,
// which issues the ONVIF RelativeMove / GotoHomePosition calls with the
// camera logins held server-side. Steps are bounded RelativeMoves, so a
// lost message can never send a camera spinning.
let ptzMode = false;
let ptzBusy = false;

// Proxy URL: explicit setting, else the go2rtc host on port 1985.
function ptzBase() {
  if (state.settings.ptzBase) return state.settings.ptzBase.replace(/\/+$/, '');
  const base = go2rtcBase();
  if (!base) return '';
  try {
    const u = new URL(base);
    u.port = '1985';
    return u.toString().replace(/\/+$/, '');
  } catch (e) { return ''; }
}

// Proxy camera key: the stream-name prefix (cam1_front_street_sub -> cam1).
function ptzKeyFor(cam) {
  const s = (cam.stream || '').toLowerCase();
  return s.split('_')[0].split('-')[0] || '';
}

function ptzStatus(text) {
  const el = $('fs-ptz-status');
  if (el) el.textContent = text;
}

function setPtzMode(on) {
  ptzMode = !!on;
  $('fs-ptz').classList.toggle('hidden', !ptzMode);
  $('btn-fs-ptz').textContent = ptzMode ? 'PTZ: on' : 'PTZ';
  if (ptzMode) ptzStatus('Arrows step the camera. Zoom and Home are below.');
}

async function sendPtz(action) {
  if (ptzBusy) return;
  const base = ptzBase();
  if (!base) { ptzStatus('PTZ proxy URL not set — check Settings.'); return; }
  if (!fsCam) return;
  ptzBusy = true;
  ptzStatus('Moving…');
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(base + '/ptz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera: ptzKeyFor(fsCam), action }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON error */ }
    if (res.ok && data.ok) ptzStatus('OK — ' + action);
    else ptzStatus('Failed: ' + (data.error || ('HTTP ' + res.status)));
  } catch (e) {
    ptzStatus('Failed: ' + (e && e.message ? e.message : e));
  }
  ptzBusy = false;
}

// ---- Layout editor ----
function openEditor() {
  const layout = ensureLayout();
  draftLayout = JSON.parse(JSON.stringify(layout));
  moveCell = null;
  resizeMode = false;
  $('ed-name').value = draftLayout.name;
  $('btn-ed-resize').textContent = 'Resize: off';
  renderEditor();
  showView('editor');
}

function renderEditor() {
  $('ed-cols-val').textContent = draftLayout.cols;
  $('ed-rows-val').textContent = draftLayout.rows;
  $('btn-ed-delete').disabled = state.layouts.length <= 1;
  const container = $('editor-grid');
  const tiles = renderGridInto(container, draftLayout, { prefix: 'e', editable: true });
  tiles.forEach(({ tile, cell }, i) => {
    tile.addEventListener('pointerdown', (ev) => editorPointerDown(ev, cell, tile));
    tile.addEventListener('click', () => { focusIndex = i; tile.focus(); });
  });
  const focusable = container.querySelectorAll('.tile');
  if (focusable[focusIndex]) focusable[focusIndex].focus();
  else if (focusable[0]) focusable[0].focus();
}

function editorPointerDown(ev, cell, tile) {
  const container = $('editor-grid');
  const rect = container.getBoundingClientRect();
  const cellW = rect.width / draftLayout.cols;
  const cellH = rect.height / draftLayout.rows;
  const isResize = ev.target && ev.target.closest && ev.target.closest('.resize-handle');
  const drag = { cell, startCell: { ...cell }, isResize };
  const onMove = (mev) => {
    const px = mev.clientX - rect.left;
    const py = mev.clientY - rect.top;
    if (drag.isResize) {
      const nx = Math.floor(px / cellW);
      const ny = Math.floor(py / cellH);
      cell.w = Math.max(1, Math.min(draftLayout.cols - cell.x, nx - cell.x + 1));
      cell.h = Math.max(1, Math.min(draftLayout.rows - cell.y, ny - cell.y + 1));
    } else {
      cell.x = Math.max(0, Math.min(draftLayout.cols - cell.w, Math.floor(px / cellW)));
      cell.y = Math.max(0, Math.min(draftLayout.rows - cell.h, Math.floor(py / cellH)));
    }
    tile.style.gridColumn = (cell.x + 1) + ' / span ' + cell.w;
    tile.style.gridRow = (cell.y + 1) + ' / span ' + cell.h;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function cellCovers(cell, x, y) {
  return x >= cell.x && x < cell.x + cell.w && y >= cell.y && y < cell.y + cell.h;
}

function findFreeSpot(layout) {
  for (let y = 0; y < layout.rows; y++) {
    for (let x = 0; x < layout.cols; x++) {
      if (!layout.cells.some((c) => cellCovers(c, x, y))) return { x, y };
    }
  }
  return null;
}

function applyPreset(cols) {
  draftLayout.cols = cols;
  draftLayout.rows = Math.max(1, Math.ceil(state.cameras.length / cols));
  draftLayout.cells = state.cameras.slice(0, cols * draftLayout.rows).map((cam, i) => ({
    cameraId: cam.id, x: i % cols, y: Math.floor(i / cols), w: 1, h: 1,
  }));
  renderEditor();
}

function saveEditor() {
  const name = $('ed-name').value.trim();
  if (!name) return;
  draftLayout.name = name;
  const idx = state.layouts.findIndex((l) => l.id === draftLayout.id);
  if (idx >= 0) state.layouts[idx] = draftLayout;
  else state.layouts.push(draftLayout);
  state.activeLayoutId = draftLayout.id;
  draftLayout = null;
  saveState();
  showView('grid');
}

// ---- Cameras view ----
let editingCamId = null;

function renderCameraList() {
  const list = $('camera-list');
  list.innerHTML = '';
  if (state.cameras.length === 0) {
    list.innerHTML = '<p>No cameras yet. Add one below.</p>';
  }
  state.cameras.forEach((cam) => {
    const row = document.createElement('div');
    row.className = 'cam-row';
    const label = document.createElement('span');
    label.textContent = cam.name + '  (' + cam.type + (cam.type === 'go2rtc' ? ': ' + maskCreds(cam.stream) : ': ' + maskCreds(cam.url)) + ')';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openCamForm(cam));
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      state.cameras = state.cameras.filter((c) => c.id !== cam.id);
      for (const l of state.layouts) l.cells = l.cells.filter((c) => c.cameraId !== cam.id);
      saveState();
      renderCameraList();
    });
    row.appendChild(label);
    row.appendChild(edit);
    row.appendChild(del);
    list.appendChild(row);
  });
  openCamForm(null);
}

function toggleCamFormRows() {
  const type = $('f-type').value;
  $('row-stream').classList.toggle('hidden', type !== 'go2rtc');
  $('row-mainstream').classList.toggle('hidden', type !== 'go2rtc');
  $('row-url').classList.toggle('hidden', type === 'go2rtc');
  $('row-user').classList.toggle('hidden', !(type === 'mjpeg' || type === 'hls'));
  $('row-pass').classList.toggle('hidden', !(type === 'mjpeg' || type === 'hls'));
}

function openCamForm(cam) {
  editingCamId = cam ? cam.id : null;
  $('cam-form-title').textContent = cam ? 'Edit camera' : 'Add camera';
  $('f-name').value = cam ? cam.name : '';
  $('f-type').value = cam ? cam.type : 'go2rtc';
  $('f-stream').value = cam ? (cam.stream || '') : '';
  $('f-mainstream').value = cam ? (cam.mainStream || '') : '';
  $('f-url').value = cam ? (cam.url || '') : '';
  $('f-user').value = cam ? (cam.username || '') : '';
  $('f-pass').value = cam ? (cam.password || '') : '';
  $('cam-form-error').classList.add('hidden');
  toggleCamFormRows();
}

// ---- ONVIF discovery (through go2rtc) ----
// The TV app cannot send UDP multicast itself, but go2rtc can: GET
// /api/onvif runs the scan server-side and returns the cameras it found.
// Adding one fetches its profiles the same way, then stores the chosen
// profile's stream URL as a go2rtc camera (go2rtc resolves arbitrary
// source URLs on demand, so no config-file edit is needed).
let discoveredDevices = [];
let pendingDevice = null;

function discoverMsg(text, isError) {
  const el = $('discover-msg');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
  el.classList.toggle('error', !!isError);
}

function onvifUrlWithCreds(deviceUrl, user, pass) {
  try {
    const u = new URL(deviceUrl);
    if (user) u.username = user;
    if (pass) u.password = pass;
    return u.toString();
  } catch (e) { return deviceUrl; }
}

function renderDiscoverList() {
  const list = $('discover-list');
  list.innerHTML = '';
  discoveredDevices.forEach((dev) => {
    const row = document.createElement('div');
    row.className = 'cam-row';
    const label = document.createElement('span');
    label.textContent = (dev.info || 'Camera') + ' (' + dev.name + ')';
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add';
    add.addEventListener('click', () => startDiscoverAdd(dev));
    row.appendChild(label);
    row.appendChild(add);
    list.appendChild(row);
  });
}

async function runDiscovery() {
  const base = go2rtcBase();
  if (!base) { discoverMsg('Set the go2rtc server URL in Settings first.', true); return; }
  discoverMsg('Scanning… (this takes a few seconds)');
  $('discover-list').innerHTML = '';
  $('discover-add').classList.add('hidden');
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    const res = await fetch(base + '/api/onvif', { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const seen = new Set();
    discoveredDevices = (data.sources || []).filter((d) => {
      if (!d.url || seen.has(d.url)) return false;
      seen.add(d.url);
      return true;
    });
    if (discoveredDevices.length === 0) discoverMsg('No ONVIF cameras found on this network.');
    else discoverMsg('Found ' + discoveredDevices.length + ' camera(s). Tap Add, then pick a stream.');
    renderDiscoverList();
  } catch (e) {
    discoverMsg('Discovery failed: ' + (e && e.message ? e.message : e), true);
  }
}

async function startDiscoverAdd(dev) {
  const base = go2rtcBase();
  const user = $('d-user').value.trim();
  const pass = $('d-pass').value;
  pendingDevice = dev;
  discoverMsg('Reading profiles for ' + (dev.info || dev.name) + '…');
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const src = onvifUrlWithCreds(dev.url, user, pass);
    const res = await fetch(base + '/api/onvif?src=' + encodeURIComponent(src), { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const profiles = (data.sources || []).filter((s) => s.url && !/snapshot$/i.test(s.name || ''));
    if (profiles.length === 0) throw new Error('no video profiles returned');
    pendingDevice.profiles = profiles;
    const host = dev.name || '';
    const lastOctet = (host.split(':')[0].split('.').pop() || '');
    $('da-name').value = (dev.info || 'Camera') + (lastOctet ? ' ' + lastOctet : '');
    const gridSel = $('da-grid');
    const fsSel = $('da-fs');
    gridSel.innerHTML = '';
    fsSel.innerHTML = '';
    profiles.forEach((p, i) => {
      const o1 = document.createElement('option');
      o1.value = p.url;
      o1.textContent = p.name;
      if (i === profiles.length - 1) o1.selected = true;
      gridSel.appendChild(o1);
      const o2 = document.createElement('option');
      o2.value = p.url;
      o2.textContent = p.name;
      fsSel.appendChild(o2);
    });
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Same as grid';
    none.selected = true;
    fsSel.insertBefore(none, fsSel.firstChild);
    $('discover-add').classList.remove('hidden');
    discoverMsg('');
  } catch (e) {
    discoverMsg("Couldn't read that camera's profiles — check the camera login above. " + (e && e.message ? e.message : e), true);
  }
}

function saveDiscoverAdd() {
  if (!pendingDevice || !pendingDevice.profiles) return;
  const name = $('da-name').value.trim();
  if (!name) { discoverMsg('Name is required.', true); return; }
  const stream = $('da-grid').value;
  const mainStream = $('da-fs').value;
  if (!stream) { discoverMsg('Pick a grid stream.', true); return; }
  const rec = { id: uid(), name, type: 'go2rtc', stream, mainStream, url: '', username: '', password: '' };
  state.cameras.push(rec);
  state.settings.camUser = $('d-user').value.trim();
  state.settings.camPass = $('d-pass').value;
  const layout = ensureLayout();
  let spot = findFreeSpot(layout);
  if (!spot) { layout.rows += 1; spot = { x: 0, y: layout.rows - 1 }; }
  layout.cells.push({ cameraId: rec.id, x: spot.x, y: spot.y, w: 1, h: 1 });
  saveState();
  $('discover-add').classList.add('hidden');
  discoverMsg('Added ' + name + ' — it is on the grid now.');
  renderCameraList();
}

// ---- Settings ----
function refreshExport() {
  $('s-export').value = JSON.stringify(state, null, 2);
  $('s-go2rtc').value = state.settings.go2rtcBase || '';
  $('s-ptz').value = state.settings.ptzBase || '';
}

function refreshDiagnostics() {
  $('diag-url').textContent = location.href;
  $('diag-secure').textContent = String(window.isSecureContext);
  $('diag-ua').textContent = navigator.userAgent;
}

function refreshBurninSettings() {
  const b = burnin();
  $('s-burn-hide').checked = !!b.hideUi;
  $('s-burn-orbit').checked = !!b.orbit;
  $('s-burn-dim').checked = !!b.dim;
}

// ---- Spatial navigation (remote arrows) ----
function tilesFrom(container, layout) {
  if (!layout) return [];
  const els = Array.from(container.querySelectorAll('.tile'));
  return els.map((tile) => {
    const cell = layout.cells.find((c) => c.cameraId === tile.dataset.cameraId);
    return cell ? { tile, cell, cam: camById(cell.cameraId) } : null;
  }).filter(Boolean);
}

function editorTiles() { return tilesFrom($('editor-grid'), draftLayout); }

function gridTiles() { return tilesFrom($('grid'), activeLayout()); }

function spatialNext(items, cur, dir) {
  if (!items[cur]) return -1;
  const c = items[cur].cell;
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  let best = -1;
  let bestScore = Infinity;
  items.forEach((it, i) => {
    if (i === cur) return;
    const o = it.cell;
    const ocx = o.x + o.w / 2;
    const ocy = o.y + o.h / 2;
    let ok = false;
    let primary = 0;
    if (dir === 'left' && o.x + o.w <= c.x) { ok = true; primary = c.x - (o.x + o.w); }
    if (dir === 'right' && o.x >= c.x + c.w) { ok = true; primary = o.x - (c.x + c.w); }
    if (dir === 'up' && o.y + o.h <= c.y) { ok = true; primary = c.y - (o.y + o.h); }
    if (dir === 'down' && o.y >= c.y + c.h) { ok = true; primary = o.y - (c.y + c.h); }
    if (!ok) return;
    const secondary = (dir === 'left' || dir === 'right') ? Math.abs(ocy - cy) : Math.abs(ocx - cx);
    const score = primary * 100 + secondary;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

function focusTile(items, idx) {
  if (items[idx] && items[idx].tile) {
    focusIndex = idx;
    items[idx].tile.focus();
  }
}

const HEADER_BTNS = ['btn-edit-layout', 'btn-cameras', 'btn-settings', 'layout-select'];

function focusHeader(idx) {
  headerFocus = Math.max(0, Math.min(HEADER_BTNS.length - 1, idx));
  const el = $(HEADER_BTNS[headerFocus]);
  if (el) el.focus();
  focusZone = 'header';
}

// ---- Global keys ----
document.addEventListener('keydown', (ev) => {
  const k = ev.keyCode || ev.which;
  const BACK = (k === 461 || k === 10009 || k === 27);
  const active = document.activeElement;
  const inField = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA');

  if ($('fullscreen') && !$('fullscreen').classList.contains('hidden')) {
    if (BACK) {
      ev.preventDefault();
      if (ptzMode) setPtzMode(false);
      else closeFullscreen();
      return;
    }
    if (ptzMode && k >= 37 && k <= 40) {
      ev.preventDefault();
      const dir = k === 37 ? 'left' : k === 39 ? 'right' : k === 38 ? 'up' : 'down';
      sendPtz(dir);
      return;
    }
    return;
  }

  if (currentView === 'editor') {
    if (moveCell) {
      if (k === 13) { moveCell = null; renderEditor(); ev.preventDefault(); return; }
      if (BACK) {
        Object.assign(moveCell, moveSnapshot);
        moveCell = null;
        renderEditor();
        ev.preventDefault();
        return;
      }
      if (k >= 37 && k <= 40) {
        ev.preventDefault();
        if (k === 37) moveCell.x = Math.max(0, moveCell.x - 1);
        if (k === 39) moveCell.x = Math.min(draftLayout.cols - moveCell.w, moveCell.x + 1);
        if (k === 38) moveCell.y = Math.max(0, moveCell.y - 1);
        if (k === 40) moveCell.y = Math.min(draftLayout.rows - moveCell.h, moveCell.y + 1);
        renderEditor();
      }
      return;
    }
    if (resizeMode) {
      const items = editorTiles();
      const cur = items[focusIndex] ? items[focusIndex].cell : null;
      if (k === 13) { resizeMode = false; $('btn-ed-resize').textContent = 'Resize: off'; renderEditor(); ev.preventDefault(); return; }
      if (BACK) { resizeMode = false; $('btn-ed-resize').textContent = 'Resize: off'; renderEditor(); ev.preventDefault(); return; }
      if (cur && k >= 37 && k <= 40) {
        ev.preventDefault();
        if (k === 37) cur.w = Math.max(1, cur.w - 1);
        if (k === 39) cur.w = Math.min(draftLayout.cols - cur.x, cur.w + 1);
        if (k === 38) cur.h = Math.max(1, cur.h - 1);
        if (k === 40) cur.h = Math.min(draftLayout.rows - cur.y, cur.h + 1);
        renderEditor();
      }
      return;
    }
    if (inField) { if (BACK) { draftLayout = null; showView('grid'); ev.preventDefault(); } return; }
    const items = editorTiles();
    if (k >= 37 && k <= 40) {
      ev.preventDefault();
      const dir = k === 37 ? 'left' : k === 39 ? 'right' : k === 38 ? 'up' : 'down';
      const next = spatialNext(items, focusIndex, dir);
      if (next >= 0) focusTile(items, next);
      return;
    }
    if (k === 13) {
      const it = items[focusIndex];
      if (it) {
        moveCell = it.cell;
        moveSnapshot = { ...it.cell };
        it.tile.classList.add('moving');
        ev.preventDefault();
      }
      return;
    }
    if (BACK) { draftLayout = null; showView('grid'); ev.preventDefault(); }
    return;
  }

  if (currentView === 'grid') {
    if (inField) return; // layout select: let native keys work, Back handled below
    if (focusZone === 'header') {
      if (k === 37) { focusHeader(headerFocus - 1); ev.preventDefault(); return; }
      if (k === 39) { focusHeader(headerFocus + 1); ev.preventDefault(); return; }
      if (k === 40) {
        focusZone = 'tiles';
        const items = gridTiles();
        focusTile(items, 0);
        ev.preventDefault();
        return;
      }
      return;
    }
    const items = gridTiles();
    if (k >= 37 && k <= 40) {
      ev.preventDefault();
      const dir = k === 37 ? 'left' : k === 39 ? 'right' : k === 38 ? 'up' : 'down';
      const next = spatialNext(items, focusIndex, dir);
      if (next >= 0) focusTile(items, next);
      else if (dir === 'up') focusHeader(headerFocus);
      return;
    }
    if (k === 13) {
      const it = items[focusIndex];
      if (it && it.cam) { ev.preventDefault(); openFullscreen(it.cam); }
      return;
    }
    return;
  }

  // cameras / settings views
  if (BACK) { ev.preventDefault(); showView('grid'); }
});

// ---- Wire-up ----
$('btn-edit-layout').addEventListener('click', openEditor);
$('btn-cameras').addEventListener('click', () => showView('cameras'));
$('btn-settings').addEventListener('click', () => showView('settings'));
$('btn-back-grid-1').addEventListener('click', () => showView('grid'));
$('btn-back-grid-2').addEventListener('click', () => showView('grid'));
$('btn-empty-add').addEventListener('click', () => showView('cameras'));
$('layout-select').addEventListener('change', (ev) => {
  state.activeLayoutId = ev.target.value;
  saveState();
  renderGridView();
});

$('ed-cols-down').addEventListener('click', () => { draftLayout.cols = Math.max(1, draftLayout.cols - 1); renderEditor(); });
$('ed-cols-up').addEventListener('click', () => { draftLayout.cols = Math.min(4, draftLayout.cols + 1); renderEditor(); });
$('ed-rows-down').addEventListener('click', () => { draftLayout.rows = Math.max(1, draftLayout.rows - 1); renderEditor(); });
$('ed-rows-up').addEventListener('click', () => { draftLayout.rows = Math.min(4, draftLayout.rows + 1); renderEditor(); });
$('btn-preset-1').addEventListener('click', () => applyPreset(1));
$('btn-preset-2').addEventListener('click', () => applyPreset(2));
$('btn-preset-3').addEventListener('click', () => applyPreset(3));
$('btn-preset-4').addEventListener('click', () => applyPreset(4));
$('btn-ed-save').addEventListener('click', saveEditor);
$('btn-ed-cancel').addEventListener('click', () => { draftLayout = null; showView('grid'); });
$('btn-ed-new').addEventListener('click', () => {
  const layout = { id: uid(), name: 'Layout ' + (state.layouts.length + 1), cols: 3, rows: 3, cells: [] };
  state.layouts.push(layout);
  state.activeLayoutId = layout.id;
  draftLayout = JSON.parse(JSON.stringify(layout));
  $('ed-name').value = draftLayout.name;
  renderEditor();
});
$('btn-ed-delete').addEventListener('click', () => {
  if (state.layouts.length <= 1) return;
  state.layouts = state.layouts.filter((l) => l.id !== draftLayout.id);
  state.activeLayoutId = state.layouts[0].id;
  draftLayout = null;
  saveState();
  showView('grid');
});
$('btn-ed-add').addEventListener('click', () => {
  const placed = new Set(draftLayout.cells.map((c) => c.cameraId));
  const sel = $('ed-add-select');
  sel.innerHTML = '';
  state.cameras.filter((c) => !placed.has(c.id)).forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  });
  $('ed-add-row').classList.toggle('hidden', sel.options.length === 0);
});
$('btn-ed-add-confirm').addEventListener('click', () => {
  const camId = $('ed-add-select').value;
  if (!camId) return;
  let spot = findFreeSpot(draftLayout);
  if (!spot) { draftLayout.rows += 1; spot = { x: 0, y: draftLayout.rows - 1 }; }
  draftLayout.cells.push({ cameraId: camId, x: spot.x, y: spot.y, w: 1, h: 1 });
  $('ed-add-row').classList.add('hidden');
  renderEditor();
});
$('btn-ed-remove').addEventListener('click', () => {
  const items = editorTiles();
  const it = items[focusIndex];
  if (!it) return;
  draftLayout.cells = draftLayout.cells.filter((c) => c !== it.cell);
  renderEditor();
});
$('btn-ed-resize').addEventListener('click', () => {
  resizeMode = !resizeMode;
  $('btn-ed-resize').textContent = resizeMode ? 'Resize: on' : 'Resize: off';
  renderEditor();
});

$('f-type').addEventListener('change', toggleCamFormRows);
$('cam-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const err = $('cam-form-error');
  const name = $('f-name').value.trim();
  const type = $('f-type').value;
  const stream = $('f-stream').value.trim().replace(/\/+$/, '');
  const mainStream = $('f-mainstream').value.trim().replace(/\/+$/, '');
  const url = $('f-url').value.trim();
  const username = $('f-user').value.trim();
  const password = $('f-pass').value;
  if (!name) { err.textContent = 'Name is required.'; err.classList.remove('hidden'); return; }
  if (type === 'go2rtc' && !stream) { err.textContent = 'Stream name is required for go2rtc cameras.'; err.classList.remove('hidden'); return; }
  if (type !== 'go2rtc' && !url) { err.textContent = 'URL is required.'; err.classList.remove('hidden'); return; }
  err.classList.add('hidden');
  const rec = { id: editingCamId || uid(), name, type, stream, mainStream, url, username, password };
  const idx = state.cameras.findIndex((c) => c.id === rec.id);
  if (idx >= 0) state.cameras[idx] = rec;
  else {
    state.cameras.push(rec);
    const layout = ensureLayout();
    if (layout.cells.length === 0) {
      layout.cells.push({ cameraId: rec.id, x: 0, y: 0, w: 1, h: 1 });
    }
  }
  saveState();
  renderCameraList();
});
$('btn-cam-cancel').addEventListener('click', () => openCamForm(null));

$('btn-discover').addEventListener('click', runDiscovery);
$('btn-da-save').addEventListener('click', saveDiscoverAdd);
$('btn-da-cancel').addEventListener('click', () => { $('discover-add').classList.add('hidden'); pendingDevice = null; });

$('btn-settings-save').addEventListener('click', () => {
  state.settings.go2rtcBase = $('s-go2rtc').value.trim().replace(/\/+$/, '');
  state.settings.ptzBase = $('s-ptz').value.trim().replace(/\/+$/, '');
  state.settings.burnin = {
    hideUi: $('s-burn-hide').checked,
    orbit: $('s-burn-orbit').checked,
    dim: $('s-burn-dim').checked,
  };
  saveState();
  const msg = $('settings-msg');
  msg.textContent = 'Settings saved.';
  msg.classList.remove('hidden');
  refreshExport();
});
$('btn-diag-run').addEventListener('click', async () => {
  const base = go2rtcBase();
  const fEl = $('diag-fetch');
  const wEl = $('diag-ws');
  if (!base) { fEl.textContent = 'go2rtc base URL not set'; wEl.textContent = 'go2rtc base URL not set'; return; }
  const stream = (state.cameras.find((c) => c.type === 'go2rtc') || {}).stream || 'cam5_back_deck_sub';
  fEl.textContent = 'Trying ' + base + '/api/streams …';
  wEl.textContent = 'Waiting…';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(base + '/api/streams', { signal: ctl.signal });
    clearTimeout(t);
    fEl.textContent = 'OK — HTTP ' + res.status;
  } catch (e) {
    fEl.textContent = 'FAILED — ' + (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : e);
  }
  const wsUrl = base.replace(/^http/, 'ws') + '/api/ws?src=' + encodeURIComponent(stream);
  wEl.textContent = 'Trying ' + maskCreds(wsUrl) + ' …';
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => { try { ws.close(); } catch (e) { /* ignore */ } reject(new Error('timeout after 8s')); }, 8000);
      ws.addEventListener('open', () => { clearTimeout(t); try { ws.close(); } catch (e) { /* ignore */ } resolve(); });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('error event')); });
      ws.addEventListener('close', (ev) => { clearTimeout(t); reject(new Error('closed, code ' + ev.code)); });
    });
    wEl.textContent = 'OK — websocket opened';
  } catch (e) {
    wEl.textContent = 'FAILED — ' + (e && e.message ? e.message : e);
  }
});
$('btn-export-refresh').addEventListener('click', refreshExport);
$('btn-import').addEventListener('click', () => {
  const msg = $('settings-msg');
  try {
    const data = JSON.parse($('s-import').value);
    if (!data || !Array.isArray(data.cameras) || !Array.isArray(data.layouts)) {
      throw new Error('bad shape');
    }
    if (!data.settings) data.settings = { go2rtcBase: '' };
    state = data;
    saveState();
    refreshLayoutSelect();
    msg.textContent = 'Configuration imported.';
    msg.classList.remove('hidden');
    showView('grid');
  } catch (e) {
    msg.textContent = 'Import failed: that is not a valid Oscar Cam configuration.';
    msg.classList.remove('hidden');
  }
});

$('btn-fs-back').addEventListener('click', closeFullscreen);
$('btn-fs-mute').addEventListener('click', toggleFsMute);
$('btn-fs-ptz').addEventListener('click', () => setPtzMode(!ptzMode));
$('btn-ptz-zoom-in').addEventListener('click', () => sendPtz('zoom_in'));
$('btn-ptz-zoom-out').addEventListener('click', () => sendPtz('zoom_out'));
$('btn-ptz-home').addEventListener('click', () => sendPtz('home'));
$('btn-ptz-exit').addEventListener('click', () => setPtzMode(false));

// ---- Init ----
if (state.layouts.length === 0 && state.cameras.length > 0) {
  const cols = 3;
  const layout = {
    id: uid(), name: 'All', cols,
    rows: Math.max(1, Math.ceil(state.cameras.length / cols)),
    cells: state.cameras.map((cam, i) => ({ cameraId: cam.id, x: i % cols, y: Math.floor(i / cols), w: 1, h: 1 })),
  };
  state.layouts.push(layout);
  state.activeLayoutId = layout.id;
  saveState();
}
refreshLayoutSelect();
showView('grid');
