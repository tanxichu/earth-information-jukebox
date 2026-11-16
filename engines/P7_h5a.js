// P7 preset h5a (harmonised groove in D major; strips from P3.js whose chord loop is already D/Bm/G/A-based). Wrapper: P7.js with opts.preset = "h5a".
import { createEngine as base } from "./P7.js";
export const meta = { id: "P7_h5a", name: "Hybrid h5a", live: true };
export const createEngine = (ctx, opts = {}) => base(ctx, { ...opts, preset: "h5a" });
