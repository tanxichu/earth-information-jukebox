// P4 "nature / auditory icons" live engine = browser port of bench/pipelines/P4 (P4_v7_pad).
// Layers (all plain Web Audio): (1) per-strip noise bed (looped band-limited noise buffer + gain, west->east pan),
// (2) per-strip texture events (pre-synthesised short buffers: ice chimes/cracks, fire crackle, drops, leaf grains,
// bird-like chirps, haze grains, city twinkles; thunder if opts.key === "lightning"), (3) chord pad (I-IV-vi-V, 3 s sections,
// one pentatonic voice per strip, level = strip amount with a floor), (4) soft piano-like plucks on the pentatonic scale,
// (5) correlated light reverb, whole-frame gain swing, gentle low-pass, tanh limiter.
export const meta = { id: "P4", name: "Nature sounds (auditory icons)", live: true };

// ---- parameters (same values as the Python render.py v7_pad) ----
const P = {
  soft: 0.7, crack_gain: 0.8, tex_gain: 0.4, pl_gain: 1.0, pl_rate: 8.0, pad_gain: 0.4, pad_amp: 1.8, rate_max: 14.0,
  rate_curve: 1.3, amp_follow: 0.6, whole_gain: 0.7, reverb: 0.12, rt60: 1.6, rev_corr: 0.8, lp_hz: 9000, event_gain: 1.0,
  bed_gain: 1.0, sec: 3.0, roots: [0, 5, 9, 7], seed: 7, ceiling: 0.78, target_rms: 0.088, stats_frames: 4, agc_warm: 16, agc_tau: 12, max_boost: 300,
  trim_db: { white: 1, warm: 1.5, orange: 1, cool: 3, green: 1.5, red: 0, dots: 3 },   // per-feature loudness trim (calibrated on the benchmark clips)
};
const PENTA = [0, 2, 4, 7, 9];
const pent = (base, k) => base * Math.pow(2, (PENTA[((k % 5) + 5) % 5] + 12 * Math.floor(k / 5)) / 12);
const snap = (f, base) => { const k = Math.round(12 * Math.log2(f / base)), o = Math.floor(k / 12), r = k - 12 * o; let b = 0, bd = 99; for (const p of [0, 2, 4, 7, 9, 12]) if (Math.abs(p - r) < bd) { bd = Math.abs(p - r); b = p; } return base * Math.pow(2, (12 * o + b) / 12); };
const BASE = { white: 220, warm: 110, orange: 164.8, cool: 196, green: 261.6, red: 98, dots: 174.6 };
const BED = { white: [3000, 9000 * P.soft, 0, .25], warm: [35, 180, 1, 1], orange: [200, 1800, 1, .8], cool: [500, 4000 * P.soft, .5, .7],
  green: [3000, 8000 * P.soft, 0, .35], red: [60, 700, 1, 1.2], dots: [4000, 9000 * P.soft, 0, .1], thunder: [500, 5000 * P.soft, .5, .3] };
const RMUL = { white: .45, warm: 1.5, orange: .5, cool: .9, green: .8, red: 1.05, dots: .7 };

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
function fft(re, im) {   // in-place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) {
      const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}
// band-limited (optionally 1/f^slope tilted) unit-variance noise of n samples
function bandNoise(r, n, lo, hi, slope, sr) {
  let m = 1; while (m < n) m <<= 1; const re = new Float64Array(m), im = new Float64Array(m);
  for (let k = 0; k <= m / 2; k++) {
    const f = k * sr / m; let h = f >= lo && f <= hi ? Math.pow(Math.max(f, 20) / 1000, -slope) : 0;
    const a = gauss(r) * h, b = gauss(r) * h; re[k] = a; im[k] = -b;        // conj for inverse-via-forward
    if (k > 0 && k < m / 2) { re[m - k] = a; im[m - k] = b; }
  }
  fft(re, im); const out = new Float32Array(n); let s2 = 0;
  for (let i = 0; i < n; i++) { out[i] = re[i]; s2 += re[i] * re[i]; }
  const sd = Math.sqrt(s2 / n) + 1e-12; for (let i = 0; i < n; i++) out[i] /= sd; return out;
}

export async function createEngine(ctx, opts) {
  const SR = ctx.sampleRate, fps = opts.fps || 4, dt = 1 / fps, feat = opts.feature in BASE ? opts.feature : "white";
  const lightning = opts.key === "lightning", AS = opts.anim_stats && Number.isFinite(opts.anim_stats.whole_mean) ? opts.anim_stats : null; const rnd = mulberry(P.seed);
  // normalisation: catalog animations pass robust ranges; for a user's own video they are missing -> running min/max of the
  // frames received so far, with the span never smaller than 30 % of the running peak (so tiny noise is not blown up).
  const hasR = Array.isArray(opts.whole_range) && Array.isArray(opts.strip_range);
  const run = { wl: Infinity, wh: -Infinity, sl: Infinity, sh: -Infinity };
  const upd = (w, st) => { run.wl = Math.min(run.wl, w); run.wh = Math.max(run.wh, w); for (const v of st) { run.sl = Math.min(run.sl, v); run.sh = Math.max(run.sh, v); } };
  const rng = (lo, hi) => hasR ? null : [lo, Math.max(hi, lo + 0.3 * Math.max(hi, 1e-9), lo + 1e-9)];
  const nrm = (v, lo, hi) => Math.min(1, Math.max(0, (v - lo) / Math.max(hi - lo, 1e-9)));
  const nw = v => { const r = hasR ? opts.whole_range : rng(run.wl, run.wh); return nrm(v, r[0], r[1]); };
  const ns = v => { const r = hasR ? opts.strip_range : rng(run.sl, run.sh); return nrm(v, r[0], r[1]); };
  const base = BASE[feat], mkbuf = (arr) => { const b = ctx.createBuffer(1, arr.length, SR); b.copyToChannel(arr, 0); return b; };
  const ramp = (p, v, t) => p.linearRampToValueAtTime(v, t);

  // ---- buffers ----
  const cache = new Map(); const memo = (key, f) => { if (!cache.has(key)) cache.set(key, f()); return cache.get(key); };
  const hann = n => i => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  const noiseBuf = (n, lo, hi, sl_, env) => { const x = bandNoise(rnd, n, lo, hi, sl_, SR); for (let i = 0; i < n; i++) x[i] *= env(i / SR, i); return mkbuf(x); };
  const crack = (dec, lo, hi) => noiseBuf(Math.floor(SR * dec * 8), lo, hi, 0, t => Math.exp(-t / dec));
  const grain = (lo, hi) => { const n = Math.floor(SR * 0.03), h = hann(n); return noiseBuf(n, lo, hi, 0, (t, i) => h(i)); };
  const sines = (len, fn) => { const n = Math.floor(SR * len), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = fn(i / SR); return mkbuf(x); };
  const chime = f => sines(1.05, t => { let s = 0; [[1, 1], [2.76, .4], [5.4, .15]].forEach(([r, a], i) => s += a * Math.sin(2 * Math.PI * f * r * t + i) * Math.exp(-t * (6 + 4 * i) / .35)); return s * Math.min(1, t * 800); });
  const pluckW = f => sines(0.5, t => (Math.sin(2 * Math.PI * f * t) + .3 * Math.sin(4 * Math.PI * f * t)) * Math.exp(-t * 9) * Math.min(1, t * 1500));
  const drop = f => sines(0.12, t => Math.sin(2 * Math.PI * f * t * (1 + 8 * t)) * Math.exp(-t * 45));
  const twinkle = f => sines(0.25, t => Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 18) * Math.min(1, t * 2000));
  const chirp = (f, v) => memo("ch" + f.toFixed(0) + v, () => { const d = 0.06 + 0.1 * rnd(), n = Math.floor(SR * d), x = new Float32Array(n), dir = rnd() < .5 ? -1 : 1, rt = 8 + 10 * rnd(); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR; ph += 2 * Math.PI * f * (1 + .5 * Math.sin(2 * Math.PI * rt * t) + dir * .6 * t / d) / SR; x[i] = (Math.sin(ph) + .3 * Math.sin(2 * ph)) * Math.pow(Math.sin(Math.PI * t / d), 2); } return mkbuf(x); });
  const thunder = dec => { const n = Math.floor(SR * dec * 2.5); return noiseBuf(n, 25, 260, 1, t => (1 - Math.exp(-t * 60)) * Math.exp(-t / dec * 1.5)); };
  const pluckBufs = Array.from({ length: 13 }, (_, k) => { const f = pent(base * 2, k); return sines(1.4, t => { let s = 0; [[1, 1, 3], [2, .4, 4.5], [3.01, .18, 6], [4.02, .08, 8]].forEach(([r, g, d]) => s += g * Math.sin(2 * Math.PI * f * r * t) * Math.exp(-t * d)); return s * Math.min(1, t * 400); }); });
  // texture event table: returns [buffer, amp]
  const NV = 6; const V = [];
  const vmake = fn => Array.from({ length: NV }, fn);
  let evPick;
  if (lightning) { const th = vmake(() => thunder(.6 + rnd())), cr = vmake(() => crack(.006, 1500, 5000 * P.soft)); evPick = (s, a) => { const i = Math.floor(rnd() * NV); return [[th[i], 1.1 * a], [cr[i], .4 * a * P.crack_gain]]; }; }
  else if (feat === "white") { const cr = vmake(() => crack(.02, 2500, 9000 * P.soft)), ch = Array.from({ length: 10 }, (_, k) => chime(pent(1100, k))); evPick = () => rnd() < .12 ? [[cr[Math.floor(rnd() * NV)], .9 * P.crack_gain]] : [[ch[Math.floor(rnd() * 10)], .35]]; }
  else if (feat === "warm") { const cr = vmake(() => crack(.004 + .006 * rnd(), 600, 5000 * P.soft)), pl = Array.from({ length: 10 }, (_, k) => pluckW(pent(base * 2, k))); evPick = () => rnd() < .35 ? [[pl[Math.floor(rnd() * 10)], .35]] : [[cr[Math.floor(rnd() * NV)], rnd() * 1.2 * P.crack_gain]]; }
  else if (feat === "orange") evPick = s => { const f = snap(300 + 300 * rnd() + 60 * s, base); return [[memo("d" + f.toFixed(1), () => drop(f)), .25]]; };
  else if (feat === "cool") evPick = () => { const f = snap(500 + 1500 * rnd(), base); return [[memo("d" + f.toFixed(1), () => drop(f)), .35]]; };
  else if (feat === "green") { const gr = vmake(() => grain(3500, 9000 * P.soft)); evPick = () => rnd() < .7 ? [[gr[Math.floor(rnd() * NV)], .6 * P.crack_gain]] : [[chirp(snap(2200 + 300 * Math.floor(rnd() * 6), base * 8), Math.floor(rnd() * 3)), .25]]; }
  else if (feat === "red") { const gr = vmake(() => grain(80, 600)); evPick = () => [[gr[Math.floor(rnd() * NV)], .8]]; }
  else { const tw = Array.from({ length: 10 }, (_, k) => twinkle(pent(1500, k))); evPick = () => [[tw[Math.floor(rnd() * 10)], .4]]; }

  // expected energy per texture event / pluck (sum x^2 / SR of the buffers), used for the causal loudness estimate
  const en = b => { const d = b.getChannelData(0); let e = 0; for (let i = 0; i < d.length; i++) e += d[i] * d[i]; return e / SR; };
  let evE = 0; for (let i = 0; i < 300; i++) for (const [b, amp] of evPick(i % 8, 1)) evE += amp * amp * en(b); evE /= 300;
  let plE = 0; for (const b of pluckBufs) plE += en(b); plE = plE / pluckBufs.length * 0.0625;
  // ---- graph ----
  const mix = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), post = ctx.createGain(), gw = ctx.createGain(), lp = ctx.createBiquadFilter(), trim = ctx.createGain(), lim = ctx.createWaveShaper();
  dry.gain.value = 1 - P.reverb; wet.gain.value = P.reverb; lp.type = "lowpass"; lp.frequency.value = P.lp_hz; lp.Q.value = 0.5; trim.gain.value = 1;
  const cv = new Float32Array(2049); for (let i = 0; i < 2049; i++) { const x = (i - 1024) / 1024; cv[i] = Math.tanh(x / P.ceiling) * P.ceiling; }
  lim.curve = cv; lim.oversample = "4x";
  // reverb IR (shared noise 80 % correlated L/R, unit energy)
  const irN = Math.floor(SR * P.rt60), ir = ctx.createBuffer(2, irN, SR), shared = bandNoise(rnd, irN, 150, 5000, .5, SR);
  for (let c = 0; c < 2; c++) { const own = bandNoise(rnd, irN, 150, 5000, .5, SR), d = ir.getChannelData(c); let e = 0;
    for (let i = 0; i < irN; i++) { const t = i / SR; d[i] = (P.rev_corr * shared[i] + (1 - P.rev_corr) * own[i]) * Math.exp(-6.9 * t / P.rt60) * Math.min(1, t * 100); e += d[i] * d[i]; }
    const k = 1 / Math.sqrt(e); for (let i = 0; i < irN; i++) d[i] *= k; }
  const conv = ctx.createConvolver(); conv.normalize = false; conv.buffer = ir;
  mix.connect(dry).connect(post); mix.connect(conv).connect(wet).connect(post); post.connect(gw).connect(lp).connect(trim).connect(lim).connect(opts.destination || ctx.destination);
  gw.gain.value = 1 - P.whole_gain;

  const lfo = (freq, amt, target) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = freq; g.gain.value = amt; o.connect(g).connect(target); o.start(0); return o; };
  const live = [];
  const [bLo, bHi, bSl, bBg] = lightning ? BED.thunder : BED[feat];
  const bedLen = 1 << 17, bedBuf = mkbuf(bandNoise(rnd, bedLen, bLo, bHi, bSl, SR));
  const S = [];
  for (let s = 0; s < 8; s++) {
    const sum = ctx.createGain(), pan = ctx.createStereoPanner(); pan.pan.value = -1 + 2 * (s + .5) / 8; sum.connect(pan).connect(mix);
    // bed: noise -> level(a) -> slow AM (0.6 + 0.4 sin) -> sum
    const src = ctx.createBufferSource(); src.buffer = bedBuf; src.loop = true; const lev = ctx.createGain(), am = ctx.createGain(); am.gain.value = 0.6;
    src.connect(lev).connect(am).connect(sum); src.start(0, rnd() * 2.5); live.push(src, lfo(.15 + .07 * s, .4, am.gain)); lev.gain.value = 0;
    // pad: sections -> lfo gain -> level -> sum
    const plfo = ctx.createGain(); plfo.gain.value = 0.8; const plev = ctx.createGain(); plev.gain.value = 0; plfo.connect(plev).connect(sum); live.push(lfo(.04 + .013 * s, .2, plfo.gain));
    S.push({ sum, lev, plfo, plev, evAcc: 0, plAcc: 0 });
  }
  const sub = ctx.createOscillator(), subg = ctx.createGain(); sub.frequency.value = base / 2; subg.gain.value = 0; sub.connect(subg).connect(mix); sub.start(0); live.push(sub);
  const rise = new Float32Array(64), fall = new Float32Array(64); for (let i = 0; i < 64; i++) { rise[i] = Math.pow(Math.sin(i / 63 * Math.PI / 2), 2); fall[i] = 1 - rise[i]; }
  let t0 = null, nextSec = 0;
  function addSection(q) {
    const sec = P.sec, c = t0 + (q + .5) * sec, start = Math.max(t0, c - sec), rt = P.roots[q % P.roots.length];
    for (let s = 0; s < 8; s++) {
      const f0 = pent(base * Math.pow(2, rt / 12), s), sg = ctx.createGain();
      if (q === 0) sg.gain.setValueAtTime(1, t0); else { sg.gain.setValueAtTime(0, t0); sg.gain.setValueCurveAtTime(rise, start, sec); }
      sg.gain.setValueCurveAtTime(fall, c, sec); sg.connect(S[s].plfo);
      [[1, 1], [2.003, .35], [3.004, .08], [1.004, .5]].forEach(([r, g]) => { const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = f0 * r; og.gain.value = g; o.connect(og).connect(sg); o.start(start); o.stop(c + sec + .05); live.push(o); });
    }
  }
  const powerAt = (a, W) => { const gwv = 1 - P.whole_gain + P.whole_gain * W, r = Math.pow(a, P.rate_curve), evg = P.event_gain * 0.35 * Math.pow(a, P.amp_follow) * P.tex_gain,
    pl = (0.25 + 0.75 * a) / 8 * 0.35 * P.pad_gain * P.pad_amp * (0.5 + 0.5 * W), bl = a * 0.12 * bBg * P.bed_gain * P.tex_gain;
    return 8 * (pl * pl * .66 * .69 * .75 + bl * bl * .44 + r * P.rate_max * (lightning ? RMUL.dots : RMUL[feat]) * evg * evg * evE + r * P.pl_rate * a * plE * P.pl_gain * P.pl_gain) * gwv * gwv; };
  const pFixed = AS ? powerAt(AS.strip_mean, AS.whole_mean) : 0;   // catalog animations: level from full-animation means (precomputed); user video: running estimate
  let n = 0, pSum = 0, pEst = 0;
  function frame(time, strips, whole) {
    if (!hasR) upd(whole, strips);
    if (t0 === null) { t0 = time; gw.gain.setValueAtTime(1 - P.whole_gain, time); }
    const first = n++ === 0, tc = time + dt / 2, W = nw(whole), set = (p, v) => { if (first) { p.setValueAtTime(v, t0); p.setValueAtTime(v, tc); } else ramp(p, v, tc); };
    while ((nextSec - .5) * P.sec <= time - t0 + dt * 0.5) addSection(nextSec++);
    const gwv = 1 - P.whole_gain + P.whole_gain * W; set(gw.gain, gwv); set(subg.gain, 0.03 * P.pad_gain * P.pad_amp * Math.pow(W, 1.5) * 0.7071);
    let pw = 0;
    for (let s = 0; s < 8; s++) {
      const a = ns(strips[s]), st = S[s];
      set(st.lev.gain, a * 0.12 * bBg * P.bed_gain * P.tex_gain);
      const pl = (0.25 + 0.75 * a) / 8 * 0.35 * P.pad_gain * P.pad_amp * (0.5 + 0.5 * W); set(st.plev.gain, pl);
      const r = Math.pow(a, P.rate_curve), evg = P.event_gain * 0.35 * Math.pow(a, P.amp_follow) * P.tex_gain;
      st.evAcc += r * P.rate_max * (lightning ? RMUL.dots : RMUL[feat]) * dt; st.plAcc += r * P.pl_rate * dt;
      const bl = a * 0.12 * bBg * P.bed_gain * P.tex_gain, evRate = r * P.rate_max * (lightning ? RMUL.dots : RMUL[feat]), plRate = r * P.pl_rate;
      pw += pl * pl * .66 * .69 * .75 + bl * bl * .44 + evRate * evg * evg * evE + plRate * a * plE * P.pl_gain * P.pl_gain;
      while (st.evAcc >= 1) { st.evAcc -= 1; const t = time + rnd() * dt;
        for (const [buf, amp] of evPick(s, a)) { const o = ctx.createBufferSource(), g = ctx.createGain(); o.buffer = buf; g.gain.value = amp * evg; o.connect(g).connect(st.sum); o.start(t); } }
      while (st.plAcc >= 1) { st.plAcc -= 1; const t = time + rnd() * dt, k = Math.max(0, Math.min(12, s + Math.floor(rnd() * 4) - 1));
        const o = ctx.createBufferSource(), g = ctx.createGain(); o.buffer = pluckBufs[k]; g.gain.value = 0.25 * P.pl_gain * Math.sqrt(a); o.connect(g).connect(st.sum); o.start(t); }
    }
    const pf = pw * gwv * gwv; pSum += pf; if (n <= P.agc_warm) pEst = AS ? (pFixed * P.stats_frames + pSum) / (P.stats_frames + n) : pSum / n; else { if (n === P.agc_warm + 1) pEst = pSum / n; pEst += (pf - pEst) * dt / P.agc_tau; }
    const g = Math.min(P.max_boost, P.target_rms * Math.pow(10, P.trim_db[feat] / 20) / Math.sqrt(pEst + 1e-12)); set(trim.gain, g);
  }
  function stop() { live.forEach(o => { try { o.stop(); } catch (e) {} }); try { trim.gain.value = 0; } catch (e) {} }
  return { frame, stop };
}
