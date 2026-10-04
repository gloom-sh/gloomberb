/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { InputHostProvider } from "../../../react/input";
import { UiHostProvider } from "../../../ui";
import { noopRendererHost } from "../../../test-support/renderer-host";
import type { SupplyRow } from "../../../api-client/supply-chain";
import { SupplyFlow } from "./flow";
import { entity, supplyRow } from "./test-fixture";

const { render, window } = createDomTestHarness({ withUi: false });

function flow(rows: SupplyRow[], height = 24) {
  return <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
    <InputHostProvider host={{ useShortcut() {}, useViewport: () => ({ width: 160, height }) }}>
      <SupplyFlow rows={rows} symbol="FOCUS" focusId="FOCUS" width={160} height={height} focused={false} selectedId={null} onSelect={() => {}} onOpen={() => {}} onVisible={() => {}} />
    </InputHostProvider>
  </UiHostProvider>;
}

/** A filled ribbon's thickness where it leaves its card: the upper edge's first point to the lower edge's last. */
function thickness(polygon: Element): number {
  const points = polygon.getAttribute("points")!.split(" ").map((pair) => pair.split(",").map(Number) as [number, number]);
  return points.at(-1)![1] - points[0]![1];
}

test("desktop ribbons keep known dollar and same-scope revenue ratios, unknown ones are hairlines, and groups never become nodes", async () => {
  const rows = [
    supplyRow("supplier-large", { role: "supplier", pctOfRevenue: null, pctBasis: null, usd: 149_000_000, usdBasis: "disclosed" }),
    supplyRow("supplier-small", { role: "supplier", pctOfRevenue: null, pctBasis: null, usd: 3_320_000, usdBasis: "disclosed" }),
    supplyRow("one", { pctOfRevenue: 22, pctScope: "Compute And Networking Segment" }),
    supplyRow("two", { pctOfRevenue: 14, pctScope: "Compute And Networking Segment" }),
    supplyRow("three", { pctOfRevenue: 13, pctBasis: "receivables" }),
    supplyRow("aggregate", { counterparty: { ...entity("aggregate", "United States And Europe Based End Customers"), aggregate: true }, pctOfRevenue: 76 }),
  ];
  const container = await render(flow(rows));
  const ribbons = [...container.querySelectorAll("svg polygon")];
  expect(ribbons).toHaveLength(4);
  const [large, small, one, two] = ribbons.map(thickness);
  expect(large! / small!).toBeCloseTo(149_000_000 / 3_320_000, 6);
  expect(one! / two!).toBeCloseTo(22 / 14, 6);
  expect(container.querySelectorAll("svg polyline")).toHaveLength(1);
  // The cohort is listed as a group in the band underneath, not drawn as a company.
  expect([...container.querySelectorAll('[data-gloom-role="supply-flow-node"]')].map((node) => node.textContent).join(" ")).not.toContain("United States");
  expect(container.textContent).toContain("United States and Europe based end customers 76%");
  expect(container.textContent).toContain("22% of Compute & Networking revenue");
  expect(container.textContent).toContain("$149M disclosed");
});

test("desktop overflow click pages 70 companies without rescaling known ribbons", async () => {
  const rows = Array.from({ length: 70 }, (_, i) => supplyRow(`customer-${i}`, { pctOfRevenue: i + 1 }));
  const container = await render(flow(rows));
  expect(container.textContent).toContain("customer-69");
  const first = thickness(container.querySelector("svg polygon")!);
  const more = [...container.querySelectorAll('[data-gloom-role="supply-flow-node"]')].find((node) => /^\+\d+ more$/.test(node.textContent ?? ""))!;
  const shown = container.querySelectorAll("svg polygon").length;
  await act(async () => { more.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }) as unknown as Event); });
  expect(container.textContent).not.toContain("customer-69");
  expect(container.querySelectorAll("svg polygon")).toHaveLength(shown);
  expect(thickness(container.querySelector("svg polygon")!) / first).toBeCloseTo((70 - shown) / 70, 6);
});

test("hovering a card brings its ribbon forward and names the figure, its denominator and the filing", async () => {
  const rows = [supplyRow("one", { pctOfRevenue: 22 }), supplyRow("two", { pctOfRevenue: 14 })];
  const container = await render(flow(rows));
  const card = [...container.querySelectorAll('[data-gloom-role="supply-flow-node"]')].find((node) => node.textContent?.startsWith("one"))!;
  await act(async () => { card.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }) as unknown as Event); });
  const tooltip = container.querySelector('[data-gloom-role="supply-flow-tooltip"]');
  expect(tooltip?.textContent).toContain("22% of FY revenue");
  expect(tooltip?.textContent).toContain("FOCUS 10-K filed 2026-02-25");
  const opacities = [...container.querySelectorAll("svg polygon")].map((polygon) => Number(polygon.getAttribute("opacity")));
  expect(opacities[0]).toBeGreaterThan(opacities[1]!);
  await act(async () => { card.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true }) as unknown as Event); });
  expect(container.querySelector('[data-gloom-role="supply-flow-tooltip"]')).toBeNull();
});
