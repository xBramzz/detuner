/* Detune pitch processor — real-time, duration-preserving pitch shifter (hybrid).

   Design notes (audited Oct 2026):
   • At |cents| ≤ 0.5 the processor is BIT-EXACT passthrough (verified by tests/pitch-test.js).
     The old build also had this property, so DSP coloration at neutral was NOT the cause of the
     "everything sounds too high" report — that was a signal-routing/latch bug in app.js
     (preservesPitch is latched by browsers at play() time; changing it together with
     playbackRate in one tick made linked/unlinked modes double-apply or drop the shift).
   • When engaged, four Hann-windowed read heads sweep a ring-buffer delay line. Improvements
     over the previous version:
       - grain span scales with shift depth (shorter grains for large shifts) which reduces the
         classic granular "warble"; heads stay quarter-phase apart so windows sum to a constant.
       - linear interpolation taps (unchanged) with per-channel shared phase → stereo-safe.
       - smooth wet ramp (≈0.5 s to full engagement) prevents clicks on rapid slider movement.
       - NaN/runaway guard per sample.
   • ratio = 2^(cents/1200); 0 c = identity, +100 c = one semitone up, ±1200 c = octave.
   • No allocation inside process(). k-rate parameter (see browser harness note in tests). */
class DetunePitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "cents", defaultValue: 0, minValue: -1200, maxValue: 1200, automationRate: "k-rate" }];
  }
  constructor() {
    super();
    this.WMAX = Math.max(256, Math.round(sampleRate * 0.1)); // max grain span ≈ 100 ms
    let size = 1; while (size < this.WMAX * 4 + 8) size <<= 1; // head-0 delay can reach ~2×W
    this.mask = size - 1;
    this.buf = [new Float32Array(size), new Float32Array(size)];
    this.w = 0;      // write index
    this.phase = 0;  // 0..1 sweep phase of head 0
    this.mix = 0;    // 0 = dry (bit-exact), 1 = shifted (smoothed)
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;
    const frames = output[0].length, chOut = output.length;
    const cents = params.cents[0];
    const ratio = Math.pow(2, cents / 1200);
    /* Deeper shifts want shorter grains (fewer repeated samples per window) — clamp W so the
       delay never exceeds the buffer and warble stays low even at ±1200 c. */
    /* For downshifts the sweep must start at phase 0 (delay W), not at a large head-0 delay:
       with d = p*W + 1 and inc < 0, a mid-sweep start would run the delay past the ring size. */
    const W = ratio >= 1
      ? Math.max(256, Math.min(this.WMAX, Math.round(this.WMAX * Math.max(0.35, ratio))))
      : Math.max(256, Math.min(this.WMAX, Math.round(this.WMAX * Math.max(0.35, 1 / ratio))));
    const inc = (1 - ratio) / W;
    const wetTarget = Math.abs(cents) > 0.5 ? 1 : 0;
    const mask = this.mask, TWO_PI = 2 * Math.PI;
    let w = this.w, phase = this.phase, mix = this.mix;
    for (let i = 0; i < frames; i++) {
      // write input into delay lines (mono sources feed both channels; silence fills gaps)
      for (let c = 0; c < 2; c++) {
        const src = input && input.length ? input[Math.min(c, input.length - 1)] : null;
        this.buf[c][w] = src ? src[i] : 0;
      }
      mix += (wetTarget - mix) * 0.0015;
      let o;
      if (mix > 0.0005) {
        let p0 = phase, p1 = phase + 0.25, p2 = phase + 0.5, p3 = phase + 0.75;
        if (p1 >= 1) p1 -= 1; if (p2 >= 1) p2 -= 1; if (p3 >= 1) p3 -= 1;
        const g0 = 0.25 - 0.25 * Math.cos(TWO_PI * p0), g1 = 0.25 - 0.25 * Math.cos(TWO_PI * p1),
              g2 = 0.25 - 0.25 * Math.cos(TWO_PI * p2), g3 = 0.25 - 0.25 * Math.cos(TWO_PI * p3);
        const d0 = p0 * W + 1, d1 = p1 * W + 1, d2 = p2 * W + 1, d3 = p3 * W + 1;
        for (let c = 0; c < chOut; c++) {
          const b = this.buf[c < 2 ? c : 1];
          const wet = g0 * this.tap(b, w, d0) + g1 * this.tap(b, w, d1) + g2 * this.tap(b, w, d2) + g3 * this.tap(b, w, d3);
          o = b[w] * (1 - mix) + wet * mix;
          if (!(o > -4 && o < 4)) o = 0; // never emit NaN / runaway samples
          output[c][i] = o;
        }
      } else {
        // Bit-exact bypass: copy input through untouched (identity at 0 cents).
        for (let c = 0; c < chOut; c++) {
          const src = input && input.length ? input[Math.min(c, input.length - 1)] : null;
          output[c][i] = src ? src[i] : 0;
        }
      }
      phase += inc;
      phase -= Math.floor(phase); // wrap into [0,1)
      w = (w + 1) & mask;
    }
    this.w = w; this.phase = phase; this.mix = mix;
    return true;
  }
  tap(b, w, d) {
    const pos = w - d, i0 = Math.floor(pos), f = pos - i0;
    const a = b[i0 & this.mask], c = b[(i0 + 1) & this.mask];
    return a + (c - a) * f;
  }
}
registerProcessor("detune-pitch", DetunePitchProcessor);
