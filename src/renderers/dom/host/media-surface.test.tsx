/** @jsxImportSource react */
import { expect, mock, spyOn, test } from "bun:test";
import { act, createRef } from "react";
import type { MediaSurfaceHandle } from "../../../ui/host";
import { createDomTestHarness } from "../test-utils";
import { WebMediaSurface } from "./media-surface";

const { window: testWindow, render } = createDomTestHarness({ withUi: false });
testWindow.happyDOM.settings.disableIframePageLoading = true;
const origin = "https://www.youtube.com";
const source = `${origin}/embed/abcdefghijk?autoplay=1&mute=1`;

async function embed() {
  const states: string[] = [];
  const onError = mock();
  const media = createRef<MediaSurfaceHandle>();
  const pane = await render(
    <WebMediaSurface src={source} autoPlay muted mediaHandleRef={media} onPlaybackStateChange={(state) => states.push(state)} onError={onError}>
      <a href="https://www.youtube.com/watch?v=abcdefghijk">Open in browser</a>
    </WebMediaSurface>,
  );
  const frame = pane.querySelector("iframe")!;
  const postMessage = mock<(message: string, targetOrigin: string) => void>();
  const frameWindow = { postMessage } as unknown as typeof testWindow;
  Object.defineProperty(frame, "contentWindow", { value: frameWindow });
  const send = (event: string, info?: unknown, from = frameWindow, eventOrigin = origin) => act(async () => {
    testWindow.dispatchEvent(new testWindow.MessageEvent("message", {
      data: JSON.stringify({ event, info }), origin: eventOrigin, source: from,
    }));
  });
  return { frame, media: media.current!, pane, states, onError, postMessage, send };
}

test("the iframe and commands do not report playback before the player confirms it", async () => {
  const { frame, media, states, postMessage, send } = await embed();
  expect(new URL(frame.src).searchParams.get("enablejsapi")).toBe("1");
  await act(async () => { frame.dispatchEvent(new Event("load")); });
  await send("onReady");
  await act(async () => media.play());
  expect(states).toEqual(["loading"]);
  await send("onStateChange", 1);
  await act(async () => media.toggle());
  expect(states.at(-1)).toBe("playing");
  await send("onStateChange", 2);
  expect(states).toEqual(["loading", "playing", "paused"]);
  expect(media.toggleMuted()).toBe(false);
  const sent = postMessage.mock.calls.map(([message, target]) => ({ ...JSON.parse(message), target }));
  expect(sent.every(({ target }) => target === origin)).toBe(true);
  expect(sent.filter(({ func }) => func === "addEventListener").map(({ args }) => args[0])).toEqual([
    "onStateChange", "onError", "onAutoplayBlocked",
  ]);
  expect(sent.slice(-3).map(({ func }) => func)).toEqual(["playVideo", "pauseVideo", "unMute"]);
});

test("an embed configuration error shows the caller's browser action only for the active player", async () => {
  const { pane, states, onError, send } = await embed();
  await send("onStateChange", 1, testWindow);
  await send("onError", 153, undefined, "https://example.test");
  await send("onStateChange", "1");
  expect(states).toEqual(["loading"]);
  expect(onError).not.toHaveBeenCalled();
  await send("onError", 153);
  expect(states).toEqual(["loading", "error"]);
  expect(onError).toHaveBeenCalledWith("The embedded player could not play this stream.");
  expect(pane.querySelector("iframe")).toBeNull();
  expect(pane.querySelector("a")?.textContent).toBe("Open in browser");
  await send("onStateChange", 1);
  expect(states.at(-1)).toBe("error");
});

test("blocked autoplay leaves the embedded controls available for a manual play", async () => {
  const { pane, states, onError, send } = await embed();
  await send("onAutoplayBlocked");
  expect(states).toEqual(["loading", "idle"]);
  expect(onError).not.toHaveBeenCalled();
  expect(pane.querySelector("iframe")).not.toBeNull();
  await send("onStateChange", 1);
  expect(states.at(-1)).toBe("playing");
});

test("a player that never reports readiness falls back instead of buffering indefinitely", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const { pane, states } = await embed();
    const expire = timer.mock.calls.find(([, delay]) => delay === 15_000)?.[0];
    expect(expire).toBeDefined();
    await act(async () => { expire?.(); });
    expect(states).toEqual(["loading", "error"]);
    expect(pane.querySelector("a")?.textContent).toBe("Open in browser");
  } finally {
    timer.mockRestore();
  }
});

test("native HLS still reports video events and shows the caller's fallback on failure", async () => {
  const states: string[] = [];
  const onError = mock();
  const videoPrototype = testWindow.HTMLVideoElement.prototype;
  const canPlayType = spyOn(videoPrototype, "canPlayType").mockReturnValue("probably");
  const play = spyOn(videoPrototype, "play").mockResolvedValue(undefined);
  const pause = spyOn(videoPrototype, "pause").mockImplementation(() => {});
  const load = spyOn(videoPrototype, "load").mockImplementation(() => {});
  try {
    const pane = await render(
      <WebMediaSurface src="https://example.test/stream.m3u8" autoPlay muted onPlaybackStateChange={(state) => states.push(state)} onError={onError}>
        Open in browser
      </WebMediaSurface>,
    );
    const video = pane.querySelector("video")!;
    expect(video.muted).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["loading"]);
    await act(async () => {
      for (const event of ["playing", "pause", "error"]) video.dispatchEvent(new Event(event));
    });
    expect(states).toEqual(["loading", "playing", "paused", "error"]);
    expect(onError).toHaveBeenCalledWith("The live stream could not be played.");
    expect(pane.textContent).toBe("Open in browser");
  } finally {
    for (const spy of [canPlayType, play, pause, load]) spy.mockRestore();
  }
});
