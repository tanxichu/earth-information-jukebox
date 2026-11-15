// preset wrapper: P6.js with preset "v12" (the shared harness only passes the engine id)
import { createEngine as base } from "./P6.js";
export const meta = { id: "P6_v12", name: "Rhythm / groove v12", live: true };
export const createEngine = (ctx, opts) => base(ctx, { ...opts, preset: "v12" });
