import { describe, expect, test } from "bun:test";
import { isPluginPackageName, pluginDirectoryNames } from "./plugin-names";

describe("pluginDirectoryNames", () => {
  test("looks under both product names, declared name first", () => {
    expect(pluginDirectoryNames("gloomberb-ibkr")).toEqual(["gloomberb-ibkr", "gloom-ibkr"]);
    expect(pluginDirectoryNames("gloom-ibkr")).toEqual(["gloom-ibkr", "gloomberb-ibkr"]);
  });

  test("leaves a name that is neither alone", () => {
    expect(pluginDirectoryNames("react")).toEqual(["react"]);
  });
});

describe("isPluginPackageName", () => {
  // A peer's name is joined to the plugins folder to find it and link it.
  test("is one folder name under either prefix, never a path", () => {
    expect(isPluginPackageName("gloom-ibkr")).toBe(true);
    expect(isPluginPackageName("gloomberb-prediction-markets")).toBe(true);
    expect(isPluginPackageName("gloom-polls_v2.1")).toBe(true);
    for (const name of ["gloom-/../../x", "gloom-..\\x", "gloom-", "gloom-.hidden", "gloom-a/b", "react", "@gloom/x"]) {
      expect(isPluginPackageName(name)).toBe(false);
    }
    expect(pluginDirectoryNames("gloom-/../../x")).toEqual([]);
  });
});
