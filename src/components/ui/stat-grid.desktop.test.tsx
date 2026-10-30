import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { ThemeProvider } from "../../theme/theme-context";
import { DEFAULT_THEME } from "../../theme/themes";
import { StatGrid, type StatItem } from "./stat-grid";

const { render } = createDomTestHarness({ capabilities: { nativePaneChrome: true } });

test("the desktop draws a wrapped figure on the terminal's two lines, its split bar beside the value", async () => {
  // A 45-column window, one figure a row: the open interest's change and EFFR's date take a second line.
  const items: StatItem[] = [
    { id: "oi", label: "Open interest", value: "1.24M", detail: "+12,743",
      split: [{ id: "calls", value: 7, color: "#00ff00" }, { id: "puts", value: 5, color: "#ff0000" }] },
    { id: "effr", label: "EFFR", value: "3.88%", detail: "88 pctl 1Y · 2026-10-29" },
    { id: "slope", label: "Dec '26 to Jul '27", value: "+37.2bp", detail: "86 pctl 1Y" },
  ];
  const container = await render(
    <ThemeProvider themeId={DEFAULT_THEME}>
      <StatGrid items={items} width={43} />
    </ThemeProvider>,
  );

  const cell = (id: string) => container.querySelector(`[data-gloom-stat-id="${id}"]`) as HTMLElement;
  const texts = (element: Element, role: string) =>
    [...element.querySelectorAll(`[data-gloom-role="${role}"]`)].map((node) => node.textContent);
  expect(cell("oi").dataset.wrapped).toBe("true");
  expect(texts(cell("oi"), "stat-grid-value")).toEqual(["1.24M"]);
  expect(texts(cell("oi"), "stat-grid-detail")).toEqual(["+12,743"]);
  // The bar sits in the value's line, before the detail's.
  const value = cell("oi").querySelector('[data-gloom-role="stat-grid-value"]')!;
  expect(value.parentElement!.querySelector('[data-gloom-role="split-bar"]')).not.toBeNull();
  expect(cell("oi").querySelectorAll('[data-gloom-role="split-bar"]')).toHaveLength(1);
  // The date is never what gives way: the percentile is cut, in the same words as the terminal.
  expect(texts(cell("effr"), "stat-grid-detail")).toEqual(["88 pctl… · 2026-10-29"]);
  // A figure that fits keeps its one line.
  expect(cell("slope").dataset.wrapped).toBeUndefined();
  // The band is sized for the lines the terminal counts: two wrapped figures and one line.
  expect((container.querySelector('[data-gloom-role="stat-grid"]') as HTMLElement).style.height).toBe(`${5 * 18}px`);
});
