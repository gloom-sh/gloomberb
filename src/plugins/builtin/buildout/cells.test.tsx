/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { Box } from "../../../ui";
import { createDomTestHarness } from "../../../renderers/electrobun/view/test-utils";
import { renderBuildoutCell } from "./cells";
import type { BuildoutRow } from "./model/types";
import { favoriteKey } from "./table-model";

const { render } = createDomTestHarness();

test("favorite table actions own their click and become disabled during a pending update", async () => {
  const row: BuildoutRow = { kind: "company", item: { id: "company", name: "Company" } };
  const toggles: BuildoutRow[] = [];
  let rowSelections = 0;
  const cell = (busy: boolean) => renderBuildoutCell(row,
    { id: "favorite", label: "Favorite", width: 2, align: "left" }, { selected: false },
    { favoriteBusyKey: busy ? favoriteKey(row) : null, toggleFavorite: (target) => { toggles.push(target); } },
  ).content;
  const container = await render(<Box onMouseDown={() => { rowSelections += 1; }}>{cell(false)}{cell(true)}</Box>);
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons[0]!.disabled).toBe(false);
  expect(buttons[1]!.disabled).toBe(true);
  await act(async () => {
    buttons[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    buttons[0]!.click();
    buttons[1]!.click();
  });
  expect(toggles).toEqual([row]);
  expect(rowSelections).toBe(0);
});
