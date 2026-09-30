/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { WebPopover } from "./popover";
import { createDomTestHarness } from "../test-utils";

const { render } = createDomTestHarness();

function popoverIn(zIndex: number | undefined) {
  return (
    <div style={{ position: "absolute", zIndex }}>
      <div style={{ position: "absolute", zIndex: zIndex === undefined ? undefined : zIndex + 1 }}>
        <WebPopover open onOpenChange={() => {}} trigger={<button type="button">Open</button>}>
          <div>Option</div>
        </WebPopover>
      </div>
    </div>
  );
}

// The popover portals to <body>. The desktop command bar stacks at the top of
// the z-index range, so a select inside it used to open underneath the panel.
test("a popover opened inside a surface stacked above the popover layer lifts over it", async () => {
  await render(popoverIn(2_147_483_646));
  const popover = document.querySelector<HTMLElement>(".gloom-popover")!;
  expect(popover.parentElement).toBe(document.body);
  expect(Number(popover.style.zIndex)).toBeGreaterThanOrEqual(2_147_483_647);
});

test("a popover in an ordinary pane keeps the stylesheet layer", async () => {
  await render(popoverIn(60));
  expect(document.querySelector<HTMLElement>(".gloom-popover")!.style.zIndex).toBe("");
});
