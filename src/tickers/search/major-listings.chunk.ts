/**
 * The major listings of the US, Hong Kong, China, Singapore, Japan and Europe
 * as search answered them when this version was built
 * (`bun run listings:snapshot`). A lazy chunk: the app reads it after launch,
 * and the web build keeps it out of the startup bundle.
 */
import snapshot from "./major-listings.json";
import type { KeptListing } from "./listing-index";

export const MAJOR_LISTINGS = snapshot.listings as unknown as readonly KeptListing[];
