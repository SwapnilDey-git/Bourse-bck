// Barrel for the data seam. `@/lib/data` keeps its exact public API — every
// type, array and helper the 18 consumer files already import is re-exported
// here unchanged, so M0 is a zero-UI-change refactor. New in M0: the
// `BourseData` contract (from ./types) and the `provider` selector (./provider),
// which the screens migrate onto domain-by-domain from M1.

// NOTE: the `provider` selector is intentionally NOT re-exported here. It pulls
// in the server-only live modules (hl/cache), so client components importing
// `@/lib/data` must not transitively bundle it. Server code imports the provider
// directly from `@/lib/data/provider`.
export * from "./types";
export * from "./mock";
