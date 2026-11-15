// P3 "Ambient voices" - live Web Audio port of bench/pipelines/P3/render.py, variant P3_v8_motif (same mapping, voices, tilt, motif, reverb).
// Mapping: D2/A2 drone (centre) + 8 west->east strip voices (pan L->R, level = strip share * pitch tilt), chord loop D(add9)-Bm-G(add9)-Asus
// every 3 s (0.6 s crossfade between two long-lived banks), whole amount -> overall level, harmonic brightness (crossfade dark/bright
// spectra) and tension voices (minor 9th / tritone / minor 9th+), sparse pentatonic motif whose register follows the amount and pan follows
// the data's west-east centre, short convolution reverb, soft ceiling. ~85 oscillators, all long-lived and driven by automation (no per-frame node creation
// except one 3-node motif note every 1.5 s).
export const meta = { id: "P3", name: "Ambient voices (drone + chords + motif)", live: true };

const P = {
  root: 73.42, chords: [[12,19,24,28,31,36,38,43],[12,19,21,26,31,33,38,43],[12,17,24,26,29,36,38,41],[12,19,24,26,31,36,38,43]],
  chordLen: 3.0, xfade: 0.6, tilt: 0.6, detune: 7, nHarm: 10, slope: [3.6, 1.3], wholeGamma: 0.6,
  wholeGain: [0.45, 1.0], droneLevel: 0.1, tensionLevel: 0.2, tensionSemis: [13, 18, 25], tensionPan: [-0.4, 0.4, 0],
  voiceGain: 0.55, motifLevel: 0.45, motifEvery: 1.5, motifScale: [26, 28, 31, 33, 38, 40, 43],
  agcTarget: 0.63, agcWarm: 8, agcAlpha: 0.03, reverbS: 2.2, wet: 0.08, out: 0.30, ceiling: 0.84,
};

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

export async function createEngine(ctx, opts) {
  const fps = opts.fps || 4, dt = 1 / fps, SR = ctx.sampleRate;
  // ranges: use the robust ones from opts; if missing (user's own video) fall back to a running min/max of frames seen so far
  let [wl, wh] = opts.whole_range || [0, 0], [sl, sh] = opts.strip_range || [0, 0]; const autoR = !(opts.whole_range && opts.strip_range && wh > wl && sh > sl); if (autoR) { wl = sl = Infinity; wh = sh = -Infinity; }
  const clip = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const nw = v => Math.pow(clip((v - wl) / Math.max(wh - wl, 1e-12)), P.wholeGamma);
  const ns = v => clip((v - sl) / Math.max(sh - sl, 1e-12));

  // ---- output chain: bus -> master -> (dry + convolver) -> soft ceiling (4x oversampled shaper) -> destination
  const bus = ctx.createGain(), master = ctx.createGain(), agc = ctx.createGain(), dry = ctx.createGain(), wetG = ctx.createGain();
  bus.connect(master); master.connect(agc); agc.connect(dry); dry.gain.value = (1 - P.wet) * P.out; wetG.gain.value = P.wet * P.out;
  const conv = ctx.createConvolver(); conv.normalize = false;
  { const L = Math.floor(P.reverbS * SR), ir = ctx.createBuffer(2, L, SR), r = rng(7);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); let e = 0;
      for (let i = 0; i < L; i++) { const t = i / SR; d[i] = gauss(r) * Math.exp(-6.9 * t / P.reverbS) * (t < 0.01 ? t / 0.01 : 1); e += d[i] * d[i]; }
      const k = 1 / Math.sqrt(e); for (let i = 0; i < L; i++) d[i] *= k; }
    conv.buffer = ir; }
  agc.connect(conv); conv.connect(wetG);
  const shaper = ctx.createWaveShaper(), C = P.ceiling, N = 2048, curve = new Float32Array(N);
  for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; curve[i] = C * Math.tanh(x / C); }
  shaper.curve = curve; shaper.oversample = "4x";
  dry.connect(shaper); wetG.connect(shaper); shaper.connect(opts.destination || ctx.destination);

  // ---- spectra: dark (h^-3.6) and bright (h^-1.3), unnormalised so the fundamental has unit amplitude
  const wave = s => { const re = new Float32Array(P.nHarm + 1), im = new Float32Array(P.nHarm + 1);
    for (let h = 1; h <= P.nHarm; h++) im[h] = Math.pow(h, -s); return ctx.createPeriodicWave(re, im, { disableNormalization: true }); };
  const wDark = wave(P.slope[0]), wBright = wave(P.slope[1]);

  // ---- a voice unit: 2 detuned oscillators per spectrum, crossfaded by brightness, panned
  const live = [];
  function unit(freq, pan) {
    const gD = ctx.createGain(), gB = ctx.createGain(), pn = ctx.createStereoPanner(); gD.gain.value = 0; gB.gain.value = 0; pn.pan.value = pan;
    const oscs = [];
    for (const det of [-P.detune, P.detune]) for (const [w, g] of [[wDark, gD], [wBright, gB]]) {
      const o = ctx.createOscillator(); o.setPeriodicWave(w); o.frequency.value = freq; o.detune.value = det; o.connect(g); o.start(0); oscs.push(o); live.push(o); }
    gD.connect(pn); gB.connect(pn); pn.connect(bus);
    return { gD, gB, oscs, set(level, bright, t) { gD.gain.linearRampToValueAtTime(level * 0.5 * (1 - bright), t); gB.gain.linearRampToValueAtTime(level * 0.5 * bright, t); },
             freq(f, t) { oscs.forEach(o => o.frequency.setValueAtTime(f, t)); } };
  }
  const drone = [unit(P.root, 0), unit(P.root * 1.5, 0)];
  const banks = [0, 1].map(() => Array.from({ length: 8 }, (_, i) => unit(P.root * 2, -1 + 2 * i / 7)));
  const tens = P.tensionSemis.map((s, j) => unit(P.root * Math.pow(2, s / 12), P.tensionPan[j]));

  // ---- helpers
  const cw = (k, t) => { const t0 = k * P.chordLen, t1 = t0 + P.chordLen, xf = P.xfade;
    let w = clip((t - (t0 - xf / 2)) / xf) * clip((t1 + xf / 2 - t) / xf); if (k === 0 && t < t1 - xf / 2) w = 1; return Math.sin(w * Math.PI / 2); };

  const HW = [0.1, 0.4, 0.8, 1, 0.8, 0.4, 0.1]; // ~1.2 s causal smoothing window over recent frames (tension control)
  let gSlow = null; // causal loudness normaliser state (see frame())
  let pwSum = 0.02 * 8, pwN = 8; // running mean of the modelled mix power (prior = 8 frames of a quiet mix): causal stand-in for Python's per-clip normalisation
  let n = 0, lastSet = -1, nextNote = 0, prevT = 0; const hist = [];
  const strips0 = new Array(8).fill(0);

  function frame(time, strips, whole) {
    if (autoR) { wl = Math.min(wl, whole); wh = Math.max(wh, whole); for (const v of strips) { sl = Math.min(sl, v); sh = Math.max(sh, v); } }
    const tc = time + dt / 2, a = nw(whole), first = n === 0, S = strips.map(ns);
    const setC = (param, v) => { if (first) param.setValueAtTime(v, time); else param.linearRampToValueAtTime(v, tc); };
    // master level + fade in
    const mg = P.wholeGain[0] + (P.wholeGain[1] - P.wholeGain[0]) * a;
    if (first) { master.gain.setValueAtTime(0, time); master.gain.linearRampToValueAtTime(mg, time + 0.05); } else master.gain.linearRampToValueAtTime(mg, tc);
    // chord frequencies: set the idle bank just before its chord becomes audible
    const kn = Math.floor((time + P.xfade / 2 + dt) / P.chordLen);
    if (kn !== lastSet) { for (let k = Math.max(lastSet + 1, 0); k <= kn; k++) P.chords[k % 4].forEach((s, i) => banks[k % 2][i].freq(P.root * Math.pow(2, s / 12), Math.max(0, time - 1e-3))); lastSet = kn; }
    let pw = 0; const kc = Math.floor(tc / P.chordLen);
    // brightness (crossfade between dark and bright spectrum) follows the whole amount
    const br = a;
    for (let b = 0; b < 2; b++) {
      let w = 0; for (let k = kc - 1; k <= kc + 1; k++) if (k >= 0 && ((k % 2) === b) && k <= lastSet) w = Math.max(w, cw(k, tc));
      const kchord = [kc - 1, kc, kc + 1].filter(k => k >= 0 && (k % 2) === b)[0];
      banks[b].forEach((u, i) => {
        // find tilt of the voice's current pitch via its chord semis
        let kk = kchord; for (const k of [kc - 1, kc, kc + 1]) if (k >= 0 && k % 2 === b && cw(k, tc) > 0) kk = k;
        const s = P.chords[(kk < 0 ? 0 : kk) % 4][i], slow = 1 + 0.12 * Math.sin(2 * Math.PI * (0.07 + 0.013 * i) * tc + i);
        const lvl = S[i] * slow * P.voiceGain * Math.pow(Math.pow(2, s / 12), P.tilt) * w;
        if (first) { u.gD.gain.setValueAtTime(0, time); u.gB.gain.setValueAtTime(0, time); }
        u.set(lvl, br, tc); pw += lvl * lvl;
      });
    }
    drone.forEach((u, i) => { if (first) { u.gD.gain.setValueAtTime(0, time); u.gB.gain.setValueAtTime(0, time); } const l = P.droneLevel * (i ? 0.5 : 1); u.set(l, br, tc); pw += l * l; });
    // tension: smoothed whole -> three dissonant voices fade in
    hist.push(a); if (hist.length > HW.length) hist.shift();
    let num = 0, den = 0; for (let j = 0; j < hist.length; j++) { const w = HW[HW.length - hist.length + j]; num += w * hist[j]; den += w; }
    const tw = num / den;
    tens.forEach((u, j) => { if (first) { u.gD.gain.setValueAtTime(0, time); u.gB.gain.setValueAtTime(0, time); }
      const l = P.tensionLevel * Math.pow(clip((tw - 0.35 - 0.12 * j) / 0.4), 1.5); u.set(l, br, tc); pw += l * l; });
    pw *= mg * mg; pwSum += pw; pwN++; let g = clip(P.agcTarget / Math.sqrt(pwSum / pwN), 0.2, 15);
    // causal normaliser: follow the running-mean estimate for the first 2 s, then follow downward moves at once and upward moves slowly (keeps within-clip loudness dynamics, like Python's constant gain)
    if (gSlow === null || n < P.agcWarm || g < gSlow) gSlow = g; else gSlow += P.agcAlpha * (g - gSlow);   // gain drops at once when the mix gets louder, rises only slowly
    g = gSlow;
    if (first) agc.gain.setValueAtTime(g, time); else agc.gain.linearRampToValueAtTime(g, tc);
    // motif: one soft note every 1.5 s, register = amount, pan = west-east centre of the data
    while (nextNote + 0.05 < time + dt - 1e-9 && nextNote + 0.05 >= time - 1e-9) {
      const e = Math.round(nextNote / P.motifEvery), ts = nextNote + 0.05, sc = P.motifScale;
      let idx = Math.round(a * (sc.length - 1)); idx = clip(idx + [0, 1, 0, -1][e % 4] * (e % 2), 0, sc.length - 1);
      const f = P.root * Math.pow(2, sc[idx] / 12), sum = S.reduce((x, y) => x + y, 0) + 1e-6, cen = clip(S.reduce((x, y, i) => x + y * i, 0) / sum / 3.5 - 1, -1, 1);
      const o = ctx.createOscillator(), g = ctx.createGain(), pn = ctx.createStereoPanner(), amp = P.motifLevel * (0.6 + 0.4 * a);
      o.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.3, 0.1]), { disableNormalization: true }));
      o.frequency.value = f; pn.pan.value = cen;
      g.gain.setValueAtTime(0, ts); g.gain.linearRampToValueAtTime(amp, ts + 0.02); g.gain.setTargetAtTime(0, ts + 0.02, 0.7);
      o.connect(g).connect(pn).connect(bus); o.start(ts); o.stop(ts + 2.4); live.push(o);
      nextNote += P.motifEvery;
    }
    n++;
  }
  function stop() { const t = ctx.currentTime; master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(0, t, 0.03);
    setTimeout(() => { live.forEach(o => { try { o.stop(); } catch (e) {} }); try { bus.disconnect(); } catch (e) {} }, 300); }
  return { frame, stop, stats: () => ({ pw: pwSum / pwN, n: pwN }) };
}
