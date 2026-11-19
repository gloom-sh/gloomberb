import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { syncTheme } from "../../theme/colors";
import { ThemeProvider } from "../../theme/theme-context";
import { DEFAULT_THEME } from "../../theme/themes";
import { Button } from "./button";
import { Badge, ClippedText, Divider, SectionHeading } from "./display";
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
  await act(async () => { updateTheme("paper"); updateState("error"); });
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

test("a clipped name keeps its end whole on the desktop: the browser cuts what comes before it, never the letter that tells it apart", async () => {
  const container = await render(<div style={{ width: "40px" }}><ClippedText text="Revenue customer 1" width={8} keepEnd=" 1" /></div>);
  const [lead, end] = [...container.querySelectorAll("span")].filter((span) => span.textContent);
  expect(lead!.textContent).toBe("Revenue customer");
  expect(lead!.style.textOverflow).toBe("ellipsis");
  expect(end!.textContent).toBe(" 1");
  // The end keeps its room: it never shrinks, so the cut falls on the words before it.
  expect(end!.style.flex).toBe("0 0 auto");
  // Without an end, or one the text does not end with, one span as before.
  const plain = await render(<ClippedText text="Hon Hai Precision Industry" width={8} keepEnd=" 1" />);
  expect([...plain.querySelectorAll("span")].filter((span) => span.textContent).map((span) => span.textContent)).toEqual(["Hon Hai Precision Industry"]);
});
