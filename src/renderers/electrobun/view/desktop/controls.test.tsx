/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { WebSegmentedControl } from "./controls";
import { WebListView } from "./list-view";
import { Button } from "../../../../components/ui/button";
import { TextField } from "../../../../components/ui/fields";
import { ActionRow } from "../../../../components/ui/action-row";
import { Box, Text } from "../../../../ui";
import { createDomTestHarness } from "../test-utils";

const { render: renderDom } = createDomTestHarness();

test("desktop segmented controls expose radio semantics and keyboard selection", async () => {
  const selected: string[] = [];
  const container = await renderDom(
    <WebSegmentedControl
      options={[{ label: "Call", value: "call" }, { label: "Put", value: "put" }]}
      value="call"
      onChange={(value) => selected.push(value)}
    />,
  );

  const group = container.querySelector('[role="radiogroup"]');
  const radios = [...container.querySelectorAll('[role="radio"]')] as unknown as HTMLElement[];
  expect(group).not.toBeNull();
  expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);

  await act(async () => {
    radios[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    radios[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(selected).toEqual(["put", "put"]);
});

test("shared buttons activate once by mouse or keyboard and isolate nested actions", async () => {
  const presses: string[] = [];
  const container = await renderDom(
    <Box onMouseDown={() => presses.push("row")}>
      <Button label="Reply to message" displayLabel="Reply" stopPropagation onPress={() => presses.push("reply")} />
      <Button label="Disabled" disabled onPress={() => presses.push("disabled")} />
      <ActionRow label="Cash" expanded onPress={() => presses.push("cash")}>
        <Box flexGrow={1} /><Text>USD 100</Text>
      </ActionRow>
    </Box>,
  );
  const [reply, disabled, disclosure] = [...container.querySelectorAll("button")] as HTMLButtonElement[];
  expect(reply!.getAttribute("aria-label")).toBe("Reply to message");
  expect(disclosure!.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("button button")).toBeNull();
  await act(async () => {
    reply!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    reply!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    reply!.click();
    reply!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    reply!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    disabled!.click();
    disabled!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(presses).toEqual(["reply", "reply", "reply"]);
});

test("TextField delivers normalized native keys before submit and respects cancellation", async () => {
  const keys: string[] = [];
  const submitted: string[] = [];
  const container = await renderDom(
    <TextField focused value="draft" onSubmit={(value) => submitted.push(value)} onKeyDown={(event) => {
      keys.push(`${event.name}:${event.shift}`);
      if (event.shift) event.preventDefault();
    }} />,
  );
  const input = container.querySelector("input")!;
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(keys).toEqual(["return:true", "return:false"]);
  expect(submitted).toEqual(["draft"]);
});

test("desktop lists skip disabled rows during keyboard selection and activation", async () => {
  const selected: number[] = [];
  const activated: string[] = [];
  const container = await renderDom(
    <WebListView items={[{ id: "a", label: "A" }, { id: "b", label: "B", disabled: true }, { id: "c", label: "C" }]}
      selectedIndex={0} onSelect={(index) => selected.push(index)} onActivate={(item) => activated.push(item.id)} />,
  );
  const rows = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
  await act(async () => {
    rows[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    rows[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    rows[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    rows[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(rows[2]);
  expect(selected).toEqual([2, 2]);
  expect(activated).toEqual(["c"]);
});

test("clicking a native action uses the value committed by the field blur", async () => {
  const saved: string[] = [];
  function Form() {
    const [committed, setCommitted] = useState("old");
    return <>
      <TextField focused value="  edited  " onBlur={(value) => setCommitted(value.trim())} />
      <Button label="Save" onPress={() => saved.push(committed)} />
    </>;
  }
  const container = await renderDom(<Form />);
  const button = container.querySelector("button")!;
  // The browser focuses the button after mousedown, before delivering click.
  await act(async () => {
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button.focus();
  });
  await act(async () => { button.click(); });
  expect(saved).toEqual(["edited"]);
});
