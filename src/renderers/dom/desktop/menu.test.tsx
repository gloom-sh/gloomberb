/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { KeybindingsProvider, resolveKeybindings } from "../../../app/keybindings";
import { createDomTestHarness } from "../test-utils";
import { WebMenu } from "./menu";

const { render } = createDomTestHarness({ withUi: false });

async function renderMenu(bindings = resolveKeybindings(undefined)) {
  const selected: string[] = [];
  const items = [
    { id: "first", label: "First" },
    { id: "second", label: "Second" },
    { id: "third", label: "Third" },
  ];
  const container = await render(
    <KeybindingsProvider value={bindings}>
      <WebMenu items={items} onSelect={(id) => selected.push(id)} />
    </KeybindingsProvider>,
  );
  const menu = container.querySelector('[role="menu"]')!;
  return {
    highlighted: () => menu.querySelector('[data-highlighted="true"]')?.textContent,
    selected,
    async press(key: string) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => { menu.dispatchEvent(event); });
      return event.defaultPrevented;
    },
  };
}

test("an uncontrolled WebMenu moves with j/k and arrows by default", async () => {
  const { highlighted, press, selected } = await renderMenu();
  await press("j");
  expect(highlighted()).toBe("Second");
  await press("ArrowDown");
  expect(highlighted()).toBe("Third");
  await press("k");
  expect(highlighted()).toBe("Second");
  await press("ArrowUp");
  expect(highlighted()).toBe("First");
  expect(selected).toEqual([]);
});

test("an uncontrolled WebMenu uses custom directions without falling back to default keys", async () => {
  const bindings = resolveKeybindings({ actions: { "navigate-down": "t", "navigate-up": "s" } });
  const { highlighted, press, selected } = await renderMenu(bindings);
  expect(await press("t")).toBe(true);
  expect(highlighted()).toBe("Second");
  for (const key of ["j", "k", "ArrowDown", "ArrowUp"]) {
    expect(await press(key)).toBe(false);
    expect(highlighted()).toBe("Second");
  }
  expect(await press("s")).toBe(true);
  expect(highlighted()).toBe("First");
  expect(selected).toEqual([]);
});
