// preset wrapper: P6.js with preset "v10" (the shared harness only passes the engine id)
import { createEngine as base } from "./P6.js";
export const meta = { id: "P6_v10", name: "Rhythm / groove v10", live: true };
export const createEngine = (ctx, opts) => base(ctx, { ...opts, preset: "v10" });
