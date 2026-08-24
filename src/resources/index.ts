/**
 * Every resource namespace, in one place.
 *
 * `client.ts` imports the namespace classes from here indirectly (it imports
 * the modules themselves, so a namespace can be dropped in without editing an
 * aggregator), and consumers import the record and input types from here.
 *
 * Re-exports every sibling module so nobody has to touch this file again: a new
 * resource means one new file plus one line in {@link Oms}, and no edit to a
 * file another agent may also be holding.
 *
 * Naming rule that keeps `export *` unambiguous: every exported name is
 * prefixed by its domain (`ShortLink`, `ShortLinkStats`, `CreateShortLinkInput`).
 * A bare `Stats` or `CreateInput` would collide the moment a second resource
 * wanted one, and TypeScript reports that as an error at this file, not at the
 * file that caused it.
 */

export * from "./account";
export * from "./chests";
export * from "./dynamicQrs";
export * from "./forms";
export * from "./ipLookup";
export * from "./jobs";
export * from "./linkTrees";
export * from "./notepads";
export * from "./shortLinks";
export * from "./storage";
export * from "./storage/upload";
export * from "./tickets";
export * from "./tools/index";
