import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../renderers/electrobun/view/test-utils";
import { ThemeProvider } from "../../theme/theme-context";
import { DEFAULT_THEME } from "../../theme/themes";
import { Prose } from "./prose";

const { render } = createDomTestHarness({ capabilities: { nativePaneChrome: true } });

const FAILURE =
  "Streaming unavailable: Ask Gloom needs a streaming connection, which this window cannot open.";

test("a long message keeps its tail and is allowed to wrap rather than run off the pane", async () => {
  const container = await render(
    <ThemeProvider themeId={DEFAULT_THEME}>
      <Prose text={FAILURE} width={40} color="#ff5555" figures={false} />
    </ThemeProvider>,
  );

  const paragraph = container.querySelector('[data-gloom-ui="prose"] span') as HTMLElement;
  expect(container.textContent).toBe(FAILURE);
  expect(paragraph.style.whiteSpace).toBe("pre-wrap");
  expect(paragraph.style.overflowWrap).toBe("break-word");
});

test("figures off leaves the message one colour, so a number does not read as a separate thing", async () => {
  const container = await render(
    <ThemeProvider themeId={DEFAULT_THEME}>
      <Prose text="Rate limited. Try again in 12s." width={60} color="#ff5555" figures={false} />
    </ThemeProvider>,
  );

  const runs = [...container.querySelectorAll('[data-gloom-ui="prose"] span span')] as HTMLElement[];
  expect(runs).toHaveLength(1);
  expect(runs[0]!.textContent).toBe("Rate limited. Try again in 12s.");
  expect(runs[0]!.style.color).toBe("#ff5555");
});

test("figures on still brightens the numbers it finds", async () => {
  const container = await render(
    <ThemeProvider themeId={DEFAULT_THEME}>
      <Prose text="Revenue rose 12% to $4.1 billion." width={60} />
    </ThemeProvider>,
  );

  const runs = [...container.querySelectorAll('[data-gloom-ui="prose"] span span')] as HTMLElement[];
  const colors = new Set(runs.map((run) => run.style.color));
  expect(runs.length).toBeGreaterThan(1);
  expect(colors.size).toBeGreaterThan(1);
  expect(container.textContent).toBe("Revenue rose 12% to $4.1 billion.");
});
