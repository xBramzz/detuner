/* Detune — application shell: library, IndexedDB persistence, playlists, queue, playback, audio engine wiring.
   Pure helpers (cents/ratio math, playback model, hashing, LRC parsing, backup validation) live in core.js
   so they can be unit-tested in Node without a DOM. */
(() => {
"use strict";
const C = window.DetuneCore;
if (!C) throw new Error("core.js failed to load");
const $ = id => document.getElementById(id);
const audio = $("audio");
const clamp = C.clamp;

/* ------------------------------------------------------------------ state */
const DB_NAME = "detune-library", DB_VERSION = 2, STORE = "tracks", META = "meta";
let db = null;
let tracks = [];                       // source of truth for the library
let playlists = [{ id: "default", name: "My graveyard", trackIds: [] }];
let activePlaylist = "default";
let settings = { ...C.DEFAULT_SETTINGS };
let perTrack = {};                     // id -> {cents,tempo} overrides
let currentId = null, queue = [], lyricsStore = {}, stats = { plays: {}, recent: [] };
let shuffle = false, repeat = "off";   // off | all | one
let loopA = null, loopB = null;
let renderQueued = false, dragId = null;
const selected = new Set();
const urls = new Set();                // live object URLs (cleanup on unload)

const fmt = n => Number.isFinite(n) && n >= 0 ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}` : "0:00";
const lastToast = { m: "", t: 0 };
function say(m) {
  const now = Date.now();
  if (m === lastToast.m && now - lastToast.t < 4000) return; // don't repeat identical toasts
  lastToast.m = m; lastToast.t = now;
  $("status").textContent = m;
  const t = $("toast"); t.textContent = m; t.style.display = "block";
  clearTimeout(say.timer); say.timer = setTimeout(() => t.style.display = "none", 3600);
}
function safeURL(blob) { const u = URL.createObjectURL(blob); urls.add(u); return u; }
function revoke(u) { if (u && urls.has(u)) { URL.revokeObjectURL(u); urls.delete(u); } }
function audioError(e) {
  console.error(e);
  say(e?.name === "QuotaExceededError"
    ? "Storage is full. Export a backup or remove tracks, then try again."
    : `Could not complete that action${e?.message ? `: ${e.message}` : ""}. Your existing library was kept.`);
}

/* ------------------------------------------------------------------ IndexedDB */
function req(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || new Error("Database request failed")); }); }
function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const q = indexedDB.open(DB_NAME, DB_VERSION);
      q.onupgradeneeded = () => {
        const d = q.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: "key" });
      };
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error || new Error("Could not open the database"));
      q.onblocked = () => reject(new Error("Database is blocked by another tab. Close Detune there and reload."));
    } catch (e) { reject(e); }
  });
}
async function migrateOldLibrary() {
  /* Previous build used DB "detune-library-v2". Open it read-only and copy every record. Never delete it. */
  try {
    const old = await new Promise((res, rej) => { const q = indexedDB.open("detune-library-v2"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); q.onblocked = () => rej(new Error("blocked")); });
    const names = [...old.objectStoreNames];
    if (names.includes(STORE)) {
      const rows = await req(old.transaction(STORE, "readonly").objectStore(STORE).getAll());
      let moved = 0;
      for (const t of rows) { if (!tracks.some(x => x.id === t.id)) { await put(STORE, t); tracks.push(t); moved++; } }
      if (moved) say(`Migrated ${moved} track${moved === 1 ? "" : "s"} from the older Detune library.`);
    }
    old.close();
  } catch (e) { console.warn("No legacy library to migrate", e); }
}
async function getAll(store = STORE) { const tx = db.transaction(store, "readonly"); return req(tx.objectStore(store).getAll()); }
async function put(store, obj) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted"));
  });
}
async function del(store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("aborted"));
  });
}
async function metaGet(key, fallback) { try { const x = await req(db.transaction(META, "readonly").objectStore(META).get(key)); return x?.value ?? fallback; } catch { return fallback; } }
async function metaSet(key, value) { await put(META, { key, value }); }
function makeId() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

/* debounced meta persistence — avoids hammering IndexedDB on slider drags */
const saveTimers = {};
function metaSetSoon(key, getVal, ms = 500) {
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => { metaSet(key, typeof getVal === "function" ? getVal() : getVal).catch(e => console.warn("Could not save " + key, e)); }, ms);
}

/* ------------------------------------------------------------------ derived views */
function playlist() { return playlists.find(p => p.id === activePlaylist) || playlists[0]; }
function trackById(id) { return tracks.find(t => t.id === id); }
function currentList() { const p = playlist(); return p ? p.trackIds.map(id => trackById(id)).filter(Boolean) : []; }
function viewRows() {
  const view = $("viewSelect")?.value || "playlist";
  let base;
  if (view === "favorites") base = tracks.filter(t => t.favorite);
  else if (view === "recent") base = [...stats.recent].map(trackById).filter(Boolean);
  else if (view === "most") base = [...tracks].sort((a, b) => (stats.plays[b.id] || 0) - (stats.plays[a.id] || 0)).filter(t => (stats.plays[t.id] || 0) > 0);
  else base = currentList();
  const q = ($("search")?.value || "").trim().toLowerCase();
  let rows = q ? base.filter(t => `${t.title} ${t.artist} ${t.album} ${t.name}`.toLowerCase().includes(q)) : [...base];
  const sort = $("sort")?.value || "added";
  rows.sort((a, b) => sort === "title" ? a.title.localeCompare(b.title)
    : sort === "artist" ? (a.artist || "").localeCompare(b.artist || "")
    : sort === "duration" ? a.duration - b.duration
    : sort === "plays" ? (stats.plays[b.id] || 0) - (stats.plays[a.id] || 0)
    : b.added - a.added);
  return { rows, total: base.length };
}

/* ------------------------------------------------------------------ rendering */
function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

function render() {
  const list = $("trackList"), { rows, total } = viewRows();
  $("count").textContent = `${rows.length} / ${total} tracks`;
  const frag = document.createDocumentFragment();
  if (!rows.length) {
    const li = el("li", "empty");
    const view = $("viewSelect").value;
    li.textContent = view === "favorites" ? "No favorites yet — tap the star on a track."
      : view === "recent" ? "Nothing played yet."
      : view === "most" ? "Play some tracks to build your top list."
      : ($("search").value.trim() ? "No matches." : "Your playlist is empty. Drop audio files above or press Import.");
    frag.append(li);
  }
  for (const t of rows) {
    const li = el("li", "track" + (t.id === currentId ? " active" : ""));
    li.dataset.id = t.id; li.draggable = true; li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `${t.title} by ${t.artist}, ${fmt(t.duration)}. Activate to play.`);
    if (t.id === currentId) li.setAttribute("aria-current", "true");

    const check = el("input"); check.type = "checkbox"; check.checked = selected.has(t.id);
    check.setAttribute("aria-label", `Select ${t.title}`);
    check.addEventListener("click", e => e.stopPropagation());
    check.addEventListener("change", () => { check.checked ? selected.add(t.id) : selected.delete(t.id); });

    const th = el("div", "thumb");
    if (t.cover) { const im = new Image(); im.loading = "lazy"; im.alt = ""; im.decoding = "async"; im.src = t.coverUrl || (t.coverUrl = safeURL(t.cover)); th.append(im); }
    else th.textContent = "♫";

    const meta = el("div", "meta");
    const b = el("strong", null, t.title);
    const s = el("span", null, (t.artist || "Unknown artist") + (t.album ? ` · ${t.album}` : ""));
    meta.append(b, s);

    const acts = el("div", "rowacts");
    const fav = el("button", "fav" + (t.favorite ? " on" : ""), t.favorite ? "★" : "☆");
    fav.setAttribute("aria-label", (t.favorite ? "Unfavorite " : "Favorite ") + t.title);
    fav.setAttribute("aria-pressed", String(!!t.favorite));
    fav.onclick = e => { e.stopPropagation(); toggleFav(t); };
    const qbtn = el("button", "q", "+"); qbtn.title = "Add to queue"; qbtn.setAttribute("aria-label", `Queue ${t.title}`);
    qbtn.onclick = e => { e.stopPropagation(); enqueue(t.id, "end"); };
    acts.append(fav, qbtn);

    const dur = el("span", "duration", fmt(t.duration) + ((stats.plays[t.id] || 0) ? ` · ${stats.plays[t.id]} plays` : ""));
    const remove = el("button", "remove", "×"); remove.setAttribute("aria-label", `Remove ${t.title}`);
    remove.onclick = e => { e.stopPropagation(); removeTrack(t.id); };

    li.append(check, th, meta, acts, dur, remove);
    li.onclick = () => playTrack(t.id, true);
    li.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playTrack(t.id, true); } };
    li.addEventListener("dragstart", e => { dragId = t.id; e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; });
    li.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    li.addEventListener("drop", e => { e.preventDefault(); const from = e.dataTransfer.getData("text/plain") || dragId; if (from && from !== t.id) reorder(from, t.id); });
    frag.append(li);
  }
  list.replaceChildren(frag);
  renderPlaylists(); renderQueue(); updateStorage();
}

function renderPlaylists() {
  const s = $("playlistSelect"); s.replaceChildren();
  for (const p of playlists) { const o = document.createElement("option"); o.value = p.id; o.textContent = `${p.name} (${p.trackIds.length})`; s.append(o); }
  s.value = activePlaylist;
}
function renderQueue() {
  const box = $("queueList"); if (!box) return;
  box.replaceChildren();
  $("queueCount").textContent = queue.length ? `${queue.length} queued` : "";
  if (!queue.length) { box.append(el("li", "empty", "Queue is empty. Use ＋ on a track or “Queue selected”.")); return; }
  queue.forEach((id, i) => {
    const t = trackById(id); if (!t) return;
    const li = el("li", "qrow");
    li.append(el("span", "qn", String(i + 1)), el("span", "qt", t.title));
    const up = el("button", "qx", "↑"); up.title = "Move up"; up.setAttribute("aria-label", "Move up"); up.disabled = i === 0;
    up.onclick = () => { [queue[i - 1], queue[i]] = [queue[i], queue[i - 1]]; saveQueueSoon(); renderQueue(); };
    const go = el("button", "qx", "▶"); go.title = "Play now"; go.setAttribute("aria-label", "Play now");
    go.onclick = () => { queue.splice(i, 1); saveQueueSoon(); playTrack(id, true); };
    const rm = el("button", "qx", "×"); rm.title = "Remove from queue"; rm.setAttribute("aria-label", "Remove from queue");
    rm.onclick = () => { queue.splice(i, 1); saveQueueSoon(); renderQueue(); };
    li.append(up, go, rm); box.append(li);
  });
}
const saveQueueSoon = () => metaSetSoon("queue", () => queue.slice(), 300);

/* ------------------------------------------------------------------ audio engine */
let ctx = null, source = null, pitchNode = null, filters = [], compressor = null, master = null, analyser = null, dry = null, wet = null, convolver = null;
const EQ_FREQS = C.EQ_FREQS; // [60,170,350,1000,3500,10000]

async function setupAudio() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("Web Audio is not supported in this browser.");
  ctx = new AC({ latencyHint: "playback" });
  /* Worklet first — createMediaElementSource must NOT exist yet, or Chrome's
     WebRTC/AEC pipeline hijacks the element and degrades pitch-shifted audio. */
  try {
    if (ctx.audioWorklet && location.protocol !== "file:") {
      await ctx.audioWorklet.addModule("./pitch-worklet.js");
      pitchNode = new AudioWorkletNode(ctx, "detune-pitch", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit", outputChannelCount: [2] });
    } else throw new Error("AudioWorklet needs http(s), not file://");
  } catch (e) {
    console.warn("Pitch worklet unavailable", e);
    pitchNode = null;
    setTimeout(() => say("Pitch engine could not load — pitch shifting is off. Open Detune over http(s), not file://."), 400);
  }
  source = ctx.createMediaElementSource(audio);
  filters = EQ_FREQS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking"; b.frequency.value = f; b.Q.value = 0.8; b.gain.value = 0; return b; });
  compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -14; compressor.knee.value = 20; compressor.ratio.value = 2.5; compressor.attack.value = 0.008; compressor.release.value = 0.2;
  dry = ctx.createGain(); wet = ctx.createGain(); convolver = ctx.createConvolver(); master = ctx.createGain();
  analyser = ctx.createAnalyser(); analyser.fftSize = document.documentElement.classList.contains("lite") ? 2048 : 4096; analyser.smoothingTimeConstant = 0.72;
  const len = Math.floor(ctx.sampleRate * 1.8), imp = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = imp.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
  convolver.buffer = imp;
  /* Chain: source → [worklet] → EQ×6 → compressor → dry+reverb(wet) → master → destination
            compressor → analyser → (zero-gain sink so the analyser never feeds audible output twice) */
  let n = source;
  if (pitchNode) { n.connect(pitchNode); n = pitchNode; }
  for (const f of filters) { n.connect(f); n = f; }
  n.connect(compressor);
  compressor.connect(dry); dry.connect(master);
  compressor.connect(convolver); convolver.connect(wet); wet.connect(master);
  master.connect(ctx.destination);
  compressor.connect(analyser);
  { const zg = ctx.createGain(); zg.gain.value = 0; analyser.connect(zg); zg.connect(ctx.destination); }
  window.DetuneFX && (DetuneFX.analyser = analyser);
  applySettings();
}
function ramp(param, value, time = 0.05) {
  try { const now = ctx.currentTime; param.cancelScheduledValues(now); param.setTargetAtTime(value, now, time); }
  catch { try { param.value = value; } catch { /* closed context */ } }
}
function applySettings() {
  const model = C.computePlayback(settings);
  if (ctx) {
    if (pitchNode) ramp(pitchNode.parameters.get("cents"), model.workletCents, 0.03);
    ramp(master.gain, settings.mute ? 0 : settings.volume);
    ramp(wet.gain, settings.reverb * 0.9);          // true crossfade-style send/return balance
    ramp(dry.gain, 1 - settings.reverb * 0.35);
    for (let i = 0; i < filters.length; i++) ramp(filters[i].gain, settings.eq[i] || 0);
  }
  /* THE FIX for "everything sounds chipmunk": browsers latch preservesPitch at play()/load() time.
     Changing preservesPitch and playbackRate in the same tick as a src swap double-applied or dropped
     the shift. We set the flag FIRST, force a load() re-latch when the flag actually changes mid-playback,
     then set the rate. Exactly ONE stage applies each transformation (see core.computePlayback). */
  const pp = model.preservesPitch;
  const needRelatch = audio.preservesPitch !== pp && !Number.isNaN(audio.duration) && !audio.paused;
  audio.preservesPitch = audio.mozPreservesPitch = audio.webkitPreservesPitch = pp;
  audio.defaultPlaybackRate = model.rate;
  audio.playbackRate = model.rate;
  if (needRelatch) { const t = audio.currentTime; try { audio.load(); audio.currentTime = t; if (!audio.paused) audio.play().catch(() => {}); } catch { /* ignore */ } }
  /* UI sync */
  $("centsText").textContent = (settings.cents > 0 ? "+" : "") + settings.cents;
  $("centsNumber").value = settings.cents; $("pitch").value = settings.cents;
  $("tempoNumber").value = settings.tempo.toFixed(2); $("tempo").value = settings.tempo;
  $("link").checked = settings.link; $("volume").value = settings.volume; $("mute").checked = settings.mute; $("reverb").value = settings.reverb;
  const semis = settings.cents / 100;
  $("pitchNote").textContent = `A₄ = ${(440 * C.centsToRatio(settings.cents)).toFixed(2)} Hz` + (settings.cents ? ` · ${semis > 0 ? "+" : ""}${semis.toFixed(2)} st` : "");
  $("modeReadout").textContent = settings.link
    ? `Vinyl mode — speed ${model.rate.toFixed(3)}× carries the pitch; tempo slider is inactive`
    : `Detuned mode — pitch ${settings.cents > 0 ? "+" : ""}${settings.cents}c via DSP · speed ${settings.tempo.toFixed(2)}× independent`;
  document.querySelectorAll(".eq").forEach((r, i) => { if (settings.eq[i] != null) r.value = settings.eq[i]; });
  metaSetSoon("settings", () => settings);
}

/* ------------------------------------------------------------------ playback */
let audioUrl = null;
async function playTrack(id, autoplay = true) {
  const t = trackById(id); if (!t) return;
  try {
    await setupAudio();
    if (ctx.state === "suspended") await ctx.resume();
    /* per-track settings override global */
    const ov = perTrack[id];
    if (ov) { settings.cents = clamp(Math.round(ov.cents || 0), -1200, 1200); settings.tempo = clamp(+ov.tempo || 1, 0.5, 2); }
    if (audioUrl) revoke(audioUrl);
    audioUrl = safeURL(t.blob);
    audio.pause();
    audio.src = audioUrl;
    currentId = id;
    applySettings();               // sets preservesPitch BEFORE load so the latch is correct
    audio.load();
    $("title").textContent = t.title; $("artist").textContent = t.artist || "Unknown artist";
    setCover(t); $("duration").textContent = fmt(t.duration); $("currentTime").textContent = "0:00";
    loopA = loopB = null; updateLoop();
    scheduleRender(); updateMediaSession(t);
    if (autoplay) { await audio.play(); countPlay(id); }
    say(autoplay ? `Playing ${t.title}` : `Loaded ${t.title}. Press Play to start.`);
  } catch (e) {
    if (e?.name === "NotAllowedError") say("Playback needs a tap on Play in this browser.");
    else say(`Playback failed for ${t.title}. Try another file.`);
    console.error(e);
  }
}
function countPlay(id) {
  stats.plays[id] = (stats.plays[id] || 0) + 1;
  stats.recent = [id, ...stats.recent.filter(x => x !== id)].slice(0, 40);
  metaSetSoon("stats", () => stats, 4000); // batch writes — no hammering on every play
}
function advance(dir = 1) {
  const ids = currentList().map(t => t.id);
  const nextQueued = dir > 0 && queue.length ? queue.shift() : null;
  const pick = C.pickNext(ids, currentId, { dir, shuffle, repeat, nextQueued });
  if (nextQueued && pick?.via === "queue") saveQueueSoon();
  if (!pick) { if (dir > 0) say("End of playlist."); return false; }
  playTrack(pick.id, true);
  return true;
}
function enqueue(id, pos = "end") {
  if (!trackById(id)) return;
  C.queueAdd(queue, id, pos); saveQueueSoon(); renderQueue();
  say(pos === "next" ? "Queued next." : "Added to queue.");
}
async function toggleFav(t) {
  t.favorite = !t.favorite;
  try { await put(STORE, { ...t }); } catch (e) { audioError(e); }
  scheduleRender();
}
function saveCurrent() {
  const t = trackById(currentId); if (!t) return;
  perTrack[t.id] = { cents: settings.cents, tempo: settings.tempo };
  metaSetSoon("perTrack", () => perTrack, 800);
}
async function removeTrack(id) {
  const t = trackById(id); if (!t) return;
  try {
    if (id === currentId) { audio.pause(); audio.removeAttribute("src"); audio.load(); revoke(audioUrl); audioUrl = null; currentId = null; $("title").textContent = "Nothing playing"; $("artist").textContent = "Add a song to begin"; setCover(null); }
    for (const p of playlists) p.trackIds = p.trackIds.filter(x => x !== id);
    queue = queue.filter(x => x !== id); saveQueueSoon();
    tracks = tracks.filter(x => x.id !== id);
    selected.delete(id); delete perTrack[id];
    if (t.coverUrl) revoke(t.coverUrl);
    await del(STORE, id);
    await savePlaylists();
    if (currentId === null && playlist()?.trackIds.length) await playTrack(playlist().trackIds[0], false);
    scheduleRender();
    say(`Removed ${t.title}.`);
  } catch (e) { audioError(e); }
}
function reorder(from, to) {
  const p = playlist(), a = p.trackIds.indexOf(from), b = p.trackIds.indexOf(to);
  if (a < 0 || b < 0) return;
  p.trackIds.splice(a, 1); p.trackIds.splice(b, 0, from);
  savePlaylists().then(scheduleRender).catch(audioError);
}
function setPitch(c) { settings.cents = clamp(Math.round(Number(c) || 0), -1200, 1200); applySettings(); saveCurrent(); }
function setTempo(v) { settings.tempo = clamp(Number(v) || 1, 0.5, 2); applySettings(); saveCurrent(); }
function updateLoop() { $("loopStatus").textContent = loopA === null ? "A–B off" : `A ${fmt(loopA)}${loopB === null ? " · set B" : ` → ${fmt(loopB)}`}`; }
function setCover(t) {
  const c = $("cover"); c.replaceChildren();
  if (t?.cover) { const im = new Image(); im.alt = ""; im.src = t.coverUrl || (t.coverUrl = safeURL(t.cover)); c.append(im); }
  else c.textContent = "♫";
}
function updateMediaSession(t) {
  try {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || "Unknown artist", album: t.album || "Detune", artwork: t.cover ? [{ src: t.coverUrl || (t.coverUrl = safeURL(t.cover)), sizes: "96x96", type: t.cover.type || "image/jpeg" }] : [] });
  } catch (e) { console.warn("Media Session metadata failed", e); }
}

/* ------------------------------------------------------------------ import */
let supportedExts = ["mp3", "wav"];
async function addFiles(fileList) {
  const all = [...fileList];
  /* Probe formats lazily: never let a failed/skipped capability check reject playable files. */
  if (supportedExts.length <= 2) {
    try { supportedExts = await C.detectFormats(); } catch { /* keep defaults */ }
  }
  const files = all.filter(f => C.fileAccepted(f, supportedExts));
  const rejected = all.length - files.length;
  if (!files.length) { if (rejected) say(`None of those ${rejected} file(s) look like playable audio (${supportedExts.join(", ")}).`); return; }
  const known = new Set(tracks.map(t => t.hash));
  let added = 0, dupes = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    say(`Importing ${i + 1} of ${files.length}: ${f.name}`);
    await new Promise(r => setTimeout(r, 0)); // keep UI responsive between files
    try {
      if (f.size === 0) { failed++; continue; }
      if (f.size > 1024 * 1024 * 1024) { say(`${f.name} is over 1 GB and was skipped.`); failed++; continue; }
      /* crypto.subtle is undefined on plain http (non-secure contexts). Pass null in that case
         so hashFileWith uses its pure-JS SHA-256 fallback instead of throwing — this was why
         every import silently failed when serving the app over http://LAN-ip. */
      const subtle = globalThis.crypto?.subtle || null;
      const hash = await C.hashFileWith(f, subtle);
      if (known.has(hash)) { dupes++; continue; }
      const tags = window.DetuneTags ? await DetuneTags.read(f, f.name) : {};
      const pic = coverBlob(tags.picture);
      const duration = await readDuration(f);
      if (!duration) { failed++; say(`Could not decode ${f.name}; unsupported or damaged audio was skipped.`); continue; }
      const t = { id: makeId(), name: f.name, blob: f, hash, title: tags.title || f.name.replace(/\.[^.]+$/, ""), artist: tags.artist || "Unknown artist", album: tags.album || "", cover: pic, duration, added: Date.now(), favorite: false, metaV: 2 };
      await put(STORE, t);
      tracks.push(t); playlist().trackIds.push(t.id); known.add(hash); added++;
    } catch (e) { failed++; audioError(e); }
  }
  try { await savePlaylists(); scheduleRender(); persistHint(); } catch (e) { audioError(e); }
  if (currentId === null && added) await playTrack(playlist().trackIds[playlist().trackIds.length - 1], false);
  const parts = [`Imported ${added}`];
  if (dupes) parts.push(`${dupes} duplicate${dupes === 1 ? "" : "s"} skipped`);
  if (failed) parts.push(`${failed} failed`);
  if (rejected) parts.push(`${rejected} unsupported`);
  say(parts.join(" · ") + ".");
}
function coverBlob(p) { try { if (!p?.data?.length) return null; return new Blob([new Uint8Array(p.data)], { type: p.format || "image/jpeg" }); } catch { return null; } }
function readDuration(file) {
  return new Promise(resolve => {
    let u; const a = new Audio(); let settled = false;
    const done = v => { if (settled) return; settled = true; clearTimeout(timer); a.removeAttribute("src"); a.load(); revoke(u); resolve(Number.isFinite(v) && v > 0 ? v : 0); };
    const timer = setTimeout(() => done(0), 12000);
    try { u = safeURL(file); a.preload = "metadata"; a.onloadedmetadata = () => done(a.duration); a.onerror = () => done(0); a.src = u; } catch { done(0); }
  });
}
async function savePlaylists() { await metaSet("playlists", playlists); await metaSet("activePlaylist", activePlaylist); }
async function persistHint() { try { await navigator.storage?.persist?.(); } catch { /* ignore */ } }
async function updateStorage() {
  try {
    const e = await navigator.storage?.estimate?.();
    $("storage").textContent = e ? `Local storage: ${Math.round((e.usage || 0) / 1048576)} MB used${e.quota ? ` · ~${Math.round(e.quota / 1048576)} MB quota` : ""} · ${tracks.length} tracks · Clearing site data deletes your music.` : "Storage estimate unavailable";
    if (e?.quota && e.usage / e.quota > 0.9) say("Storage is almost full. Export a backup soon.");
  } catch { $("storage").textContent = "Storage estimate unavailable"; }
}

/* ------------------------------------------------------------------ presets & EQ */
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0],
  bass: [7, 5, 1, 0, -1, -2],
  "no-bass": [-6, -4, 0, 1, 2, 2],
  vocal: [-2, 0, 3, 5, 3, 0],
  treble: [-2, -1, 0, 2, 5, 7],
  warm: [4, 2, 0, -1, -2, -3],
  bright: [-3, -1, 0, 2, 4, 6],
};
function setPreset(name) {
  if (name === "reset") { settings.cents = 0; settings.tempo = 1; settings.link = false; settings.reverb = 0; settings.eq = [0, 0, 0, 0, 0, 0]; }
  else if (name === "432") { settings.cents = Math.round(1200 * Math.log2(432 / 440)); }
  else if (name === "nightcore") { settings.link = true; settings.cents = 300; }
  else if (name === "slowed") { settings.link = false; settings.cents = -300; settings.tempo = 0.8; }
  else if (name === "reverb-slowed") { settings.link = false; settings.cents = -300; settings.tempo = 0.8; settings.reverb = 0.55; }
  else if (EQ_PRESETS[name]) { settings.eq = EQ_PRESETS[name].slice(); }
  applySettings(); saveCurrent();
  say(`Preset applied: ${name}.`);
}

/* ------------------------------------------------------------------ export / backup */
async function exportWav() {
  const t = trackById(currentId); if (!t) return say("Choose a track first.");
  const button = $("exportWav"); button.disabled = true;
  try {
    say("Preparing WAV export…");
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) throw new Error("Offline audio rendering is unsupported here.");
    const probe = new AC(2, 1, 44100);
    const buf = await probe.decodeAudioData(await t.blob.arrayBuffer());
    const model = C.computePlayback(settings);
    const frames = Math.ceil(buf.length / model.rate);
    const off = new AC(buf.numberOfChannels, frames, buf.sampleRate);
    const src = off.createBufferSource(); src.buffer = buf; src.playbackRate.value = model.rate;
    const gain = off.createGain(); gain.gain.value = settings.mute ? 0 : settings.volume;
    src.connect(gain); gain.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    const wav = encodeWav(rendered);
    const a = document.createElement("a"); a.href = safeURL(wav); a.download = `${t.title.replace(/[\\/:*?"<>|]/g, "_")}-detuned.wav`; a.click();
    setTimeout(() => revoke(a.href), 30000);
    say("WAV exported. Note: offline export bakes in speed and volume only — live pitch/EQ/reverb are not included.");
  } catch (e) { audioError(e); } finally { button.disabled = false; }
}
function encodeWav(buffer) {
  const channels = buffer.numberOfChannels, len = buffer.length, bytes = 44 + len * channels * 2;
  const ab = new ArrayBuffer(bytes), v = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, bytes - 8, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, buffer.sampleRate, true); v.setUint32(28, buffer.sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, bytes - 44, true);
  let o = 44;
  for (let i = 0; i < len; i++) for (let ch = 0; ch < channels; ch++) { const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i])); v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true); o += 2; }
  return new Blob([ab], { type: "audio/wav" });
}
async function blobToBase64(blob) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = () => reject(r.error); r.readAsDataURL(blob); }); }
function fromBase64(s, type) { const raw = atob(s.replace(/^data:[^,]*,/, "")), arr = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i); return new Blob([arr], { type }); }
async function backup() {
  try {
    say("Building backup (includes full audio — may take a moment)…");
    const payload = { version: 3, playlists, activePlaylist, settings, stats, perTrack, lyrics: lyricsStore, tracks: [] };
    for (const t of tracks) {
      payload.tracks.push({ id: t.id, name: t.name, title: t.title, artist: t.artist, album: t.album, duration: t.duration, added: t.added, cents: perTrack[t.id]?.cents ?? 0, tempo: perTrack[t.id]?.tempo ?? 1, hash: t.hash, favorite: !!t.favorite, plays: stats.plays[t.id] || 0, blobData: await blobToBase64(t.blob), coverData: t.cover ? await blobToBase64(t.cover) : null });
    }
    const b = new Blob([JSON.stringify(payload)], { type: "application/json" }), u = safeURL(b), a = document.createElement("a");
    a.href = u; a.download = "detune-backup.json"; a.click();
    setTimeout(() => revoke(u), 30000);
    say(`Backup exported with ${tracks.length} track(s) including audio.`);
  } catch (e) { audioError(e); }
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const clean = C.validateBackup(data);
    if (!clean.tracks.length) throw new Error("The backup contains no restorable audio tracks.");
    if (!confirm(`Restore ${clean.tracks.length} track(s) from this backup? Tracks will be ADDED to your current library (duplicates by content are skipped).`)) return;
    const known = new Set(tracks.map(t => t.hash));
    const idMap = new Map(); let added = 0, skipped = 0;
    for (const raw of clean.tracks) {
      if (raw.hash && known.has(raw.hash)) { skipped++; continue; }
      const blob = fromBase64(raw.blobData, /\.wav$/i.test(raw.name) ? "audio/wav" : "audio/mpeg");
      const cover = raw.coverData ? fromBase64(raw.coverData, "image/jpeg") : null;
      const t = { id: raw.id || makeId(), name: raw.name, title: raw.title, artist: raw.artist, album: raw.album, duration: raw.duration, added: raw.added, hash: raw.hash, favorite: raw.favorite, blob, cover, metaV: 2 };
      if (tracks.some(x => x.id === t.id)) t.id = makeId();
      idMap.set(raw.id, t.id);
      await put(STORE, t); tracks.push(t); known.add(raw.hash); added++;
      if (raw.cents || raw.tempo !== 1) perTrack[t.id] = { cents: raw.cents, tempo: raw.tempo };
    }
    for (const p of clean.playlists) {
      const ids = p.trackIds.map(id => idMap.get(id)).filter(Boolean);
      if (!ids.length && p.trackIds.length) continue;
      const dest = playlists.find(x => x.name === p.name) || { id: makeId(), name: p.name, trackIds: [] };
      for (const id of ids) if (!dest.trackIds.includes(id)) dest.trackIds.push(id);
      if (!playlists.includes(dest)) playlists.push(dest);
    }
    if (clean.settings) settings = { ...settings, ...clean.settings };
    if (clean.lyrics) Object.assign(lyricsStore, clean.lyrics);
    await Promise.all([savePlaylists(), metaSet("settings", settings), metaSet("perTrack", perTrack)]);
    applySettings(); scheduleRender();
    say(`Restored ${added} track(s)${skipped ? `, ${skipped} duplicate(s) skipped` : ""}.`);
  } catch (e) { audioError(e); }
}

/* ------------------------------------------------------------------ sleep timer */
let sleepTimer = null;
function setSleep(min) {
  clearTimeout(sleepTimer);
  settings.sleepMin = min;
  if (min > 0) {
    sleepTimer = setTimeout(() => { audio.pause(); say("Sleep timer finished — playback paused."); }, min * 60000);
    say(`Sleep timer set for ${min} minutes.`);
  } else say("Sleep timer cleared.");
  metaSetSoon("settings", () => settings);
}

/* ------------------------------------------------------------------ A-B loop */
function setAB(which) {
  if (which === "A") { loopA = audio.currentTime; loopB = null; }
  else { if (loopA === null) return say("Set A first."); if (audio.currentTime <= loopA) return say("Point B must be after A."); loopB = audio.currentTime; }
  updateLoop();
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  $("browse").onclick = () => $("files").click();
  $("files").onchange = e => { addFiles(e.target.files); e.target.value = ""; };
  const drop = $("drop");
  for (const n of ["dragenter", "dragover"]) drop.addEventListener(n, e => { e.preventDefault(); drop.classList.add("over"); });
  for (const n of ["dragleave", "drop"]) drop.addEventListener(n, e => { e.preventDefault(); drop.classList.remove("over"); });
  drop.addEventListener("drop", e => { const f = [...e.dataTransfer.files]; if (f.length) addFiles(f); });

  $("play").onclick = async () => {
    if (currentId === null) { const id = queue.shift() || playlist()?.trackIds[0]; if (id) { saveQueueSoon(); await playTrack(id, true); } else say("Add a track first."); return; }
    try { if (ctx?.state === "suspended") await ctx.resume(); if (audio.paused) await audio.play(); else audio.pause(); }
    catch { say("Playback needs a user gesture. Press Play again."); }
  };
  $("prev").onclick = () => advance(-1);
  $("next").onclick = () => advance(1);
  $("skipBack").onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - settings.skip); };
  $("skipFwd").onclick = () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + settings.skip); };

  audio.addEventListener("play", () => { document.querySelector(".player").classList.add("playing"); $("playIcon").innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'; $("play").setAttribute("aria-label", "Pause"); });
  audio.addEventListener("pause", () => { document.querySelector(".player").classList.remove("playing"); $("playIcon").innerHTML = '<path d="M8 5v14l11-7z"/>'; $("play").setAttribute("aria-label", "Play"); });
  audio.addEventListener("ended", () => {
    if (repeat === "one") { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    const went = advance(1);
    if (!went && !queue.length) say("Track ended.");
  });
  audio.addEventListener("error", () => { if (audio.src) say("This audio could not be played. Try a different file."); });
  audio.addEventListener("timeupdate", () => {
    if (loopA !== null && loopB !== null && audio.currentTime >= loopB) audio.currentTime = loopA;
    $("currentTime").textContent = fmt(audio.currentTime);
    if (audio.duration && !$("seek").matches(":active")) $("seek").value = audio.currentTime / audio.duration * 1000;
  });
  audio.addEventListener("loadedmetadata", () => { $("duration").textContent = fmt(audio.duration); });

  $("seek").addEventListener("input", e => { if (audio.duration) audio.currentTime = Number(e.target.value) / 1000 * audio.duration; });
  $("pitch").addEventListener("input", e => setPitch(e.target.value));
  $("centsNumber").onchange = e => setPitch(e.target.value);
  $("tempo").addEventListener("input", e => setTempo(e.target.value));
  $("tempoNumber").onchange = e => setTempo(e.target.value);
  $("link").onchange = e => { settings.link = e.target.checked; applySettings(); };
  $("volume").addEventListener("input", e => { settings.volume = +e.target.value; applySettings(); });
  $("mute").onchange = e => { settings.mute = e.target.checked; applySettings(); };
  $("reverb").addEventListener("input", e => { settings.reverb = +e.target.value; applySettings(); });
  document.querySelectorAll(".eq").forEach((elm, i) => { elm.addEventListener("input", () => { settings.eq[i] = clamp(+elm.value || 0, -12, 12); applySettings(); }); });
  document.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => setPreset(b.dataset.preset));
  $("resetPitch").onclick = () => { settings.cents = 0; applySettings(); saveCurrent(); say("Pitch returned to 0 cents — original sound restored."); };
  $("resetTempo").onclick = () => { settings.tempo = 1; applySettings(); saveCurrent(); say("Speed back to 1.00×."); };

  $("setA").onclick = () => setAB("A");
  $("setB").onclick = () => setAB("B");
  $("clearLoop").onclick = () => { loopA = loopB = null; updateLoop(); };

  $("search").addEventListener("input", scheduleRender);
  $("clearSearch").onclick = () => { $("search").value = ""; $("viewSelect").value = "playlist"; scheduleRender(); };
  $("sort").onchange = scheduleRender;
  $("viewSelect").onchange = scheduleRender;
  $("playlistSelect").onchange = async e => { activePlaylist = e.target.value; await savePlaylists(); scheduleRender(); };
  $("newPlaylist").onclick = async () => { const name = prompt("Name your playlist:"); if (!name?.trim()) return; const p = { id: makeId(), name: name.trim().slice(0, 80), trackIds: [] }; playlists.push(p); activePlaylist = p.id; await savePlaylists(); scheduleRender(); say(`Created playlist “${p.name}”.`); };
  $("renamePlaylist").onclick = async () => { const p = playlist(), name = prompt("Rename playlist:", p.name); if (!name?.trim()) return; p.name = name.trim().slice(0, 80); await savePlaylists(); scheduleRender(); };
  $("deletePlaylist").onclick = async () => { const p = playlist(); if (p.id === "default") return say("The default playlist cannot be deleted."); if (!confirm(`Delete playlist “${p.name}”? The tracks themselves stay in your library.`)) return; playlists = playlists.filter(x => x !== p); activePlaylist = playlists[0]?.id || "default"; if (!playlists.length) playlists = [{ id: "default", name: "My graveyard", trackIds: [] }]; await savePlaylists(); scheduleRender(); say(`Deleted playlist “${p.name}”.`); };

  $("shuffle").onclick = () => { shuffle = !shuffle; $("shuffle").textContent = `Shuffle: ${shuffle ? "on" : "off"}`; $("shuffle").setAttribute("aria-pressed", String(shuffle)); };
  $("repeat").onclick = () => { repeat = repeat === "off" ? "all" : repeat === "all" ? "one" : "off"; $("repeat").textContent = `Repeat: ${repeat}`; };
  $("enqueueSel").onclick = () => { if (!selected.size) return say("Select tracks first."); [...selected].forEach(id => C.queueAdd(queue, id, "end")); saveQueueSoon(); renderQueue(); say(`${selected.size} track(s) queued.`); };
  $("clearQueue").onclick = () => { if (queue.length && confirm("Clear the whole queue?")) { queue = []; saveQueueSoon(); renderQueue(); } };

  $("selectAll").onclick = () => { viewRows().rows.forEach(t => selected.add(t.id)); scheduleRender(); };
  $("deleteSelected").onclick = async () => { if (!selected.size) return say("Select tracks to delete."); if (!confirm(`Delete ${selected.size} selected track(s) from the library? This removes their stored audio.`)) return; for (const id of [...selected]) await removeTrack(id); selected.clear(); scheduleRender(); };
  $("clearAll").onclick = async () => { if (!confirm("Remove every track from this playlist? Files referenced by other playlists remain in the library.")) return; for (const id of [...playlist().trackIds]) { playlist().trackIds = playlist().trackIds.filter(x => x !== id); if (!playlists.some(p => p.trackIds.includes(id))) await removeTrack(id); } await savePlaylists(); scheduleRender(); };

  $("exportWav").onclick = exportWav;
  $("exportBackup").onclick = backup;
  $("importBackup").onclick = () => $("backupFile").click();
  $("backupFile").onchange = e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; };
  $("sleepMin").onchange = e => setSleep(clamp(Math.round(+e.target.value || 0), 0, 240));
  $("skipSec").onchange = e => { settings.skip = clamp(Math.round(+e.target.value || 5), 1, 60); applySettings(); say(`Skip interval: ${settings.skip}s.`); };

  $("closeShortcuts").onclick = closeModal;
  $("shortcuts").addEventListener("click", e => { if (e.target === $("shortcuts")) closeModal(); });

  document.addEventListener("keydown", e => {
    if (e.target.matches("input,textarea,select") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "?") { e.preventDefault(); $("shortcuts").classList.add("open"); }
    else if (e.code === "Space") { e.preventDefault(); $("play").click(); }
    else if (e.key === "ArrowLeft") { audio.currentTime = Math.max(0, audio.currentTime - settings.skip); }
    else if (e.key === "ArrowRight") { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + settings.skip); }
    else if (e.key === "[") setPitch(settings.cents - 100);
    else if (e.key === "]") setPitch(settings.cents + 100);
    else if (e.key === "0") setPitch(0);
    else if (e.key.toLowerCase() === "m") $("mute").click();
    else if (e.key.toLowerCase() === "s") $("shuffle").click();
    else if (e.key.toLowerCase() === "r") $("repeat").click();
    else if (e.key.toLowerCase() === "q") $("enqueueSel").click();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) audio.dataset.wasPlaying = "1"; else delete audio.dataset.wasPlaying; });
  window.addEventListener("beforeunload", () => { for (const u of [...urls]) revoke(u); try { ctx?.close(); } catch { /* ignore */ } });

  try {
    if ("mediaSession" in navigator) {
      const h = navigator.mediaSession;
      h.setActionHandler("play", () => audio.play().catch(() => {}));
      h.setActionHandler("pause", () => audio.pause());
      h.setActionHandler("previoustrack", () => advance(-1));
      h.setActionHandler("nexttrack", () => advance(1));
      h.setActionHandler("seekbackward", () => { audio.currentTime = Math.max(0, audio.currentTime - settings.skip); });
      h.setActionHandler("seekforward", () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + settings.skip); });
    }
  } catch (e) { console.warn("Media Session handlers unavailable", e); }
}
function closeModal() { $("shortcuts").classList.remove("open"); }

/* ------------------------------------------------------------------ init */
async function init() {
  wire();
  try {
    db = await openDB();
    tracks = await getAll();
    await migrateOldLibrary();
    playlists = await metaGet("playlists", playlists);
    activePlaylist = await metaGet("activePlaylist", "default");
    settings = C.sanitizeSettings({ ...settings, ...(await metaGet("settings", {})) });
    perTrack = await metaGet("perTrack", {});
    queue = (await metaGet("queue", [])).filter(trackById); // drop stale references
    stats = await metaGet("stats", stats);
    lyricsStore = await metaGet("lyrics", {});
    for (const t of tracks) { if (!t.id) t.id = makeId(); if (!Number.isFinite(t.duration)) t.duration = 0; if (!Number.isFinite(t.added)) t.added = Date.now(); }
    if (!Array.isArray(playlists) || !playlists.length) playlists = [{ id: "default", name: "My graveyard", trackIds: tracks.map(t => t.id) }];
    if (!playlists.some(p => p.id === activePlaylist)) activePlaylist = playlists[0].id;
    const referenced = new Set(playlists.flatMap(p => p.trackIds));
    for (const t of tracks) if (!referenced.has(t.id)) playlists[0].trackIds.push(t.id);
    for (const p of playlists) p.trackIds = p.trackIds.filter(trackById); // prune deleted ids
    await savePlaylists();
    await persistHint();
    supportedExts = await C.detectFormats();
    $("acceptExt").textContent = supportedExts.join(" · ");
    $("files").accept = "." + supportedExts.join(",.") + ",audio/*";
    applySettings();
    render();
    retag();
    if (queue.length) $("queueCount").textContent = `${queue.length} queued`;
    if (playlist().trackIds.length) await playTrack(playlist().trackIds[0], false);
    if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js").catch(e => console.warn("PWA offline caching unavailable", e));
    say("Library ready.");
  } catch (e) {
    console.error(e);
    say("Local library could not be opened. Use a current browser and serve this folder over localhost or HTTPS.");
    $("storage").textContent = "IndexedDB unavailable; this version needs browser storage.";
  }
}
async function retag() {
  if (!window.DetuneTags) return;
  let n = 0;
  for (const t of tracks) {
    if (t.metaV >= 2 || !t.blob) continue;
    try {
      const g = await DetuneTags.read(t.blob, t.name);
      t.title = g.title || t.title; t.artist = g.artist || t.artist; t.album = g.album || t.album;
      if (g.picture && !t.cover) { const c = coverBlob(g.picture); if (c) t.cover = c; }
      t.metaV = 2; await put(STORE, t); n++;
    } catch (e) { console.warn(e); }
  }
  if (n) { scheduleRender(); const c = trackById(currentId); if (c) { $("title").textContent = c.title; $("artist").textContent = c.artist; setCover(c); updateMediaSession(c); } }
}
window.DetuneApp = { applySettings, computeModel: () => C.computePlayback(settings), settings, get currentId() { return currentId; }, trackById };
init();
})();
