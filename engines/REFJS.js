// Reference engine for testing the harness (not a candidate): every 2 s, 8 short sine tones west→east,
// pitch from the strip amount, panned left→right, level from the whole-frame amount. Mirrors bench/tools/ref_render.py REF_sine.
export const meta = { id: "REFJS", name: "Reference sine sweep", live: true };
export async function createEngine(ctx, opts) {
  const out = ctx.createGain(); out.gain.value = 0.5;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -6; comp.ratio.value = 8;
  out.connect(comp).connect(opts.destination || ctx.destination);
  const [wl, wh] = opts.whole_range, [sl, sh] = opts.strip_range, fps = opts.fps || 4;
  const nw = v => Math.min(1, Math.max(0, (v - wl) / Math.max(wh - wl, 1e-9))), ns = v => Math.min(1, Math.max(0, (v - sl) / Math.max(sh - sl, 1e-9)));
  let n = 0; const live = [];
  function frame(time, strips, whole) {
    if (n++ % (2 * fps) !== 0) return;          // one sweep every 2 s, aligned to t = 0
    const a = nw(whole);
    strips.forEach((raw, k) => {
      const v = ns(raw); if (v < 0.08) return;
      const t0 = time + k * 0.25, o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
      o.frequency.value = 220 * Math.pow(2, 2 * v); p.pan.value = -1 + 2 * k / 7;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.3 + 0.7 * a, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
      o.connect(g).connect(p).connect(out); o.start(t0); o.stop(t0 + 0.25); live.push(o);
    });
  }
  function stop() { live.forEach(o => { try { o.stop(); } catch (e) {} }); out.gain.value = 0; }
  return { frame, stop };
}
