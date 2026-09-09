/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { WebSegmentedControl } from "./controls";
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
