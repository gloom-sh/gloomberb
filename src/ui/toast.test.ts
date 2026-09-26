import { expect, test } from "bun:test";
import { createToastStore, type ToastStore } from "./toast";

const bodies = (store: ToastStore) => store.getSnapshot().map((toast) => toast.body);

test("the newest four toasts show, a short buffer stays behind them, and hidden actions stay out of reach", () => {
  const store = createToastStore();
  let opened = 0;
  for (let index = 1; index <= 10; index++) {
    // t4 is retained but hidden behind the four newest toasts.
    const action = index === 4 ? { label: "Open", onClick: () => { opened++; } } : undefined;
    store.info(`t${index}`, { duration: 0, action });
  }
  expect(bodies(store)).toEqual(["t7", "t8", "t9", "t10"]);
  expect(store.activateNewest()).toBe(false);
  expect(opened).toBe(0);

  for (let index = 0; index < 4; index++) store.dismissNewest();
  expect(bodies(store)).toEqual(["t3", "t4", "t5", "t6"]);
  expect(store.activateNewest()).toBe(true);
  expect(opened).toBe(1);
  expect(bodies(store)).toEqual(["t3", "t5", "t6"]);
});

test("a toast expires after its duration; 0 and Infinity keep it until dismissed", async () => {
  const store = createToastStore();
  store.info("brief", { duration: 5 });
  store.info("sticky", { duration: 0 });
  store.info("forever", { duration: Infinity });
  await Bun.sleep(40);
  expect(bodies(store)).toEqual(["sticky", "forever"]);
});
