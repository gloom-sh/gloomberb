/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { MiniWorkspace } from "./mini-workspace";
import { testLayout, testPanes as panes } from "./test-fixture";
import { createDomTestHarness } from "../renderers/electrobun/view/test-utils";

const { render: renderDom } = createDomTestHarness();

async function renderPreview() {
  const container = await renderDom(
    <MiniWorkspace layout={testLayout()} panes={panes} width={320} height={160} />,
  );
  return container;
}

test("draws every pane with a readable header instead of an empty rectangle", async () => {
  const container = await renderPreview();

  const labels = [...container.querySelectorAll("text")].map((node) => node.textContent ?? "");
  expect(labels.length).toBe(5);
  expect(labels.some((label) => label.includes("Portfolio"))).toBe(true);
  expect(labels.some((label) => label.includes("Chat"))).toBe(true);
  // A published fixed ticker is public metadata and belongs on the header.
  expect(labels.some((label) => label.includes("Chart") && label.includes("NVDA"))).toBe(true);
  // An uninstalled pane type keeps its id as the label rather than going blank.
  expect(labels.some((label) => label.includes("mystery-pane"))).toBe(true);
  expect(labels.every((label) => label.trim().length > 0)).toBe(true);
});

test("layers floating and detached panes and hatches missing pane types", async () => {
  const container = await renderPreview();

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
});
