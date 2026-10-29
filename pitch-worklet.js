/* Detune pitch processor: real-time, duration-preserving pitch shifter.
   Four overlapping Hann-windowed read heads sweep a delay line (granular / "delay-line" shifter).
   Each head's delay drifts at (1 - ratio) samples per sample, so playback speed is untouched while
   pitch moves by ratio = 2^(cents/1200). Heads sit 25% apart, so their windows sum to a constant.
   At ~0 cents the processor is bypassed (bit-exact), with a short crossfade to avoid clicks.
   Both channels share the same phases, so stereo stays in sync. No allocation in process(). */
class DetunePitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "cents", defaultValue: 0, minValue: -1200, maxValue: 1200, automationRate: "k-rate" }];
  }
  constructor() {
    super();
    this.W = Math.max(256, Math.round(sampleRate * 0.1)); // grain span ≈ 100 ms
    let size = 1; while (size < this.W * 2 + 8) size <<= 1;
    this.mask = size - 1;
    this.buf = [new Float32Array(size), new Float32Array(size)];
    this.w = 0;      // write index
    this.phase = 0;  // 0..1 sweep phase of head 0
    this.mix = 0;    // 0 = dry, 1 = shifted (smoothed)
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;
    const frames = output[0].length, chOut = output.length;
    const cents = params.cents[0];
    const ratio = Math.pow(2, cents / 1200);
    const inc = (1 - ratio) / this.W;
    const wetTarget = Math.abs(cents) > 0.5 ? 1 : 0;
    const W = this.W, mask = this.mask, TWO_PI = 2 * Math.PI;
    let w = this.w, phase = this.phase, mix = this.mix;
    for (let i = 0; i < frames; i++) {
      // write input into delay lines
      for (let c = 0; c < 2; c++) {
        const src = input && input.length ? input[Math.min(c, input.length - 1)] : null;
        this.buf[c][w] = src ? src[i] : 0;
      }
      mix += (wetTarget - mix) * 0.0015;
      let p0 = phase, p1 = phase + 0.25, p2 = phase + 0.5, p3 = phase + 0.75;
      if (p1 >= 1) p1 -= 1; if (p2 >= 1) p2 -= 1; if (p3 >= 1) p3 -= 1;
      const g0 = 0.25 - 0.25 * Math.cos(TWO_PI * p0), g1 = 0.25 - 0.25 * Math.cos(TWO_PI * p1),
            g2 = 0.25 - 0.25 * Math.cos(TWO_PI * p2), g3 = 0.25 - 0.25 * Math.cos(TWO_PI * p3);
      const d0 = p0 * W + 1, d1 = p1 * W + 1, d2 = p2 * W + 1, d3 = p3 * W + 1;
      for (let c = 0; c < chOut; c++) {
        const b = this.buf[c < 2 ? c : 1];
        let wet = 0;
        if (mix > 0.0005) {
          wet = g0 * this.tap(b, w, d0) + g1 * this.tap(b, w, d1) + g2 * this.tap(b, w, d2) + g3 * this.tap(b, w, d3);
        }
        const dry = b[w];
        let o = mix > 0.0005 ? dry * (1 - mix) + wet * mix : dry;
        if (!(o > -4 && o < 4)) o = 0; // never emit NaN / runaway samples
        output[c][i] = o;
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
