import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { changedThePage, SHOT_MUTATION_OPTIONS } from "./cli-pane-shot-mutations";

test("a capture waits on what changes the page, not on an input's name cleared and set back as React renders it", async () => {
  const window = new Window();
  const document = window.document;
  const input = document.createElement("input");
  input.setAttribute("name", "ticker");
  input.setAttribute("type", "file");
  const cell = document.createElement("span");
  cell.textContent = "848.1k";
  document.body.append(input, cell);
  const batches: boolean[] = [];
  const observer = new window.MutationObserver((records) => { batches.push(changedThePage(records as unknown as MutationRecord[])); });
  observer.observe(document.body as never, SHOT_MUTATION_OPTIONS);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // React's update of the input: name cleared, type set again, name set back; the cell's text set to what it was.
  input.setAttribute("name", "");
  input.setAttribute("type", "file");
  input.setAttribute("name", "ticker");
  (cell.firstChild as unknown as { data: string }).data = "848.1k";
  await settle();
  // A figure that moves is a change, and so is a row that arrives.
  (cell.firstChild as unknown as { data: string }).data = "848.4k";
  await settle();
  document.body.append(document.createElement("div"));
  await settle();
  expect(batches).toEqual([false, true, true]);
  observer.disconnect();
  await window.happyDOM.close();
});
