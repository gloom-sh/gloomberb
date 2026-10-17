import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { collectSilentCatches, formatSilentCatchAllowlist, scanSilentCatches } from "../../scripts/update-silent-catch-allowlist";

const ROOT = resolve(import.meta.dir, "../..");
const ALLOWLIST = new URL("./silent-catch-allowlist.json", import.meta.url);
const UPDATE = "bun scripts/update-silent-catch-allowlist.ts";

test("core silent catches match the allowlist", async () => {
  const allowlist: Record<string, string[]> = await Bun.file(ALLOWLIST).json();
  const sites = collectSilentCatches(ROOT).filter((site) => site.scope === "in" && !site.intentional);
  const remaining = new Map(Object.entries(allowlist).flatMap(([file, signatures]) =>
    [...new Set(signatures)].map((signature) => [
      `${file}:${signature}`, signatures.filter((value) => value === signature).length,
    ] as const)));
  const added: string[] = [];
  for (const site of sites) {
    const key = `${site.file}:${site.signature}`;
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else added.push(`${site.file}:${site.line}:${site.column} (${site.kind})`);
  }
  const stale = [...remaining].filter(([, count]) => count > 0).map(([key, count]) => `${key} (${count} site${count === 1 ? "" : "s"})`);
  const failures: string[] = [];
  if (added.length) failures.push("New silent catches in core:\n" + added.join("\n")
    + "\nRecord real failures with logFailure or the caller's existing error surface. For an intentional ignore, put `Intentional ignore: <specific reason>` in a comment inside the handler.");
  if (stale.length) failures.push("Stale silent catch allowlist entries:\n" + stale.join("\n")
    + `\nRun \`${UPDATE}\` to remove stale entries.`);
  if (failures.length) throw new Error(failures.join("\n\n"));
});

test("the silent catch allowlist is canonical and names existing files", async () => {
  const text = await Bun.file(ALLOWLIST).text();
  const allowlist: Record<string, string[]> = JSON.parse(text);
  expect(text, `Run \`${UPDATE}\` to sort the allowlist.`).toBe(formatSilentCatchAllowlist(allowlist));
  for (const [file, signatures] of Object.entries(allowlist)) {
    expect(signatures.length, `${file} has no sites. Run \`${UPDATE}\`.`).toBeGreaterThan(0);
    expect(await Bun.file(resolve(ROOT, file)).exists(), `${file} does not exist. Run \`${UPDATE}\`.`).toBe(true);
  }
});

test("the AST walk finds multiline constant fallbacks and requires an actual handler comment", () => {
  const sites = scanSilentCatches("src/example.ts", `
    // Intentional ignore: this comment is outside the handler.
    try { work(); } catch {}
    try { work(); } catch (error) { return { rows: [], failed: false }; }
    job.catch(
      (_error) => {
        return undefined;
      },
    );
    job.catch((error) => { void error; });
    job.catch(() => ([] as const));
    job["catch"](function () { return null; });
    job.catch(() => {
      // Intentional ignore: the caller already reports this task's failure.
    });
    job.catch(() => { /* Intentional ignore: cleanup is best effort. */ return false; });
    try { work(); } catch { return "// Intentional ignore: this is a string"; }
    job.catch(() => { /* Intentional ignore: */ });
    // job.catch(() => {});
    const example = "try {} catch {}";
    job.catch((error) => report(error));
    job.catch((error) => error);
    job.catch(() => loadFallback());
    try { work(); } catch (error) { throw error; }
    try { work(); } catch { return getFallback(); }
  `);
  expect(sites.map(({ kind, intentional }) => ({ kind, intentional }))).toEqual([
    { kind: "catch", intentional: false },
    { kind: "catch", intentional: false },
    { kind: "promise-catch", intentional: false },
    { kind: "promise-catch", intentional: false },
    { kind: "promise-catch", intentional: false },
    { kind: "promise-catch", intentional: false },
    { kind: "promise-catch", intentional: true },
    { kind: "promise-catch", intentional: true },
    { kind: "catch", intentional: false },
    { kind: "promise-catch", intentional: false },
  ]);
});
