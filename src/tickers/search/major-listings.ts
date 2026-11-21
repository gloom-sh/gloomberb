import type { KeptListing } from "./listing-index";

let listings: Promise<readonly KeptListing[]> | null = null;

/**
 * The major listings shipped with the app, read once, the first time they are
 * asked for. Code outside this folder loads the lazy chunk through here: the
 * web build takes a chunk only as `./name.chunk.js` from its own folder.
 */
export function majorListings(): Promise<readonly KeptListing[]> {
  listings ??= import("./major-listings.chunk.js").then(({ MAJOR_LISTINGS }) => MAJOR_LISTINGS);
  return listings;
}
