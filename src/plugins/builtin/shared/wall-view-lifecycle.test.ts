import { expect, test } from "bun:test";
import { trackWallView } from "./wall-view-lifecycle";

test("a wall closed during exposure is counted as the original wall that was visible", async () => {
  const exposure = Promise.withResolvers<"teaser">();
  const views: unknown[] = [];
  const view = trackWallView({ identity: "short-visit", placement: "risk-wall", exposure: exposure.promise,
    currentIdentity: () => "short-visit", record: (...args) => { views.push(args); } });
  view.release();
  view.release();
  exposure.resolve("teaser");
  await view.exposure;
  expect(views).toEqual([["risk-wall", "none"]]);
});

test("a replacement of the same wall reports its completed teaser instead of an older pending view", async () => {
  const exposure = Promise.withResolvers<"teaser">();
  const views: unknown[] = [];
  const options = { identity: "replacement", placement: "risk-wall", exposure: exposure.promise,
    currentIdentity: () => "replacement", record: (...args: unknown[]) => { views.push(args); } };
  const first = trackWallView(options);
  first.release();
  const second = trackWallView(options);
  exposure.resolve("teaser");
  await first.exposure;
  expect(views).toEqual([]);
  second.report("summary");
  second.release();
  await second.exposure;
  expect(views).toEqual([["risk-wall", "summary"]]);
});

test("an account switch during exposure cannot attribute the previous account's wall to the new account", async () => {
  const exposure = Promise.withResolvers<"control">();
  const views: unknown[] = [];
  let identity = "before-sign-in";
  const view = trackWallView({ identity, placement: "most-wall", exposure: exposure.promise,
    currentIdentity: () => identity, record: (...args) => { views.push(args); } });
  view.release();
  identity = "after-sign-in";
  exposure.resolve("control");
  await view.exposure;
  expect(views).toEqual([]);
});
