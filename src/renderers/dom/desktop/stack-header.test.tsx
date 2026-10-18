/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { PageStackView } from "../../../components/ui/page-stack-view";
import { QueryBar } from "../../../components/ui/query-bar";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { Text, UiHostProvider } from "../../../ui";
import { createDomUiHost } from "../dom-ui-host";
import { WebInputHostProvider } from "../input-host";
import { createDomTestHarness } from "../test-utils";

const dom = createDomTestHarness({ withUi: false });

// A detail drawn at once (nothing to load first) mounts its query bar in the
// same commit as the stack's detail, before React attaches the detail's ref:
// the bar still takes Back and the title, on every open, not only the first.
test("a query bar that opens with its detail takes the stack's Back and title, each time it opens", async () => {
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
            detailContent={<QueryBar width={80} view={{ value: "a", options: [{ value: "a", label: "Trades" }, { value: "b", label: "Insiders" }], onChange: () => {} }} />}
          />
        </WebInputHostProvider>
      </UiHostProvider>
    );
  }
  const container = await dom.render(<Stack />);
  for (let visit = 0; visit < 2; visit++) {
    await act(async () => setOpen(true));
    expect(container.querySelectorAll("[data-gloom-role='page-stack-header']")).toHaveLength(0);
    expect(container.querySelector(".gloom-qb")?.textContent).toContain("BackBORR");
    await act(async () => setOpen(false));
    expect(container.textContent).toContain("Root");
  }
});
