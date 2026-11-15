// P6 rhythm / groove engine (port of bench/pipelines/P6/render.py, version v12).
// 120 BPM, 2-s bar = 8 eighth-note steps; frame() is called once per step, step k <-> west->east strip k.
// Chords Am-F-C-G (one per bar): strip hits are chord tones, pad + syncopated stabs + bass; kick/snare/hat/shaker
// are panned to the data's west->east centroid. Causal version: bar-level quantities (hits per bar, bar mean) are
// estimated from the frames seen so far (the Python reference looks at the whole bar).
export const meta = { id: "P6", name: "Rhythm / groove", live: true };

const STEP = 0.25, BAR = 2.0;
const CHORDS = [[33, [57, 60, 64]], [29, [53, 57, 60]], [36, [55, 60, 64]], [31, [55, 59, 62]]];   // Am F C G
const P = { swing: 0.12, hits: 1.8, floor: 0.03, tilt: 14, back: 0.3, bass: 0.5, shaker: 1.6, hat: 0.3, snare: 0.5,
            shpan: 2.2, accent: 0.3, pad: 1.0, stab: 0.6, velMin: 0.25, velPow: 0.7, wet: 0.1, master: 1.0 };
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
function pool(tri, n = 8, lo = 57) {
  let out = [], o = 0;
  while (out.length < n) {
    for (const t of tri) { const m = t + 12 * (o + (t + 12 * o < lo - 12 ? 1 : 0)); if (m >= lo && !out.includes(m)) out.push(m); }
    o++; out.sort((a, b) => a - b);
  }
  return out.slice(0, n);
}

export async function createEngine(ctx, opts) {
  const dest = opts.destination || ctx.destination, fps = opts.fps || 4;
  // robust ranges from opts; if missing, fall back to a running min/max of the frames received so far (causal)
  const wr = opts.whole_range ? null : [Infinity, -Infinity], sr_ = opts.strip_range ? null : [Infinity, -Infinity];
  const [wl0, wh0] = opts.whole_range || [0, 1], [sl0, sh0] = opts.strip_range || [0, 1];
  const nw = v => { let lo = wl0, hi = wh0; if (wr) { wr[0] = Math.min(wr[0], v); wr[1] = Math.max(wr[1], v); lo = wr[0]; hi = wr[1]; }
    return Math.min(1, Math.max(0, (v - lo) / Math.max(hi - lo, 1e-9))); };
  const ns = v => { let lo = sl0, hi = sh0; if (sr_) { sr_[0] = Math.min(sr_[0], v); sr_[1] = Math.max(sr_[1], v); lo = sr_[0]; hi = sr_[1]; }
    return Math.min(1, Math.max(0, (v - lo) / Math.max(hi - lo, 1e-9))); };
  const sr = ctx.sampleRate;  // (sr = sample rate; sr_ above = running strip range)
  // ---- output chain: dry + short reverb -> soft limiter (tanh, 4x oversampled) -> ceiling
  const mix = ctx.createGain();
  const curve = new Float32Array(4096); for (let i = 0; i < 4096; i++) { const x = (i / 2047.5 - 1) * 2; curve[i] = Math.tanh(x); }
  const shaper = ctx.createWaveShaper(); shaper.curve = curve; shaper.oversample = "4x";
  const pre = ctx.createGain(); pre.gain.value = 0.6 * P.master;   // tanh knee sits at +-2.0 on the shaper input
  const post = ctx.createGain(); post.gain.value = 0.5;
  const agc = ctx.createGain();   // loudness leveller: slow running mean of the whole-frame amount sets the gain (live has no per-clip normalisation)
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -3; comp.knee.value = 3; comp.ratio.value = 20; comp.attack.value = 0.002; comp.release.value = 0.12;
  mix.connect(agc).connect(comp).connect(pre).connect(shaper).connect(post).connect(dest);
  const conv = ctx.createConvolver(), irLen = Math.floor(0.9 * sr), ir = ctx.createBuffer(2, irLen, sr);
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.732;
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 1; i < irLen; i++) d[i] = gauss() * Math.exp(-(i / sr) / 0.22); }
  conv.buffer = ir; const wet = ctx.createGain(); wet.gain.value = P.wet * 0.5; mix.connect(conv); conv.connect(wet).connect(agc);
  // shared noise
  const nbuf = ctx.createBuffer(1, sr, sr), nd = nbuf.getChannelData(0); for (let i = 0; i < sr; i++) nd[i] = gauss();

  const panner = p => { const n = ctx.createStereoPanner(); n.pan.value = Math.max(-1, Math.min(1, p)); n.connect(mix); return n; };
  // partial: sine at freq with exponential decay (time constant dec), short attack
  function tone(t0, dur, freq, amp, dec, pan, att = 0.002, harm = [[1, 1, dec]]) {
    const pn = panner(pan);
    for (const [r, a, d] of harm) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = freq * r;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(amp * a, t0 + att); g.gain.setTargetAtTime(0, t0 + att, d);
      o.connect(g).connect(pn); o.start(t0); o.stop(t0 + dur);
    }
  }
  function burst(t0, dur, amp, dec, hpf, pan) {
    const s = ctx.createBufferSource(); s.buffer = nbuf; const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hpf;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(amp, t0 + 0.001); g.gain.setTargetAtTime(0, t0 + 0.001, dec);
    s.connect(f).connect(g).connect(panner(pan)); s.start(t0, rnd() * 0.9, dur); s.stop(t0 + dur);
  }
  function kick(t0, amp, pan) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(155, t0); o.frequency.setTargetAtTime(45, t0, 0.03);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(amp, t0 + 0.002); g.gain.setTargetAtTime(0, t0 + 0.002, 0.14);
    o.connect(g).connect(panner(pan)); o.start(t0); o.stop(t0 + 0.4);
  }
  const cen = (strips) => { let s = 0, c = 0; for (let k = 0; k < 8; k++) { s += strips[k]; c += strips[k] * k; }
    return s > 1e-6 ? Math.max(-1, Math.min(1, (c / s - 3.5) / 3.5 * P.shpan)) : 0; };

  let f = 0, wSum = 0; const dHist = []; const wHist = []; const live = [];
  function frame(time, rawStrips, rawWhole) {
    const k = f % 8, b = Math.floor(f / 8); f++;
    const S = Array.from(rawStrips, ns), w = nw(rawWhole);
    wHist.push(w); if (wHist.length > 8) wHist.shift();
    const wb = wHist.reduce((a, v) => a + v, 0) / wHist.length;     // causal bar mean (last <= 8 frames)
    wSum += w; const prior = (opts.anim_stats && opts.anim_stats.whole_mean != null) ? opts.anim_stats.whole_mean : 0.35, mAvg = (wSum + 4 * prior) / (f + 4);   // animation mean (when known) only as the prior of the running mean: the 12-s clip differs from the full animation
    agc.gain.setTargetAtTime(Math.pow(10, Math.min(12, -16 - 19.5 * Math.log10(Math.max(mAvg, 0.02))) / 20), time, 1.0);
    const [root, tri] = CHORDS[b % 4], pl = pool(tri);
    const lvl = Math.pow(10, (w - 0.5) * P.tilt / 20), bg = (P.floor + (1 - P.floor) * w) * P.back * lvl;
    const c = cen(S), sw = (k % 2 ? P.swing * STEP : 0), t0 = time + sw;
    // kick / snare / hat
    if (k === 0 || k === 4) kick(time, 0.9 * bg * 0.9, c);
    if (k === 2 || k === 6) burst(time, 0.2, 0.5 * 0.7 * P.snare * bg, 0.06, 1500, c);
    if (k % 2 === 1) burst(t0, 0.08, 0.4 * 0.7 * P.hat * bg * (0.6 + 0.4 * S[k]), 0.02, 5000, c);
    // strip hit: n hits per bar from the bar mean; strip k fires if it is among the n strongest strips of this frame
    const nh = Math.round(1 + wb * 7), rank = (dHist.push(S[k]), dHist.length > 8 && dHist.shift(), dHist.filter(v => v > S[k]).length);
    if (rank < nh) {
      const v = P.velMin + (1 - P.velMin) * Math.pow(S[k], P.velPow);
      const amp = P.hits * v * lvl * (1 + P.accent * (k === 0 || k === 4 ? 1 : 0) - P.accent * 0.4 * (k % 2)) * 0.6;
      tone(t0, 0.6, mtof(pl[k]), amp, 0.25, (k - 3.5) / 3.5, 0.002, [[1, 1, 0.25], [4, 0.35, 0.06], [9.9, 0.12, 0.02]]);
    }
    // 16th shaker (2 per step) panned to centroid
    const lv = lvl * Math.pow(w, 0.8);
    for (let j = 0; j < 2; j++) burst(time + j * 0.125 + (j ? P.swing * 0.125 : 0), 0.05, 0.35 * 0.7 * P.shaker * lv, 0.015, 5000, c);
    // bass (root on 1, fifth on 3)
    if (k === 0 || k === 4) {
      const m = k === 4 && wb > 0.3 ? root + 7 : root, bl = P.bass * (0.3 + 0.7 * wb);
      tone(time, 0.45, mtof(m), 0.5 * bl, 0.3, c, 0.005, [[1, 1, 0.3], [2, 0.3, 0.3]]);
    }
    // pad (bar start) and stabs (steps 0, 3, 6)
    if (k === 0 || k === 3 || k === 6) {
      tri.forEach((m, i) => {
        if (k === 0) { const pn = c * 0.5 + c * (i - 1) * 0.3 * 1;
          for (const dt of [-0.003, 0, 0.003]) { const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), pnn = panner(pn);
            const fr = mtof(m + 12) * (1 + dt); o.frequency.value = fr; o2.frequency.value = fr * 2; const g2 = ctx.createGain(); g2.gain.value = 0.3;
            const a = 0.12 * P.pad * (0.3 + 0.7 * wb); g.gain.setValueAtTime(0, time); g.gain.linearRampToValueAtTime(a, time + 0.2); g.gain.setValueAtTime(a, time + 1.7); g.gain.linearRampToValueAtTime(0, time + 2.0);
            o.connect(g); o2.connect(g2).connect(g); g.connect(pnn); o.start(time); o2.start(time); o.stop(time + 2); o2.stop(time + 2); } }
        tone(t0, 0.3, mtof(m + 12), 0.2 * P.stab * (0.4 + 0.6 * wb) * (k === 0 ? 1 : 0.6), 0.09, c * 0.5);
      });
    }
  }
  function stop() { mix.gain.value = 0; }
  return { frame, stop };
}
