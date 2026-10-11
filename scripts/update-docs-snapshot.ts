/**
 * Refreshes the DOCS pane's offline copy, `src/docs/snapshot.json`, from the
 * index gloom.sh serves: `bun run docs:snapshot`. The app reads the site live
 * and keeps what it read; this copy is what a first start or an offline
 * machine shows. It is written as the site sent it, never edited by hand.
 *
 * `--file <path>` reads a saved index instead, for a site change that is not
 * deployed yet. `--check` fails when the copy no longer parses.
 */
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { DOCS_FEED_URL, parseDocsFeed } from "../src/docs/content";

const SNAPSHOT_PATH = join(import.meta.dir, "..", "src", "docs", "snapshot.json");

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function readSource(): Promise<unknown> {
  const file = argValue("--file");
  if (file) return JSON.parse(await readFile(file, "utf8"));
  const response = await fetch(DOCS_FEED_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${DOCS_FEED_URL} returned ${response.status}`);
  return response.json();
}

if (process.argv.includes("--check")) {
  const feed = parseDocsFeed(JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")));
  if (!feed) {
    console.error(`${SNAPSHOT_PATH} is not a docs index this app can read. Run bun run docs:snapshot.`);
    process.exit(1);
  }
  console.log(`docs snapshot: ${feed.functions.length} functions, ${feed.pages.length} pages, ${feed.lessons.length} lessons, ${feed.updatedAt}`);
} else {
  const raw = await readSource();
  const feed = parseDocsFeed(raw);
  if (!feed) throw new Error("The docs index is not in a shape this app reads.");
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(raw, null, 1)}\n`);
  console.log(`Wrote ${SNAPSHOT_PATH}: ${feed.functions.length} functions, ${feed.pages.length} pages, ${feed.lessons.length} lessons.`);
}
