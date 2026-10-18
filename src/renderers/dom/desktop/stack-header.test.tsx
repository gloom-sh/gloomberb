/** @jsxImportSource react */
import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { PageStackView } from "../../../components/ui/page-stack-view";
import { QueryBar } from "../../../components/ui/query-bar";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { Text, UiHostProvider } from "../../../ui";
import { createDomUiHost } from "../dom-ui-host";
import { WebInputHostProvider } from "../input-host";
import { createDomTestHarness } from "../test-utils";

const dom = createDomTestHarness({ withUi: false });

// The test DOM lays nothing out, so every box would sit at the top. Here an
// element sits as far down its detail as the `data-test-top` around it says.
function layOut() {
  return spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = Number(this.closest("[data-test-top]")?.getAttribute("data-test-top") ?? 0);
    return { top, bottom: top + 24, left: 0, right: 640, width: 640, height: 24, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
}
let geometry: ReturnType<typeof layOut> | null = null;
afterEach(() => {
  geometry?.mockRestore();
  geometry = null;
});

const bar = <QueryBar width={80} view={{ value: "a", options: [{ value: "a", label: "Trades" }, { value: "b", label: "Insiders" }], onChange: () => {} }} />;

async function mountStack(detail: ReactNode) {
  let setOpen: (open: boolean) => void = () => {};
  function Stack() {
    const [open, update] = useState(false);
    setOpen = update;
    return (
      <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
        <WebInputHostProvider>
          <PageStackView
            focused
            detailOpen={open}
            onBack={() => update(false)}
            detailTitle="BORR"
            rootContent={<Text>Root</Text>}
            detailContent={detail}
          />
        </WebInputHostProvider>
      </UiHostProvider>
    );
  }
  const container = await dom.render(<Stack />);
  return { container, open: (open: boolean) => act(async () => setOpen(open)) };
}

// A detail drawn at once (nothing to load first) mounts its query bar in the
// same commit as the stack's detail, before React attaches the detail's ref:
// the bar still takes Back and the title.
test("a query bar that opens with its detail takes the stack's Back and title", async () => {
  geometry = layOut();
  const { container, open } = await mountStack(<div data-test-top="0">{bar}</div>);
  await open(true);
  expect(container.querySelectorAll("[data-gloom-role='page-stack-header']")).toHaveLength(0);
  expect(container.querySelector(".gloom-qb")?.textContent).toContain("BackBORR");
  await open(false);
  expect(container.textContent).toContain("Root");
});

// Only a bar at the very top of the detail takes the header: one below a
// summary, a chart or another bar leaves Back in its own band above them.
test("a query bar below another element of its detail leaves the stack its Back band", async () => {
  geometry = layOut();
  const { container, open } = await mountStack(<>
    <Text>Summary</Text>
    <div data-test-top="24">{bar}</div>
  </>);
  await open(true);
  const band = container.querySelector("[data-gloom-role='page-stack-header']");
  expect(band?.textContent).toContain("BackBORR");
  expect(container.querySelector(".gloom-qb")?.textContent).not.toContain("Back");
});
