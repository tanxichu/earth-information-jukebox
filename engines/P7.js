// P7 hybrid = live P7_h4a (bench/pipelines/P7/render.py). Three existing engines mixed through sub-buses, one end limiter:
//   strips layer  = P3.js (8 panned strip voices + drone + chords + motif)  0 dB   <- carries the data
//   piano layer   = P1.js createPianoLayer, preset c3 (chord-tone ladder piano + root bed)  -6 dB
//   groove layer  = P6.js (kick/snare/hat/shaker panned to the data centroid + chord hits)   -10 dB
// Python matched each stem by its own RMS per clip; live cannot, so the sub-bus gains are fixed constants calibrated on the MAIN benchmark set
// (mean log-RMS of each engine rendered alone): gain_k = 10^(dB_k/20) * RMS_strips / RMS_k. The holdout set was not used for calibration.
// Differences from the Python h4a: P3.js is the P3_v8_motif port (chord loop + motif, own AGC), P6.js is v12 in A minor (Python h4a used v8), all causal.
export const meta = { id: "P7", name: "Hybrid (strips + piano + groove)", live: true };
import { createEngine as createP3 } from "./P3.js";
import { createPianoLayer } from "./P1.js";

const RMS = { p3: 0.0633, p1: 0.0231, p6: 0.0840 };        // alone-rendered mean RMS on the main set (full-scale = 1)
const DB = { p3: 0, p1: -6, p6: -10 };
const MASTER = 0.78;                                         // end level: -0.7 dB so the loudest main clip (-14.0 LUFS) and the quietest (-22.1) both sit inside the -23..-14 gate
const SEND = { wet: 1.0, p3: 0.08, p1: 0.2, p6: 0.1 };      // lite: send level of each layer into the shared reverb (their own private wet shares)
const THIN_OFF = true;   // thinning P3 detune pairs (opts.thin=true to try) cost -0.013 main overall, kept off: speed gain was small
const CEIL = 0.80;                                           // tanh ceiling = -1.9 dBFS, 4x oversampled, so true peak stays <= -1.5 dBTP

// ---- lite mode: sub-engines are used unchanged, but they see a wrapped context that (a) turns their private ConvolverNodes into silent
// gain nodes (their reverb is replaced by ONE shared convolver fed from send buses), (b) drops the second detuned oscillator pair of every P3
// voice unit (84 -> 42 oscillators, built during init only), (c) runs their waveshapers at 2x instead of 4x oversampling.
function liteCtx(ctx, state) {
  const osDesc = Object.getOwnPropertyDescriptor(WaveShaperNode.prototype, "oversample");
  const nullOsc = () => ({ frequency: { value: 0, setValueAtTime() {} }, detune: { value: 0 }, setPeriodicWave() {}, connect(x) { return x; }, start() {}, stop() {}, disconnect() {} });
  let nOsc = 0;
  return new Proxy(ctx, {
    get(t, p) {
      if (p === "createConvolver") return () => { const g = t.createGain(); g.gain.value = 0; return g; };
      if (p === "createOscillator") return () => { if (state.init && state.thin && (nOsc++ % 4) >= 2) return nullOsc(); return t.createOscillator(); };
      if (p === "createWaveShaper") return () => { const w = t.createWaveShaper();
        Object.defineProperty(w, "oversample", { get() { return osDesc.get.call(w); }, set(v) { osDesc.set.call(w, v === "4x" ? "2x" : v); } }); return w; };
      const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

export async function createEngine(ctx, opts = {}) {
  const lite = opts.lite !== false, state = { init: true, thin: opts.thin !== false && !THIN_OFF };
  const sub = lite ? liteCtx(ctx, state) : ctx;
  const dest = opts.destination || ctx.destination;
  const master = ctx.createGain(); master.gain.value = MASTER;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -9; comp.knee.value = 6; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.15;
  const ws = ctx.createWaveShaper(), N = 4096, cv = new Float32Array(N);
  for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; cv[i] = CEIL * Math.tanh(x / CEIL); }
  ws.curve = cv; ws.oversample = "4x";
  ws.oversample = lite ? "2x" : "4x";
  master.connect(comp).connect(ws).connect(dest);
  const bus = k => { const g = ctx.createGain(); g.gain.value = Math.pow(10, DB[k] / 20) * RMS.p3 / RMS[k]; g.connect(master); return g; };
  // one shared reverb (lite): 2.2-s exponentially decaying stereo noise, fed by per-layer sends (about the wet share each engine had privately)
  let sendIn = null;
  if (lite) {
    const SR = ctx.sampleRate, L = Math.floor(2.2 * SR), ir = ctx.createBuffer(2, L, SR); let sd = 7;
    const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); let e = 0; for (let i = 0; i < L; i++) { const t = i / SR; d[i] = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()) * Math.exp(-6.9 * t / 2.2); e += d[i] * d[i]; } const k = 1 / Math.sqrt(e); for (let i = 0; i < L; i++) d[i] *= k; }
    const cvl = ctx.createConvolver(); cvl.normalize = false; cvl.buffer = ir; const wet = ctx.createGain(); wet.gain.value = SEND.wet; sendIn = ctx.createGain(); sendIn.connect(cvl).connect(wet).connect(master);
  }
  const b3 = bus("p3"), b1 = bus("p1"), b6 = bus("p6");
  const send = (b, k) => { if (lite) { const g = ctx.createGain(); g.gain.value = SEND[k]; b.connect(g).connect(sendIn); } };
  send(b3, "p3"); send(b1, "p1"); send(b6, "p6");
  const base = { ...opts };
  const createP6 = (await import(opts.preset === "h5a" ? "./P6_D.js" : "./P6.js")).createEngine;   // h5a: groove in the piano's D-major progression
  const [e3, e1, e6] = await Promise.all([
    createP3(sub, { ...base, destination: b3 }),
    createPianoLayer(sub, { ...base, destination: b1, gain: 1, preset: "c3" }),
    createP6(sub, { ...base, destination: b6 }),
  ]);
  state.init = false;
  return {
    frame(time, strips, whole) { e3.frame(time, strips, whole); e1.frame(time, strips, whole); e6.frame(time, strips, whole); },
    stop() { for (const e of [e3, e1, e6]) { try { e.stop(); } catch (x) {} } const t = ctx.currentTime; master.gain.setTargetAtTime(0, t, 0.03); },
  };
}
