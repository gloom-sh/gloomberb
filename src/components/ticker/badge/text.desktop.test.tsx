import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { TickerBadgeText } from "./text";

const { window: testWindow, render } = createDomTestHarness();

/** The chip's text that takes up room in the line: everything but what is laid over it. */
function inFlowText(chip: HTMLElement): string {
  return [...chip.children]
    .filter((child) => (child as HTMLElement).style.position !== "absolute")
    .map((child) => child.textContent)
    .join("");
}

test("on the desktop a hovered chip lays its price over its resting text, which keeps its width", async () => {
  const container = await render(
    <TickerBadgeText
      text="Watching $TSLA now"
      lineWidth={40}
      catalog={{ TSLA: { status: "ready", ticker: null, quote: { symbol: "TSLA", price: 250, currency: "USD", change: -12.5, changePercent: -5, lastUpdated: 1 } } }}
      textColor="#ffffff"
      openTicker={() => {}}
    />,
  );
  const chip = container.querySelector("[aria-label=TSLA]") as HTMLElement;
  expect(inFlowText(chip)).toBe("TSLA -5.0%");

  await act(async () => {
    chip.dispatchEvent(new testWindow.MouseEvent("mouseover", { bubbles: true }) as unknown as Event);
  });

  expect(inFlowText(chip)).toBe("TSLA -5.0%");
  const price = [...chip.children].find((child) => (child as HTMLElement).style.position === "absolute") as HTMLElement;
  expect(price.textContent).toBe("$250.00");
  // The pointer stays on the chip itself, so hover does not flicker as the price appears.
  expect(price.style.pointerEvents).toBe("none");
});
