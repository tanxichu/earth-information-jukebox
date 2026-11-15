# Live sonification engines (browser, Web Audio)

Each engine is an ES module `engines/<ID>.js` that turns NASA EIC animation data into sound **in real time**.
The same module is used (a) live on the product page and (b) offline by the benchmark harness, so the score of the
browser version can be checked against the Python reference renderer in `bench/pipelines/<family>/`.

## Interface (all engines)
```js
export const meta = { id: "P3", name: "Ambient voices", live: true };
export async function createEngine(ctx, opts) { ... return { frame, stop }; }
```
- `ctx`: a `BaseAudioContext` (live `AudioContext` or `OfflineAudioContext`). Connect your output to `opts.destination || ctx.destination`.
- `opts`: `{ key, feature, whole_range: [lo, hi], strip_range: [lo, hi], anim_stats: {whole_mean, strip_mean}, fps: 4, baseUrl }`. `key`, ranges and `anim_stats` are per-animation constants precomputed from the FULL animation (like `eic/ranges.json`), so the live page has them for the 25 catalog animations; for a user's own video they are missing (`key`/`anim_stats` undefined) and the engine must fall back to running estimates. `anim_stats` means are of the range-normalised amounts (0–1). (`baseUrl` = URL of the `web/` root, for samples, e.g. `../vendor/salamander/`).
- `frame(time, strips, whole)`: called once per data frame (every 1/fps = 0.25 s), **in order**, with `time` = the context time at which this frame starts. `strips` = 8 raw west→east shares, `whole` = raw whole-frame share (normalise them yourself with the ranges, same as the Python version). Schedule everything for `[time, time + 1/fps)`; continuous voices may be updated with `setTargetAtTime`/`linearRampToValueAtTime`. In offline rendering all frames are called before rendering starts, so never read `ctx.currentTime` to decide what to play.
- **Causal only (main-session rule, 22:55):** an engine may use `opts` (feature, the animation's robust ranges, fps) and the frames it has already been given — never future frames. Live, the page only knows the precomputed ranges (`eic/ranges.json`) and the frames played so far (for a user's own video not even the ranges, so keep a running min/max fallback when ranges are missing). The harness therefore passes no data preview. If the Python reference used whole-clip statistics, match it as closely as a causal engine can and report the gap honestly.
- `stop()`: silence quickly and release nodes (live use).
- Loudness: aim for about −18 LUFS and true peak ≤ −1.5 dBTP (put a `DynamicsCompressorNode` or gain at the end); the harness does not normalise.
- No external libraries required; plain Web Audio. Samples allowed: Salamander piano (CC-BY) from `../vendor/salamander/`.

## Harness
`engines/harness.html?engine=<ID>&set=main|holdout` renders the 12 benchmark clips offline (data in `engines/benchdata/`)
and exposes the WAVs; `bench/tools/render_js.js` (Node + Playwright) saves them to `bench/out/<RUN>/` (or `out_holdout/`)
so `bench/tools/score.py` scores the browser version exactly like a Python run.
