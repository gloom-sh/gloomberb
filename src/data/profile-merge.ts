/**
 * Folds one writer's change to a saved profile document (config.json, a
 * ticker row) into another copy of it, so two programs writing the same
 * profile keep each other's edits: the app open in a terminal and a `gloom`
 * command run beside it.
 *
 * `diffProfile` lists what changed between the copy a writer started from
 * and the one it wrote; `applyProfileEdits` replays that list on any other
 * copy. The edits are fine-grained, so unrelated changes never collide:
 *
 * - objects merge key by key;
 * - lists of records with an `id` (or a pane's `instanceId`) merge record by
 *   record, keeping each side's additions, removals and order;
 * - lists of plain values (symbols, ids) merge as sets;
 * - a string that holds JSON (the alert lists) merges as the JSON it holds.
 *
 * When both sides changed the same value, the copy the edits land on keeps
 * its own. A removal always lands: an alert or a watchlist one side deleted
 * stays deleted, whatever the other changed in it meanwhile.
 */

export type ProfileJson = null | boolean | number | string | ProfileJson[] | { [key: string]: ProfileJson };
type ProfileObject = { [key: string]: ProfileJson };

/** One step into a document: an object key, a record in a list by its id, or the JSON a string holds. */
type ProfileStep = { key: string } | { id: string } | { json: true };

export type ProfileEdit =
  | { kind: "set"; path: ProfileStep[]; from: ProfileJson | undefined; to: ProfileJson }
  | { kind: "remove"; path: ProfileStep[] }
  | { kind: "members"; path: ProfileStep[]; from: ProfileJson[]; to: ProfileJson[]; add: ProfileJson[]; remove: ProfileJson[] }
  | { kind: "insert"; path: ProfileStep[]; after: string | null; record: ProfileObject }
  | { kind: "order"; path: ProfileStep[]; from: string[]; to: string[] };

const RECORD_KEYS = ["id", "instanceId"] as const;
type RecordKey = typeof RECORD_KEYS[number];

function isObject(value: unknown): value is ProfileObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sameProfileJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameProfileJson(entry, b[index]));
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && sameProfileJson(a[key], b[key]));
  }
  return false;
}

/** The field that names each record of a list, when every entry is a record with a distinct one. */
function recordKeyOf(list: readonly ProfileJson[]): RecordKey | null {
  if (list.length === 0) return null;
  for (const key of RECORD_KEYS) {
    const ids = new Set<string>();
    if (list.every((entry) => isObject(entry) && typeof entry[key] === "string" && !ids.has(entry[key] as string) && ids.add(entry[key] as string))) {
      return key;
    }
  }
  return null;
}

/** Both lists' record field: empty lists take the other's. */
function sharedRecordKey(a: readonly ProfileJson[], b: readonly ProfileJson[]): RecordKey | null {
  const aKey = recordKeyOf(a);
  const bKey = recordKeyOf(b);
  if (a.length === 0) return bKey;
  if (b.length === 0) return aKey;
  return aKey === bKey ? aKey : null;
}

function recordId(entry: ProfileJson, key: RecordKey | null): string | null {
  if (!isObject(entry)) return null;
  if (key) return typeof entry[key] === "string" ? entry[key] as string : null;
  for (const field of RECORD_KEYS) if (typeof entry[field] === "string") return entry[field] as string;
  return null;
}

function isPrimitive(value: ProfileJson): boolean {
  return value === null || typeof value !== "object";
}

/** A list of plain values with no repeats, which merges as a set. */
function isValueSet(list: readonly ProfileJson[]): boolean {
  return list.every(isPrimitive) && new Set(list).size === list.length;
}

function parseJsonText(value: string): ProfileJson | undefined {
  const text = value.trimStart();
  if (!text.startsWith("[") && !text.startsWith("{")) return undefined;
  try {
    return JSON.parse(value) as ProfileJson;
  } catch {
    // Intentional ignore: a string that only looks like JSON is compared as text.
    return undefined;
  }
}

/** The edits that turn `base` into `next`. */
export function diffProfile(base: ProfileJson | undefined, next: ProfileJson | undefined): ProfileEdit[] {
  const edits: ProfileEdit[] = [];
  diffInto(base, next, [], edits);
  return edits;
}

function diffInto(base: ProfileJson | undefined, next: ProfileJson | undefined, path: ProfileStep[], edits: ProfileEdit[]): void {
  if (sameProfileJson(base, next)) return;
  if (next === undefined) {
    edits.push({ kind: "remove", path });
    return;
  }
  if (isObject(base) && isObject(next)) {
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(next, key)) edits.push({ kind: "remove", path: [...path, { key }] });
    }
    for (const key of Object.keys(next)) diffInto(base[key], next[key], [...path, { key }], edits);
    return;
  }
  if (Array.isArray(base) && Array.isArray(next)) {
    const key = sharedRecordKey(base, next);
    if (key) {
      diffRecords(base, next, key, path, edits);
      return;
    }
    if (isValueSet(base) && isValueSet(next)) {
      const add = next.filter((entry) => !base.includes(entry));
      const remove = base.filter((entry) => !next.includes(entry));
      edits.push(add.length === 0 && remove.length === 0
        ? { kind: "set", path, from: base, to: next }
        : { kind: "members", path, from: base, to: next, add, remove });
      return;
    }
  }
  if (typeof base === "string" && typeof next === "string") {
    const baseJson = parseJsonText(base);
    const nextJson = parseJsonText(next);
    if (baseJson !== undefined && nextJson !== undefined) {
      diffInto(baseJson, nextJson, [...path, { json: true }], edits);
      return;
    }
  }
  edits.push({ kind: "set", path, from: base, to: next });
}

function diffRecords(base: ProfileJson[], next: ProfileJson[], key: RecordKey, path: ProfileStep[], edits: ProfileEdit[]): void {
  const baseById = new Map(base.map((entry) => [recordId(entry, key)!, entry]));
  const nextIds = next.map((entry) => recordId(entry, key)!);
  const nextIdSet = new Set(nextIds);
  for (const id of baseById.keys()) {
    if (!nextIdSet.has(id)) edits.push({ kind: "remove", path: [...path, { id }] });
  }
  next.forEach((entry, index) => {
    const id = nextIds[index]!;
    const before = baseById.get(id);
    if (before === undefined) {
      edits.push({ kind: "insert", path, after: index > 0 ? nextIds[index - 1]! : null, record: entry as ProfileObject });
    } else {
      diffInto(before, entry, [...path, { id }], edits);
    }
  });
  const from = [...baseById.keys()].filter((id) => nextIdSet.has(id));
  const to = nextIds.filter((id) => baseById.has(id));
  if (from.some((id, index) => id !== to[index])) edits.push({ kind: "order", path, from, to });
}

const REMOVED = Symbol("removed");
type Updated = ProfileJson | undefined | typeof REMOVED;

export interface ApplyProfileEditsOptions {
  /**
   * Who keeps a value both sides changed: the target (`keep`, the default),
   * or the side the edits came from (`take`).
   */
  conflicts?: "keep" | "take";
}

/** `target` with every edit replayed on it; the same object when none lands. */
export function applyProfileEdits<T extends ProfileJson>(target: T, edits: readonly ProfileEdit[], options: ApplyProfileEditsOptions = {}): T {
  const take = options.conflicts === "take";
  let result: ProfileJson = target;
  for (const edit of edits) {
    const next = updateAt(result, edit.path, 0, (current) => applyLeaf(current, edit, take));
    if (next !== REMOVED && next !== undefined) result = next;
  }
  return result as T;
}

/**
 * Rewrites the value at `path` with `update`. A step that no longer resolves
 * (a record or key the target removed, a string that no longer holds JSON)
 * leaves the target as it is: that side's removal wins.
 */
function updateAt(value: ProfileJson | undefined, path: readonly ProfileStep[], index: number, update: (current: ProfileJson | undefined) => Updated): Updated {
  if (index === path.length) return update(value);
  const step = path[index]!;
  if ("json" in step) {
    if (typeof value !== "string") return value;
    const parsed = parseJsonText(value);
    if (parsed === undefined) return value;
    const next = updateAt(parsed, path, index + 1, update);
    if (next === parsed || next === REMOVED || next === undefined) return value;
    return value.includes("\n") ? JSON.stringify(next, null, 2) : JSON.stringify(next);
  }
  if ("key" in step) {
    if (!isObject(value)) return value;
    const child = value[step.key];
    // Below a key the target no longer has, there is nothing left to change.
    if (child === undefined && index + 1 < path.length) return value;
    const next = updateAt(child, path, index + 1, update);
    if (next === child) return value;
    if (next === REMOVED || next === undefined) {
      if (!Object.hasOwn(value, step.key)) return value;
      const { [step.key]: _removed, ...rest } = value;
      return rest;
    }
    return { ...value, [step.key]: next };
  }
  if (!Array.isArray(value)) return value;
  const position = value.findIndex((entry) => recordId(entry, null) === step.id);
  if (position < 0) return value;
  const child = value[position]!;
  const next = updateAt(child, path, index + 1, update);
  if (next === child) return value;
  if (next === REMOVED || next === undefined) return value.filter((_, at) => at !== position);
  return value.map((entry, at) => (at === position ? next : entry));
}

function applyLeaf(current: ProfileJson | undefined, edit: ProfileEdit, take: boolean): Updated {
  switch (edit.kind) {
    case "remove":
      return current === undefined ? current : REMOVED;
    case "set":
      if (sameProfileJson(current, edit.to)) return current;
      if (take || sameProfileJson(current, edit.from)) return edit.to;
      // Both sides added the same key: keep this side's values and take what only the other has.
      if (edit.from === undefined && isObject(current) && isObject(edit.to)) return fillMissing(current, edit.to);
      return current;
    case "members": {
      if (sameProfileJson(current, edit.from)) return edit.to;
      if (!Array.isArray(current)) return current;
      const kept = current.filter((entry) => !edit.remove.some((removed) => sameProfileJson(removed, entry)));
      const added = edit.add.filter((entry) => !kept.some((present) => sameProfileJson(present, entry)));
      const next = [...kept, ...added];
      return sameProfileJson(next, current) ? current : next;
    }
    case "insert": {
      if (!Array.isArray(current)) return current;
      const id = recordId(edit.record, null);
      const existing = current.findIndex((entry) => recordId(entry, null) === id);
      if (existing >= 0) {
        const present = current[existing]!;
        if (!isObject(present)) return current;
        const filled = fillMissing(present, edit.record);
        return filled === present ? current : current.map((entry, at) => (at === existing ? filled : entry));
      }
      const afterIndex = edit.after === null ? -1 : current.findIndex((entry) => recordId(entry, null) === edit.after);
      const at = edit.after === null ? 0 : afterIndex >= 0 ? afterIndex + 1 : current.length;
      return [...current.slice(0, at), edit.record, ...current.slice(at)];
    }
    case "order": {
      if (!Array.isArray(current)) return current;
      const wanted = new Set(edit.to);
      const positions: number[] = [];
      const present: string[] = [];
      current.forEach((entry, at) => {
        const id = recordId(entry, null);
        if (id !== null && wanted.has(id)) {
          positions.push(at);
          present.push(id);
        }
      });
      // A list this side reordered keeps its own order.
      const fromOrder = edit.from.filter((id) => present.includes(id));
      if (fromOrder.some((id, at) => id !== present[at])) return current;
      const toOrder = edit.to.filter((id) => present.includes(id));
      const byId = new Map(current.map((entry) => [recordId(entry, null), entry]));
      const next = [...current];
      positions.forEach((position, at) => { next[position] = byId.get(toOrder[at]!)!; });
      return sameProfileJson(next, current) ? current : next;
    }
  }
}

/** `present` with the keys only `added` has, recursively. */
function fillMissing(present: ProfileObject, added: ProfileObject): ProfileObject {
  let result = present;
  for (const [key, value] of Object.entries(added)) {
    const mine = present[key];
    const next = mine === undefined ? value : isObject(mine) && isObject(value) ? fillMissing(mine, value) : mine;
    if (next !== mine) result = { ...result, [key]: next };
  }
  return result;
}
