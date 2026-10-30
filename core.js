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
      /* Vinyl mode: the element's raw rate carries BOTH pitch and tempo; the worklet is bypassed
         so nothing is applied twice. */
      const rate = clamp(tempo * centsToRatio(cents), 0.0625, 4);
      return { rate, workletCents: 0, preservesPitch: false, cents, tempo,
               elementRatio: rate, workletRatio: 1 };
    }
    /* Detuned mode: worklet does the pitch (time-stretch), element does ONLY the tempo with
       preservesPitch latched ON — exactly one stage per transformation, no chipmunk doubling. */
    return { rate: tempo, workletCents: cents, preservesPitch: true, cents, tempo,
             elementRatio: tempo, workletRatio: centsToRatio(cents) };
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
  /* Pure-JS SHA-256 fallback for non-secure contexts (plain http on a LAN IP), where
     crypto.subtle is undefined. Deterministic and content-only, so duplicate detection
     survives reloads instead of silently failing like the old name:size:mtime key did. */
  const SHA_K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256Hex(u8) {
    const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const len = u8.length, total = ((len + 9) >> 6 << 6) + 64; // 64-byte blocks incl. 0x80 + 8-byte length
    const m = new Uint8Array(total); m.set(u8); m[len] = 0x80;
    const bitsHi = Math.floor(len / 2 ** 29), bitsLo = (len * 8) >>> 0;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 8, bitsHi); dv.setUint32(total - 4, bitsLo);
    const w = new Uint32Array(64);
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [(H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,(H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0];
    }
    return H.map(x => x.toString(16).padStart(8, "0")).join("");
  }

  async function hashFileWith(file, subtle) {
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
    /* Content-only hash + size. Never include name/lastModified: the same song imported twice
       (renamed, or re-dropped after a failed save) must be detected as a duplicate, and the
       hash must stay stable across sessions so dedupe survives reloads. */
    if (!subtle) return sha256Hex(buf) + "-" + file.size; // non-secure-context fallback (pure JS)
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
    if (text == null || text === "") return { synced: false, lines: [] };
    text = String(text).replace(/\r/g, "");
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
    s = (s && typeof s === "object") ? s : {};
    const out = {
      cents: clamp(Math.round(+s.cents || 0), -1200, 1200),
      tempo: clamp(+s.tempo || 1, 0.5, 2),
      link: !!s.link,
      volume: clamp(+s.volume ?? 0.8, 0, 1),
      mute: !!s.mute,
      reverb: clamp(+s.reverb || 0, 0, 1),
      /* Always exactly 6 bands; missing entries pad with 0 (UI indexes filters[i] positionally). */
      eq: (() => { const src = Array.isArray(s.eq) ? s.eq : []; const e = []; for (let i = 0; i < 6; i++) e.push(clamp(+src[i] || 0, -12, 12)); return e; })(),
      skip: (() => { const v = Math.round(+s.skip || 0); return v < 0 ? 5 : clamp(v, 1, 60); })(),
      vizMode: ["spectrum", "bars", "scope", "circle"].includes(s.vizMode) ? s.vizMode : "spectrum",
      vizFx: s.vizFx === undefined ? true : !!s.vizFx,
      crossfade: clamp(+s.crossfade || 0, 0, 12),
      beatmatch: !!s.beatmatch,
      resume: s.resume === undefined ? true : !!s.resume,
      theme: s.theme === "light" ? "light" : "dark",
      accentHue: clamp(Math.round(+s.accentHue || 355), 0, 360),
      sleepMin: clamp(Math.round(+s.sleepMin || 0), 0, 240),
    };
    return out;
  }
  const DEFAULT_SETTINGS = sanitizeSettings({});

  /* ---------- LRCLIB (https://lrclib.net/docs) — pure request builders, testable in Node.
     The app only ever calls these with locally-known title/artist/duration; nothing else
     about the user's library leaves the browser. ---- */
  const LRCLIB_BASE = "https://lrclib.net/api";
  function lrcClean(s) { return String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim().slice(0, 200); }
  function lrcSyncedUrl({ artist, title, duration }) {
    const p = new URLSearchParams();
    const a = lrcClean(artist), t = lrcClean(title);
    if (a && !/^(unknown|unknown artist)$/i.test(a)) p.set("artist_name", a);
    if (t) p.set("track_title", t);
    if (Number.isFinite(duration) && duration > 0) p.set("duration", Math.round(duration));
    if (!p.has("track_title")) return null; // API requires at least a track title
    return `${LRCLIB_BASE}/get?${p.toString()}`;
  }
  function lrcSearchUrl({ artist, title }) {
    const p = new URLSearchParams();
    const q = [lrcClean(title), lrcClean(artist)].filter(x => x && !/^(unknown|unknown artist)$/i.test(x)).join(" ");
    if (!q) return null;
    p.set("q", q);
    return `${LRCLIB_BASE}/search?${p.toString()}`;
  }
  /* Map an LRCLIB record to our raw-LRC text (or null). Prefers synced lyrics so the
     highlighter works; falls back to plain text. Never fabricates timestamps. */
  function lrcFromRecord(rec) {
    if (!rec || typeof rec !== "object") return null;
    const synced = typeof rec.syncedLyrics === "string" ? rec.syncedLyrics.trim() : "";
    const plain = typeof rec.plainLyrics === "string" ? rec.plainLyrics.trim() : "";
    if (synced && /\[\d{1,3}:\d{1,2}/.test(synced)) return synced;
    if (plain) return plain;
    return null;
  }

  /* ---------- BPM estimation (autocorrelation on band-limited onset energy) ----------
     Pure DSP over an AudioBuffer — deterministic and unit-testable with synthetic beats.
     Steps: lowpass ~200 Hz → envelope (rectify + 50 Hz lowpass) → 40 Hz highpass to strip
     the DC bias (this is what makes sustained bass count as energy instead of "beats") →
     normalise → autocorrelation over 70–190 BPM → parabolic peak interpolation. */
  function estimateBpm(buffer) {
    try {
      if (!buffer || !buffer.length || !buffer.sampleRate) return null;
      const sr = buffer.sampleRate;
      const chA = buffer.getChannelData(0);
      const chB = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
      const win = Math.min(chA.length, Math.floor(sr * 30)); // analyse first 30 s — plenty for tempo
      const fs = sr / 8;                                     // decimate ×8 (e.g. 44.1k → 5.5125 kHz)
      const n = Math.floor(win / 8);
      if (n < fs) return null;                               // under one second of audio
      /* 8× decimation lowpass (~Nyquist/8 ≈ 550 Hz @44.1k) — kills aliasing before downsample */
      const taps = 17, h = new Float32Array(taps);
      { let s = 0; const fc = 0.115;
        for (let i = 0; i < taps; i++) { const x = i - (taps >> 1); h[i] = x === 0 ? 2 * fc : Math.sin(Math.PI * fc * x) / (Math.PI * x); }
        for (let i = 0; i < taps; i++) { const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1)); h[i] *= w; s += h[i]; }
        for (let i = 0; i < taps; i++) h[i] /= s; }
      const env = new Float32Array(n);
      /* Kick-band envelope: two cascaded one-pole lowpass ≈150 Hz @5.5 kHz (state persists
         across every sample), rectified, RMS per decimated frame, then a DC-blocking HPF so
         a sustained sub-bass drone counts as *energy*, not as beats. */
      const aLP = 1 - Math.exp(-2 * Math.PI * 150 / fs);
      const aHP = Math.exp(-2 * Math.PI * 40 / fs);          // one-pole HPF ≈40 Hz @5.5 kHz
      let lp1 = 0, lp2 = 0, xPrev = 0, yPrev = 0;
      for (let i = 0; i < n; i++) {
        const base = i * 8;
        let acc = 0;
        for (let j = 0; j < 8; j++) {
          const k = base + j; if (k >= win) break;
          let x = chA[k]; if (chB) x = (x + chB[k]) * 0.5;   // mono sum keeps stereo decks fair
          lp1 += aLP * (x - lp1); lp2 += aLP * (lp1 - lp2);
          acc += lp2 * lp2;                                  // rectify: energy of the kick band
        }
        const e = Math.sqrt(acc / 8);
        const dc = e - xPrev + yPrev;                        // HPF difference equation
        xPrev = e; yPrev = dc;
        env[i] = dc > 0 ? dc : 0;                            // keep onsets only
      }
      let m = 0; for (let i = 0; i < n; i++) m += env[i]; m /= n;
      if (!(m > 1e-7)) return null;                          // silence → no guess
      /* Adaptive binarisation (~25% of mean onset height): makes autocorrelation fire on the
         KICK pulse instead of riding the continuous bassline wobble. */
      const thr = m * 0.25;
      for (let i = 0; i < n; i++) env[i] = env[i] > thr ? 1 : 0;
      const lagMin = Math.max(1, Math.round(fs * 60 / 200)); // 200 BPM ceiling
      const lagMax = Math.min(n - 2, Math.round(fs * 60 / 60)); // 60 BPM floor
      if (lagMax - lagMin < 2) return null;
      const ac = new Float32Array(lagMax + 2);
      for (let lag = lagMin; lag <= lagMax; lag++) {
        let s = 0;
        for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
        ac[lag] = s / (n - lag);                             // unbiased — short lags stay honest
      }
      /* Octave disambiguation: tempo octaves all correlate, and the *fundamental* (longest
         strong lag) reads best for beatmatching. Walk down from the slowest tempo; accept a
         lag if it's within 2% of the global max AND no smaller divisor lag (lag/2, lag/3…)
         is equally strong. Bounded scan — stops at the first accepted candidate. */
      let gmax = 0;
      for (let lag = lagMin; lag <= lagMax; lag++) if (ac[lag] > gmax) gmax = ac[lag];
      if (!(gmax > 0)) return null;
      const eps = gmax * 0.98;
      let best = 0;
      for (let lag = lagMax; lag >= lagMin && !best; lag--) {
        if (ac[lag] < eps) continue;
        let dominatedByDivisor = false;
        /* Check every exact divisor lag q (lag = q*h): does q itself correlate strongly?
           Bounded by q >= lagMin, so this always terminates. */
        for (let h = 2; ; h++) {
          const q = Math.floor(lag / h);
          if (q < lagMin) break;                 // divisors only get smaller — done
          if (q * h === lag && ac[q] >= eps) { dominatedByDivisor = true; break; }
        }
        if (!dominatedByDivisor) best = lag;
      }
      if (!best) { best = lagMin; for (let lag = lagMin + 1; lag <= lagMax; lag++) if (ac[lag] > ac[best]) best = lag; }
      let lag = best;                                        // parabolic interpolation around the peak
      if (best > lagMin && best < lagMax) {
        const d = ac[best - 1] - 2 * ac[best] + ac[best + 1];
        if (Math.abs(d) > 1e-12) lag = best - 0.5 * (ac[best + 1] - ac[best - 1]) / d;
      }
      let bpm = 60 * fs / lag;
      while (bpm < 70) bpm *= 2;                             // fold into a DJ-friendly window
      while (bpm > 190) bpm /= 2;
      return Math.round(bpm * 10) / 10;
    } catch { return null; }
  }

  /* ---------- beatmatch tempo planning (pure — unit-testable) ----------
     Given the BPMs of the outgoing and incoming tracks, decide how much to temporarily
     alter the INCOMING track's playback rate so the two decks align. Rules:
       • Either BPM missing / non-finite → no match (null).
       • Fold octave errors first: halve/double the candidate until it is within ±12% of
         the target (DJ-standard 68–136 window means only one doubling/halving is ever needed).
       • If the folded gap exceeds maxPct percent → leave the incoming at its natural tempo
         but report the folded value as `matched` so the UI can show "would fit at X BPM".
       • Otherwise return a multiplier (incomingRate = settings.tempo × mul) that lands the
         decks within maxPct of each other. */
  function planBeatmatch(currentBpm, nextBpm, maxPct = 6) {
    if (!Number.isFinite(currentBpm) || !Number.isFinite(nextBpm) || currentBpm <= 0 || nextBpm <= 0) return null;
    const lim = clamp(maxPct, 0.5, 25) / 100;
    let n = nextBpm;
    while (n > currentBpm * 1.12) n /= 2;
    while (n < currentBpm / 1.12) n *= 2;
    const ratio = currentBpm / n;
    const matched = Math.round(n * 10) / 10;
    if (Math.abs(ratio - 1) <= lim) {
      return { mul: Math.round(ratio * 10000) / 10000, from: Math.round(nextBpm * 10) / 10, to: matched, target: Math.round(currentBpm * 10) / 10, inRange: true };
    }
    return { mul: 1, from: Math.round(nextBpm * 10) / 10, to: matched, target: Math.round(currentBpm * 10) / 10, inRange: false };
  }

  /* Equal-power crossfade curve for x ∈ [0,1]. cos/sin pair keeps summed power flat. */
  const xfadeGain = (x, out) => { const t = clamp(x, 0, 1); return out ? Math.cos(t * Math.PI / 2) : Math.sin(t * Math.PI / 2); };

  /* Pick the best usable record from an LRCLIB /get or /search JSON response.
     Pure so it can be unit-tested without fetch(). Never throws on garbage input. */
  function lrcPick(json) {
    if (!json) return null;
    const arr = Array.isArray(json) ? json : (typeof json === "object" ? [json] : []);
    for (const rec of arr) { const txt = lrcFromRecord(rec); if (txt) return txt; }
    return null;
  }

  /* ---------- queue semantics ---------- */
  function makeQueue() { return []; }
  /* Queue semantics: the playback queue is a list of upcoming tracks.
     - "next": insert at the front so it plays immediately after the current track.
       Duplicates of an already-queued id are MOVED to the front rather than added twice
       (playing the same queued song "now" shouldn't create two entries).
     - "end": append; duplicates are allowed (classic "add to queue" behaviour). */
  function queueAdd(q, id, position) {
    if (!id) return q;
    if (position === "next") {
      const i = q.indexOf(id);
      if (i >= 0) q.splice(i, 1);
      q.unshift(id);
    } else {
      q.push(id);
    }
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
    makeQueue, queueAdd, nextFromQueue, pickNext, EQ_FREQS, NOTE_NAMES, sha256Hex,
    lrcSyncedUrl, lrcSearchUrl, lrcFromRecord, lrcPick, estimateBpm, LRCLIB_BASE,
    planBeatmatch, xfadeGain,
  };
})(typeof window !== "undefined" ? window : globalThis);
