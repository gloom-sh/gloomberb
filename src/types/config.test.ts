import { describe, expect, test } from "bun:test";
import {
  createPaneInstance,
  findPaneInstance,
  findPrimaryPaneInstance,
  materializeDetachedPanesAsFloating,
  normalizePaneLayout,
  resolveFollowBindingInstance,
  resolvePaneInstance,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "./config";

function createLayout(instances: PaneInstanceConfig[]): LayoutConfig {
  return {
    dockRoot: null,
    instances,
    floating: [],
    detached: [],
  };
}

describe("findPaneInstance", () => {
  // The lookup caches an index per instances array. In-place edits, which the
  // screenshot CLI and chart settings still do, must not serve stale hits.
  test("survives in-place replacement and removal in the same array", () => {
    const first = createPaneInstance("ticker-detail", { instanceId: "ticker-detail:a" });
    const second = createPaneInstance("ticker-detail", { instanceId: "ticker-detail:b" });
    const layout = createLayout([first, second]);

    expect(findPaneInstance(layout, "ticker-detail:b")).toBe(second);

    const replacement = createPaneInstance("ticker-detail", { instanceId: "ticker-detail:c" });
    layout.instances[1] = replacement;
    expect(findPaneInstance(layout, "ticker-detail:b")).toBeUndefined();
    expect(findPaneInstance(layout, "ticker-detail:c")).toBe(replacement);

    layout.instances.splice(0, 1);
    expect(findPaneInstance(layout, "ticker-detail:a")).toBeUndefined();
    expect(findPaneInstance(layout, "ticker-detail:c")).toBe(replacement);

    layout.instances.push(first);
    expect(findPaneInstance(layout, "ticker-detail:a")).toBe(first);
  });

  test("returns the first instance when an id is duplicated", () => {
    const first = createPaneInstance("chat", { instanceId: "chat:main" });
    const duplicate = createPaneInstance("chat", { instanceId: "chat:main" });
    expect(findPaneInstance(createLayout([first, duplicate]), "chat:main")).toBe(first);
  });
});

describe("findPrimaryPaneInstance", () => {
  test("prefers the main non-fixed ticker pane", () => {
    const layout = createLayout([
      createPaneInstance("portfolio-list", {
        instanceId: "portfolio-list:main",
        binding: { kind: "none" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:pinned",
        binding: { kind: "fixed", symbol: "AAPL" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:main",
        binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
      }),
    ]);

    expect(findPrimaryPaneInstance(layout, "ticker-detail")?.instanceId).toBe("ticker-detail:main");
  });

  test("does not treat fixed ticker panes as the primary pane", () => {
    const layout = createLayout([
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:aapl",
        binding: { kind: "fixed", symbol: "AAPL" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:msft",
        binding: { kind: "fixed", symbol: "MSFT" },
      }),
    ]);

    expect(findPrimaryPaneInstance(layout, "ticker-detail")).toBeUndefined();
  });
});

describe("resolvePaneInstance", () => {
  test("accepts either an instance id or a pane id", () => {
    const layout = createLayout([
      createPaneInstance("portfolio-list", {
        instanceId: "portfolio-list:main",
        binding: { kind: "none" },
      }),
    ]);

    expect(resolvePaneInstance(layout, "portfolio-list:main")?.instanceId).toBe("portfolio-list:main");
    expect(resolvePaneInstance(layout, "portfolio-list")?.instanceId).toBe("portfolio-list:main");
  });
});

describe("resolveFollowBindingInstance", () => {
  test("walks follow bindings until it finds a matching pane", () => {
    const layout = createLayout([
      createPaneInstance("portfolio-list", {
        instanceId: "portfolio-list:main",
        binding: { kind: "none" },
      }),
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:main",
        binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
      }),
      createPaneInstance("quote-monitor", {
        instanceId: "quote-monitor:main",
        binding: { kind: "follow", sourceInstanceId: "ticker-detail:main" },
      }),
    ]);

    expect(
      resolveFollowBindingInstance(layout, "quote-monitor:main", (instance) => instance.paneId === "portfolio-list")?.instanceId,
    ).toBe("portfolio-list:main");
  });

  test("stops on follow cycles", () => {
    const layout = createLayout([
      createPaneInstance("ticker-detail", {
        instanceId: "ticker-detail:first",
        binding: { kind: "follow", sourceInstanceId: "quote-monitor:first" },
      }),
      createPaneInstance("quote-monitor", {
        instanceId: "quote-monitor:first",
        binding: { kind: "follow", sourceInstanceId: "ticker-detail:first" },
      }),
    ]);

    expect(
      resolveFollowBindingInstance(layout, "ticker-detail:first", (instance) => instance.paneId === "portfolio-list"),
    ).toBeUndefined();
  });
});

describe("materializeDetachedPanesAsFloating", () => {
  test("degrades detached panes into floating panes for non-desktop renderers", () => {
    const layout = createLayout([
      createPaneInstance("chat", {
        instanceId: "chat:main",
        binding: { kind: "none" },
      }),
    ]);
    layout.detached = [
      { instanceId: "chat:main", x: 14, y: 6, width: 48, height: 18 },
    ];

    const next = materializeDetachedPanesAsFloating(layout);

    expect(next.detached).toEqual([]);
    expect(next.floating).toEqual([
      { instanceId: "chat:main", x: 14, y: 6, width: 48, height: 18 },
    ]);
  });
});

describe("normalizePaneLayout", () => {
  // INS alone is the market's insider buying: its unbound pane is a view, not
  // a pane that lost its ticker, so loading a layout neither drops it nor
  // links it to the portfolio list as it does an unbound quote monitor.
  test("keeps an unbound INS pane unbound and links or drops other unbound ticker panes", () => {
    const layout: LayoutConfig = {
      dockRoot: { kind: "split", axis: "horizontal", ratio: 0.5, first: { kind: "pane", instanceId: "list" }, second: { kind: "split", axis: "vertical", ratio: 0.5, first: { kind: "pane", instanceId: "ins" }, second: { kind: "pane", instanceId: "quote" } } },
      instances: [
        createPaneInstance("portfolio-list", { instanceId: "list", binding: { kind: "none" } }),
        createPaneInstance("insider", { instanceId: "ins", binding: { kind: "none" } }),
        createPaneInstance("quote-monitor", { instanceId: "quote", binding: { kind: "none" } }),
      ],
      floating: [],
      detached: [],
    };
    const bindings = (next: LayoutConfig) => Object.fromEntries(next.instances.map((instance) => [instance.instanceId, instance.binding]));

    expect(bindings(normalizePaneLayout(layout, { defaultFollowSourceInstanceId: "list" }))).toEqual({
      list: { kind: "none" },
      ins: { kind: "none" },
      quote: { kind: "follow", sourceInstanceId: "list" },
    });
    expect(bindings(normalizePaneLayout(layout))).toEqual({ list: { kind: "none" }, ins: { kind: "none" } });
  });
});
