/* Detune core library — pure, environment-independent helpers shared by app.js and the Node test suite.
   No DOM, no IndexedDB: everything here is deterministic and unit-testable. */
(function (global) {
  "use strict";

  /* ---------- cents ↔ ratio (the one true conversion) ---------- */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const centsToRatio = (cents) => Math.pow(2, clamp(cents, -1200, 1200) / 1200);
  const ratioToCents = (r) => 1200 * Math.log2(r);

  /* ---------- playback model (single source of truth) ----------
     UNLINKED ("Detuned" mode): audio.playbackRate = tempo, preservesPitch = true,
       worklet receives settings.cents. Duration changes with tempo; pitch only via worklet.
     LINKED ("Vinyl" mode): audio.playbackRate = 2^(cents/1200), preservesPitch = false,
       worklet receives 0 (bypassed). The naive rate change IS the shift — applied exactly once.
     Never let both stages apply the same transformation. */
  function computePlayback(settings) {
    const cents = clamp(Math.round(settings.cents || 0), -1200, 1200);
    const tempo = clamp(Number(settings.tempo) || 1, 0.5, 2);
    if (settings.link) {
      return { rate: centsToRatio(cents), workletCents: 0, preservesPitch: false, cents, tempo };
    }
    return { rate: tempo, workletCents: cents, preservesPitch: true, cents, tempo };
  }

  /* ---------- note names for the pitch readout ---------- */
  const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  function freqToNote(freq) {
    if (!Number.isFinite(freq) || freq <= 0) return null;
    const n = Math.round(69 + 12 * Math.log2(freq / 440));
    const centsOff = Math.round(ratioToCents(freq / 440) - (n - 69) * 100);
    return { name: NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1), cents: centsOff, midi: n };
  }

  /* ---------- duplicate detection ----------
     Hashing only the first 1 MB + size can collide between different tracks that share a header
     region. Strategy: hash head (1 MB) + tail (1 MB) + size. For files ≤ 2 MB this covers every
     byte (exact). Larger files remain probabilistic but far more discriminating than head-only. */
  async function hashFileWith(file, subtle) {
    if (!subtle) return `${file.name}:${file.size}:${file.lastModified}`; // non-secure-context fallback
    const TAIL = 1024 * 1024;
    let buf;
    if (file.size <= TAIL * 2) {
      buf = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
    } else {
      const head = new Uint8Array(await file.slice(0, TAIL).arrayBuffer());
      const tail = new Uint8Array(await file.slice(file.size - TAIL).arrayBuffer());
      buf = new Uint8Array(TAIL * 2);
      buf.set(head, 0); buf.set(tail, TAIL);
    }
    const digest = await subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("") + `-${file.size}`;
  }

  /* ---------- format support ----------
     Promise-based capability probe so we never promise formats the browser cannot decode. */
  const FORMAT_CANDIDATES = [
    ["audio/mpeg", "mp3"], ["audio/wav", "wav"], ["audio/x-wav", "wav"], ["audio/ogg", "ogg"],
    ["audio/opus", "opus"], ["audio/flac", "flac"], ["audio/mp4", "m4a"], ["audio/aac", "aac"],
    ["audio/webm;codecs=opus", "weba"], ["audio/webm", "weba"]
  ];
  async function detectFormats() {
    const probe = typeof Audio !== "undefined" ? new Audio() : null;
    const ok = [];
    for (const [mime, ext] of FORMAT_CANDIDATES) {
      try { if (probe && probe.canPlayType(mime)) ok.push(ext); } catch { /* ignore */ }
    }
    return ok.length ? ok : ["mp3", "wav"];
  }
  function fileAccepted(file, exts) {
    const ext = /\.([a-z0-9]+)$/i.exec(file.name || "");
    const byExt = ext ? exts.includes(ext[1].toLowerCase()) : false;
    const byMime = /^audio\//.test(file.type || "") ||
      ["audio/mp4", "audio/x-m4a", "audio/aac", "video/webm"].includes(file.type);
    // Accept when either the extension or MIME matches a supported/probable audio type:
    // never silently discard valid files whose extension is missing or misleading.
    return byExt || byMime;
  }

  /* ---------- LRC lyrics parsing (offsets, multiple timestamps, malformed lines) ---------- */
  function parseLrc(text) {
    text = String(text == null ? "" : text).replace(/\r/g, "");
    const out = [];
    const tre = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    let off = 0, any = false;
    for (const ln of text.split("\n")) {
      const om = ln.match(/^\[offset:\s*(-?\d+)\s*\]/i);
      if (om) { off = +om[1] / 1000; continue; }
      if (/^\[[a-z]{2,6}:[^\]]*\]\s*$/i.test(ln)) continue; // metadata tags like [ar:..], [by:..]
      const times = [];
      let m; tre.lastIndex = 0;
      while ((m = tre.exec(ln))) {
        const frac = m[3] ? parseFloat("0." + m[3]) : 0; // ".45" → 0.45 s, ".450" → 0.45 s
        times.push(clamp(+m[1] * 60 + +m[2] + frac + off, 0, 24 * 3600));
      }
      const s = ln.replace(tre, "").replace(/<\d+:\d+(?:\.\d+)?>/g, "").trim();
      if (times.length) { any = true; for (const t of times) out.push({ t, s }); }
      else out.push({ t: null, s });
    }
    if (any) { out.sort((x, y) => x.t - y.t); return { synced: true, lines: out.filter((l) => l.t !== null) }; }
    return { synced: false, lines: out };
  }

  /* ---------- backup validation (versioned, defensive) ---------- */
  const BACKUP_VERSIONS = [1, 2, 3];
  function validateBackup(data) {
    if (!data || typeof data !== "object") throw new Error("Backup is not an object.");
    if (!BACKUP_VERSIONS.includes(data.version)) throw new Error(`Unsupported backup version ${data.version}.`);
    if (!Array.isArray(data.tracks)) throw new Error("Backup has no track list.");
    if (!Array.isArray(data.playlists)) throw new Error("Backup has no playlists.");
    const cleanTracks = [], seenIds = new Set();
    for (const raw of data.tracks) {
      if (!raw || typeof raw !== "object") continue;
      if (typeof raw.blobData !== "string" || !raw.blobData) continue; // audio is mandatory in v2/v3
      if (/^\s*(javascript|data:text\/html)/i.test(raw.blobData)) continue; // refuse non-audio payloads
      const t = {
        id: typeof raw.id === "string" ? raw.id.slice(0, 64) : "",
        name: String(raw.name || "track").slice(0, 255),
        title: String(raw.title || raw.name || "Untitled").slice(0, 300),
        artist: String(raw.artist || "").slice(0, 300),
        album: String(raw.album || "").slice(0, 300),
        duration: Number.isFinite(+raw.duration) && +raw.duration > 0 ? +raw.duration : 0,
        added: Number.isFinite(+raw.added) ? +raw.added : Date.now(),
        cents: clamp(Math.round(+raw.cents || 0), -1200, 1200),
        tempo: clamp(+raw.tempo || 1, 0.5, 2),
        hash: typeof raw.hash === "string" ? raw.hash.slice(0, 128) : "",
        favorite: !!raw.favorite,
        plays: Math.max(0, Math.round(+raw.plays || 0)),
        blobData: raw.blobData,
        coverData: typeof raw.coverData === "string" && raw.coverData ? raw.coverData : null,
      };
      if (seenIds.has(t.id)) t.id = ""; // duplicate ids → regenerate downstream
      seenIds.add(t.id);
      cleanTracks.push(t);
    }
    const playlists = data.playlists.map((p) => ({
      id: typeof p?.id === "string" ? p.id.slice(0, 64) : "",
      name: String(p?.name || "Playlist").slice(0, 80),
      trackIds: Array.isArray(p?.trackIds) ? p.trackIds.filter((x) => typeof x === "string") : [],
    }));
    const settings = data.settings && typeof data.settings === "object" ? sanitizeSettings(data.settings) : null;
    return { version: data.version, tracks: cleanTracks, playlists, activePlaylist: String(data.activePlaylist || ""), settings, stats: data.stats && typeof data.stats === "object" ? data.stats : null, lyrics: data.lyrics && typeof data.lyrics === "object" ? data.lyrics : null };
  }

  /* ---------- settings sanitisation (never trust persisted/imported values) ---------- */
  const EQ_FREQS = [60, 170, 350, 1000, 3500, 10000];
  function sanitizeSettings(s) {
    const out = {
      cents: clamp(Math.round(+s.cents || 0), -1200, 1200),
      tempo: clamp(+s.tempo || 1, 0.5, 2),
      link: !!s.link,
      volume: clamp(+s.volume ?? 0.8, 0, 1),
      mute: !!s.mute,
      reverb: clamp(+s.reverb || 0, 0, 1),
      eq: Array.isArray(s.eq) ? s.eq.slice(0, 6).map((g) => clamp(+g || 0, -12, 12)) : [0, 0, 0, 0, 0, 0],
      skip: clamp(Math.round(+s.skip || 5), 1, 60),
      vizMode: ["spectrum", "bars", "scope", "circle"].includes(s.vizMode) ? s.vizMode : "spectrum",
      vizFx: s.vizFx === undefined ? true : !!s.vizFx,
      crossfade: clamp(+s.crossfade || 0, 0, 12),
      resume: s.resume === undefined ? true : !!s.resume,
      theme: s.theme === "light" ? "light" : "dark",
      accentHue: clamp(Math.round(+s.accentHue || 355), 0, 360),
      sleepMin: clamp(Math.round(+s.sleepMin || 0), 0, 240),
    };
    return out;
  }
  const DEFAULT_SETTINGS = sanitizeSettings({});

  /* ---------- queue semantics ---------- */
  function makeQueue() { return []; }
  function queueAdd(q, id, position) {
    if (!id) return q;
    if (position === "next") q.unshift(id); else q.push(id);
    return q;
  }
  function nextFromQueue(q) { return q.length ? q.shift() : null; }

  /* ---------- repeat/shuffle next-track logic (pure) ---------- */
  function pickNext(ids, currentId, opts) {
    if (!ids.length) return null;
    if (opts.nextQueued) return { id: opts.nextQueued, via: "queue" };
    if (opts.shuffle && ids.length > 1) {
      const from = ids.indexOf(currentId);
      let n = from, guard = 0;
      while (n === from && guard++ < 64) n = Math.floor(Math.random() * ids.length);
      return { id: ids[n], via: "shuffle" };
    }
    const i = Math.max(0, ids.indexOf(currentId));
    const j = i + (opts.dir || 1);
    if (j >= ids.length) {
      if (opts.repeat === "all") return { id: ids[0], via: "wrap" };
      return null; // end of playlist with repeat off
    }
    if (j < 0) {
      if (opts.repeat === "all") return { id: ids[ids.length - 1], via: "wrap" };
      return null;
    }
    return { id: ids[j], via: "order" };
  }

  global.DetuneCore = {
    clamp, centsToRatio, ratioToCents, computePlayback, freqToNote, hashFileWith,
    detectFormats, fileAccepted, parseLrc, validateBackup, sanitizeSettings, DEFAULT_SETTINGS,
    makeQueue, queueAdd, nextFromQueue, pickNext, EQ_FREQS, NOTE_NAMES,
  };
})(typeof window !== "undefined" ? window : globalThis);
