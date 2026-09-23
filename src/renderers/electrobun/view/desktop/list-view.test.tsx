/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { WebListView } from "./list-view";
import { createDomTestHarness } from "../test-utils";

const { render: renderDom } = createDomTestHarness();

test("a focused list row follows the outside cursor, and checkbox rows leave Enter to the dialog", async () => {
  const activated: string[] = [];
  let moveCursor: (index: number) => void = () => {};
  function Checklist() {
    const [selectedIndex, setSelectedIndex] = useState(0);
    moveCursor = setSelectedIndex;
    return <WebListView checkboxRows items={[{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }]}
      selectedIndex={selectedIndex} onSelect={setSelectedIndex} onActivate={(item) => activated.push(item.id)} />;
  }
  const container = await renderDom(<Checklist />);
  const rows = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  // Outside a dialog a pressed row takes no focus that would keep the pane's keys.
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  await act(async () => { rows[1]!.dispatchEvent(press); });
  expect(press.defaultPrevented).toBe(true);

  // Tab left the focus on row A, then the dialog's j/k moves the cursor to C.
  await act(async () => { rows[0]!.focus(); });
  await act(async () => { moveCursor(2); });
  expect(document.activeElement).toBe(rows[2]);
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  await act(async () => {
    rows[2]!.dispatchEvent(enter);
    rows[2]!.dispatchEvent(space);
  });
  expect(enter.defaultPrevented).toBe(false);
  expect(activated).toEqual(["b", "c"]);
});
