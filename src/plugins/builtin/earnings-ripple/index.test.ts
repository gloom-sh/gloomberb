import { expect, test } from "bun:test";
import { createTestTemplateContext } from "../../../test-support/headless";
import { earningsRippleModule } from "./index";

const template = earningsRippleModule.paneTemplates!.find((entry) => entry.id === "earnings-ripple-pane")!;
const names = Array.from({ length: 11 }, (_, index) => `FIX${index}`);
const create = async (options: Parameters<NonNullable<typeof template.createInstance>>[1]) => template.createInstance!(createTestTemplateContext(), options);

test("a typed list past ten tickers is refused with the command bar's message instead of opening on the person's holdings", async () => {
  expect(await create({ arg: names.slice(0, 10).join(" ") })).toMatchObject({ settings: { symbols: names.slice(0, 10).join(", ") } });
  await expect(create({ arg: names.join(" ") })).rejects.toThrow("You can compare up to 10 tickers.");
  // `fn` and `shot` resolve their own list, which may be longer.
  expect(await create({ arg: names.join(" "), symbols: names })).toMatchObject({ settings: { symbols: names.join(", ") } });
});
