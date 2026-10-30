/* Unit tests for core.js — run with: node tests/unit-test.js */
const assert = require("assert");
global.window = {};
require(__dirname + "/../core.js");
const C = global.window.DetuneCore;

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
assert.deepStrictEqual(q, ["a","b","a"], "end allows duplicates? NO — dedupe: " + JSON.stringify(q));
C.queueAdd(q, "c", "next");
assert.deepStrictEqual(q, ["c","a","b","a"], "next inserts at front (play next): " + JSON.stringify(q));

/* ---- hashFile determinism (pure JS fallback) ---- */
(async () => {
  const blob = new Blob(["hello detune world"]);
  const h1 = await C.hashFileWith(blob, null), h2 = await C.hashFileWith(blob, null);
  assert.strictEqual(h1, h2, "fallback hash deterministic");
  assert.strictEqual(h1.length, 67, "hex64 + dash + single-digit size");
  assert.match(h1, /^[0-9a-f]{64}-\d+$/, "hash shape is 64-hex dash size");
  const subtle = require("crypto").webcrypto.subtle;
  const h3 = await C.hashFileWith(blob, subtle);
  assert.strictEqual(h3.slice(0,64), sha("hello detune world"), "fallback matches real SHA-256 vector");
  const empty = await C.hashFileWith(new Blob([]), null);
  assert.strictEqual(empty, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855-0", "sha256 of empty blob + size 0");

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
  assert.strictEqual(C.parseLrc("[0:00.00]").lines.length, 0, "empty text dropped? -> keeps as gap line only if timed non-empty");

  /* ---- backup validation ---- */
  const good = { tracks: [{ name: "a.mp3", title: "A", artist: "", duration: 12, added: 1, blobData: "AAAA" }, { name: "bad", blobData: "" }], playlists: [{ name: "P", trackIds: [1,2] }] };
  const v = C.validateBackup(good);
  assert.strictEqual(v.tracks.length, 1, "invalid track dropped");
  assert.strictEqual(v.playlists[0].trackIds.length, 1, "index remapped");
  assert.strictEqual(v.playlists[0].trackIds[0], 0);
  assert.throws(() => C.validateBackup("nope"));
  assert.throws(() => C.validateBackup({ tracks: [] }));

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

  console.log("ALL UNIT TESTS PASSED");
})().catch(e => { console.error("UNIT TEST FAILURE:", e.message); process.exit(1); });
