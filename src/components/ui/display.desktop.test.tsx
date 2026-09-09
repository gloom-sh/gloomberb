import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createDomTestHarness } from "../../renderers/electrobun/view/test-utils";
import { syncTheme } from "../../theme/colors";
import { ThemeProvider } from "../../theme/theme-context";
import { DEFAULT_THEME } from "../../theme/themes";
import { Button } from "./button";
import { Badge, Divider, SectionHeading } from "./display";
import { PaneStatusBody } from "./status";

const { render, window } = createDomTestHarness();
afterEach(() => syncTheme(DEFAULT_THEME));

test("stable display content follows theme changes and status transitions expose only the active state", async () => {
  let updateTheme!: (theme: string) => void;
  let updateState!: (state: "loading" | "error" | "ready") => void;
  let retries = 0;
  const display = <><SectionHeading title="Details" /><Badge label="Live" tone="positive" /><Divider /></>;
  function View() {
    const [theme, setTheme] = useState(DEFAULT_THEME);
    const [state, setState] = useState<"loading" | "error" | "ready">("loading");
    updateTheme = setTheme;
    updateState = setState;
    return (
      <ThemeProvider themeId={theme}>
        {display}
        <PaneStatusBody
          loading={state === "loading"}
          error={state === "error" ? "Please retry this request." : null}
          subject="history"
          actions={<Button label="Retry" onPress={() => { retries += 1; }} />}
        >
          <span>Loaded history</span>
        </PaneStatusBody>
      </ThemeProvider>
    );
  }
  const container = await render(<View />);
  const headingColor = () => (container.querySelector('[data-gloom-ui="section-heading"] span') as HTMLElement).style.color;
  const original = headingColor();
  expect(container.querySelector('[data-gloom-status="loading"]')).not.toBeNull();
  await act(async () => { updateTheme("midnight"); updateState("error"); });
  expect(headingColor()).not.toBe(original);
  expect(container.querySelector('[data-gloom-status="loading"]')).toBeNull();
  expect(container.querySelector('[data-gloom-status="empty"]')).toBeNull();
  expect(container.querySelector('[data-gloom-status="error"]')?.textContent).toContain("Please retry this request.");
  await act(async () => {
    container.querySelector("button")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    updateState("ready");
  });
  expect(retries).toBe(1);
  expect(container.querySelector('[data-gloom-status]')).toBeNull();
  expect(container.textContent).toContain("Loaded history");
  expect(container.querySelector('[data-gloom-ui="divider"]')?.textContent).toBe("");
});
