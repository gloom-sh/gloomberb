import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { ThemeProvider } from "../../theme/theme-context";
import { DEFAULT_THEME } from "../../theme/themes";
import { RangeTrack } from "./range-track";

const desktop = createDomTestHarness();
const terminal = createDomTestHarness({ capabilities: { nativePaneChrome: false } });

const track = (position: number, outside?: boolean) => (
  <ThemeProvider themeId={DEFAULT_THEME}>
    <RangeTrack position={position} width={11} markerColor="#ffffff" outside={outside} />
  </ThemeProvider>
);

test("the terminal marks a value past an end with an arrow at that end when asked to", async () => {
  expect((await terminal.render(track(-0.2, true))).textContent).toBe(`◂${"─".repeat(10)}`);
  expect((await terminal.render(track(1.2, true))).textContent).toBe(`${"─".repeat(10)}▸`);
});

test("a value inside the range, or at an end, keeps the dot", async () => {
  expect((await terminal.render(track(0.5, true))).textContent).toBe(`${"─".repeat(5)}●${"─".repeat(5)}`);
  expect((await terminal.render(track(0, true))).textContent).toBe(`●${"─".repeat(10)}`);
  expect((await terminal.render(track(1, true))).textContent).toBe(`${"─".repeat(10)}●`);
});

test("without the option a value past an end is pinned there as a dot", async () => {
  expect((await terminal.render(track(-0.2))).textContent).toBe(`●${"─".repeat(10)}`);
  expect((await terminal.render(track(1.2))).textContent).toBe(`${"─".repeat(10)}●`);
});

test("the desktop swaps the round dot for a square past an end, drawing no glyphs", async () => {
  const marker = (container: Element) => container.querySelector('[data-gloom-role="range-track"]')!.lastElementChild as HTMLElement;
  const past = await desktop.render(track(1.2, true));
  expect(past.textContent).toBe("");
  expect(marker(past).style.left).toBe("100%");
  expect(marker(past).style.borderRadius).toBe("1px");
  expect(marker(await desktop.render(track(0.5, true))).style.borderRadius).toBe("50%");
  expect(marker(await desktop.render(track(1.2))).style.borderRadius).toBe("50%");
});
