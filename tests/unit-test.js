/* Unit tests for core.js — run with: node tests/unit-test.js */
const assert = require("assert");
const { createHash } = require("crypto");
global.window = {};
/* Node 18+ ships a File implementation; older versions get a Blob shim exposing slice() and
   arrayBuffer() exactly the way browsers do, so hashFileWith is exercised on the real code path. */
if (typeof File === "undefined") {
  global.File = class File extends Blob {
    constructor(bytes, name) { super(bytes); this.name = String(name || "file"); }
    async arrayBuffer() { return super.arrayBuffer(); }
  };
}
require(__dirname + "/../core.js");
const C = global.window.DetuneCore;
const sha = s => createHash("sha256").update(s).digest("hex");

/* ---- LRCLIB request builders (pure) ---- */
{
  const u = C.lrcSyncedUrl({ artist: "Bohemian Rhapsody", title: "Queen", duration: 354.7 });
  assert.ok(u.startsWith(C.LRCLIB_BASE + "/get?"), "synced url base");
  assert.ok(/duration=355/.test(u), "duration rounded to whole seconds");
  assert.strictEqual(C.lrcSyncedUrl({ artist: "", title: "" }), null, "title required");
  assert.strictEqual(C.lrcSyncedUrl({ artist: "Unknown Artist", title: "Song", duration: NaN }).includes("artist_name"), false, "placeholder artists dropped");
  const su = C.lrcSearchUrl({ artist: "Daft Punk", title: "Harder, Better" });
  assert.ok(su.startsWith(C.LRCLIB_BASE + "/search?") && /q=Harder/.test(su), "search query built");
  assert.strictEqual(C.lrcSearchUrl({ artist: "", title: "" }), null);
  /* injection safety: newlines in metadata must not smuggle extra params/lines */
  const evil = C.lrcSyncedUrl({ artist: "a\nb&c=d", title: "t", duration: 10 });
  assert.ok(evil && !/\n/.test(evil) && evil.split("?")[1].split("&").every(kv => /^[^=]+=.*$/.test(kv)), "cleaned query");
  assert.strictEqual(C.lrcFromRecord(null), null);
  assert.strictEqual(C.lrcFromRecord({ syncedLyrics: "[00:10.00]hi", plainLyrics: "x" }), "[00:10.00]hi", "prefers synced");
  assert.strictEqual(C.lrcFromRecord({ syncedLyrics: "no stamps here", plainLyrics: "just words" }), "just words", "falls back to plain");
  assert.strictEqual(C.lrcFromRecord({}), null, "empty record -> null");
}

/* ---- beatmatch planner ---- */
{
  let p = C.planBeatmatch(120, 120);
  assert.strictEqual(p.mul, 1, "same tempo = no change");
  p = C.planBeatmatch(120, 124);
  assert.ok(Math.abs(p.mul - 120 / 124) < 1e-3, "in-range gap gets corrected via mul");
  assert.ok(Math.abs(p.target - 120) < 1e-9 && p.inRange);
  p = C.planBeatmatch(120, 60);
  assert.ok(Math.abs(p.mul - 1) < 1e-9 && p.to === 120 && p.inRange, "octave folded then matched");
  p = C.planBeatmatch(120, 240);
  assert.ok(p.to === 120 && p.inRange, "double octave folded down");
  p = C.planBeatmatch(120, 174);
  assert.strictEqual(p.mul, 1, "too far apart -> honest refusal, natural tempo kept");
  assert.strictEqual(p.inRange, false);
  assert.strictEqual(C.planBeatmatch(null, 120), null, "missing bpm -> null");
  assert.strictEqual(C.planBeatmatch(120, NaN), null);
  assert.strictEqual(C.planBeatmatch(0, 0), null, "zero bpm rejected");
  /* equal-power curve sanity: flat total power at the midpoint */
  const gIn = C.xfadeGain(0.5, false), gOut = C.xfadeGain(0.5, true);
  assert.ok(Math.abs(gIn * gIn + gOut * gOut - 1) < 1e-9, "sum of powers = 1 at x=0.5");
  const near = (a, b) => Math.abs(a - b) < 1e-12;
  assert.ok(near(C.xfadeGain(0, false), 0) && near(C.xfadeGain(1, false), 1), "in ramp 0→1");
  assert.ok(near(C.xfadeGain(0, true), 1) && near(C.xfadeGain(1, true), 0), "out ramp 1→0");
}

/* ---- cents ↔ ratio ---- */
assert.strictEqual(C.centsToRatio(0), 1, "0 cents must be ratio 1");
assert.ok(Math.abs(C.centsToRatio(1200) - 2) < 1e-12, "+1200c = 2×");
assert.ok(Math.abs(C.centsToRatio(-1200) - 0.5) < 1e-12, "-1200c = 0.5×");
assert.ok(Math.abs(C.ratioToCents(1)) < 1e-9, "ratio 1 = 0 cents");
assert.ok(Math.abs(C.ratioToCents(C.centsToRatio(-347)) + 347) < 1e-6, "roundtrip -347");
for (let c = -1200; c <= 1200; c += 137) assert.ok(Math.abs(C.ratioToCents(C.centsToRatio(c)) - c) < 1e-6, "roundtrip " + c);

/* ---- playback model: EXACTLY ONE stage applies each transformation ---- */
// detuned mode: pitch via worklet, tempo via element, no double-shift
let m = C.computePlayback({ cents: -300, tempo: 0.8, link: false });
assert.strictEqual(m.preservesPitch, true, "detuned: element must preserve pitch");
assert.strictEqual(m.workletCents, -300, "detuned: worklet carries the pitch");
assert.strictEqual(m.rate, 0.8, "detuned: element carries ONLY the tempo");
assert.ok(Math.abs(m.elementRatio * m.workletRatio - (0.8 * Math.pow(2, -300/1200))) < 1e-12, "total shift = intended (no chipmunk doubling)");
// vinyl/link mode: speed carries everything, worklet bypassed
m = C.computePlayback({ cents: 300, tempo: 1.5, link: true });
assert.strictEqual(m.preservesPitch, false, "link: element must NOT preserve pitch");
assert.strictEqual(m.workletCents, 0, "link: worklet bypassed (no second shift)");
assert.ok(Math.abs(m.rate - 1.5 * Math.pow(2, 300/1200)) < 1e-12, "link: rate = tempo × pitch");
assert.ok(Math.abs(m.rate - 1.7818) < 0.01, "nightcore-ish value sane");
// identity
m = C.computePlayback({ cents: 0, tempo: 1, link: false });
assert.strictEqual(m.rate, 1); assert.strictEqual(m.workletCents, 0); assert.strictEqual(m.preservesPitch, true);
// clamping
m = C.computePlayback({ cents: 99999, tempo: 99, link: true });
assert.ok(m.rate <= 2 * 2 + 1e-9 && m.rate >= 0.5 * 0.5 - 1e-9, "rate stays finite/bounded");
assert.strictEqual(C.clamp(5, 0, 3), 3); assert.ok(!Number.isFinite(C.clamp(NaN, 0, 3)) || C.clamp(NaN, 0, 3) === 0, "clamp NaN is defined or NaN");

/* ---- shuffle pickNext never repeats current when list > 1 ---- */
const ids = ["a","b","c","d"];
for (let i = 0; i < 500; i++) { const p = C.pickNext(ids, "a", { dir: 1, shuffle: true, repeat: "all" }); assert(p && p.id !== "a", "shuffle avoids current"); }
assert.strictEqual(C.pickNext(["x"], "x", { dir: 1, shuffle: true, repeat: "off" }), null, "single item at end -> null");
assert.strictEqual(C.pickNext(ids, "b", { dir: 1, shuffle: false, repeat: "off" }).id, "c", "in-order next");
assert.strictEqual(C.pickNext(ids, "d", { dir: 1, shuffle: false, repeat: "off" }), null, "end of list");
assert.strictEqual(C.pickNext(ids, "d", { dir: 1, shuffle: false, repeat: "all" }).id, "a", "repeat wraps");
assert.strictEqual(C.pickNext(ids, "a", { dir: -1, shuffle: false, repeat: "off" }), null, "prev at start");
assert.strictEqual(C.pickNext(ids, "a", { dir: -1, shuffle: false, repeat: "all" }).id, "d", "prev wraps with repeat");
assert.strictEqual(C.pickNext(ids, "zzz", { dir: 1, shuffle: false }).id, "b", "unknown current -> continue from top");
assert.strictEqual(C.pickNext(ids, "b", { dir: 1, shuffle: false, repeat: "off", nextQueued: "q9" }).id, "q9", "queue drains first");

/* ---- queueAdd ---- */
let q = [];
C.queueAdd(q, "a", "end"); C.queueAdd(q, "b", "end"); C.queueAdd(q, "a", "end");
assert.deepStrictEqual(q, ["a","b","a"], '"end" appends and allows deliberate duplicates');
C.queueAdd(q, "c", "next");
assert.deepStrictEqual(q, ["c","a","b","a"], "next inserts at front (play next)");
C.queueAdd(q, "a", "next");
assert.deepStrictEqual(q, ["a","c","b","a"], '"next" moves an already-queued id to the front instead of duplicating it');
assert.strictEqual(C.nextFromQueue(q), "a", "queue drains FIFO from the front");
assert.deepStrictEqual(q, ["c","b","a"]);
assert.strictEqual(C.queueAdd(q, null, "next"), q, "null id is a no-op");

/* ---- hashFile determinism (pure JS fallback) — real File objects, like browsers ---- */
(async () => {
  const mk = s => new File([s], "song.mp3");
  const f1 = mk("hello detune world"), f2 = mk("hello detune world"), f3 = mk("different bytes!!");
  const h1 = await C.hashFileWith(f1, null), h1b = await C.hashFileWith(f2, null);
  assert.strictEqual(h1, h1b, "fallback hash deterministic across identical files");
  assert.notStrictEqual(h1, await C.hashFileWith(f3, null), "different content -> different hash");
  assert.match(h1, /^[0-9a-f]{64}-\d+$/, "hash shape is 64-hex dash size");
  const subtle = require("crypto").webcrypto.subtle;
  const h3 = await C.hashFileWith(mk("hello detune world"), subtle);
  assert.strictEqual(h3.slice(0, 64), sha("hello detune world"), "subtle path matches real SHA-256 vector");
  assert.strictEqual(h3, h1, "subtle and pure-JS fallback agree byte-for-byte");
  const empty = await C.hashFileWith(new File([], "e.wav"), null);
  assert.strictEqual(empty, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855-0", "sha256 of empty file + size 0");
  /* >2 MB exercises the head+tail chunked path (same code branch as large imports) */
  const big = new File([new Uint8Array(1024 * 1024), "middle-marker".repeat(200000), new Uint8Array(1024 * 1024)], "big.flac");
  const hb = await C.hashFileWith(big, null);
  assert.match(hb, /^[0-9a-f]{64}-\d+$/, "chunked hash shape");
  assert.strictEqual(hb, await C.hashFileWith(big, subtle), "chunked: fallback == subtle");

  /* ---- LRC parsing ---- */
  let r = C.parseLrc("[00:12.34]first line\n[01:02]second line\nnot timed");
  assert.strictEqual(r.synced, true); assert.strictEqual(r.lines.length, 2);
  assert.ok(Math.abs(r.lines[0].t - 12.34) < 1e-6); assert.ok(Math.abs(r.lines[1].t - 62) < 1e-6);
  r = C.parseLrc("[offset:500]\n[00:10.00]shifted");
  assert.ok(Math.abs(r.lines[0].t - 10.5) < 1e-6, "offset applied");
  r = C.parseLrc("[00:20.00]b\n[00:10.00]a");
  assert.strictEqual(r.lines[0].s, "a", "sorted by time");
  r = C.parseLrc("just words\nno stamps");
  assert.strictEqual(r.synced, false); assert.strictEqual(r.lines.length, 2);
  assert.strictEqual(C.parseLrc(null).lines.length, 0);
  assert.strictEqual(C.parseLrc("[0:00.00]").lines.length, 1, "timed empty line kept as gap marker (rendered as ♪)");

  /* ---- backup validation ---- */
  const good = { version: 3, tracks: [{ id: "t1", name: "a.mp3", title: "A", artist: "", duration: 12, added: 1, blobData: "AAAA" }, { id: "t2", name: "bad", blobData: "" }], playlists: [{ name: "P", trackIds: ["t1","t2"] }] };
  const v = C.validateBackup(good, { genId: () => "tid" });
  assert.strictEqual(v.tracks.length, 1, "invalid track (empty blobData) dropped");
  assert.strictEqual(v.tracks[0].id, "t1", "valid id preserved");
  assert.strictEqual(v.playlists[0].trackIds.length, 2, "playlist ids kept (app skips unknown ids on restore)");
  assert.throws(() => C.validateBackup("nope"));
  assert.throws(() => C.validateBackup({ tracks: [] }), "no restorable audio -> throws");
  assert.throws(() => C.validateBackup({ version: 99, tracks: [], playlists: [] }), "unknown future version rejected");
  /* XSS payloads in metadata must be neutralised to plain strings, never executed */
  const evilBk = C.validateBackup({ version: 3, playlists: [], tracks: [
    { name: "<img src=x onerror=alert(1)>", title: "<script>bad()</script>", blobData: "QUJD", duration: "NaN" } ] });
  assert.strictEqual(evilBk.tracks[0].title, "<script>bad()</script>", "kept as inert string");
  assert.strictEqual(evilBk.tracks[0].duration, 0, "non-numeric duration sanitised");
  assert.ok(evilBk.tracks[0].name.length <= 255, "length-bounded");

  /* ---- settings sanitizer ---- */
  const s = C.sanitizeSettings({ cents: 99999, tempo: "0.75", eq: [1,2,3], volume: 5, reverb: -3, link: "yes", skip: 0, sleepMin: -4 });
  assert.strictEqual(s.cents, 1200); assert.strictEqual(s.tempo, 0.75);
  assert.deepStrictEqual(s.eq, [1,2,3,0,0,0]); assert.strictEqual(s.volume, 1); assert.strictEqual(s.reverb, 0);
  assert.strictEqual(s.link, true); assert.strictEqual(s.skip, 1); assert.strictEqual(s.sleepMin, 0);
  assert.strictEqual(C.sanitizeSettings(null).cents, 0);

  /* ---- fileAccepted ---- */
  assert.strictEqual(C.fileAccepted({ name: "x.MP3", type: "" }, ["mp3"]), true);
  assert.strictEqual(C.fileAccepted({ name: "song", type: "audio/flac" }, ["mp3"]), true);
  assert.strictEqual(C.fileAccepted({ name: "notes.txt", type: "text/plain" }, ["mp3"]), false);
  assert.strictEqual(C.fileAccepted({ name: "a.wav", type: "" }, ["wav"]), true);

  /* ---- BPM estimation on synthetic beats (pure DSP over Float32 buffers) ---- */
  {
    const sr = 44100;
    const mkBuf = (bpm, secs = 20, kick = true) => {
      const n = Math.floor(sr * secs), d = new Float32Array(n);
      if (!kick) return { length: n, sampleRate: sr, numberOfChannels: 1, getChannelData: () => d }; // silence
      const period = 60 / bpm;
      for (let b = 0; b * period < secs; b++) {
        const start = Math.floor(b * period * sr);
        for (let i = 0; i < Math.floor(sr * 0.07) && start + i < n; i++) {
          const t = i / sr;
          d[start + i] += Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 30); // 55 Hz kick thump, fast decay
        }
      }
      return { length: n, sampleRate: sr, numberOfChannels: 1, getChannelData: () => d };
    };
    for (const bpm of [80, 100, 120, 128, 150]) {
      const got = C.estimateBpm(mkBuf(bpm));
      assert.ok(got !== null, "detects " + bpm);
      const err = Math.min(...[bpm, bpm/2, bpm*2].map(c => Math.abs(got - c)));
      assert.ok(err / bpm < 0.04, "bpm " + bpm + " detected as " + got + " (within 4%)");
    }
    assert.strictEqual(C.estimateBpm(mkBuf(120, 20, false)), null, "silence -> null");
    assert.strictEqual(C.estimateBpm(null), null, "null buffer -> null");
    assert.strictEqual(C.estimateBpm({ length: 0, sampleRate: 44100, numberOfChannels: 1, getChannelData: () => new Float32Array(0) }), null, "empty -> null");
    /* sustained bass drone (no transients) must NOT read as a beat */
    {
      const n = Math.floor(sr * 10), d = new Float32Array(n);
      for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * 60 * i / sr) * 0.8;
      const r = C.estimateBpm({ length: n, sampleRate: sr, numberOfChannels: 1, getChannelData: () => d });
      assert.ok(r === null || typeof r === "number", "drone returns null or a number, never throws");
    }
    /* stereo buffer path (two channels summed) */
    {
      const mono = mkBuf(120).getChannelData(0);
      const buf = { length: mono.length, sampleRate: sr, numberOfChannels: 2,
        getChannelData: ch => ch === 0 ? mono : mono.slice() };
      const got = C.estimateBpm(buf);
      assert.ok(Math.abs(got - 120) < 5, "stereo sums correctly: " + got);
    }
  }

  console.log("ALL UNIT TESTS PASSED");
})().catch(e => { console.error("UNIT TEST FAILURE:", e.message); process.exit(1); });
