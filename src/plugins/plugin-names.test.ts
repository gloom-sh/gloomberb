import { describe, expect, test } from "bun:test";
import { pluginDirectoryNames } from "./plugin-names";

describe("pluginDirectoryNames", () => {
  test("looks under both product names, declared name first", () => {
    expect(pluginDirectoryNames("gloomberb-ibkr")).toEqual(["gloomberb-ibkr", "gloom-ibkr"]);
    expect(pluginDirectoryNames("gloom-ibkr")).toEqual(["gloom-ibkr", "gloomberb-ibkr"]);
  });

  test("leaves a name that is neither alone", () => {
    expect(pluginDirectoryNames("react")).toEqual(["react"]);
  });
});
