// preset wrapper: P6.js with preset "v16_dry" (the shared harness only passes the engine id)
import { createEngine as base } from "./P6.js";
export const meta = { id: "P6_v16_dry", name: "Rhythm / groove v16_dry", live: true };
export const createEngine = (ctx, opts) => base(ctx, { ...opts, preset: "v16_dry" });
