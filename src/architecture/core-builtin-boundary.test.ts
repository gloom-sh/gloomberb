import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { collectCoreBuiltinImports, formatCoreBuiltinAllowlist } from "../../scripts/update-core-builtin-allowlist";

const ROOT = resolve(import.meta.dir, "../..");
const ALLOWLIST = new URL("./core-builtin-allowlist.json", import.meta.url);
const UPDATE = "bun scripts/update-core-builtin-allowlist.ts";

test("core imports of specific built-in plugins match the allowlist", async () => {
  const allowlist: Record<string, string[]> = await Bun.file(ALLOWLIST).json();
  const imports = collectCoreBuiltinImports(ROOT);
  const current = new Set(imports.map(({ file, plugin }) => `${file}:${plugin}`));
  const added = imports.filter(({ file, plugin }) => !allowlist[file]?.includes(plugin));
  const stale = Object.entries(allowlist).flatMap(([file, plugins]) =>
    plugins.filter((plugin) => !current.has(`${file}:${plugin}`)).map((plugin) => `${file} -> ${plugin}`));
  const failures: string[] = [];
  if (added.length) {
    failures.push("New core to built-in imports:\n"
      + added.map(({ file, specifier, plugin }) => `${file}: ${JSON.stringify(specifier)} -> ${plugin}`).join("\n")
      + "\nCore code should not import a specific built-in plugin. Move the shared code to core (src/<area>/) or to src/plugins/builtin/shared, or, if core really must call this plugin, add the edge with `"
      + UPDATE + "` and say why in the PR.");
  }
  if (stale.length) {
    failures.push("Stale core to built-in allowlist entries:\n" + stale.join("\n")
      + `\nRun \`${UPDATE}\` to remove stale entries so the number of allowed edges goes down.`);
  }
  if (failures.length) throw new Error(failures.join("\n\n"));
});

test("the core to built-in allowlist is sorted, unique, and names existing files", async () => {
  const text = await Bun.file(ALLOWLIST).text();
  const allowlist: Record<string, string[]> = JSON.parse(text);
  // Comparing the serialized form also catches duplicate JSON keys.
  expect(text, `Run \`${UPDATE}\` to sort and deduplicate the allowlist.`).toBe(formatCoreBuiltinAllowlist(allowlist));
  for (const [file, plugins] of Object.entries(allowlist)) {
    expect(plugins.length, `${file} has no edges. Run \`${UPDATE}\`.`).toBeGreaterThan(0);
    expect(await Bun.file(resolve(ROOT, file)).exists(), `${file} does not exist. Run \`${UPDATE}\`.`).toBe(true);
  }
});
