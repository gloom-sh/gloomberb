/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { InputHostProvider } from "../../../react/input";
import { UiHostProvider } from "../../../ui";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { SupplyFlow } from "./flow";
import { entity, supplyRow } from "./test-fixture";

const { render } = createDomTestHarness({ withUi: false });
test("desktop SVG preserves known dollar and same-scope revenue ratios without drawing aggregate groups", async () => {
  const rows = [
    supplyRow("supplier-large", { role: "supplier", pctOfRevenue: null, pctBasis: null, usd: 149_000_000, usdBasis: "disclosed" }),
    supplyRow("supplier-small", { role: "supplier", pctOfRevenue: null, pctBasis: null, usd: 3_320_000, usdBasis: "disclosed" }),
    supplyRow("one", { pctOfRevenue: 22, pctScope: "Compute And Networking Segment" }),
    supplyRow("two", { pctOfRevenue: 14, pctScope: "Compute And Networking Segment" }),
    supplyRow("aggregate", { counterparty: { ...entity("aggregate"), aggregate: true }, pctOfRevenue: 76 }),
  ];
  const container = await render(<UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
    <InputHostProvider host={{ useShortcut() {}, useViewport: () => ({ width: 160, height: 24 }) }}>
    <SupplyFlow rows={rows} symbol="FOCUS" focusId="FOCUS" width={160} height={24} focused={false} selectedId={null} onSelect={() => {}} onOpen={() => {}} onVisible={() => {}} />
    </InputHostProvider>
  </UiHostProvider>);
  const ribbons = [...container.querySelectorAll("svg polyline")];
  const widths = ribbons.map((ribbon) => Number(ribbon.getAttribute("stroke-width")));
  expect(ribbons).toHaveLength(4);
  expect(widths[0]! / widths[1]!).toBeCloseTo(149_000_000 / 3_320_000, 8);
  expect(widths[2]! / widths[3]!).toBeCloseTo(22 / 14, 8);
  expect(container.textContent).not.toContain("aggregate");
  expect(container.textContent).toContain("Compute & Networking");
  expect(container.textContent).toContain("Scale: USD");
  expect(container.textContent).toContain("$149M disclosed");
});

test("desktop overflow click pages 70 companies without rescaling known ribbons", async () => {
  const rows = Array.from({ length: 70 }, (_, i) => supplyRow(`customer-${i}`, { pctOfRevenue: i + 1 }));
  const container = await render(<UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
    <InputHostProvider host={{ useShortcut() {}, useViewport: () => ({ width: 160, height: 24 }) }}>
      <SupplyFlow rows={rows} symbol="FOCUS" focusId="FOCUS" width={160} height={24} focused={false} selectedId={null} onSelect={() => {}} onOpen={() => {}} onVisible={() => {}} />
    </InputHostProvider>
  </UiHostProvider>);
  expect(container.textContent).toContain("customer-69");
  expect(container.querySelectorAll("svg polyline")).toHaveLength(7);
  expect(Number(container.querySelector("svg polyline")!.getAttribute("stroke-width"))).toBe(16);
  const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "+63 more")!;
  await act(async () => { more.click(); });
  expect(container.textContent).not.toContain("customer-69");
  expect(container.textContent).toContain("customer-62");
  expect(container.querySelectorAll("svg polyline")).toHaveLength(7);
  expect(Number(container.querySelector("svg polyline")!.getAttribute("stroke-width"))).toBeCloseTo(16 * 63 / 70, 10);
});
