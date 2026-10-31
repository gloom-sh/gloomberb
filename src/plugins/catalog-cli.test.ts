import { expect, test } from "bun:test";
import { getPluginCatalog } from "./catalog";
import { getBuiltinCliCommands } from "./catalog-cli";

test("CLI registration uses every built-in command and its original owner in catalog order", () => {
  const expected = getPluginCatalog().flatMap(({ plugin }) => (
    plugin.cliCommands?.length ? [{ pluginId: plugin.id, commands: plugin.cliCommands }] : []
  ));
  const actual = getBuiltinCliCommands();
  expect(actual.map(({ pluginId, commands }) => [pluginId, commands.map((command) => command.name)]))
    .toEqual(expected.map(({ pluginId, commands }) => [pluginId, commands.map((command) => command.name)]));
  for (let index = 0; index < actual.length; index++) {
    actual[index]!.commands.forEach((command, commandIndex) => {
      expect(command).toBe(expected[index]!.commands[commandIndex]);
    });
  }
});

test("reading built-in CLI commands never evaluates the pane catalog", () => {
  // A separate process avoids the UI modules imported by this test and other tests.
  const result = Bun.spawnSync([process.execPath, "-e", `
    await import(${JSON.stringify(new URL("./catalog-cli.ts", import.meta.url).href)});
    console.log(JSON.stringify(Object.keys(require.cache).filter(path =>
      /[\\/]catalog(?:-ui)?\\.ts$/.test(path) || /[\\/]pane\\.tsx?$/.test(path)
    )));
  `], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual([]);
});
