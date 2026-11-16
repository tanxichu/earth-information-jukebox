// preset wrapper: P6.js with preset "v17_both" (the shared harness only passes the engine id)
import { createEngine as base } from "./P6.js";
export const meta = { id: "P6_v17_both", name: "Rhythm / groove v17_both", live: true };
export const createEngine = (ctx, opts) => base(ctx, { ...opts, preset: "v17_both" });
