// P1 piano sweep (browser engine). Port of bench/pipelines/P1/render.py presets e5 and c3.
// Every data frame (0.25 s) the 8 west->east strips are read; each strip k sounds one Salamander piano note at its own slot
// (note time = sweep start + k*slot), pitch = strip amount on a scale, velocity = amount^2, pan west(left)->east(right),
// over a quiet, data-independent root/fifth/octave bed that follows a 4-chord loop (2 s per chord), plus a light convolution reverb.
export const meta = { id: "P1", name: "Piano sweep", live: true };

const SAMPLES = { A1: 33, A2: 45, A3: 57, A4: 69, A5: 81, A6: 93, C2: 36, C3: 48, C4: 60, C5: 72, C6: 84, Ds3: 51, Ds4: 63, Ds5: 75, Fs3: 54, Fs4: 66, Fs5: 78 };
const PENTA = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86];
const CHORDS = [[2, 6, 9, 1, 4], [11, 2, 6, 9, 1], [7, 11, 2, 6, 9], [9, 1, 4, 11, 6], [2, 6, 9, 1, 4], [11, 2, 6, 9, 1], [7, 11, 2, 6, 9], [9, 1, 4, 11, 6]];
const ROOTS = [38, 35, 43, 33];
// ---- presets (same numbers as render.py VERSIONS e5 / c3) ----
const PRESETS = {
  e5: { scale: PENTA, chords: false, period: 0.5, slot: 0.0625, ndur: 0.35, vmin: 0.02, vmax: 1.0, vpow: 2.0, thr: 0.03, rootBed: 0.5, wet: 0.2, sweepGain: 2.5 },
  c3: { scale: null, chords: true, period: 1.0, slot: 0.125, ndur: 0.5, vmin: 0.02, vmax: 1.0, vpow: 2.0, thr: 0.03, rootBed: 0.35, wet: 0.2, sweepGain: 2.5, lo: 60, hi: 90 },
};
const GAIN = { e5: 2.5, c3: 2.5 };   // fixed output gain (the Python renderer normalises per clip to -18 LUFS; live code cannot)
const CHORD_LEN = 2.0;

const bufCache = new Map();   // url -> Promise<ArrayBuffer>, shared between engines
async function loadSamples(ctx, base) {
  const out = {};
  await Promise.all(Object.entries(SAMPLES).map(async ([name, m]) => {
    const url = base + "vendor/salamander/" + name + ".mp3";
    if (!bufCache.has(url)) bufCache.set(url, fetch(url).then(r => r.arrayBuffer()));
    const ab = (await bufCache.get(url)).slice(0);
    const dec = await ctx.decodeAudioData(ab);   // downmix to mono (as ffmpeg -ac 1 in render.py) so the StereoPanner uses its equal-power mono law
    if (dec.numberOfChannels === 1) { out[m] = dec; return; }
    const mono = ctx.createBuffer(1, dec.length, dec.sampleRate), md = mono.getChannelData(0), nc = dec.numberOfChannels;
    for (let c = 0; c < nc; c++) { const cd = dec.getChannelData(c); for (let i = 0; i < dec.length; i++) md[i] += cd[i] / nc; }
    out[m] = mono;
  }));
  return out;
}

function makeIR(ctx, wet) {   // 2.5 s exponentially decaying noise, as in render.py; one channel per ear
  const sr = ctx.sampleRate, n = Math.floor(2.5 * sr), ir = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    let s = 12345 + c * 777; const d = ir.getChannelData(c); let sum = 0;
    for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; const u1 = ((s >>> 8) + 1) / 16777217; s = (s * 1664525 + 1013904223) >>> 0; const u2 = (s >>> 8) / 16777216;
      const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); d[i] = g * Math.exp(-i / sr * 2.6); sum += Math.abs(d[i]); }
    const k = 1 / (Math.sqrt(sum) * 4); for (let i = 0; i < n; i++) d[i] *= k;
  }
  return ir;
}

async function build(ctx, opts, presetName, limiter) {
  const P = PRESETS[presetName] || PRESETS.e5, S = await loadSamples(ctx, opts.baseUrl || "");
  const dest = opts.destination || ctx.destination;
  const mix = ctx.createGain(); mix.gain.value = (opts.gain != null ? opts.gain : GAIN[presetName] || GAIN.e5);
  const dry = ctx.createGain(); dry.gain.value = 1 - P.wet;
  // two mono convolvers (left ear / right ear), so the stereo position of the notes is kept inside the reverb as in render.py
  const ir = makeIR(ctx, P.wet), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  for (let c = 0; c < 2; c++) {
    const b1 = ctx.createBuffer(1, ir.length, ir.sampleRate); b1.copyToChannel(ir.getChannelData(c), 0);
    const cv = ctx.createConvolver(); cv.normalize = false; cv.buffer = b1; split.connect(cv, c, 0); cv.connect(merge, 0, c);
  }
  const wetG = ctx.createGain(); wetG.gain.value = P.wet * 3;
  const bus = ctx.createGain(); bus.channelCount = 2; bus.channelCountMode = "explicit"; bus.connect(dry); bus.connect(split); merge.connect(wetG); dry.connect(mix); wetG.connect(mix);
  let tail = mix;
  if (limiter) {   // soft clip at about -1.5 dBFS (tanh), no pumping
    const ws = ctx.createWaveShaper(), N = 2048, c = new Float32Array(N), L = 0.84; for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; c[i] = L * Math.tanh(x / L); }
    ws.curve = c; ws.oversample = "2x"; mix.connect(ws); tail = ws;
  }
  tail.connect(dest);
  const [wl, wh] = opts.whole_range || [0, 1], [sl, sh] = opts.strip_range || [0, 1], fps = opts.fps || 4;
  const eRange = (lo, hi) => { if (!(hi > 1e-4)) return [0, 1]; const span = Math.max(hi - lo, 0.3 * hi); return [hi - span, hi]; };
  const [slo, shi] = eRange(sl, sh);
  // causal guard (only after 6 s): if the animation still has not come near the declared range (night_lights: range 0.0156, max 0.0018) the top of the scale follows the running maximum; render.py caps the range by the true data max instead (non-causal)
  let runmax = 0, ADAPT = opts.adaptive !== false;
  const norm = v => { const hi = ADAPT && n > 24 && runmax < 0.1 * shi ? Math.max(runmax, 0.03 * shi) : shi; const lo = Math.min(slo, hi - 1e-9); return hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0; };
  const live = []; let n = 0;

  function note(m, t, dur, vel, pan) {
    let sm = 0, best = 1e9; for (const k in S) { const d = Math.abs(+k - m); if (d < best) { best = d; sm = +k; } }
    const src = ctx.createBufferSource(); src.buffer = S[sm]; src.playbackRate.value = Math.pow(2, (m - sm) / 12);
    const g = ctx.createGain(), p = ctx.createStereoPanner(); p.pan.value = pan;
    const v = vel * 0.9; g.gain.setValueAtTime(v, t);
    const cv = new Float32Array(16); for (let i = 0; i < 16; i++) cv[i] = v * Math.pow(1 - i / 15, 2);   // (1-x)^2 release over 0.8 s, as render.py
    g.gain.setValueAtTime(v, t + dur); g.gain.setValueCurveAtTime(cv, t + dur, 0.8);
    src.connect(g).connect(p).connect(bus); src.start(t); src.stop(t + dur + 0.8); live.push(src);
  }
  function ladder(ci) { const pcs = CHORDS[ci % CHORDS.length], r = []; for (let m = P.lo; m <= P.hi; m++) if (pcs.includes(m % 12)) r.push(m); return r; }

  function frame(time, strips, whole) {
    for (const v of strips) if (v > runmax) runmax = v;
    const dt = 1 / fps, tm0 = n * dt; n++;                 // musical time of this frame (frame counter, independent of ctx time)
    // bed: one root+fifth+octave per chord, at chord starts
    if (P.rootBed > 0) {
      const c = Math.round(tm0 / CHORD_LEN); if (Math.abs(c * CHORD_LEN - tm0) < 1e-6) {
        const r = ROOTS[c % 4]; [[r, 1], [r + 7, 0.6], [r + 12, 0.5]].forEach(([m, v]) => note(m, time, CHORD_LEN * 0.95, P.rootBed * v, 0));
      }
    }
    // sweep notes whose slot falls inside this frame; their strip amounts are read from this frame (render.py: frame = int(t * fps))
    const w0 = Math.floor((tm0 - 7 * P.slot) / P.period + 1e-9), w1 = Math.floor((tm0 + dt) / P.period + 1e-9);
    for (let w = Math.max(0, w0); w <= w1; w++) for (let k = 0; k < 8; k++) {
      const tn = w * P.period + k * P.slot; if (tn < tm0 - 1e-9 || tn >= tm0 + dt - 1e-9) continue;
      const a = norm(strips[k]); if (a < P.thr) continue;
      const m = P.chords ? (() => { const l = ladder(Math.floor(tn / CHORD_LEN + 1e-9)); return l[Math.min(l.length - 1, Math.floor(a * l.length))]; })() : P.scale[Math.min(P.scale.length - 1, Math.floor(a * P.scale.length))];
      note(m, time + (tn - tm0), P.ndur, (P.vmin + (P.vmax - P.vmin) * Math.pow(a, P.vpow)) * P.sweepGain, -1 + 2 * k / 7);
    }
  }
  function stop() { live.forEach(s => { try { s.stop(); } catch (e) {} }); mix.gain.value = 0; }
  return { frame, stop };
}

export async function createEngine(ctx, opts = {}) { return build(ctx, opts, opts.preset || "e5", true); }
// For the P7 hybrid: same frame() interface, preset c3, no limiter (the host engine limits the mix). opts.gain scales the layer (-6 dB = 0.5).
export async function createPianoLayer(ctx, opts = {}) { return build(ctx, opts, opts.preset || "c3", false); }
