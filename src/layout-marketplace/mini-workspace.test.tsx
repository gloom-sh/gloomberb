/** @jsxImportSource react */
import { Window } from "happy-dom";

const testWindow = new Window({ url: "http://localhost" });
const domGlobals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  HTMLElement: testWindow.HTMLElement,
  Node: testWindow.Node,
};

/** Bun shares one process across test files, so the DOM globals must not leak. */
const priorGlobals = Object.fromEntries(
  Object.keys(domGlobals).map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
);
Object.assign(globalThis, domGlobals);

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UiHostProvider, type RendererHost, type UiHost } from "../ui";
import { WebBox } from "../renderers/electrobun/view/host/box";
import { WebText } from "../renderers/electrobun/view/host/text";
import { cloneLayout, createDefaultConfig } from "../types/config";
import type { PaneDef } from "../types/plugin";
import { MiniWorkspace } from "./mini-workspace";

const renderer: RendererHost = {
  requestExit() {},
  async openExternal() {},
  async copyText() {},
  async readText() { return ""; },
  notify() {},
};

const ui = {
  kind: "desktop-web",
  capabilities: { cellWidthPx: 8, fractionalViewport: true },
  Box: WebBox,
  Text: WebText,
} as unknown as UiHost;

afterAll(() => {
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
});

function paneDef(id: string, name: string, icon: string): PaneDef {
  return { id, name, icon, component: () => null, defaultPosition: "left" };
}

const panes = new Map<string, PaneDef>([
  ["portfolio-list", paneDef("portfolio-list", "Portfolio", "P")],
  ["ticker-research", paneDef("ticker-research", "Ticker Research", "T")],
  ["chat", paneDef("chat", "Chat", "M")],
  ["ticker-chart", paneDef("ticker-chart", "Chart", "C")],
]);

function testLayout() {
  const layout = cloneLayout(createDefaultConfig("/tmp/gloomberb-mini-workspace-test").layout);
  layout.instances = [
    ...layout.instances,
    { instanceId: "ticker-chart:1", paneId: "ticker-chart", binding: { kind: "fixed", symbol: "NVDA" } },
    { instanceId: "mystery:1", paneId: "mystery-pane" },
  ];
  layout.floating = [{ instanceId: "ticker-chart:1", x: 20, y: 6, width: 60, height: 20 }];
  layout.detached = [{ instanceId: "mystery:1", x: 120, y: 4, width: 50, height: 18 }];
  return layout;
}

async function renderPreview() {
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <UiHostProvider ui={ui} renderer={renderer}>
        <MiniWorkspace layout={testLayout()} panes={panes} width={320} height={160} />
      </UiHostProvider>,
    );
  });
  return { container, root };
}

test("draws every pane with a readable header instead of an empty rectangle", async () => {
  const { container, root } = await renderPreview();

  const labels = [...container.querySelectorAll("text")].map((node) => node.textContent ?? "");
  expect(labels.length).toBe(5);
  expect(labels.some((label) => label.includes("Portfolio"))).toBe(true);
  expect(labels.some((label) => label.includes("Chat"))).toBe(true);
  // A published fixed ticker is public metadata and belongs on the header.
  expect(labels.some((label) => label.includes("Chart") && label.includes("NVDA"))).toBe(true);
  // An uninstalled pane type keeps its id as the label rather than going blank.
  expect(labels.some((label) => label.includes("mystery-pane"))).toBe(true);
  expect(labels.every((label) => label.trim().length > 0)).toBe(true);

  await act(async () => root.unmount());
});

test("layers floating and detached panes and hatches missing pane types", async () => {
  const { container, root } = await renderPreview();

  const svg = container.querySelector("svg")!;
  expect(svg.getAttribute("aria-label")).toContain("Chart NVDA");
  // Missing pane types get the hatch fill; installed panes keep real imagery.
  expect(container.querySelector("rect[fill^='url(#gloom-missing-pane-']")).not.toBeNull();
  expect(container.querySelectorAll("path[stroke-linejoin='round']").length).toBeGreaterThan(0);

  const groups = [...container.querySelectorAll("g")];
  const detachedIndex = groups.findIndex((group) => group.textContent?.includes("mystery-pane"));
  const floatingIndex = groups.findIndex((group) => group.textContent?.includes("NVDA"));
  const dockedIndex = groups.findIndex((group) => group.textContent?.includes("Portfolio"));
  expect(dockedIndex).toBeLessThan(floatingIndex);
  expect(floatingIndex).toBeLessThan(detachedIndex);

  await act(async () => root.unmount());
});
