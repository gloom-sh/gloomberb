import { afterEach, expect, test } from "bun:test";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function fakeWindow() {
  const sent: string[] = [];
  const target = Object.assign(new EventTarget(), {
    __electrobunWindowId: 3,
    __electrobunInternalBridge: {
      postMessage(batch: string) {
        for (const message of JSON.parse(batch) as string[]) {
          const { id, payload } = JSON.parse(message) as { id: string; payload: { id: number } };
          sent.push(`${id}:${payload.id}`);
        }
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: target });
  return { sent, release: () => target.dispatchEvent(new Event("mouseup")) };
}

test("a window move stops on release, also when the release beats the start to the native side", async () => {
  const { startElectrobunWindowDrag } = await import("./window-move");
  const { sent, release } = fakeWindow();

  // A quick click: the release follows at once. The stop is queued behind the start.
  startElectrobunWindowDrag();
  release();
  expect(sent).toEqual(["startWindowMove:3", "stopWindowMove:3"]);

  // A press whose release never reached the page is stopped before the next start.
  sent.length = 0;
  startElectrobunWindowDrag();
  startElectrobunWindowDrag();
  release();
  release();
  expect(sent).toEqual(["startWindowMove:3", "stopWindowMove:3", "startWindowMove:3", "stopWindowMove:3"]);
});
