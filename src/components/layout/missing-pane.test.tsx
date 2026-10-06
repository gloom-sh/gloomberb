/** @jsxImportSource react */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import type { LayoutRequirement } from "../../layout-marketplace/cloud";
import {
  setMarketplaceHost,
  setPluginManager,
  type MarketplaceHost,
  type PluginManager,
} from "../../plugins/builtin/plugin-marketplace/store";
import { setCurrentPluginTarget } from "../../plugins/current-target";
import { WebDialogHostProvider } from "../../renderers/dom/dialog-host";
import { WebInputHostProvider } from "../../renderers/dom/input-host";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { cloneLayout, createDefaultConfig, type LayoutOrigin } from "../../types/config";
import type { PaneProps } from "../../types/plugin";
import { describeMissingPane, missingPanePlaceholderDef, rememberLayoutRequirements } from "./missing-pane";

const { render } = createDomTestHarness();

afterEach(() => {
  setPluginManager(null);
  setMarketplaceHost(null);
  setCurrentPluginTarget("cli");
});

const requirement: LayoutRequirement = { pluginId: "gloom-heatmap", repo: "gloom-sh/gloom-heatmap" };
const base = { requirement: null, fromTeam: false, canInstall: false, runsPlugins: true };

describe("describeMissingPane", () => {
  test("names the plugin from the requirement, else the id up to its colon, else the whole id", () => {
    expect(describeMissingPane({ ...base, paneType: "market-heatmap", requirement }).pluginLabel).toBe("gloom-heatmap");
    expect(describeMissingPane({ ...base, paneType: "market-heatmap" }).pluginLabel).toBe("market-heatmap");
    expect(describeMissingPane({ ...base, paneType: "market-heatmap" }).title).toBe("market-heatmap is not installed");
    expect(describeMissingPane({ ...base, paneType: "heatmap:world-map" }).pluginLabel).toBe("heatmap");
  });

  test("says teammate only for a pane that came with a team layout", () => {
    expect(describeMissingPane({ ...base, paneType: "heatmap:map" }).message)
      .toStartWith("This pane comes from the heatmap plugin.");
    expect(describeMissingPane({ ...base, paneType: "heatmap:map", fromTeam: true }).message)
      .toStartWith("A teammate's pane from heatmap.");
  });

  test("offers the install only where a manager is registered and the requirement has a repo", () => {
    const desktop = describeMissingPane({ ...base, paneType: "heatmap:map", requirement, fromTeam: true, canInstall: true });
    expect(desktop.installable).toBe(true);
    expect(desktop.message).toEndWith("Install the plugin to see it.");

    const noRepo = describeMissingPane({ ...base, paneType: "heatmap:map", requirement: { pluginId: "heatmap" }, canInstall: true });
    expect(noRepo.installable).toBe(false);
    expect(noRepo.message).toEndWith("Install the plugin with PL to see it.");

    const web = describeMissingPane({ ...base, paneType: "heatmap:map", requirement, runsPlugins: false });
    expect(web.installable).toBe(false);
    expect(web.message).toEndWith("Plugins are not available on the web.");
  });
});

function Placeholder(props: { paneType: string; origin?: LayoutOrigin }) {
  const config = createDefaultConfig("/tmp/gloomberb-missing-pane-test");
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout), ...(props.origin ? { origin: props.origin } : {}) }];
  config.activeLayoutIndex = 0;
  const Component = missingPanePlaceholderDef(props.paneType).component;
  return (
    <AppContext value={createStaticAppStore(createInitialState(config))}>
      <WebInputHostProvider><WebDialogHostProvider>
        <Component {...({ paneType: props.paneType, width: 60 } as PaneProps)} />
      </WebDialogHostProvider></WebInputHostProvider>
    </AppContext>
  );
}

const teamOrigin: LayoutOrigin = { kind: "team", teamId: "t1", layoutId: "layout-missing-pane", revision: 1, contentHash: "h", syncedAt: "2026-10-06T00:00:00.000Z" };

describe("missing pane placeholder", () => {
  function desktopSetup(target: "desktop" | "tui") {
    setCurrentPluginTarget(target);
    rememberLayoutRequirements("layout-missing-pane", [requirement]);
    const install = mock(async () => ({ ok: true as const, directory: "gloom-heatmap" }));
    const load = mock(async () => null);
    setPluginManager({ install, load } as unknown as PluginManager);
    setMarketplaceHost({ activate: mock(async () => {}) } as unknown as MarketplaceHost);
    return { install, load };
  }

  const findButton = (root: ParentNode, text: string) => (
    [...root.querySelectorAll("button")].find((node) => node.textContent?.includes(text))
  );
  const click = (node: Element | undefined) => act(async () => {
    node!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  test.each(["desktop", "tui"] as const)("%s asks first, then installs through the manager and activates the plugin in the session", async (target) => {
    const { install, load } = desktopSetup(target);

    const container = await render(<Placeholder paneType="gloom-heatmap:world" origin={teamOrigin} />);
    expect(container.textContent).toContain("A teammate's pane from gloom-heatmap.");
    await click(findButton(container, "Install gloom-heatmap"));

    // A layout names the repo, so nothing runs until the person agrees.
    expect(install).not.toHaveBeenCalled();
    const dialog = document.querySelector(".gloom-dialog")!;
    expect(dialog.textContent).toContain("Install gloom-heatmap?");
    expect(dialog.textContent).toContain("github.com/gloom-sh/gloom-heatmap");
    expect(dialog.textContent).toContain("Community plugin, not reviewed.");

    await click(findButton(dialog, "Install"));
    expect(install).toHaveBeenCalledWith("gloom-sh/gloom-heatmap");
    expect(load).toHaveBeenCalledWith("gloom-heatmap");
    // The plugin could not be loaded: the pane says so instead of staying silent.
    expect(container.textContent).toContain("Installed but did not load: The plugin has no entry file.");
  });

  test("cancelling the confirmation leaves the placeholder alone and installs nothing", async () => {
    const { install, load } = desktopSetup("desktop");

    const container = await render(<Placeholder paneType="gloom-heatmap:world" origin={teamOrigin} />);
    await click(findButton(container, "Install gloom-heatmap"));
    await click(findButton(document.querySelector(".gloom-dialog")!, "Cancel"));

    expect(document.querySelector(".gloom-dialog")).toBeNull();
    expect(install).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(findButton(container, "Install gloom-heatmap")?.textContent).toContain("Install gloom-heatmap");
    expect(container.textContent).toContain("Publishing from here keeps this pane for the rest of the team.");
  });

  test("the web terminal has no manager: no button, and it says plugins are unavailable", async () => {
    setCurrentPluginTarget("web");

    const container = await render(<Placeholder paneType="market-heatmap" />);
    expect(container.textContent).toContain("market-heatmap is not installed");
    expect(container.textContent).toContain("This pane comes from the market-heatmap plugin. Plugins are not available on the web.");
    expect(container.querySelector("button")).toBeNull();
  });
});
