/**
 * Every resource namespace, in one place.
 *
 * `client.ts` imports the namespace classes from the modules themselves rather
 * than from here, so adding a resource does not serialise on this file;
 * consumers import the record and input types from here, flattened through
 * `src/index.ts`.
 *
 * Re-exports every sibling module so nobody has to touch this file twice: a new
 * resource means one new file, one line here, and one line in {@link Oms}.
 *
 * Naming rule that keeps `export *` unambiguous: every exported name is
 * prefixed by its domain (`ShortLink`, `ShortLinkStats`, `CreateShortLinkInput`).
 * A bare `Stats` or `CreateInput` would collide the moment a second resource
 * wanted one, and an `export *` collision does NOT fail the build - TypeScript
 * drops the ambiguous name from the barrel in silence, so the symbol simply
 * stops existing for consumers. `test/exports.test.ts` walks the re-export
 * graph and fails on a duplicate, because the compiler will not.
 */

export * from "./account";
export * from "./admin";
export * from "./auth/index";
export * from "./chests";
export * from "./content";
export * from "./dynamicQrs";
export * from "./forms";
export * from "./ipLookup";
export * from "./jobs";
export * from "./library";
export * from "./linkTrees";
export * from "./media";
export * from "./movies";
export * from "./music/index";
export * from "./notepads";
export * from "./quotas";
export * from "./realtime";
export * from "./search";
export * from "./shortLinks";
export * from "./social";
export * from "./storage";
export * from "./storage/upload";
export * from "./tickets";
export * from "./tools/index";
