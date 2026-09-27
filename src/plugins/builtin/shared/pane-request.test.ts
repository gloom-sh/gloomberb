import { expect, test } from "bun:test";
import { createPaneRequestChannel } from "./pane-request";

test("holds a request for the first pane to mount, then delivers live without holding", () => {
  const channel = createPaneRequestChannel<string>();
  channel.request("emails");

  const first: string[] = [];
  const unsubscribe = channel.subscribe((value) => first.push(value));
  const late: string[] = [];
  channel.subscribe((value) => late.push(value))();
  expect(first).toEqual(["emails"]);
  expect(late).toEqual([]);

  channel.request("pro");
  unsubscribe();
  const next: string[] = [];
  channel.subscribe((value) => next.push(value));
  expect(first).toEqual(["emails", "pro"]);
  expect(next).toEqual([]);
});
