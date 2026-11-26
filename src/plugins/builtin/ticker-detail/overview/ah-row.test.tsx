import { expect, test } from "bun:test";
import { act } from "react";
import { PaneLinkMenu } from "../../../../components";
import { PaneFooterProvider } from "../../../../components/layout/pane/footer";
import { createDomTestHarness } from "../../../../renderers/dom/test-utils";
import type { ContextMenuItem } from "../../../../types/context-menu";
import { FundamentalsGrid } from "./components";
import { buildOverviewStats } from "./model";

const { render } = createDomTestHarness();

/** DES's figures for one BYD line: the H shares with a receipt of them and their board lot, or the A shares. */
function stats(side: "h" | "a") {
  return buildOverviewStats({
    quote: undefined, fundamentals: undefined, quoteCurrency: side === "h" ? "HKD" : "CNY", baseCurrency: "USD", toBase: (value) => value,
    ahPair: { other: side === "h" ? "002594:SZSE" : "1211:HKEX", side, premiumPercent: -21.4 },
    ...(side === "h" ? { depositaryPair: { pair: { receipt: "BYDDY", ratio: 2, ordinary: ["1211:HKEX"] }, receiptSide: false }, boardLot: 500 } : {}),
  });
}

async function draw(side: "h" | "a") {
  const opened: string[] = [];
  let menu: ContextMenuItem[] = [];
  const container = await render(
    <PaneFooterProvider>{(footer) => {
      menu = footer.menu;
      return (
        <PaneLinkMenu>
          <FundamentalsGrid fields={stats(side)} width={100} onOpenLink={(link) => opened.push(link.name)} onOpenListing={(ticker) => opened.push(ticker)} />
        </PaneLinkMenu>
      );
    }}</PaneFooterProvider>,
  );
  const click = async (label: string) => {
    const cell = container.querySelector<HTMLElement>(`[data-gloom-label="${label}"]`)!;
    await act(async () => { cell.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true })); });
  };
  const pick = async (label: string) => {
    const item = menu.find((entry) => entry.type !== "divider" && entry.label === label);
    await act(async () => { if (item && item.type !== "divider") await item.onSelect?.(); });
  };
  const labels = () => menu.flatMap((item) => (item.type === "divider" ? [] : [item.label]));
  return { container, opened, click, pick, labels };
}

test("an A+H line's row opens the other line's DES by click and pane menu; the ADR row keeps ADR vs Home", async () => {
  const h = await draw("h");
  // The row and the premium stay as they read; only the board lot is a plain figure.
  expect([...h.container.querySelectorAll("[data-gloom-interactive]")].map((cell) => cell.textContent))
    .toEqual(["ADRBYDDY 1:2", "A Share002594:SZSE H -21.4%"]);
  expect(h.labels()).toEqual(["Open ADR vs Home", "Open 002594:SZSE"]);
  await h.click("Open 002594:SZSE");
  await h.pick("Open 002594:SZSE");
  await h.click("Open ADR vs Home");
  expect(h.opened).toEqual(["002594:SZSE", "002594:SZSE", "ADR vs Home"]);

  const a = await draw("a");
  expect(a.labels()).toEqual(["Open 1211:HKEX"]);
  await a.click("Open 1211:HKEX");
  await a.pick("Open 1211:HKEX");
  expect(a.opened).toEqual(["1211:HKEX", "1211:HKEX"]);
});
