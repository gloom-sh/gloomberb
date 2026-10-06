import type { JsonValue } from "./protocol";

/** One list the budget shortened, named so a reader can tell which. */
export interface TrimmedList {
  path: string;
  shown: number;
  total: number;
  /** Rows of a list, or characters of one oversized text value. */
  unit: "rows" | "characters";
}

export interface FittedResult {
  result: JsonValue;
  trimmed: TrimmedList[];
}

interface ListNode {
  list: JsonValue[];
  path: string;
  bytes: number;
  /** Bytes of the largest list nested anywhere inside this one. */
  largestNestedBytes: number;
}

interface TextNode {
  holder: { [key: string]: JsonValue } | JsonValue[];
  key: string | number;
  path: string;
  length: number;
}

const encoder = new TextEncoder();
const MAX_PASSES = 64;
/** Text is only cut once no list can give up a row, and never below this. */
const MIN_TEXT_LENGTH = 200;
const TEXT_CUT_MARK = " [cut]";

function jsonBytes(value: JsonValue): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `sections[correlation]` reads better than `sections[3]` when the entry names itself. */
function entryLabel(entry: JsonValue, index: number): string {
  if (isObject(entry)) {
    for (const key of ["title", "label", "id", "symbol", "name"]) {
      const value = entry[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 40);
    }
  }
  return String(index);
}

/** Lists with more than one entry, each with its size and the size of its largest nested list. */
function collectLists(value: JsonValue, path: string, out: ListNode[]): number {
  if (Array.isArray(value)) {
    let largestNestedBytes = 0;
    value.forEach((entry, index) => {
      const nested = collectLists(entry, `${path}[${entryLabel(entry, index)}]`, out);
      largestNestedBytes = Math.max(largestNestedBytes, nested);
    });
    const bytes = jsonBytes(value);
    if (value.length > 1) out.push({ list: value, path: path || "result", bytes, largestNestedBytes });
    return Math.max(largestNestedBytes, value.length > 1 ? bytes : 0);
  }
  if (isObject(value)) {
    let largest = 0;
    for (const [key, entry] of Object.entries(value)) {
      largest = Math.max(largest, collectLists(entry, path ? `${path}.${key}` : key, out));
    }
    return largest;
  }
  return 0;
}

function longestText(value: JsonValue, path: string): TextNode | null {
  let best = null as TextNode | null;
  const visit = (holder: TextNode["holder"], key: string | number, entry: JsonValue, entryPath: string) => {
    if (typeof entry === "string") {
      if (!best || entry.length > best.length) best = { holder, key, path: entryPath, length: entry.length };
      return;
    }
    walk(entry, entryPath);
  };
  const walk = (node: JsonValue, nodePath: string) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(node, index, entry, `${nodePath}[${entryLabel(entry, index)}]`));
    } else if (isObject(node)) {
      for (const [key, entry] of Object.entries(node)) visit(node, key, entry, nodePath ? `${nodePath}.${key}` : key);
    }
  };
  walk(value, path);
  return best;
}

/**
 * Shrinks a tool result until its JSON fits `maxBytes` by dropping whole rows,
 * never by cutting text: what is left still parses and every row in it is
 * complete. The list holding most of the bytes loses rows first, and a list
 * only gives way to the lists inside it when one of those is most of its size,
 * so a bundle loses rows from its biggest section rather than whole sections.
 * Rows keep their order and the first ones stay, except series `points`, which
 * keep their latest observations. Only when no list can shrink further is the
 * longest text value shortened, and it is marked as cut. Null when nothing
 * left can give way.
 */
export function fitResultToBytes(value: JsonValue, maxBytes: number): FittedResult | null {
  const result = structuredClone(value);
  const trimmed = new Map<string, TrimmedList>();
  const record = (path: string, unit: TrimmedList["unit"], total: number, shown: number) => {
    const current = trimmed.get(path);
    trimmed.set(path, { path, unit, total: current?.total ?? total, shown });
  };

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const size = jsonBytes(result);
    if (size <= maxBytes) {
      return { result, trimmed: [...trimmed.values()] };
    }

    const lists: ListNode[] = [];
    collectLists(result, "", lists);
    const target = lists
      .filter((node) => node.largestNestedBytes <= node.bytes / 2)
      .sort((left, right) => right.bytes - left.bytes)[0];
    if (target) {
      const { list, path } = target;
      const total = list.length;
      const perRow = target.bytes / list.length;
      const remove = Math.ceil(((size - maxBytes) / perRow) * 1.05) + 1;
      const keep = Math.max(1, list.length - remove);
      if (path.endsWith(".points")) list.splice(0, list.length - keep);
      else list.splice(keep);
      record(path, "rows", total, keep);
      continue;
    }

    const text = longestText(result, "");
    if (!text || text.length <= MIN_TEXT_LENGTH) return null;
    const current = (text.holder as Record<string | number, string>)[text.key]!;
    const keep = Math.max(MIN_TEXT_LENGTH, Math.floor(current.length - (size - maxBytes) * 1.05) - TEXT_CUT_MARK.length);
    (text.holder as Record<string | number, JsonValue>)[text.key] = `${current.slice(0, keep)}${TEXT_CUT_MARK}`;
    record(text.path, "characters", current.length, keep);
  }
  return null;
}

/** "sections[correlation].rows 50 of 4371 rows" for each shortened value, for the result note. */
export function describeTrimmedLists(trimmed: readonly TrimmedList[]): string {
  return trimmed
    .map(({ path, shown, total, unit }) => `${path} ${shown} of ${total} ${unit}`)
    .join(", ");
}
