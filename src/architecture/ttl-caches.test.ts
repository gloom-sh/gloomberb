import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

// A built-in plugin that keeps loaded data for a while uses `createTtlCache`
// (src/data/ttl-cache.ts), which has one rule for a concurrent call, a forced
// reload and a failed load. Before it, a dozen plugins each kept a
// `Map<key, { at, value }>` with a TTL constant and a `Date.now() - at` check,
// every copy with its own rules. This ratchet finds the two shapes such a copy
// takes, and a new one fails the test. A site that is not a cache of loaded
// data, or that cannot use the helper, is listed in ttl-caches-allowlist.json
// with the reason.
//
// The scan is a heuristic over names, so it cannot prove a plugin has no hand
// rolled cache: it catches the shapes that were actually written.
const ROOT = resolve(import.meta.dir, "../..");
const ALLOWLIST = new URL("./ttl-caches-allowlist.json", import.meta.url);
const SCANNED = ["src/plugins/builtin"];

/** The names a cache entry's timestamp goes by. */
const STAMPS = new Set(["at", "fetchedAt", "loadedAt", "cachedAt", "savedAt", "storedAt", "checkedAt", "expiresAt", "retryAt"]);
/** What an age is compared with when it is a cache's limit. */
const LIMIT_NAME = /ttl|reuse|cache|fresh/i;
const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);

interface Site { file: string; line: number; signature: string }

function sourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, files);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

/** Hand-rolled caches in one file: a Map of entries that carry a timestamp, and an age compared with a cache limit. */
function handRolledTtlCaches(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const declared = new Map<string, ts.Node>();
  const collect = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) declared.set(node.name.text, node);
    ts.forEachChild(node, collect);
  };
  collect(source);

  const stamped = (members: ts.NodeArray<ts.TypeElement>) => members.some((member) => ts.isPropertySignature(member)
    && ts.isIdentifier(member.name) && STAMPS.has(member.name.text) && member.type?.kind === ts.SyntaxKind.NumberKeyword);
  const carriesStamp = (type: ts.TypeNode | undefined, depth = 0): boolean => {
    if (!type || depth > 3) return false;
    if (ts.isTypeLiteralNode(type)) return stamped(type.members);
    if (!ts.isTypeReferenceNode(type)) return false;
    const name = type.typeName.getText(source);
    if (name === "Map" || name === "WeakMap") return (type.typeArguments ?? []).some((argument) => carriesStamp(argument, depth + 1));
    const local = declared.get(name);
    if (local && ts.isInterfaceDeclaration(local)) return stamped(local.members);
    return !!local && ts.isTypeAliasDeclaration(local) && carriesStamp(local.type, depth + 1);
  };
  const isClock = (node: ts.Expression) => /^(Date\.now\(\)|now\(\)|this\.now\(\)|now)$/.test(node.getText(source));
  const stampOf = (node: ts.Expression) => {
    const expression = unwrap(node);
    return ts.isPropertyAccessExpression(expression) && STAMPS.has(expression.name.text) ? expression : null;
  };

  const sites: Site[] = [];
  const found = (node: ts.Node, kind: string) => sites.push({
    file,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    signature: `${kind}: ${normalize(node.getText(source))}`,
  });
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && /^(Map|WeakMap)$/.test(node.expression.getText(source))
      && node.typeArguments?.some((argument) => carriesStamp(argument))) found(node, "map");
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
      const [left, right] = [unwrap(node.left), unwrap(node.right)];
      for (const [age, limit] of [[left, right], [right, left]] as const) {
        // `now - entry.at < TTL`: how old an entry is against how long it may live.
        if (ts.isBinaryExpression(age) && age.operatorToken.kind === ts.SyntaxKind.MinusToken
          && isClock(unwrap(age.left)) && stampOf(age.right) && LIMIT_NAME.test(limit.getText(source))) found(node, "age");
        // `entry.expiresAt > now`: an entry's own deadline against the clock.
        const deadline = stampOf(age);
        if (deadline && /^(expiresAt|retryAt)$/.test(deadline.name.text) && isClock(limit)) found(node, "deadline");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function scan(): Site[] {
  return SCANNED.flatMap((dir) => sourceFiles(resolve(ROOT, dir)))
    .flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return handRolledTtlCaches(relative(ROOT, path).split(sep).join("/"), text);
    });
}

test("every hand-rolled TTL cache in a built-in plugin is listed with its reason", async () => {
  const allowlist: Record<string, Record<string, string>> = await Bun.file(ALLOWLIST).json();
  const listed = new Set(Object.entries(allowlist).flatMap(([file, signatures]) => Object.keys(signatures).map((signature) => `${file}\n${signature}`)));
  const sites = scan();
  const keyOf = (site: Site) => `${site.file}\n${site.signature}`;
  const seen = new Set(sites.map(keyOf));
  const failures = [
    ...sites.filter((site) => !listed.has(keyOf(site))).map((site) => `${site.file}:${site.line} keeps its own TTL cache (${site.signature}).`),
    ...[...listed].filter((key) => !seen.has(key)).map((key) => `Stale entry in ttl-caches-allowlist.json: ${key.replace("\n", " ")}`),
  ];
  if (failures.length) {
    throw new Error(`${failures.join("\n")}\n\nUse createTtlCache from src/data/ttl-cache.ts. If the site is not a cache of loaded data, or needs something the helper does not give, list it in src/architecture/ttl-caches-allowlist.json with the reason.`);
  }
}, 15_000);

test("the allowlist gives a reason for every entry", async () => {
  const allowlist: Record<string, Record<string, string>> = await Bun.file(ALLOWLIST).json();
  for (const [file, signatures] of Object.entries(allowlist)) {
    for (const [signature, why] of Object.entries(signatures)) expect(why.trim().length, `${file}: ${signature}`).toBeGreaterThan(20);
  }
});

test("the scan finds the Map of timestamped entries and the age check, and leaves the helper and plain maps alone", () => {
  const sites = handRolledTtlCaches("src/plugins/builtin/example.ts", `
    interface Kept { at: number; answer: Promise<boolean> }
    const a = new Map<string, { at: number; state: State }>();
    const b = new WeakMap<Route, Map<string, Kept>>();
    const c = new Map<string, { value: number; expiresAt: number }>();
    const plain = new Map<string, { value: number; label: string }>();
    const named = new Map<string, { at: string }>();
    if (Date.now() - entry.at > SUMMARY_TTL_MS) return null;
    if (now - cached.fetchedAt < reuseMs) return cached;
    if (cached.expiresAt > this.now()) return cached;
    if (now < cached.retryAt) return cached;
    if (Date.now() - pending.at < PENDING_FOCUS_MS) return pending;
    if (now - state.at >= intervalMs) return state;
    const cache = createTtlCache<string>({ ttlMs: 1_000 });
  `);
  expect(sites.map((site) => site.signature.split(":")[0])).toEqual(["map", "map", "map", "age", "age", "deadline", "deadline"]);
});
