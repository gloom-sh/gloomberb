import { expect, test } from "bun:test";
import { createToastStore, type ToastStore } from "./toast";

const bodies = (store: ToastStore) => store.getSnapshot().map((toast) => toast.body);

test("the newest four toasts show, a short buffer stays behind them, and hidden actions stay out of reach", () => {
  const store = createToastStore();
  store.info("t1", { duration: 0, action: { label: "Open", onClick: () => {} } });
  for (let index = 2; index <= 10; index++) store.info(`t${index}`, { duration: 0 });
  expect(bodies(store)).toEqual(["t7", "t8", "t9", "t10"]);
  expect(store.activateNewest()).toBe(false);

  store.dismissNewest();
  expect(bodies(store)).toEqual(["t6", "t7", "t8", "t9"]);
  for (let index = 0; index < 6; index++) store.dismissNewest();
  expect(bodies(store)).toEqual(["t3"]);
});

test("a toast expires after its duration; 0 and Infinity keep it until dismissed", async () => {
  const store = createToastStore();
  store.info("brief", { duration: 5 });
  store.info("sticky", { duration: 0 });
  store.info("forever", { duration: Infinity });
  await Bun.sleep(40);
  expect(bodies(store)).toEqual(["sticky", "forever"]);
});
