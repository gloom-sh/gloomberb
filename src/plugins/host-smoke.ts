import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadExternalPlugin } from "./loader";

/**
 * The plugin the smoke writes: one import from each kind of module a real
 * plugin uses. `react` and the JSX runtime have to be the host's own
 * instance, imported by name as registry plugins do: a host that served
 * React's default export alone passed a default import and failed every
 * plugin. `gloomberb/ui` is shared state, `gloomberb/types/config` is a
 * value from a module that used to be bundled from the package directory,
 * and `smoke-dep` stands in for a dependency `bun install` put in the
 * plugin's own `node_modules`.
 */
const SMOKE_PLUGIN_SOURCE = `
import React, { memo, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text } from "gloomberb/ui";
import { formatNumber } from "gloomberb/utils";
import { TICKER_RESEARCH_PANE_ID } from "gloomberb/types/config";
import { platform } from "smoke-dep";

function Probe() {
  return <Box><Text>{formatNumber(1)}</Text></Box>;
}

export default {
  id: "smoke-plugin-host",
  name: "Plugin host smoke",
  version: "0.0.0",
  probe() {
    const element = <Probe />;
    const tree = Probe();
    return {
      react: typeof React.createElement === "function"
        && [memo, useCallback, useEffect, useState, useSyncExternalStore].every((value) => typeof value === "function"),
      jsx: typeof element.type === "function" && tree != null && typeof tree === "object" && "type" in tree,
      paneId: TICKER_RESEARCH_PANE_ID,
      platform,
    };
  },
};
`;

/**
 * A dependency whose `exports` map picks the entry by condition, as
 * `youtubei.js`, `meriyah`, and `@earendil-works/pi-ai` do. A standalone
 * executable that does not read package.json at runtime cannot resolve it
 * at all, and one that resolves it with the wrong conditions lands on the
 * browser build.
 */
const SMOKE_DEPENDENCY_PACKAGE = {
  name: "smoke-dep",
  version: "1.0.0",
  type: "module",
  exports: {
    ".": {
      node: { import: "./node.js", default: "./node.js" },
      browser: "./browser.js",
      default: "./browser.js",
    },
  },
};

interface SmokeProbe {
  react: boolean;
  jsx: boolean;
  paneId: string;
  platform: string;
}

/**
 * Writes the plugin to a temporary directory, loads it through the real
 * loader, and throws with the loader's own error when it does not come up.
 */
export async function smokePluginHostLoad(): Promise<void> {
  const pluginDir = mkdtempSync(join(tmpdir(), "gloomberb-plugin-host-smoke-"));
  try {
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "smoke-plugin-host", main: "index.tsx" }));
    writeFileSync(join(pluginDir, "index.tsx"), SMOKE_PLUGIN_SOURCE);

    const dependencyDir = join(pluginDir, "node_modules", "smoke-dep");
    mkdirSync(dependencyDir, { recursive: true });
    writeFileSync(join(dependencyDir, "package.json"), JSON.stringify(SMOKE_DEPENDENCY_PACKAGE));
    writeFileSync(join(dependencyDir, "node.js"), "export const platform = \"node\";\n");
    writeFileSync(join(dependencyDir, "browser.js"), "export const platform = \"browser\";\n");

    const loaded = await loadExternalPlugin(pluginDir, "tui");
    if (!loaded) throw new Error("The smoke plugin directory was not recognised as a plugin.");
    if (loaded.error) throw new Error(`The smoke plugin failed to load: ${loaded.error}`);

    const probe = (loaded.plugin as unknown as { probe?: () => SmokeProbe }).probe?.();
    if (!probe) throw new Error("The smoke plugin loaded without its probe export.");
    if (!probe.react) throw new Error("The smoke plugin did not receive a working React.");
    if (!probe.jsx) throw new Error("The smoke plugin's JSX did not compile against the host runtime.");
    if (probe.paneId !== "ticker-research") {
      throw new Error(`The smoke plugin read "${probe.paneId}" from gloomberb/types/config.`);
    }
    if (probe.platform !== "node") {
      throw new Error(`The smoke plugin's dependency resolved to its "${probe.platform}" entry instead of "node".`);
    }
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
}
