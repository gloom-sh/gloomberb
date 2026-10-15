/**
 * The one mapping from a pane, or a function, to its place in the docs. The
 * `?` on every pane, `F1`'s card and `DOCS <function>` all go through it.
 *
 * A pane stands for the function that opened it (`helpFunctionForPane`: GP for
 * a chart opened as GP, otherwise the pane's first function). A function's
 * entry is its own mnemonic in the docs, or where its help card files it
 * (BTST under BT, MCP on a page of its own). The few panes no function opens
 * are listed here; `targets.test.ts` fails when a pane or a function has no
 * entry in the docs the app ships.
 */
import { DOCS_SITE } from "../../../docs/content";
import type { DocsTopic } from "../../../docs/topics";
import {
  helpFunctionForPane,
  type HelpFunction,
  type HelpFunctionIndex,
} from "../help/function-index";

/** Panes no function opens, by the entry that explains them. */
const PANE_DOCS: Readonly<Record<string, DocsTopic>> = {
  // The chat inbox of unread conversations.
  "unread-inbox": { kind: "function", code: "CHAT" },
  team: { kind: "function", code: "TEAM" },
  "twitter-feed": { kind: "function", code: "TWIT" },
  // One article opened from a news list.
  "news-story": { kind: "function", code: "N" },
  "attention-trending": { kind: "page", slug: "attention" },
  // The reader itself: its ? goes back to the index.
  docs: { kind: "home" },
};

const SITE_DOCS_PREFIX = `${DOCS_SITE}/docs/`;

/** The entry for a function: its own mnemonic, or the one its help card files it under. */
export function docsTopicForFunction(fn: Pick<HelpFunction, "code" | "help">): DocsTopic {
  const target = fn.help?.docs ?? fn.code;
  if (!target.startsWith("https://")) return { kind: "function", code: target.toUpperCase() };
  if (target.startsWith(`${SITE_DOCS_PREFIX}functions#`)) {
    return { kind: "function", code: fn.code };
  }
  if (target.startsWith(SITE_DOCS_PREFIX)) {
    return { kind: "page", slug: target.slice(SITE_DOCS_PREFIX.length).split("#")[0]! };
  }
  return { kind: "function", code: fn.code };
}

/** The entry for a pane instance, or null for a pane the docs know nothing about. */
export function docsTopicForPane(
  index: HelpFunctionIndex,
  registry: Parameters<typeof helpFunctionForPane>[1],
  instance: { paneId: string; title?: string },
): DocsTopic | null {
  const listed = PANE_DOCS[instance.paneId];
  if (listed) return listed;
  const fn = helpFunctionForPane(index, registry, instance);
  return fn ? docsTopicForFunction(fn) : null;
}

/**
 * What `DOCS <argument>` asks for: a mnemonic or one of its aliases
 * (`DOCS OMON`, `DOCS ct`), with or without its own argument (`DOCS OMON
 * NVDA`), or words to search the docs for. Without an index every argument
 * stays a search, which the reader opens on a matching entry.
 */
export function docsTopicForArgument(index: HelpFunctionIndex | null, argument: string): DocsTopic {
  const query = argument.trim();
  if (!query) return { kind: "home" };
  // A command line with no registry (`gloomberb fn DOCS RV`) cannot resolve a mnemonic here: the reader does, from its own entries.
  const fn = index?.get(query.toUpperCase()) ?? index?.get((query.split(/\s+/)[0] ?? "").toUpperCase());
  if (fn) return docsTopicForFunction(fn);
  return { kind: "home", query };
}

