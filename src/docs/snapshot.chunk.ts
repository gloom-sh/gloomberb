/**
 * The docs index as gloom.sh served it when this version was built
 * (`bun run docs:snapshot`). A lazy chunk: the web build fetches it only when
 * the DOCS pane first opens.
 */
import snapshot from "./snapshot.json";

export const DOCS_SNAPSHOT: unknown = snapshot;
